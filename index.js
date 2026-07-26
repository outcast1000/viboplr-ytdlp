// viboplr-ytdlp — play & download audio and video from YouTube, SoundCloud,
// Bandcamp, Vimeo and 1000+ other sites via yt-dlp. Replaces the YouTube plugin.
//
// Design notes:
//  - Dependency detection is the HOST's job. We only READ cached status via
//    api.system.getDependency (never probe --version, never check releases). The
//    host surfaces missing/updatable yt-dlp/ffmpeg (sidebar dot + Settings →
//    Dependencies). We just gate our work on what it reports.
//  - Playback is HYBRID: try a direct stream URL (`yt-dlp -g`, validated with a
//    tiny range request), fall back to download-then-play. A setting forces
//    download-only for maximum reliability.
//  - The sandbox has no Date.now()/Math.random(). Uniqueness comes from a
//    monotonic counter; cache filenames from a deterministic hash of the source.

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
var ytDlpVersion = null;
var ffmpegVersion = null;
var statusLoaded = false;

// Settings (persisted).
var cacheMaxMb = 100;
var playbackMode = "stream"; // "stream" (hybrid) | "download"
var searchSource = "youtube"; // default source for the sidebar view + modal search
var resolverSource = "youtube"; // site the metadata fallback resolver searches (Spotify/library-miss playback + downloads)

// Sidebar search view state — kept PER SOURCE TAB, so flipping tabs never
// shows one source's results under another tab's UI (and a fetched link
// survives a detour through the search tabs). Each entry: { query, results,
// meta } where `results` is an array of candidates (null before the first
// search) and `meta` is a link fetch's playlist info ({ title, count }) or null.
var tabState = {};
function stateFor(source) {
  if (!tabState[source]) tabState[source] = { query: "", results: null, meta: null };
  return tabState[source];
}
// One search runs at a time; searchingSource marks the tab that owns the
// spinner / Cancel button. searchGen is bumped on every search start AND on
// cancel; an in-flight search compares its captured generation and discards
// its result if the value has moved on.
var searching = false;
var searchingSource = null;
var searchGen = 0;

// Cache-eviction bookkeeping (see cleanupCache).
var inFlightFiles = {};
var lastSourceFile = null;
var cleanupChain = Promise.resolve();
var convSeq = 0; // monotonic counter for unique temp filenames

// ---------------------------------------------------------------------------
// Search sources
// ---------------------------------------------------------------------------
// prefix: the yt-dlp search extractor (null ⇒ no search, URL/paste only).
var SOURCES = {
  youtube:    { label: "YouTube",    prefix: "ytsearch" },
  soundcloud: { label: "SoundCloud", prefix: "scsearch" },
  // The "Link" tab has no search extractor — it only takes a pasted URL, and a
  // playlist / album / set URL fans out into its entries (capped by LINK_MAX).
  link:       { label: "Link",       prefix: null }
};
// Ordered list for the source tabs.
var SOURCE_ORDER = ["youtube", "soundcloud", "link"];
// Cap on entries pulled from a pasted playlist/album/set, so an enormous list
// can't flood the view or the queue. A single video returns one row, untouched.
var LINK_MAX = 100;

// yt-dlp writes non-ASCII --print output (titles, artists, albums) using
// locale.getpreferredencoding() for some internal paths, which on Windows is
// the ANSI codepage (e.g. cp1253 on Greek Windows) rather than UTF-8 — the
// host's PYTHONUTF8/PYTHONIOENCODING env vars don't override this. yt-dlp's
// own --encoding flag does. Every invocation that reads text back (search,
// link fetch, download metadata) must carry this.
var ENCODING_ARGS = ["--encoding", "utf-8"];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function basename(p) { return p.replace(/^.*[\/\\]/, ""); }
function stemOf(name) { var d = name.lastIndexOf("."); return d > 0 ? name.substring(0, d) : name; }
function extOf(p) { var m = p.match(/\.([^.\/\\]+)$/); return m ? m[1].toLowerCase() : ""; }

// Seconds -> "m:ss" / "h:mm:ss". Returns "" for null/NaN/negative.
function formatDuration(secs) {
  if (secs == null || isNaN(secs) || secs < 0) return "";
  var s = Math.floor(secs % 60), m = Math.floor((secs / 60) % 60), h = Math.floor(secs / 3600);
  var mm = (h > 0 && m < 10 ? "0" : "") + m, ss = (s < 10 ? "0" : "") + s;
  return (h > 0 ? h + ":" : "") + mm + ":" + ss;
}

// Deterministic base36 hash (djb2) — used for cache filenames since the sandbox
// has no Math.random/Date. Length is folded in to further cut collision odds.
function hashSlug(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + s.length.toString(36);
}

// Cache stem is per (source-url, kind) so audio and video of the same URL don't
// collide. Stems are [a-z0-9] — safe as filenames and easy to validate.
function cacheStem(url, isVideo) { return hashSlug(url) + (isVideo ? "v" : "a"); }
var STEM_RE = /^[a-z0-9]+$/;

function isHttpUrl(u) { return typeof u === "string" && /^https?:\/\//i.test(u); }

// yt-dlp --print emits titles as the site provides them — some extractors
// (e.g. Reddit) HTML-escape them ("Clips &amp; More"). Decode the common
// entities; &amp; is decoded LAST so "&amp;lt;" can't double-decode into "<".
function decodeHtmlEntities(s) {
  if (!s || s.indexOf("&") === -1) return s;
  return s
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Render an exec argv as a copy-pasteable command line (for logs).
function formatCmd(program, args) {
  var parts = [program];
  for (var i = 0; i < args.length; i++) {
    var a = String(args[i]);
    parts.push(/\s/.test(a) ? '"' + a + '"' : a);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// ytdlp:// scheme encoding
// ---------------------------------------------------------------------------
// A track's identity is the source webpage URL, encoded into a ytdlp:// path so
// it survives queue persistence and is re-resolved to a fresh stream at play
// time. Dots are percent-escaped so the host's path-extension video detection
// never trips on the encoded URL; a literal ".mp4" suffix is appended for video
// tracks so isVideoTrack() routes them to the theater view.
function encodeRef(url, isVideo) {
  var enc = encodeURIComponent(url).replace(/\./g, "%2E");
  return "ytdlp://" + enc + (isVideo ? ".mp4" : "");
}
// Decode the id portion (everything after "ytdlp://") back to { url, isVideo }.
// Returns null when the decoded value isn't an http(s) URL (guards exec).
var VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|wmv)$/i;
function decodeRef(id) {
  if (!id) return null;
  var isVideo = VIDEO_EXT_RE.test(id);
  var enc = isVideo ? id.replace(VIDEO_EXT_RE, "") : id;
  var url;
  try { url = decodeURIComponent(enc); } catch (e) { return null; }
  if (!isHttpUrl(url)) return null;
  return { url: url, isVideo: isVideo };
}

// ---------------------------------------------------------------------------
// Legacy youtube:// compatibility
// ---------------------------------------------------------------------------
// Existing queues/playlists may still carry youtube://<11-char-id> paths from the
// old plugin. Keep them playable/downloadable by mapping the id to a watch URL.
var YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
function youtubeWatchUrl(id) { return "https://www.youtube.com/watch?v=" + id; }

// Extract the 11-char YouTube video id from a watch / youtu.be / shorts URL, else null.
function ytVideoId(url) {
  if (!url) return null;
  var m = url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    url.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Best thumbnail for a search candidate. Flat-playlist search returns no
// thumbnail (%(thumbnail)s == "NA"), and if we pass none the host falls back to
// name-based artwork (the ARTIST image, not the video). So prefer yt-dlp's
// thumbnail when present, else a deterministic per-VIDEO YouTube thumbnail.
function thumbFor(url, ytThumb) {
  if (isHttpUrl(ytThumb)) return ytThumb;
  var id = ytVideoId(url);
  return id ? "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg" : undefined;
}

// ---------------------------------------------------------------------------
// Title parsing (best-effort "Artist - Song")
// ---------------------------------------------------------------------------
var REMASTER_SUFFIX = /\s*-\s*.*remaster.*$/i;
function stripRemasterSuffix(s) { if (!s) return s; return s.replace(REMASTER_SUFFIX, "").trim() || s; }

var TITLE_NOISE = [
  /\s*[\(\[][^\)\]]*official[^\)\]]*[\)\]]\s*$/i,
  /\s*[\(\[][^\)\]]*lyric[^\)\]]*[\)\]]\s*$/i,
  /\s*[\(\[][^\)\]]*(audio|visualizer|hd|hq|4k)[^\)\]]*[\)\]]\s*$/i,
  /\s*-\s*(official video|official audio|hd|hq|4k)\s*$/i,
  /\s+(hd|hq|4k)\s*$/i
];
function cleanTitle(s) {
  if (!s) return s;
  var prev;
  do {
    prev = s;
    for (var i = 0; i < TITLE_NOISE.length; i++) s = s.replace(TITLE_NOISE[i], "");
    s = stripRemasterSuffix(s);
    s = s.trim();
  } while (s !== prev);
  return s;
}
// Returns { artist, title }. Splits on the first " - "/en-dash/em-dash; falls
// back to the uploader/channel as artist.
function parseTrackTitle(rawTitle, uploader) {
  var cleaned = cleanTitle(rawTitle) || rawTitle || "";
  var seps = [" - ", " – ", " — "];
  for (var i = 0; i < seps.length; i++) {
    var idx = cleaned.indexOf(seps[i]);
    if (idx > 0) {
      var left = cleaned.substring(0, idx).trim();
      var right = cleaned.substring(idx + seps[i].length).trim();
      if (left && right) return { artist: left, title: right };
    }
  }
  return { artist: uploader || "", title: cleaned };
}

// A search candidate { url, title, uploader, durationSecs, thumbnail } -> host
// PluginTrack. Shared by Play/Queue/row-click so they can't drift.
function buildTrack(c, isVideo) {
  var parsed = parseTrackTitle(c.title, c.uploader);
  return {
    title: parsed.title || c.title || c.url,
    artist_name: parsed.artist || c.uploader || null,
    duration_secs: c.durationSecs != null ? c.durationSecs : null,
    path: encodeRef(c.url, isVideo),
    image_url: thumbFor(c.url, c.thumbnail)
  };
}

// ---------------------------------------------------------------------------
// Tool status (read-only, from the host — never probed here)
// ---------------------------------------------------------------------------
async function loadToolStatus(api) {
  if (api.system && typeof api.system.getDependency === "function") {
    var results = await Promise.all([
      api.system.getDependency("yt-dlp"),
      api.system.getDependency("ffmpeg")
    ]);
    var y = results[0], f = results[1];
    ytDlpVersion = y && y.installed ? (y.version || "unknown") : null;
    ffmpegVersion = f && f.installed ? (f.version || "unknown") : null;
  } else {
    ytDlpVersion = "unknown";
    ffmpegVersion = "unknown";
  }
  statusLoaded = true;
}
async function ensureToolStatus(api) { if (!statusLoaded) await loadToolStatus(api); }

// Map yt-dlp stderr to a user-facing reason — the host download modal shows
// thrown messages, so the real cause reaches the user instead of a generic
// "could not resolve" failure. Pure; exported for tests.
function classifyYtdlpError(stderr) {
  var s = stderr || "";
  if (/sign in to confirm/i.test(s)) {
    return "YouTube rejected the request with a sign-in / bot check. This is temporary — try again in a few minutes.";
  }
  if (/account authentication is required|--cookies/i.test(s)) {
    return "The site requires a signed-in account to access this item.";
  }
  if (/requested format is not available/i.test(s)) {
    return "The requested format isn't available for this item.";
  }
  if (/video unavailable|private video|has been removed|geo.?restricted|not available in your country/i.test(s)) {
    return "The video is unavailable (removed, private or region-locked).";
  }
  if (/HTTP Error 403/i.test(s)) {
    return "The site refused the transfer (HTTP 403) — often temporary; updating yt-dlp may help.";
  }
  // Fall back to the last ERROR: line, minus the "[extractor] id:" prefix.
  var lines = s.split("\n");
  for (var i = lines.length - 1; i >= 0; i--) {
    var m = lines[i].match(/^ERROR:\s*(.*)$/);
    if (m) return "yt-dlp: " + m[1].replace(/^\[[^\]]*\]\s*[^\s:]*:\s*/, "").trim();
  }
  return "yt-dlp could not download this item.";
}

// Absolute filesystem path (POSIX or Windows drive letter)?
function looksLikePath(s) { return /^\/|^[A-Za-z]:[\\\/]/.test(s || ""); }

// True when version a is clearly older than b (dotted numeric segments, e.g.
// yt-dlp's date-style "2026.07.04"). Pure; exported for tests.
function isOlderVersion(a, b) {
  var pa = String(a || "").split("."), pb = String(b || "").split(".");
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    var x = parseInt(pa[i] || "0", 10), y = parseInt(pb[i] || "0", 10);
    if (isNaN(x) || isNaN(y)) return false;
    if (x !== y) return x < y;
  }
  return false;
}

// Append an "outdated yt-dlp" note when the host's cached dependency check
// knows a newer version exists — stale yt-dlp is the usual cause of
// persistent YouTube failures and otherwise reads as an app bug. Cache-only;
// never hits the network.
async function withOutdatedHint(api, message) {
  try {
    var dep = await api.system.getDependency("yt-dlp");
    if (dep && dep.installed && dep.latest && isOlderVersion(dep.version, dep.latest)) {
      return message + " Installed yt-dlp " + dep.version + " is outdated (latest " + dep.latest + ") — update it in Settings → Dependencies.";
    }
  } catch (e) { console.error("[ytdlp] outdated-hint lookup failed:", e); }
  return message;
}

// YouTube sometimes rate-gates a device ("Sign in to confirm you're not a
// bot"): every extraction fails for a while, playback silently falls back
// (e.g. to a local audio copy of the song) and searches return nothing — with
// no clue why. Surface it ONCE per session as a notification.
var botGateNotified = false;
function noteBotGate(api, stderr) {
  if (botGateNotified || !/sign in to confirm/i.test(stderr || "")) return;
  botGateNotified = true;
  api.log("warn", "YouTube bot gate detected — extractions will fail until it lifts", "ytdlp");
  api.ui.showNotification("YouTube is temporarily rate-limiting this device (sign-in / bot check). YouTube playback, search and downloads may fail for a while.");
}

// ---------------------------------------------------------------------------
// Diagnostics — re-run extraction in verbose simulate mode to surface WHY a
// download/stream failed (PO-token/SABR/403). Best-effort; never throws.
// ---------------------------------------------------------------------------
async function logDownloadDiagnostics(api, url) {
  try {
    var diag = await api.system.exec("yt-dlp", ["-v", "--simulate", "-f", "bestaudio", url], { cwd: null });
    var out = ((diag.stderr || "") + "\n" + (diag.stdout || "")).trim();
    var keep = [], lines = out.split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (/po.?token|sabr|gvs|skipped|missing a URL|forcing|403|forbidden|player_client|experiment/i.test(lines[i])) {
        keep.push(lines[i].trim());
      }
    }
    var summary = keep.length ? keep.join("\n") : out;
    if (summary) api.log("warn", "yt-dlp diagnostics:\n" + summary, "ytdlp");
  } catch (e) {
    api.log("warn", "yt-dlp diagnostics probe failed: " + (e && e.message ? e.message : e), "ytdlp");
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
// Run a search (or resolve a pasted URL) and return candidates:
// [{ url, title, uploader, durationSecs, thumbnail }]. Returns [] on failure.
async function runSearch(api, source, query, count) {
  return (await runSearchFull(api, source, query, count)).candidates;
}

// Full variant: also returns `meta` — the fetched playlist's { title, count }
// for a pasted URL, null for plain searches and single videos. The sidebar
// Link tab uses it for its playlist header; every other caller goes through
// runSearch and ignores it.
async function runSearchFull(api, source, query, count) {
  var none = { candidates: [], meta: null };
  var q = (query || "").trim();
  if (!q) return none;
  var n = count || 25;
  var target;
  var isUrl = isHttpUrl(q);
  if (isUrl) {
    // Pasted URL (any of yt-dlp's sites — Bandcamp/Vimeo/etc. have no search
    // prefix, but a direct URL always works). A single video → one row; a
    // playlist / album / set → its entries (capped below). --no-playlist only
    // disambiguates a "video + &list=" watch URL toward the single video; it does
    // NOT stop a pure playlist URL from expanding.
    target = q;
  } else {
    var src = SOURCES[source] || SOURCES.youtube;
    if (!src.prefix) return none;
    target = src.prefix + n + ":" + q;
  }
  var args = [
    target,
    "--flat-playlist",
    "--no-playlist",
    "--no-warnings"
  ].concat(ENCODING_ARGS);
  // Bound a pasted playlist so a huge list can't flood the view/queue.
  if (isUrl) args.push("-I", "1:" + LINK_MAX);
  // Comma fields = first non-null. thumbnail is best-effort. URL fetches also
  // carry the playlist's title/count (NA for a single video) so the Link tab
  // can name what it fetched and show how much the -I cap hid.
  var printFields = "%(url,webpage_url)s\t%(duration)s\t%(uploader,channel,uploader_id)s\t%(title)s\t%(thumbnail)s";
  if (isUrl) printFields += "\t%(playlist_title)s\t%(playlist_count)s";
  args.push("--print", printFields);
  api.log("info", "Running: " + formatCmd("yt-dlp", args), "ytdlp");
  var res;
  try {
    res = await api.system.exec("yt-dlp", args);
  } catch (e) {
    api.log("warn", "yt-dlp search exec failed: " + (e && e.message ? e.message : e), "ytdlp");
    return none;
  }
  if (res.exitCode !== 0 || !res.stdout) {
    api.log("warn", "yt-dlp search returned no results (exit " + res.exitCode + ")" +
      (res.stderr ? ": " + res.stderr.trim() : ""), "ytdlp");
    noteBotGate(api, res.stderr);
    return none;
  }
  var parsed = parseSearchOutput(res.stdout, isUrl);
  return {
    candidates: dropSoundcloudPreviews(parsed.candidates, source, isUrl, api),
    meta: parsed.meta
  };
}

// Parse `--print` output lines into candidates, plus the playlist meta when
// the extra URL-fetch fields were requested (every entry line repeats them;
// the first line with a non-NA value wins). Pure — exported for tests.
function parseSearchOutput(stdout, withPlaylistFields) {
  var lines = (stdout || "").split("\n"), out = [], meta = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || !line.trim()) continue;
    var cols = line.split("\t");
    var url = cols[0];
    if (!isHttpUrl(url)) continue;
    var durRaw = cols[1];
    var dur = durRaw && durRaw !== "NA" ? parseInt(durRaw, 10) : NaN;
    var uploader = cols[2] && cols[2] !== "NA" ? decodeHtmlEntities(cols[2]) : "";
    var title = cols[3] && cols[3] !== "NA" ? decodeHtmlEntities(cols[3]) : null;
    var thumb = cols[4] && cols[4] !== "NA" && isHttpUrl(cols[4]) ? cols[4] : null;
    out.push({ url: url, title: title, uploader: uploader, durationSecs: isNaN(dur) ? null : dur, thumbnail: thumb });
    if (withPlaylistFields && !meta) {
      var pTitle = cols[5] && cols[5] !== "NA" ? decodeHtmlEntities(cols[5]) : null;
      var pCount = cols[6] && cols[6] !== "NA" ? parseInt(cols[6], 10) : NaN;
      if (pTitle || !isNaN(pCount)) meta = { title: pTitle, count: isNaN(pCount) ? null : pCount };
    }
  }
  return { candidates: out, meta: meta };
}

// SoundCloud Go+/paid tracks expose only a 30s preview without auth. Real tracks
// are rarely exactly ~30s, so treat a ~30s SoundCloud result as an "obvious
// preview" and drop it — but never for a directly pasted URL (there the user
// asked for that exact item).
function isPreviewDuration(d) { return d != null && d >= 29 && d <= 31; }
function dropSoundcloudPreviews(candidates, source, isUrlPaste, api) {
  if (source !== "soundcloud" || isUrlPaste) return candidates;
  var kept = candidates.filter(function (c) { return !isPreviewDuration(c.durationSecs); });
  if (api && kept.length < candidates.length) {
    api.log("info", "Hid " + (candidates.length - kept.length) + " SoundCloud preview(s) (~30s)", "ytdlp");
  }
  return kept;
}

// Pick the best candidate for a known target duration (fallback resolver path):
// first within ±3s, else the top result. Returns a candidate or null.
function pickBestCandidate(candidates, durationSecs, api) {
  if (!candidates || candidates.length === 0) {
    if (api) api.log("warn", "yt-dlp search parsed 0 valid candidates", "ytdlp");
    return null;
  }
  var best = candidates[0], matched = false;
  if (durationSecs != null && durationSecs > 0) {
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c].durationSecs !== null && Math.abs(candidates[c].durationSecs - durationSecs) <= 3) {
        best = candidates[c]; matched = true; break;
      }
    }
  }
  if (api) api.log("info", candidates.length + " candidate(s); chose " + best.url + (matched ? " (duration match)" : " (top result)"), "ytdlp");
  return best;
}

async function searchByMetadata(api, title, artistName, durationSecs) {
  var query = artistName ? title + " " + artistName : title;
  // Uses the configurable fallback source (YouTube by default) — this is what
  // resolves tracks that have no direct source of their own (e.g. from Spotify,
  // or a library track missing locally), for both playback and download.
  var candidates = await runSearch(api, resolverSource, query, 7);
  return pickBestCandidate(candidates, durationSecs, api);
}

// Context-menu "Watch YouTube video": search YouTube by the track's metadata
// and play the top hit as a VIDEO in the theater. Always searches YouTube (the
// video source), NOT the configurable fallback resolver — the action is
// explicitly about YouTube video. Feedback is a notification (context-menu
// actions have no loading modal); errors surface the same way and never throw.
async function watchVideoFor(api, title, artistName) {
  await ensureToolStatus(api);
  if (!ytDlpVersion) {
    api.ui.showNotification("yt-dlp isn't installed — see Settings → Dependencies.");
    return;
  }
  var clean = stripRemasterSuffix((title || "").trim());
  if (!clean) return;
  api.ui.showNotification("Searching YouTube for a video…");
  try {
    var query = artistName ? clean + " " + artistName : clean;
    var candidates = await runSearch(api, "youtube", query, 7);
    var cand = pickBestCandidate(candidates, null, api);
    if (!cand) {
      api.ui.showNotification("No video found for “" + clean + "”.");
      return;
    }
    api.playback.playTracks([buildTrack(cand, true)], 0);
  } catch (e) {
    api.log("error", "Watch video failed: " + (e && e.message ? e.message : e), "ytdlp");
    api.ui.showNotification("Couldn't find a video for “" + clean + "”.");
  }
}

// ---------------------------------------------------------------------------
// Downloads — yt-dlp does the transcode AND embeds tags (metadata only)
// ---------------------------------------------------------------------------
// Audio formats offered as a RE-ENCODE (yt-dlp `-x --audio-format`). "original"
// keeps the source stream verbatim (best quality) and is not listed here.
var TRANSCODE_FORMATS = { aac: 1, mp3: 1, opus: 1, flac: 1 };

// Metadata --print template: first non-null of each comma group wins.
// track/title | artist/creator/uploader | album | release_year | title
var META_PRINT = "%(track,title)s\t%(artist,creator,uploader)s\t%(album)s\t%(release_year)s\t%(title)s";

// Parse a META_PRINT line into { title?, artist?, album?, year? }. Pure.
function parseMetadataLine(line) {
  var cols = (line || "").split("\t");
  function clean(v) { return v && v !== "NA" ? v.trim() : ""; }
  var meta = {};
  var title = clean(cols[0]) || clean(cols[4]);
  if (title) meta.title = title;
  if (clean(cols[1])) meta.artist = clean(cols[1]);
  if (clean(cols[2])) meta.album = clean(cols[2]);
  var yearStr = clean(cols[3]);
  if (/^\d{4}$/.test(yearStr)) meta.year = parseInt(yearStr, 10);
  return meta;
}

// Pure builder for the download argv. opts: { url, video?, audioFormat? } where
// audioFormat is a TRANSCODE_FORMATS key (re-encode) or falsy (keep the source
// codec = "original"). `embed` (= ffmpeg available) embeds tags AND enables
// lossless audio extraction.
//
// We embed metadata (artist/album/year) via ffmpeg but deliberately do NOT embed
// cover art: `--embed-thumbnail` needs the Python `mutagen` module for opus/ogg/
// flac, which the managed yt-dlp zipapp's system Python often lacks — and a failed
// thumbnail embed aborts the whole download. Metadata-only embedding has no such
// dependency, so the download always completes. In-app artwork is unaffected (it
// comes from the track's image_url / the host's image providers, not the file).
//
// "original" uses `-x --audio-format best`: ffmpeg *copies* the source codec
// (no re-encode) into a taggable, non-webm container (opus→ogg, aac→m4a,
// flac→flac). This is deliberate — a raw bestaudio download is Opus-in-webm,
// and the HOST re-encodes any .webm to lossy AAC, so we must hand it a non-webm
// container to preserve quality. Without ffmpeg we can't extract, so we fall
// back to a raw bestaudio download (may be webm; the host handles it degraded).
function buildDownloadArgs(opts, outDir, seq, embed) {
  var args;
  if (opts.video) {
    args = ["-f", "bestvideo*+bestaudio/best", "--merge-output-format", "mp4"];
  } else if (opts.audioFormat) {
    args = ["-x", "--audio-format", opts.audioFormat, "--audio-quality", "0"];
  } else if (embed) {
    args = ["-x", "--audio-format", "best"];
  } else {
    args = ["-f", "bestaudio/best"];
  }
  if (embed) args = args.concat(["--embed-metadata"]);
  // Two prints: the META_PRINT line lands at extraction time, the filepath
  // after the file is moved into place — so ONE run yields both the metadata
  // and the file (a separate metadata fetch doubled our request volume, which
  // is what provokes YouTube's bot gate).
  return args.concat(ENCODING_ARGS).concat([
    "--no-warnings", "--quiet", "--no-simulate", "--no-playlist",
    "--print", META_PRINT,
    "--print", "after_move:filepath",
    "-P", outDir, "-o", "dl." + seq + ".%(ext)s", opts.url
  ]);
}

// Download to the temp dir with tags embedded (no cover art — see
// buildDownloadArgs). Returns { filePath, meta } — `meta` is yt-dlp's own
// metadata, printed by the SAME run (no separate metadata fetch). Throws an
// Error with a user-facing reason on failure; the host download modal shows
// thrown messages, so the real cause (bot check, region lock, missing format)
// reaches the user.
async function downloadForDownload(api, url, opts) {
  var outDir = await ensureDir(api, "temp");
  if (!outDir) throw new Error("The plugin's temp folder is unavailable — cannot download.");
  var attempt = async function () {
    var args = buildDownloadArgs({ url: url, video: opts.video, audioFormat: opts.audioFormat }, outDir, convSeq++, !!ffmpegVersion);
    api.log("info", "Running: " + formatCmd("yt-dlp", args), "ytdlp");
    try {
      return await api.system.exec("yt-dlp", args, { cwd: null });
    } catch (e) {
      api.log("error", "yt-dlp download exec failed: " + (e && e.message ? e.message : e), "ytdlp");
      throw new Error("yt-dlp could not be run — check Settings → Dependencies.");
    }
  };
  var res = await attempt();
  if (res.exitCode !== 0 && /HTTP Error 403|403 Forbidden/i.test(res.stderr || "")) {
    // A 403 on the media URLs is usually YouTube's transient PO-token/SABR
    // gate on the just-minted URLs; a NEW extraction mints fresh URLs and
    // often passes. Retry once before giving up.
    api.log("warn", "HTTP 403 on media download — retrying with a fresh extraction", "ytdlp");
    res = await attempt();
  }
  if (res.exitCode !== 0) {
    api.log("error", "yt-dlp download failed (exit " + res.exitCode + "): " + (res.stderr || "").trim(), "ytdlp");
    await logDownloadDiagnostics(api, url);
    throw new Error(await withOutdatedHint(api, classifyYtdlpError(res.stderr)));
  }
  // stdout: the META_PRINT line (extraction time), then the after_move
  // filepath line. Anything that doesn't end in an absolute path means no
  // file actually landed.
  var lines = (res.stdout || "").split("\n").filter(function (l) { return l.trim(); });
  var last = lines.length ? lines[lines.length - 1].trim() : "";
  if (!looksLikePath(last)) {
    api.log("warn", "yt-dlp returned no file path — likely SABR/PO-token", "ytdlp");
    await logDownloadDiagnostics(api, url);
    throw new Error("The download produced no file — often a YouTube restriction; updating yt-dlp usually fixes this.");
  }
  api.log("info", "Downloaded to: " + last, "ytdlp");
  return { filePath: last, meta: lines.length > 1 ? parseMetadataLine(lines[0]) : {} };
}

// ---------------------------------------------------------------------------
// Cache management (LRU by mtime, budget = cacheMaxMb)
// ---------------------------------------------------------------------------
// Resolve a plugin-storage dir to an absolute path, CREATING it when missing.
// getPath returns null for paths that don't exist on disk — and the startup
// cleanup removes the whole temp dir — so the first download after a restart
// used to build a literal "-P null" argv (the v1.2.0 bug's second home).
// writeText creates parent dirs, so touching a marker materializes the dir.
async function ensureDir(api, name) {
  var p = await api.storage.files.getPath([name]);
  if (p) return p;
  try { await api.storage.files.writeText([name, ".keep"], ""); }
  catch (e) { console.error("[ytdlp] ensureDir " + name + " failed:", e); }
  return await api.storage.files.getPath([name]);
}
async function findCachedDownload(api, stem) {
  try {
    var entries = await api.storage.files.list(["cache"]);
    for (var i = 0; i < entries.length; i++) {
      if (stemOf(entries[i].name) === stem) return await api.storage.files.getPath(["cache", entries[i].name]);
    }
  } catch (e) { /* cache dir may not exist yet */ }
  return null;
}

async function cleanupCache(api, wipeTemp) {
  var maxBytes = cacheMaxMb * 1024 * 1024;
  if (wipeTemp) { try { await api.storage.files.remove(["temp"]); } catch (e) {} }
  var entries;
  try { entries = await api.storage.files.list(["cache"]); } catch (e) { return; }

  var valid = [], removedStray = 0;
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (entry.isDir) continue;
    var stem = stemOf(entry.name);
    if (!STEM_RE.test(stem)) {
      try { await api.storage.files.remove(["cache", entry.name]); removedStray++; } catch (e) {}
    } else {
      valid.push({ name: entry.name, size: entry.size || 0, modifiedAt: entry.modifiedAt || 0 });
    }
  }
  valid.sort(function (a, b) { return a.modifiedAt - b.modifiedAt; });

  var total = 0;
  for (var j = 0; j < valid.length; j++) total += valid[j].size;

  var evicted = 0, idx = 0;
  while (total > maxBytes && idx < valid.length) {
    var oldest = valid[idx];
    if (inFlightFiles[oldest.name] || oldest.name === lastSourceFile) { idx++; continue; }
    try { await api.storage.files.remove(["cache", oldest.name]); evicted++; total -= oldest.size; } catch (e) {}
    valid.splice(idx, 1);
  }
  if (removedStray > 0 || evicted > 0) {
    api.log("info", "Cache cleanup: evicted " + evicted + ", removed " + removedStray + " stray, " + Math.round(total / 1024 / 1024) + " MB left", "ytdlp");
  }
}
function scheduleCleanup(api, wipeTemp) {
  cleanupChain = cleanupChain.then(function () { return cleanupCache(api, wipeTemp); }, function () { return cleanupCache(api, wipeTemp); });
  return cleanupChain;
}

// ---------------------------------------------------------------------------
// Resolution primitives
// ---------------------------------------------------------------------------
// Get a direct stream URL via `yt-dlp -g`. audio: bestaudio; video: a single
// muxed stream (streamable without a local merge). Returns a URL or null.
// Video falls back to the HLS MASTER playlist when no muxed stream exists —
// see getHlsMasterUrl.
async function getDirectUrl(api, url, isVideo) {
  var fmt = isVideo ? "best[ext=mp4]/best" : "bestaudio[ext=m4a]/bestaudio";
  var args = ["-g", "-f", fmt, "--no-warnings", "--no-playlist", url];
  api.log("info", "Running: " + formatCmd("yt-dlp", args), "ytdlp");
  var res;
  try { res = await api.system.exec("yt-dlp", args, { cwd: null }); }
  catch (e) { api.log("warn", "yt-dlp -g exec failed: " + (e && e.message ? e.message : e), "ytdlp"); return null; }
  if (res.exitCode === 0 && res.stdout) {
    // -g prints one URL per selected stream. For our single-stream selectors
    // the last non-empty line is the (only) media URL.
    var lines = res.stdout.split("\n"), direct = null;
    for (var i = lines.length - 1; i >= 0; i--) { var l = lines[i].trim(); if (l) { direct = l; break; } }
    if (isHttpUrl(direct)) return direct;
  }
  noteBotGate(api, res.stderr);
  // Some sites (e.g. Reddit) have NO muxed video+audio format at all — only
  // split DASH/HLS streams — so `best` matches nothing. The HLS MASTER
  // playlist is one URL carrying the video renditions + the audio group,
  // playable by mpv and the macOS webview alike.
  return isVideo ? await getHlsMasterUrl(api, url) : null;
}

// Pure: the master manifest URL of the best (last) m3u8 format, or null.
function pickHlsMaster(formats) {
  if (!formats || !formats.length) return null;
  for (var i = formats.length - 1; i >= 0; i--) {
    var f = formats[i];
    if (f && typeof f.protocol === "string" && f.protocol.indexOf("m3u8") === 0 && isHttpUrl(f.manifest_url)) {
      return f.manifest_url;
    }
  }
  return null;
}

async function getHlsMasterUrl(api, url) {
  var args = ["--no-warnings", "--no-playlist", "--skip-download", "--print", "%(formats)j", url];
  try {
    var res = await api.system.exec("yt-dlp", args, { cwd: null });
    if (res.exitCode !== 0 || !res.stdout) return null;
    var master = pickHlsMaster(JSON.parse(res.stdout.split("\n")[0]));
    if (master) api.log("info", "No muxed stream — using HLS master: " + master, "ytdlp");
    return master;
  } catch (e) {
    api.log("warn", "HLS master lookup failed: " + (e && e.message ? e.message : e), "ytdlp");
    return null;
  }
}

// Best-effort check that a direct URL is actually fetchable with default headers
// (some sources sign URLs or require a UA). A tiny range GET through the host's
// CORS-bypassing proxy. Returns true on 2xx, false on anything else/errors.
async function validateDirectUrl(api, url) {
  if (!api.network || typeof api.network.fetch !== "function") return true; // can't check → trust it
  try {
    var res = await api.network.fetch(url, { headers: { Range: "bytes=0-1" } });
    return !!res && res.status >= 200 && res.status < 400;
  } catch (e) { return false; }
}

// Download the source media to cache/<stem>.<ext>. audio: bestaudio; video:
// bestvideo+bestaudio merged to mp4 (needs ffmpeg). Returns the file path or null.
async function downloadToCache(api, url, isVideo) {
  var stem = cacheStem(url, isVideo);
  var cached = await findCachedDownload(api, stem);
  if (cached) { api.log("info", "Using cached download: " + cached, "ytdlp"); return cached; }

  var cacheDir = await ensureDir(api, "cache");
  if (!cacheDir) { api.log("error", "Cache dir unavailable — cannot download", "ytdlp"); return null; }
  var args;
  if (isVideo) {
    args = ["-f", "bestvideo*+bestaudio/best", "--merge-output-format", "mp4"];
  } else {
    args = ["-f", "bestaudio[ext=m4a]/bestaudio"];
  }
  args = args.concat([
    "--no-warnings", "--quiet", "--no-simulate", "--no-playlist",
    "--print", "after_move:filepath",
    "-P", cacheDir, "-o", stem + ".%(ext)s", url
  ]);
  api.log("info", "Running: " + formatCmd("yt-dlp", args), "ytdlp");
  var filePath = null;
  try {
    var res = await api.system.exec("yt-dlp", args, { cwd: null });
    if (res.exitCode !== 0 && /HTTP Error 403|403 Forbidden/i.test(res.stderr || "")) {
      // Transient PO-token/SABR gate on the minted URLs — a fresh extraction
      // often passes (same retry as downloadForDownload).
      api.log("warn", "HTTP 403 on media download — retrying with a fresh extraction", "ytdlp");
      res = await api.system.exec("yt-dlp", args, { cwd: null });
    }
    if (res.exitCode !== 0) {
      api.log("error", "yt-dlp download failed (exit " + res.exitCode + "): " + (res.stderr || "").trim(), "ytdlp");
      await logDownloadDiagnostics(api, url);
      return null;
    }
    filePath = res.stdout ? res.stdout.trim() || null : null;
  } catch (e) {
    api.log("error", "yt-dlp exec failed: " + (e && e.message ? e.message : e), "ytdlp");
    return null;
  }
  if (!filePath) {
    api.log("warn", "yt-dlp returned no file path (exit 0, no output) — likely SABR/PO-token", "ytdlp");
    await logDownloadDiagnostics(api, url);
    return null;
  }
  api.log("info", "Downloaded to: " + filePath, "ytdlp");
  return filePath;
}

// Protect a just-produced cache file from eviction while `work` runs, then
// mark it as the most-recent source and schedule cleanup.
async function withCacheProtection(api, filePath, work) {
  var name = basename(filePath);
  inFlightFiles[name] = (inFlightFiles[name] || 0) + 1;
  try {
    return await work();
  } finally {
    lastSourceFile = name;
    inFlightFiles[name]--;
    if (inFlightFiles[name] <= 0) delete inFlightFiles[name];
    scheduleCleanup(api).catch(function (e) { api.log("warn", "Cache cleanup failed: " + (e && e.message ? e.message : e), "ytdlp"); });
  }
}

// Resolve a source URL to a PLAYABLE url. Returns { url, downloaded } or null.
//
// "stream" mode returns a direct URL only — it does NOT fall back to downloading
// on failure. A download of the same source doesn't fix a codec the engine can't
// play (that's the mpv engine's job), and downloading the whole file first is
// slow; so a direct-stream failure fails cleanly and the host surfaces an error.
// Users who want the reliability of a local copy pick "Download then play".
async function resolvePlayable(api, url, isVideo) {
  if (playbackMode === "stream") {
    var direct = await getDirectUrl(api, url, isVideo);
    if (direct && await validateDirectUrl(api, direct)) {
      api.log("info", "Streaming directly: " + url, "ytdlp");
      return { url: direct, downloaded: false };
    }
    api.log("warn", "Direct stream unavailable: " + url, "ytdlp");
    return null;
  }
  // "download" mode: fetch a local copy (browser-friendly m4a / merged mp4).
  var filePath = await downloadToCache(api, url, isVideo);
  if (!filePath) return null;
  return { url: "file://" + filePath, downloaded: true, filePath: filePath };
}

// Produce the host download-resolve result for a source URL + chosen format.
// Always downloads locally so yt-dlp can embed tags (using its rich metadata)
// into a correctly-named file. `caller` carries any AUTHORITATIVE
// metadata the host already has (e.g. a library track's real title/artist/album),
// which overrides yt-dlp's guesses; when absent, yt-dlp's own metadata is used.
// Throws (via downloadForDownload) with a user-facing reason on failure.
async function resolveDownload(api, url, format, caller) {
  var fmt = format || "original";
  var isVideo = fmt === "video";
  var audioFormat = null;
  if (!isVideo && TRANSCODE_FORMATS[fmt]) {
    if (ffmpegVersion) audioFormat = fmt;
    else api.log("warn", "ffmpeg missing — downloading original audio instead of " + fmt, "ytdlp");
  }

  var dl = await downloadForDownload(api, url, { video: isVideo, audioFormat: audioFormat });
  // Rich metadata from yt-dlp (printed by the download run itself);
  // caller-supplied fields win.
  var meta = dl.meta || {};
  var md = {};
  md.title = (caller && caller.title) || meta.title || url;
  var artist = (caller && caller.artist) || meta.artist;
  if (artist) md.artist = artist;
  var album = (caller && caller.album) || meta.album;
  if (album) md.album = album;
  if (meta.year) md.year = meta.year;

  return await withCacheProtection(api, dl.filePath, function () {
    return { url: "file://" + dl.filePath, headers: null, ext: extOf(dl.filePath) || undefined, metadata: md };
  });
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
async function activate(api) {
  var stored = await Promise.all([
    api.storage.get("cacheMaxMb"),
    api.storage.get("playbackMode"),
    api.storage.get("searchSource"),
    api.storage.get("resolverSource")
  ]);
  if (stored[0] != null && typeof stored[0] === "number") cacheMaxMb = stored[0];
  if (stored[1] === "download" || stored[1] === "stream") playbackMode = stored[1];
  if (stored[2] && SOURCES[stored[2]]) searchSource = stored[2];
  if (stored[3] && SOURCES[stored[3]]) resolverSource = stored[3];

  // Startup cleanup: wipe transcoded temp files; keep cached source downloads.
  scheduleCleanup(api, true).catch(function (e) { api.log("warn", "Startup cache cleanup failed: " + (e && e.message ? e.message : e), "ytdlp"); });

  // ---- Playback: metadata fallback resolver (the "youtube-fallback" role) ----
  // Honors the host's advisory `preferVideo` hint: when set, resolve a video
  // stream and flag the result `video: true` so the host plays it in the theater;
  // fall back to audio when no video is available. Without the hint (or on
  // fallback) it returns audio exactly as before.
  api.playback.onStreamResolve("ytdlp-fallback", async function (title, artistName, albumName, durationSecs, opts) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) { api.log("warn", "Stream resolve skipped — yt-dlp not available", "ytdlp"); return null; }
    title = stripRemasterSuffix(title);
    var preferVideo = !!(opts && opts.preferVideo);
    try {
      var cand = await searchByMetadata(api, title, artistName, durationSecs);
      if (!cand) { api.log("warn", "No match for: " + title, "ytdlp"); return null; }
      if (preferVideo) {
        var vid = await resolvePlayable(api, cand.url, true);
        if (vid) return { url: vid.url, label: "yt-dlp (video)", sourceUrl: cand.url, video: true };
        api.log("warn", "No video stream — falling back to audio: " + cand.url, "ytdlp");
      }
      var playable = await resolvePlayable(api, cand.url, false);
      if (!playable) return null;
      return { url: playable.url, label: "yt-dlp", sourceUrl: cand.url };
    } catch (e) {
      api.log("error", "Stream resolve failed: " + (e && e.message ? e.message : e), "ytdlp");
      return null;
    }
  });

  // ---- Playback: ytdlp:// scheme resolver (exact source, audio or video) ----
  api.playback.onResolveStreamByUri("ytdlp", async function (id, quality) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) { api.log("warn", "URI resolve skipped — yt-dlp not available", "ytdlp"); return null; }
    var ref = decodeRef(id);
    if (!ref) { api.log("warn", "URI resolve: bad ref " + id, "ytdlp"); return null; }
    try {
      var playable = await resolvePlayable(api, ref.url, ref.isVideo);
      return playable ? playable.url : null;
    } catch (e) {
      api.log("error", "URI resolve failed: " + (e && e.message ? e.message : e), "ytdlp");
      return null;
    }
  });

  // ---- Playback: legacy youtube:// compatibility ----
  api.playback.onResolveStreamByUri("youtube", async function (id, quality) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) return null;
    if (!YT_ID_RE.test(id)) { api.log("warn", "Legacy youtube:// resolve: bad id " + id, "ytdlp"); return null; }
    try {
      var playable = await resolvePlayable(api, youtubeWatchUrl(id), false);
      return playable ? playable.url : null;
    } catch (e) {
      api.log("error", "Legacy youtube:// resolve failed: " + (e && e.message ? e.message : e), "ytdlp");
      return null;
    }
  });

  // ---- Context menu: "Watch YouTube video" (universal track action) ----
  // Appears on every track surface (library, queue, playlists, search results,
  // similar tracks). The target carries title/artistName — no DB id needed.
  api.contextMenu.onAction("ytdlp-watch-video", function (target) {
    if (!target || !target.title) return;
    watchVideoFor(api, target.title, target.artistName || null);
  });

  // ---- Download provider: qualities ----
  api.downloads.onGetQualities("ytdlp-download", function () {
    // "Original" keeps the source stream verbatim — the best quality and the
    // right default. Lossy sources (YouTube tops out at Opus ~160k / AAC ~128k)
    // have no lossless master to recover, so the re-encode options are only for
    // users who want a uniform library format. FLAC in particular does NOT
    // improve quality: it wraps already-lossy audio in a lossless container
    // (much larger file, zero quality gain). Labels are "Type · Format — note"
    // (all the old host shows); `description` renders under the picker on newer
    // hosts. (Opus re-encode was dropped in v1.8.0 — unused.)
    var q = [{
      value: "original",
      label: "Audio · Original — keeps the source codec",
      description: "Best quality: the source audio is copied, not re-encoded, into a taggable file. The format follows the source — YouTube is usually Opus ~160k (.ogg), SoundCloud/Bandcamp MP3 128k. Tags embedded."
    }];
    if (ffmpegVersion) {
      q.push({
        value: "aac",
        label: "Audio · AAC (.m4a) — re-encode",
        description: "Re-encodes the source to AAC. Pick for maximum device compatibility; slight quality loss vs Original. Tags embedded."
      });
      q.push({
        value: "mp3",
        label: "Audio · MP3 — re-encode",
        description: "Re-encodes the source to MP3. Pick for maximum device compatibility; slight quality loss vs Original. Tags embedded."
      });
      q.push({
        value: "flac",
        label: "Audio · FLAC — lossless wrap of a lossy source",
        description: "No quality gain over Original — the source is already lossy, so FLAC only makes the file much larger. Only useful for a uniform-format library. Tags embedded."
      });
      q.push({
        value: "video",
        label: "Video · MP4 — best video + audio, merged",
        video: true,
        description: "Downloads the best video and audio streams and merges them into an .mp4."
      });
    }
    return q;
  });

  // ---- Download provider: by URI (ytdlp:// or legacy youtube://) ----
  api.downloads.onResolveByUri("ytdlp-download", async function (uri, format) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) return null;
    var url = null;
    if (uri && uri.indexOf("ytdlp://") === 0) {
      var ref = decodeRef(uri.substring("ytdlp://".length));
      if (ref) { url = ref.url; if (ref.isVideo && !format) format = "video"; }
    } else if (uri && uri.indexOf("youtube://") === 0) {
      var yid = uri.substring("youtube://".length);
      if (YT_ID_RE.test(yid)) url = youtubeWatchUrl(yid);
    }
    if (!url) { api.log("warn", "Download URI resolve: unrecognized uri " + uri, "ytdlp"); return null; }
    // No authoritative caller metadata for a bare URI — use yt-dlp's own (best).
    // Failures PROPAGATE with a user-facing reason (bot check, region lock, …)
    // so the host download modal shows the real cause; nothing else can serve
    // a ytdlp:// URI anyway.
    try { return await resolveDownload(api, url, format, null); }
    catch (e) { console.error("[ytdlp] download URI resolve failed:", e, e.stack || ""); throw e; }
  });

  // ---- Download provider: by metadata (stream-resolver-win fallback path) ----
  api.downloads.onResolveByMetadata("ytdlp-download", async function (title, artistName, albumName, durationSecs, format) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) return null;
    title = stripRemasterSuffix(title);
    try {
      var cand = await searchByMetadata(api, title, artistName, durationSecs);
      if (!cand) return null;
      // The host's metadata is authoritative here (a real library track).
      return await resolveDownload(api, cand.url, format, { title: title, artist: artistName, album: albumName });
    } catch (e) { console.error("[ytdlp] download resolve failed:", e, e.stack || ""); return null; }
  });

  // ---- Download provider: interactive (download modal manual search) ----
  api.downloads.onInteractiveSearch("ytdlp-download", async function (query, limit) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) return [];
    // The modal's manual search is free text; the prefix-less "Link" tab can't
    // serve that, so fall back to the (always real) fallback search source.
    var isearchSource = searchSource === "link" ? resolverSource : searchSource;
    var candidates = await runSearch(api, isearchSource, query, limit || 10);
    var out = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i], parsed = parseTrackTitle(c.title, c.uploader);
      out.push({
        id: encodeRef(c.url, false), // audio identity; video handled via the sidebar
        title: parsed.title || c.title || c.url,
        artistName: parsed.artist || c.uploader || undefined,
        durationSecs: c.durationSecs != null ? c.durationSecs : undefined,
        coverUrl: thumbFor(c.url, c.thumbnail)
      });
    }
    return out;
  });

  api.downloads.onInteractiveResolve("ytdlp-download", async function (matchId, format) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) throw new Error("yt-dlp not available");
    var url = null;
    if (matchId && matchId.indexOf("ytdlp://") === 0) {
      var ref = decodeRef(matchId.substring("ytdlp://".length));
      if (ref) { url = ref.url; if (ref.isVideo && !format) format = "video"; }
    } else if (matchId && matchId.indexOf("youtube://") === 0) {
      var yid = matchId.substring("youtube://".length);
      if (YT_ID_RE.test(yid)) url = youtubeWatchUrl(yid);
    } else if (isHttpUrl(matchId)) {
      url = matchId;
    }
    if (!url) throw new Error("Invalid yt-dlp match id: " + matchId);
    var result = await resolveDownload(api, url, format, null);
    if (!result) throw new Error("Failed to download " + url);
    return result;
  });

  // ---- Sidebar search view ----
  api.ui.onAction("ytdlp-source", function (data) {
    // The `tabs` control dispatches { tabId }, not { value } (that's `select`).
    var s = data && (data.tabId || data.value);
    if (s && SOURCES[s]) { searchSource = s; api.storage.set("searchSource", s); renderSearchView(api); }
  });

  api.ui.onAction("ytdlp-search-submit", async function (data) {
    // Click while THIS tab's search is running = cancel. A search started from
    // another tab is just superseded by the new one (generation bump below).
    if (searching && searchingSource === searchSource) {
      searchGen++; searching = false; searchingSource = null; renderSearchView(api); return;
    }
    var source = searchSource;
    var st = stateFor(source);
    st.query = data && typeof data.query === "string" ? data.query : "";
    if (!st.query.trim()) { st.results = null; st.meta = null; renderSearchView(api); return; }
    await ensureToolStatus(api);
    if (!ytDlpVersion) { renderSearchView(api); return; }
    var gen = ++searchGen;
    searching = true; searchingSource = source; renderSearchView(api);
    try {
      var full = await runSearchFull(api, source, st.query, 25);
      if (gen !== searchGen) return; // cancelled/superseded
      st.results = full.candidates;
      st.meta = full.meta;
    } catch (e) {
      if (gen !== searchGen) return;
      api.log("error", "Search failed: " + (e && e.message ? e.message : e), "ytdlp");
      st.results = []; st.meta = null;
    }
    searching = false; searchingSource = null; renderSearchView(api);
  });

  function findResult(refId) {
    var results = stateFor(searchSource).results;
    if (!results) return null;
    for (var i = 0; i < results.length; i++) {
      if (encodeRef(results[i].url, false) === refId || results[i].url === refId) return results[i];
    }
    return null;
  }
  function selectedResults(data) {
    var ids = data && data.selectedIds ? data.selectedIds : [], out = [];
    for (var i = 0; i < ids.length; i++) { var c = findResult(ids[i]); if (c) out.push(c); }
    return out;
  }

  // Play / Queue / row-click all default to AUDIO (this is a music app). "Watch"
  // is the explicit per-selection video action (theater view). Downloads are
  // audio by default too — the download modal's quality picker offers Video (MP4)
  // for anyone who wants the video file, so no separate video-download action.
  api.ui.onAction("ytdlp-play", function (data) {
    var chosen = selectedResults(data);
    if (chosen.length === 0 || !ytDlpVersion) return;
    var tracks = [];
    for (var i = 0; i < chosen.length; i++) tracks.push(buildTrack(chosen[i], false));
    api.playback.playTracks(tracks, 0);
  });
  api.ui.onAction("ytdlp-queue", function (data) {
    var chosen = selectedResults(data);
    if (chosen.length === 0 || !ytDlpVersion) return;
    var tracks = [];
    for (var i = 0; i < chosen.length; i++) tracks.push(buildTrack(chosen[i], false));
    api.playback.insertTracks(tracks, -1);
  });
  api.ui.onAction("ytdlp-watch", function (data) {
    var chosen = selectedResults(data);
    if (chosen.length === 0 || !ytDlpVersion) return;
    var tracks = [];
    for (var i = 0; i < chosen.length; i++) tracks.push(buildTrack(chosen[i], true));
    api.playback.playTracks(tracks, 0);
  });
  api.ui.onAction("ytdlp-queue-video", function (data) {
    var chosen = selectedResults(data);
    if (chosen.length === 0 || !ytDlpVersion) return;
    var tracks = [];
    for (var i = 0; i < chosen.length; i++) tracks.push(buildTrack(chosen[i], true));
    api.playback.insertTracks(tracks, -1);
  });
  api.ui.onAction("ytdlp-play-one", function (data) {
    var id = data && data.itemId;
    if (!id || !ytDlpVersion) return;
    var c = findResult(id);
    if (c) api.playback.playTracks([buildTrack(c, false)], 0);
  });
  api.ui.onAction("ytdlp-download", function (data) {
    var chosen = selectedResults(data);
    if (chosen.length === 0) return;
    if (!ytDlpVersion) { api.ui.showNotification("yt-dlp isn't installed — see Settings → Dependencies."); return; }
    var tracks = [];
    for (var i = 0; i < chosen.length; i++) {
      var t = buildTrack(chosen[i], false); // audio ref; modal offers Video (MP4)
      tracks.push({ title: t.title, artist_name: t.artist_name, album_title: null, uri: t.path, durationSecs: t.duration_secs });
    }
    api.ui.requestAction("download-tracks", { providerId: "ytdlp:ytdlp-download", providerName: "yt-dlp", tracks: tracks });
  });

  // ---- Link tab: whole-playlist actions (the header toolbar) ----
  function linkAllTracks() {
    var st = tabState.link;
    if (!st || !st.results) return [];
    var tracks = [];
    for (var i = 0; i < st.results.length; i++) tracks.push(buildTrack(st.results[i], false));
    return tracks;
  }
  api.ui.onAction("ytdlp-link-play-all", function () {
    var tracks = linkAllTracks();
    if (tracks.length === 0 || !ytDlpVersion) return;
    var st = tabState.link;
    // Playlist context gives the queue panel its banner (name + cover).
    var ctx = { name: (st.meta && st.meta.title) || "Fetched link", source: "playlist" };
    if (tracks[0].image_url) ctx.coverUrl = tracks[0].image_url;
    api.playback.playTracks(tracks, 0, ctx);
  });
  api.ui.onAction("ytdlp-link-queue-all", function () {
    var tracks = linkAllTracks();
    if (tracks.length === 0 || !ytDlpVersion) return;
    api.playback.insertTracks(tracks, -1);
  });

  // ---- Settings ----
  api.ui.onAction("ytdlp-cache-size", async function (data) {
    var v = parseInt(typeof data === "string" ? data : data && data.value, 10);
    if (isNaN(v) || v < 0) return;
    cacheMaxMb = v; await api.storage.set("cacheMaxMb", v); renderSettings(api);
    scheduleCleanup(api).catch(console.error);
  });
  api.ui.onAction("ytdlp-playback-mode", async function (data) {
    var v = data && data.value;
    if (v !== "stream" && v !== "download") return;
    playbackMode = v; await api.storage.set("playbackMode", v); renderSettings(api);
  });
  api.ui.onAction("ytdlp-resolver-source", async function (data) {
    var v = data && data.value;
    if (!v || !SOURCES[v]) return;
    resolverSource = v; await api.storage.set("resolverSource", v); renderSettings(api);
  });

  renderSettings(api);
  renderSearchView(api);

  // Populate dependency status AFTER activation (next tick), never during it.
  setTimeout(function () {
    ensureToolStatus(api).then(function () { renderSettings(api); renderSearchView(api); });
  }, 0);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function makeMissingDepNote() {
  if (!statusLoaded || ytDlpVersion) return null;
  return { type: "text", className: "ds-banner ds-banner--error",
    content: "yt-dlp isn't installed. Install it from Settings → Dependencies to search, play or download." };
}

function renderSearchView(api) {
  var children = [];
  var note = makeMissingDepNote();
  if (note) children.push(note);

  // Source tabs (which extractor the search box queries).
  var sourceTabs = [];
  for (var i = 0; i < SOURCE_ORDER.length; i++) {
    var k = SOURCE_ORDER[i];
    sourceTabs.push({ id: k, label: SOURCES[k].label });
  }
  children.push({ type: "tabs", tabs: sourceTabs, activeTab: searchSource, action: "ytdlp-source" });

  var st = stateFor(searchSource);
  var isLink = searchSource === "link";
  var busy = searching && searchingSource === searchSource;
  children.push({
    type: "search-input",
    placeholder: isLink
      ? "Paste a link — a video, playlist, album or set…"
      : "Search " + (SOURCES[searchSource] ? SOURCES[searchSource].label : "") + ", or paste a URL…",
    action: "ytdlp-search-submit",
    value: st.query,
    // Newer hosts keep each tab's typed text separate (stateKey) and offer a
    // one-click paste-and-fetch button on the Link tab; older hosts ignore both.
    stateKey: searchSource,
    pasteButton: isLink,
    buttonLabel: busy ? "Cancel" : (isLink ? "Fetch" : "Search")
  });

  var results = st.results;
  var isPlaylist = !busy && isLink && results != null && results.length > 1;
  if (isPlaylist) {
    // Playlist header — a leading toolbar node, so the host hoists it into the
    // sticky area next to the tabs/search box. Title + TRUE count (playlist_count
    // when yt-dlp reports one), and whole-list actions that don't require a
    // selection. Play all passes playlist context so the queue shows its banner.
    var total = (st.meta && st.meta.count) || results.length;
    children.push({
      type: "toolbar",
      title: ((st.meta && st.meta.title) || "Fetched link") + " · " + total + " tracks",
      buttons: [
        { label: "Play all", action: "ytdlp-link-play-all", variant: "accent", icon: "▶" },
        { label: "Queue all", action: "ytdlp-link-queue-all", icon: "+" }
      ]
    });
  }

  if (busy) {
    children.push({ type: "loading", message: isLink ? "Fetching…" : "Searching…" });
  } else if (results && results.length > 0) {
    if (isLink && results.length >= LINK_MAX) {
      var of = st.meta && st.meta.count && st.meta.count > results.length ? " of " + st.meta.count : "";
      children.push({ type: "text",
        content: "Showing the first " + LINK_MAX + of + " tracks from this link.",
        className: "ds-empty" });
    }
    var items = [];
    for (var j = 0; j < results.length; j++) {
      var c = results[j], parsed = parseTrackTitle(c.title, c.uploader);
      var artist = parsed.artist || c.uploader || "";
      items.push({
        id: encodeRef(c.url, false),
        title: parsed.title || c.title || c.url,
        subtitle: artist,
        duration: formatDuration(c.durationSecs),
        imageUrl: thumbFor(c.url, c.thumbnail),
        action: "ytdlp-play-one",
        // Carry the audio ref + metadata so the host builds a native right-click
        // menu (Play / Enqueue / Play Next), resolves artwork by name, and allows
        // drag-to-queue — all without a DB id.
        path: encodeRef(c.url, false),
        artistName: artist || null,
        durationSecs: c.durationSecs != null ? c.durationSecs : null
      });
    }
    children.push({
      type: "track-row-list",
      selectable: true,
      // Fetched playlists keep their source order — number the rows like an album.
      numbered: isPlaylist,
      items: items,
      actions: [
        { id: "ytdlp-play", label: "Play", icon: "▶" },
        { id: "ytdlp-queue", label: "Queue", icon: "+" },
        { id: "ytdlp-watch", label: "Watch", icon: "🎬" },
        { id: "ytdlp-queue-video", label: "Queue video", icon: "📼" },
        { id: "ytdlp-download", label: "Download", icon: "⬇" }
      ]
    });
  } else if (results && results.length === 0) {
    children.push({ type: "text",
      content: (isLink && st.query && !isHttpUrl(st.query))
        ? "That doesn't look like a link — paste a full URL starting with http(s)://."
        : "No results.",
      className: "ds-empty" });
  } else {
    children.push({ type: "text",
      content: isLink
        ? "Paste a link to a video, playlist, album or set. The tracks appear here to play, queue or download."
        : "Search or paste a link. Play/Queue listen as audio; Watch opens the video; Download lets you pick the format (incl. MP4).",
      className: "ds-empty" });
  }

  api.ui.setViewData("ytdlp-search", { type: "layout", direction: "vertical", children: children }, { scrollKey: searchSource });
}

function renderSettings(api) {
  api.ui.setViewData("ytdlp-settings", {
    type: "layout", direction: "vertical", children: [
      {
        type: "section", title: "Playback", children: [{
          type: "settings-row",
          label: "Playback mode",
          description: playbackMode === "stream"
            ? "Stream directly when possible, downloading only as a fallback (faster start)."
            : "Always download before playing (most reliable).",
          control: {
            type: "select", action: "ytdlp-playback-mode", value: playbackMode,
            options: [
              { value: "stream", label: "Stream (hybrid)" },
              { value: "download", label: "Download then play" }
            ]
          }
        }]
      },
      {
        type: "section", title: "Fallback resolver", children: [{
          type: "settings-row",
          label: "Search source",
          description: "Where to find a track that has no direct source of its own — e.g. a track played from Spotify, or a library track missing on disk. Used for both playback and download.",
          control: {
            type: "select", action: "ytdlp-resolver-source", value: resolverSource,
            options: [
              { value: "youtube", label: "YouTube (recommended)" },
              { value: "soundcloud", label: "SoundCloud" }
            ]
          }
        }]
      },
      {
        type: "section", title: "Cache", children: [{
          type: "settings-row",
          label: "Cache size limit",
          description: cacheMaxMb === 0 ? "Only the current track is kept on disk" : cacheMaxMb + " MB",
          control: {
            type: "select", action: "ytdlp-cache-size", value: String(cacheMaxMb),
            options: [
              { value: "0", label: "Off (no caching)" },
              { value: "50", label: "50 MB" },
              { value: "100", label: "100 MB" },
              { value: "200", label: "200 MB" },
              { value: "500", label: "500 MB" },
              { value: "1000", label: "1 GB" }
            ]
          }
        }]
      }
    ]
  });
}

function deactivate() {
  ytDlpVersion = null; ffmpegVersion = null; statusLoaded = false;
  inFlightFiles = {}; lastSourceFile = null;
  tabState = {}; searching = false; searchingSource = null; searchGen = 0;
  botGateNotified = false;
}

return {
  activate: activate,
  deactivate: deactivate,
  // Exposed for the test harness.
  _parseTrackTitle: parseTrackTitle,
  _formatDuration: formatDuration,
  _encodeRef: encodeRef,
  _decodeRef: decodeRef,
  _cacheStem: cacheStem,
  _buildDownloadArgs: buildDownloadArgs,
  _parseMetadataLine: parseMetadataLine,
  _thumbFor: thumbFor,
  _parseSearchOutput: parseSearchOutput,
  _decodeHtmlEntities: decodeHtmlEntities,
  _classifyYtdlpError: classifyYtdlpError,
  _isOlderVersion: isOlderVersion,
  _pickHlsMaster: pickHlsMaster,
  _dropSoundcloudPreviews: dropSoundcloudPreviews,
  _loadToolStatus: loadToolStatus
};
