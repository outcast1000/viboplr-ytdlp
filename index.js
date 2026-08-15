// viboplr-ytdlp — play & download audio and video from YouTube, SoundCloud,
// Bandcamp, Vimeo and 1000+ other sites via yt-dlp. Replaces the YouTube plugin.
//
// Design notes:
//  - Dependency detection is the HOST's job. We only READ cached status via
//    api.system.getDependency (never probe --version, never check releases). The
//    host surfaces missing/updatable yt-dlp/ffmpeg (sidebar dot + Settings →
//    Dependencies). We just gate our work on what it reports.
//  - Playback is HYBRID: try a direct stream URL (one `yt-dlp` extraction that
//    prints the url AND its http_headers) or download then play. A setting
//    forces download-only for maximum reliability.
//  - Cache filenames come from a deterministic hash of the source and temp names
//    from a monotonic counter — so the same source always maps to the same file
//    and a re-run can find it. (Date and Math ARE in the sandbox; this is a
//    determinism choice, not a missing global. Expiry logic does use Date.now.)

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
// Max video height (px) for hi-res streaming + the default video download. 0 =
// best available (no cap). Streaming a video-only + audio-only pair only happens
// on the native mpv engine (which merges them); the browser engine still gets a
// muxed stream regardless. 1080 by default to avoid pulling 4K by surprise.
var maxVideoHeight = 1080;
// When on, each sidebar search result shows its ranking score breakdown
// (relevance position, view boost, final score) so you can see WHY a result
// landed where it did — and why the automated pick (Watch / playback fallback,
// same pipeline) chose what it chose. Off by default; persisted.
var debugScoring = false;
// Debug: the most recent AUTOMATED resolve (playback/download fallback or the
// "Watch YouTube video" action). Captured so the sidebar can show which
// candidate the resolver picked, and the alternatives it scored, right when a
// track is resolved. Only populated while debugScoring is on. Cleared on
// deactivate. Shape: { kind, query, source, target, candidates, chosen }.
var lastResolve = null;

// The two tunable scoring profiles that drive which candidate a RESOLVE picks
// (audio playback/download fallback vs. "Watch"/preferVideo). Seeded from the
// defaults, overwritten by stored values on activate. See "Scoring profiles".
var scoringAudio = null;  // lazily set to defaultProfile("audio") on activate
var scoringVideo = null;  // lazily set to defaultProfile("video") on activate
// Debug-only tabs (visible only while debugScoring is on), each swapping the
// search UI within the same sidebar item (no extra sidebar entries). At most one
// is open at a time; selecting a real source tab closes both.
//   tuneOpen    — the live scoring-profile tuner
//   resolveOpen — the "Last resolve" readout (what the last automated pick scored)
var resolveOpen = false;
// Tuning tab: the profile being edited, the query/target-duration inputs, and
// the last raw fetch it ranked (kept so editing a param re-ranks WITHOUT
// re-fetching).
var tuneOpen = false;
var tuneProfile = "audio"; // "audio" | "video"
var tuneQuery = "";
var tuneTarget = null;     // target duration (secs) or null
var tuneResults = null;    // raw candidates from the last Run (null before first)
var tuneBusy = false;
// Raw typed text for the numeric inputs, so a live re-render hands each input
// back exactly what was typed (partial values like "-" or "1." survive) while
// the parsed number drives the profile. Cleared on reset / profile switch.
var tuneParamText = {};    // param key -> raw string
var tuneTargetRaw = null;  // raw target-duration string (null = derive from tuneTarget)

// Shared resolution choices, used for BOTH the streaming cap (Settings) and the
// video download quality options. Order is best → lower (the first is default).
var VIDEO_RESOLUTIONS = [
  { height: 0, label: "Best available" },
  { height: 2160, label: "4K · 2160p" },
  { height: 1080, label: "1080p" },
  { height: 720, label: "720p" },
  { height: 480, label: "480p" }
];

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

// View count -> compact "1.5B views" / "16M views" / "573K views" / "42 views".
// Floors like YouTube (1 decimal below 10 of a unit, whole above). Returns ""
// for null/NaN/negative. Pure; exported for tests.
function formatViews(n) {
  if (n == null || isNaN(n) || n < 0) return "";
  function unit(x) {
    var v = x < 10 ? Math.floor(x * 10) / 10 : Math.floor(x);
    return String(v);
  }
  if (n >= 1e9) return unit(n / 1e9) + "B views";
  if (n >= 1e6) return unit(n / 1e6) + "M views";
  if (n >= 1e3) return unit(n / 1e3) + "K views";
  return n + (n === 1 ? " view" : " views");
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
  // "available in your country", not "not available in your country": yt-dlp's
  // actual geo-block wording is "The uploader has not made this video available
  // in your country", where the negation is nowhere near the phrase.
  if (/video unavailable|private video|has been removed|geo.?restricted|available in your country/i.test(s)) {
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
//
// This is a SECOND full extraction, so who waits for it differs by caller. A
// download is one deliberate action with a user watching a modal: it awaits,
// because the answer is the point. Playback is automatic and repeats per track:
// it goes through maybeDeepDiagnostics below, which neither waits nor repeats.
// ---------------------------------------------------------------------------
async function logExtractionDiagnostics(api, url) {
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

// Which stream failures a deep probe can actually explain. A bot gate, a removed
// or private video and a login wall already say exactly what they are, and
// re-running the extraction verbosely would add a request to a source that is
// already refusing us to learn nothing. The ambiguous ones — a 403, a missing
// format, or an exit 0 that produced no URL — are precisely where a PO-token /
// SABR gate hides, and they are what this probe exists to name.
// Pure; exported for tests.
function warrantsDeepDiagnostics(stderr) {
  var s = stderr || "";
  if (/sign in to confirm|account authentication is required|--cookies/i.test(s)) return false;
  if (/video unavailable|private video|has been removed|geo.?restricted|available in your country/i.test(s)) return false;
  return true;
}

// Deep diagnostics for a FAILED playback resolve. Two deliberate restraints,
// because unlike a download this runs by itself and once per track:
//
//  - Not awaited. The host has already given up on us and moved to the next
//    resolver in its chain; blocking that fallback for seconds to produce a log
//    line nobody is waiting on would turn a diagnostic into a stall.
//  - Once per session. A bot gate or an offline network fails every track, and
//    a probe per failure would mean dozens of extra extractions aimed at a
//    source that is already rate-limiting us — making the problem worse while
//    logging the same paragraph each time. The first one has the answer.
//
// Settings → Debug's on-demand report is the way to get a fresh one after this.
var deepDiagnosticsRun = false;
function maybeDeepDiagnostics(api, url, stderr) {
  if (deepDiagnosticsRun || !warrantsDeepDiagnostics(stderr)) return;
  deepDiagnosticsRun = true;
  api.log("info", "Probing why the stream failed (once per session) — " + url, "ytdlp");
  logExtractionDiagnostics(api, url).catch(function (e) {
    api.log("warn", "Stream diagnostics probe failed: " + (e && e.message ? e.message : e), "ytdlp");
  });
}

// ---------------------------------------------------------------------------
// Caches — resolved stream URLs and search results
// ---------------------------------------------------------------------------
// These exist to cut yt-dlp INVOCATIONS, not just milliseconds. Every extraction
// is an API request to the source, and YouTube rate-gates a device that makes
// too many of them ("Sign in to confirm you're not a bot"), after which nothing
// resolves until it lifts. So a hit is worth more than the seconds it saves.
//
// Measured: yt-dlp costs ~360ms to boot before doing any work; a search is
// ~1.5s and a resolve ~1.8s, so playing a track found by metadata is ~3.2s
// across two processes. Forcing a single `player_client` was tried and is NOT a
// win — yt-dlp already picks the fastest (android_vr) and only tries one.
//
// Deliberately in MEMORY rather than plugin storage. A signed media URL is bound
// to the IP that minted it (`ip=` is in the query string), so one persisted
// across a restart could be handed to a different network and 403 — and the
// plugin is never told about a playback failure, so it could not self-correct.
// A restart is a free and honest invalidation point.

var CACHE_MAX_ENTRIES = 200;

// Pure: the live value for `key`, or null when absent or aged out. Expired
// entries are dropped on read; there is no sweeper, because an entry nobody
// looks up costs nothing but a little memory the cap already bounds.
// Exported for tests.
function cacheGet(store, key, now) {
  var e = store[key];
  if (!e) return null;
  if (now >= e.expiresAt) { delete store[key]; return null; }
  return e.value;
}

// Insert, then evict the SOONEST-TO-EXPIRE entries past `max` — not the oldest
// inserted. The entries worth keeping are the ones with the most life left,
// which is what a re-play or a repeated search is most likely to want.
// Exported for tests.
function cachePut(store, key, value, expiresAt, max) {
  store[key] = { value: value, expiresAt: expiresAt };
  var cap = max || CACHE_MAX_ENTRIES;
  var keys = Object.keys(store);
  if (keys.length <= cap) return;
  keys.sort(function (a, b) { return store[a].expiresAt - store[b].expiresAt; });
  for (var i = 0; i < keys.length - cap; i++) delete store[keys[i]];
}

// A signed URL carries its own deadline in the query string (`expire`, in unix
// seconds — YouTube's observed window is 6 hours). Trust it, but never serve one
// with less than this margin left: a track runs for minutes and the engine
// re-requests ranges as it plays and seeks, so a URL that dies mid-song is a
// worse outcome than one extra extraction.
var STREAM_URL_EXPIRY_MARGIN_MS = 15 * 60 * 1000;
// Hard ceiling regardless of what the URL claims, and the whole TTL for sources
// that publish no `expire` at all. Bounds how long a cached URL can outlive the
// network change that invalidated it.
var STREAM_URL_MAX_AGE_MS = 30 * 60 * 1000;

// Pure: when a resolved URL stops being safe to reuse, in epoch ms — or null if
// it is already too close to its own deadline to be worth caching.
// Exported for tests.
function streamUrlExpiry(url, now) {
  var ceiling = now + STREAM_URL_MAX_AGE_MS;
  var m = /[?&]expire=(\d+)/.exec(url || "");
  if (!m) return ceiling;
  var signed = parseInt(m[1], 10) * 1000 - STREAM_URL_EXPIRY_MARGIN_MS;
  if (!isFinite(signed)) return ceiling;
  if (signed <= now) return null;
  return signed < ceiling ? signed : ceiling;
}

// Search results move slowly, and a user re-runs the same query constantly —
// retyping, going back, reopening the view. Short enough that a new upload
// surfaces soon; long enough to cover a session's worth of navigation.
var SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;

var streamUrlCache = {};
var searchCache = {};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
// Run a search (or resolve a pasted URL) and return candidates:
// [{ url, title, uploader, durationSecs, thumbnail }]. Returns [] on failure.
// View-boost reranked (the sidebar/interactive-search order).
async function runSearch(api, source, query, count) {
  return (await runSearchFull(api, source, query, count)).candidates;
}

// Raw variant: candidates in yt-dlp's own relevance order (NO view rerank), so a
// profile can score them off the true relevance position. Used by the resolve
// paths and the Tuning tab, which do their own ranking.
async function runSearchRaw(api, source, query, count) {
  return (await runSearchFull(api, source, query, count, { rank: "none" })).candidates;
}

// Full variant: also returns `meta` — the fetched playlist's { title, count }
// for a pasted URL, null for plain searches and single videos. The sidebar
// Link tab uses it for its playlist header; every other caller goes through
// runSearch and ignores it.
async function runSearchFull(api, source, query, count, opts) {
  var none = { candidates: [], meta: null };
  var q = (query || "").trim();
  if (!q) return none;
  var n = count || 25;
  var target;
  var isUrl = isHttpUrl(q);
  // `rank` is in the key because it changes the ORDER of what we return, and a
  // caller that ranks itself (the resolve paths, the Tuning tab) must not be
  // handed the view-boosted order from a sidebar search of the same words.
  // JSON rather than a joined string: no separator can collide with a query
  // that happens to contain it.
  var cacheKey = JSON.stringify([source, q, n, (opts && opts.rank) || "views"]);
  var cached = cacheGet(searchCache, cacheKey, Date.now());
  if (cached) {
    api.log("info", "Search served from cache (" + cached.candidates.length + " result(s)): " + q, "ytdlp");
    return cloneSearchResult(cached);
  }
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
  // Comma fields = first non-null. thumbnail + view_count are best-effort
  // (view_count is "NA" on sources/entries that don't report it — SoundCloud
  // flat search, most non-YouTube sites). URL fetches also carry the playlist's
  // title/count (NA for a single video) so the Link tab can name what it fetched
  // and show how much the -I cap hid. Keep view_count BEFORE the playlist fields
  // so its column index is stable whether or not they're appended.
  var printFields = "%(url,webpage_url)s\t%(duration)s\t%(uploader,channel,uploader_id)s\t%(title)s\t%(thumbnail)s\t%(view_count)s";
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
  var candidates = dropSoundcloudPreviews(parsed.candidates, source, isUrl, api);
  // Promote high-view results for real searches (official music videos usually
  // dwarf covers/lyric re-uploads in views). A pasted URL / playlist keeps its
  // source order untouched, and callers that rank themselves (resolve paths,
  // Tuning tab) pass rank: "none" to get the raw relevance order.
  if (!isUrl && !(opts && opts.rank === "none")) candidates = rerankByViews(candidates, api);
  var result = { candidates: candidates, meta: parsed.meta };
  // Only cache a NON-EMPTY result. Every failure above returns `none`, and a bot
  // gate makes every search empty — caching that would pin the outage in place
  // for the whole TTL and make a retry pointless, which is exactly when a user
  // retries most.
  if (candidates.length) cachePut(searchCache, cacheKey, result, Date.now() + SEARCH_CACHE_TTL_MS, CACHE_MAX_ENTRIES);
  return cloneSearchResult(result);
}

// Hand every caller its OWN candidate objects. `rankByProfile` stamps
// `_profileScore` onto each one and the sidebar keeps results in view state, so
// sharing the cached objects would let one caller's ranking show up in another's
// list — and let the view mutate what the cache hands out next.
// Pure; exported for tests.
function cloneSearchResult(result) {
  return {
    candidates: (result.candidates || []).map(function (c) { return Object.assign({}, c); }),
    meta: result.meta,
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
    var viewsRaw = cols[5];
    var views = viewsRaw && viewsRaw !== "NA" ? parseInt(viewsRaw, 10) : NaN;
    out.push({
      url: url, title: title, uploader: uploader,
      durationSecs: isNaN(dur) ? null : dur,
      thumbnail: thumb, views: isNaN(views) ? null : views
    });
    if (withPlaylistFields && !meta) {
      var pTitle = cols[6] && cols[6] !== "NA" ? decodeHtmlEntities(cols[6]) : null;
      var pCount = cols[7] && cols[7] !== "NA" ? parseInt(cols[7], 10) : NaN;
      if (pTitle || !isNaN(pCount)) meta = { title: pTitle, count: isNaN(pCount) ? null : pCount };
    }
  }
  return { candidates: out, meta: meta };
}

// Re-rank search candidates so popular results (usually the official music
// video) surface, WITHOUT throwing away yt-dlp's relevance ordering. Each
// candidate keeps its relevance position `rel` (0 = top); we add a boost that
// grows with log10(views), so an order-of-magnitude more views is worth about
// VIEW_WEIGHT relevance positions. That lets a runaway view lead (an official
// video with 100–1000× the views of a cover) climb several spots, while a
// modest view edge barely moves anything — "a bit more", not a pure view sort.
// Unknown/zero views contribute no boost (they sink toward their relevance
// spot). No-op unless at least two candidates report a positive view count, so
// sources that don't expose views (SoundCloud flat search) keep source order.
// Stable on ties (falls back to relevance). Pure; exported for tests.
var VIEW_WEIGHT = 1.5;

// Compute the ranking score breakdown for each candidate, in the SAME order as
// the input (i.e. yt-dlp's own relevance order). Returns a parallel array of
// { rel, views, viewBoost, score, viewsActive }:
//   - rel        the 0-based relevance position (yt-dlp's order; the tie-break)
//   - views      the view count used (0 when unknown/zero)
//   - viewBoost  VIEW_WEIGHT · log10(views+1), or 0 when views aren't in play
//   - score      -rel + viewBoost  (higher = better)
//   - viewsActive false when fewer than two candidates report a positive view
//                 count — then every viewBoost is 0, so sorting by score is a
//                 no-op and source order is preserved.
// This is the single source of truth for ranking: rerankByViews sorts by it,
// and the debug UI displays it. Pure; exported for tests.
function scoreCandidates(candidates) {
  var list = candidates || [];
  var withViews = 0;
  for (var k = 0; k < list.length; k++) {
    if (list[k] && list[k].views != null && list[k].views > 0) withViews++;
  }
  var viewsActive = withViews >= 2;
  return list.map(function (c, i) {
    var v = c && c.views != null && c.views > 0 ? c.views : 0;
    var viewBoost = viewsActive ? VIEW_WEIGHT * Math.log(v + 1) / Math.LN10 : 0;
    return { rel: i, views: v, viewBoost: viewBoost, score: -i + viewBoost, viewsActive: viewsActive };
  });
}

function rerankByViews(candidates, api) {
  if (!candidates || candidates.length < 2) return candidates || [];
  var breakdowns = scoreCandidates(candidates);
  // Stamp each candidate with its breakdown so the debug UI can show it even
  // after reordering (the pre-rerank position survives as _score.rel).
  for (var i = 0; i < candidates.length; i++) candidates[i]._score = breakdowns[i];
  // No-op when views aren't in play (SoundCloud flat search, etc.): keep the
  // source array + order untouched so callers relying on identity still see it.
  if (!breakdowns[0].viewsActive) return candidates;
  var scored = candidates.map(function (c, idx) { return { c: c, rel: idx, score: breakdowns[idx].score }; });
  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.rel - b.rel; // deterministic tie-break: keep relevance order
  });
  var reordered = scored.map(function (s) { return s.c; });
  if (api && reordered[0] !== candidates[0]) {
    api.log("info", "Re-ranked search by views: top is now \"" +
      (reordered[0].title || reordered[0].url) + "\" (" + (reordered[0].views || 0) + " views)", "ytdlp");
  }
  return reordered;
}

// Compact one-line score breakdown for a candidate at final display position
// `pos`, for the debug UI. "" when the candidate carries no score (link fetches
// / playlists keep source order and aren't scored). Pure; exported for tests.
function formatScoreDebug(c, pos) {
  var s = c && c._score;
  if (!s) return "";
  var parts = ["#" + (pos + 1)];
  if (s.rel !== pos) parts.push("was #" + (s.rel + 1)); // moved by the view rerank
  parts.push("score " + s.score.toFixed(2));
  if (s.viewsActive) {
    if (s.viewBoost > 0) parts.push("boost +" + s.viewBoost.toFixed(2));
  } else {
    parts.push("no view data");
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Scoring profiles (audio vs video track-finding)
// ---------------------------------------------------------------------------
// When RESOLVING a track (playback/download fallback, "Watch YouTube video",
// preferVideo streaming) we pick ONE candidate out of a yt-dlp search. The right
// pick differs by intent: for audio we want the clean official-audio / "- Topic"
// upload whose length matches the album track; for video we want the official
// music video / VEVO upload, popularity-led. So the pick is driven by one of two
// tunable PROFILES — a map of weights over signals extracted from each
// candidate's title / uploader / duration / views. The Tuning tab (visible when
// Settings → Debugging → "Show scoring in results" is on) edits these live and
// validates the resulting rank. The sidebar's own manual search is unaffected —
// it keeps its view-boost order (rerankByViews).
//
// Each param: key, human label, `type` ("weight" = continuous multiplier,
// "flag" = keyword bonus/penalty applied when the signal is present), and the
// per-profile default. Order drives the Tuning editor layout AND the debug
// breakdown order. Pure data; exported for tests.
var SCORING_PARAMS = [
  { key: "w_rel",         type: "weight", label: "Relevance weight",            audio: 1.0, video: 1.0 },
  { key: "w_views",       type: "weight", label: "Views weight",                audio: 1.0, video: 2.5 },
  { key: "w_dur",         type: "weight", label: "Duration-match weight",       audio: 5.0, video: 1.0 },
  { key: "official",      type: "flag",   label: "“official”",        audio: 1,   video: 2 },
  { key: "officialAudio", type: "flag",   label: "“official audio”",  audio: 3,   video: -2 },
  { key: "officialVideo", type: "flag",   label: "“official video” / MV", audio: -1, video: 4 },
  { key: "topic",         type: "flag",   label: "“- Topic” channel", audio: 4,   video: -4 },
  { key: "vevo",          type: "flag",   label: "VEVO channel",                audio: 1,   video: 3 },
  { key: "lyrics",        type: "flag",   label: "lyric video",                 audio: 1,   video: -2 },
  { key: "live",          type: "flag",   label: "live",                        audio: -4,  video: -1 },
  { key: "cover",         type: "flag",   label: "cover",                       audio: -3,  video: -3 },
  { key: "remix",         type: "flag",   label: "remix",                       audio: -2,  video: -1 },
  { key: "instrumental",  type: "flag",   label: "instrumental",                audio: -3,  video: -2 },
  { key: "effects",       type: "flag",   label: "sped up / nightcore / 8D",    audio: -4,  video: -3 }
];
// Fixed contribution order for the debug breakdown (weights first, then flags in
// param order) so the readout is deterministic regardless of object key order.
var CONTRIB_ORDER = (function () {
  var o = ["rel", "views", "dur"];
  for (var i = 0; i < SCORING_PARAMS.length; i++) {
    if (SCORING_PARAMS[i].type === "flag") o.push(SCORING_PARAMS[i].key);
  }
  return o;
})();

// A profile filled with a kind's ("audio" | "video") defaults. Pure.
function defaultProfile(kind) {
  var p = {};
  for (var i = 0; i < SCORING_PARAMS.length; i++) p[SCORING_PARAMS[i].key] = SCORING_PARAMS[i][kind];
  return p;
}
// Merge a stored profile over the kind's defaults: every known key gets the
// stored numeric value if present, else the default; unknown/NaN keys are
// dropped. So adding a new param later still yields a valid profile from old
// storage. Pure; exported for tests.
function normalizeProfile(kind, stored) {
  var p = defaultProfile(kind);
  if (stored && typeof stored === "object") {
    for (var i = 0; i < SCORING_PARAMS.length; i++) {
      var k = SCORING_PARAMS[i].key, v = stored[k];
      if (typeof v === "number" && isFinite(v)) p[k] = v;
    }
  }
  return p;
}

// Lowercase + collapse whitespace, padded with spaces so \b-free substring
// checks still see word edges. Pure.
function normForMatch(s) {
  return " " + String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim() + " ";
}

// Duration closeness in [-1, 1]: exact match = +1, decays linearly to 0 at 15s
// off and floors at -1 by 30s off (so a wildly wrong length is penalized, not
// merely un-rewarded). Neutral 0 when either duration is unknown. Pure.
function durationScore(dur, target) {
  if (target == null || target <= 0 || dur == null) return 0;
  var s = 1 - Math.abs(dur - target) / 15;
  return s > 1 ? 1 : (s < -1 ? -1 : s);
}

// Parse a target-duration input into seconds: plain seconds ("238"), "m:ss"
// ("3:58" -> 238) or "h:mm:ss". Returns null for blank/garbage. Pure; exported.
function parseDurationInput(s) {
  var str = String(s == null ? "" : s).trim();
  if (!str) return null;
  var parts = str.split(":");
  if (parts.length === 1) {
    var n = parseInt(parts[0], 10);
    return isNaN(n) || n < 0 ? null : n;
  }
  var total = 0;
  for (var i = 0; i < parts.length; i++) {
    var p = parseInt(parts[i], 10);
    if (isNaN(p) || p < 0) return null;
    total = total * 60 + p;
  }
  return total;
}

// Extract the keyword/channel signals (0/1 flags matching the SCORING_PARAMS
// "flag" keys) from a candidate. Pure; exported for tests.
function candidateSignals(c) {
  var t = normForMatch(c && c.title);
  var u = normForMatch(c && c.uploader);
  var officialVideo = /\bofficial\s+(music\s+)?video\b/.test(t) || /\bofficial\s+mv\b/.test(t) || /\bmv\b/.test(t);
  var officialAudio = /\bofficial\s+audio\b/.test(t);
  return {
    official: /\bofficial\b/.test(t) ? 1 : 0,
    officialAudio: officialAudio ? 1 : 0,
    officialVideo: officialVideo ? 1 : 0,
    topic: /-\s*topic\s*$/.test(u) ? 1 : 0,
    vevo: /vevo/.test(u) ? 1 : 0,
    lyrics: /\blyric/.test(t) ? 1 : 0,
    live: /\blive\b/.test(t) ? 1 : 0,
    cover: /\bcover\b/.test(t) ? 1 : 0,
    remix: /\bremix\b/.test(t) ? 1 : 0,
    instrumental: /\binstrumental\b/.test(t) ? 1 : 0,
    effects: /\b(sped\s*up|nightcore|8d|slowed|reverb|daycore)\b/.test(t) ? 1 : 0
  };
}

// Score one candidate under a profile. `ctx` = { rel, target }. Returns
// { score, parts, rel, views, signals } where `parts` is the per-signal
// contribution (for the debug breakdown). Pure; exported for tests.
function scoreWithProfile(c, ctx, params) {
  var rel = ctx && ctx.rel != null ? ctx.rel : 0;
  var target = ctx ? ctx.target : null;
  var views = c && c.views != null && c.views > 0 ? c.views : 0;
  var dur = c && c.durationSecs != null ? c.durationSecs : null;
  var sig = candidateSignals(c);
  var parts = {}, total = 0;
  function add(name, val) { parts[name] = val; total += val; }
  add("rel", -rel * (params.w_rel || 0));
  add("views", (params.w_views || 0) * Math.log(views + 1) / Math.LN10);
  add("dur", (params.w_dur || 0) * durationScore(dur, target));
  for (var i = 0; i < SCORING_PARAMS.length; i++) {
    var sp = SCORING_PARAMS[i];
    if (sp.type === "flag" && sig[sp.key]) add(sp.key, params[sp.key] || 0);
  }
  return { score: total, parts: parts, rel: rel, views: views, signals: sig };
}

// Rank candidates by a profile (highest score first, stable on the original
// yt-dlp relevance order). Stamps each candidate with `_profileScore` so the
// Tuning UI can show why it placed where it did. Pure (aside from the stamp);
// exported for tests.
function rankByProfile(candidates, params, target) {
  var list = candidates || [];
  var scored = list.map(function (c, i) {
    return { c: c, rel: i, res: scoreWithProfile(c, { rel: i, target: target != null ? target : null }, params) };
  });
  scored.sort(function (a, b) {
    if (b.res.score !== a.res.score) return b.res.score - a.res.score;
    return a.rel - b.rel;
  });
  return scored.map(function (s, pos) {
    s.c._profileScore = { pos: pos, rel: s.rel, score: s.res.score, parts: s.res.parts, signals: s.res.signals };
    return s.c;
  });
}

// Compact one-line profile-score breakdown for the Tuning result list. ""
// when the candidate carries no profile score. Pure; exported for tests.
function formatProfileScore(c) {
  var s = c && c._profileScore;
  if (!s) return "";
  var parts = ["#" + (s.pos + 1)];
  if (s.rel !== s.pos) parts.push("was #" + (s.rel + 1));
  parts.push("score " + s.score.toFixed(2));
  var contribs = [];
  for (var i = 0; i < CONTRIB_ORDER.length; i++) {
    var k = CONTRIB_ORDER[i], v = s.parts[k];
    if (typeof v === "number" && Math.abs(v) >= 0.005) {
      contribs.push(k + " " + (v >= 0 ? "+" : "") + v.toFixed(2));
    }
  }
  if (contribs.length) parts.push(contribs.join(" "));
  return parts.join(" · ");
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

// The active scoring profile for a kind ("audio" | "video"), falling back to the
// baked defaults if activate hasn't populated them yet.
function profileFor(kind) {
  if (kind === "video") return scoringVideo || defaultProfile("video");
  return scoringAudio || defaultProfile("audio");
}

// Capture an automated resolve for the debug panel and refresh the sidebar so
// it shows immediately. No-op (and clears any stale capture) when debug scoring
// is off, so normal playback never re-renders the view.
function recordResolve(api, info) {
  if (!debugScoring) { lastResolve = null; return; }
  lastResolve = info;
  renderSearchView(api);
}

// Shared resolve: fetch RAW candidates (yt-dlp relevance order), rank them by
// the given profile ("audio" | "video"), record the resolve for the debug panel
// and return the winner (or null). `target` is the known duration in secs (or
// null); `resolveKind` is the human label shown in the panel.
async function resolvePick(api, source, query, target, profileKind, resolveKind) {
  var candidates = await runSearchRaw(api, source, query, 7);
  var ranked = rankByProfile(candidates, profileFor(profileKind), target);
  var cand = ranked.length ? ranked[0] : null;
  if (api) {
    if (!cand) api.log("warn", "yt-dlp search parsed 0 valid candidates", "ytdlp");
    else api.log("info", ranked.length + " candidate(s); " + profileKind + " profile chose " +
      cand.url + " (score " + cand._profileScore.score.toFixed(2) + ")", "ytdlp");
  }
  recordResolve(api, {
    kind: resolveKind, query: query, source: source, profile: profileKind,
    target: target != null ? target : null, candidates: ranked, chosen: cand
  });
  return cand;
}

// Resolve a track that has no direct source of its own (played from Spotify, a
// library miss, or a metadata download) via the configurable fallback source
// (YouTube by default). `profileKind` selects the scoring profile — "audio" for
// ordinary playback/downloads, "video" when the host wants a video stream.
async function searchByMetadata(api, title, artistName, durationSecs, profileKind) {
  var query = artistName ? title + " " + artistName : title;
  return resolvePick(api, resolverSource, query,
    durationSecs != null ? durationSecs : null,
    profileKind === "video" ? "video" : "audio",
    "Playback / download fallback");
}

// Context-menu "Watch YouTube video": search YouTube by the track's metadata and
// play the top hit as a VIDEO in the theater. Always searches YouTube (the video
// source), NOT the configurable fallback resolver, and always ranks with the
// VIDEO profile. Feedback is a notification (context-menu actions have no loading
// modal); errors surface the same way and never throw.
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
    var cand = await resolvePick(api, "youtube", query, null, "video", "Watch YouTube video");
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

// Parse a download `format` value into video intent + a height cap. "video" =
// best; "video-<N>" = capped at N px; anything else = not a video download.
// Pure; exported for tests.
function parseVideoFormat(fmt) {
  if (fmt === "video") return { isVideo: true, maxHeight: 0 };
  var m = /^video-(\d+)$/.exec(fmt || "");
  if (m) return { isVideo: true, maxHeight: parseInt(m[1], 10) };
  return { isVideo: false, maxHeight: 0 };
}

// yt-dlp `-f` selector for a merged video download, optionally height-capped.
//
// Codec choice matters as much as resolution: yt-dlp's DEFAULT ranking prefers
// AV1 > VP9 > H.264 and Opus > AAC, so a bare `bestvideo*+bestaudio` merged into
// .mp4 yields AV1 video + Opus audio in an MP4 — which QuickTime, Finder/Quick
// Look and the app's own webview all refuse to decode (it opens as "an .mp4 with
// no video"). So ask for H.264 + AAC first — universally playable, and on
// YouTube available up to 1080p — and only fall back to the unconstrained best
// when the source offers no such pair. `avc1`/`mp4a` is YouTube's naming,
// `h264`/`aac` is what most other extractors report.
// Pure; exported for tests.
function videoFormatSelector(maxHeight) {
  var cap = maxHeight > 0 ? "[height<=" + maxHeight + "]" : "";
  return [
    "bestvideo*[vcodec^=avc1]" + cap + "+bestaudio[acodec^=mp4a]",
    "bestvideo*[vcodec^=h264]" + cap + "+bestaudio[acodec^=aac]",
    "bestvideo*" + cap + "+bestaudio",
    "best" + cap
  ].join("/");
}

// Containers offered to `--merge-output-format`, best-fit first. yt-dlp picks the
// first one whose codecs are actually compatible, so the fallback tiers above
// (AV1/VP9/Opus, when a source has no H.264) land in .mkv instead of being forced
// into an .mp4 that no player can open. The saved file is named from the real
// container (the host uses the resolver's `ext`), so the name never lies.
var MERGE_CONTAINERS = "mp4/mkv";

// Metadata --print template: first non-null of each comma group wins.
// track/title | artist/creator/uploader | album | release_year | title
var META_PRINT = "%(track,title)s\t%(artist,creator,uploader)s\t%(album)s\t%(release_year)s\t%(title)s";

// --- Download progress -----------------------------------------------------
// A download resolve here is not a URL lookup: it fetches the whole file (and
// for video, merges two streams through ffmpeg), which can take minutes. The
// host can only show a spinner unless we tell it what's happening, so the
// download run is asked for machine-readable progress on its own prefixed
// lines, which the stdout parse then drops. `--progress` is required because
// the run is `--quiet`; `--newline` because the default carriage-return redraw
// never completes a line.
var PROG_PREFIX = "[vbprog]";
var PROG_PP_PREFIX = "[vbprog-pp]";
var PROGRESS_ARGS = [
  "--progress", "--newline",
  "--progress-template",
  // The real total is only known once the headers land; before that (and for a
  // chunked stream) yt-dlp has an estimate, so ask for the exact size first and
  // fall back — the comma group is the output template's "first non-null wins".
  // vcodec identifies WHICH stream is downloading. A hi-res video is two
  // separate downloads (video-only, then audio-only) and each runs 0→100%, so
  // without this the bar restarts for no visible reason halfway through.
  "download:" + PROG_PREFIX + "%(progress._percent_str)s|%(progress._downloaded_bytes_str)s|"
    + "%(progress._total_bytes_str,progress._total_bytes_estimate_str)s|"
    + "%(progress._speed_str)s|%(progress.eta)s|%(info.vcodec)s",
  "--progress-template",
  "postprocess:" + PROG_PP_PREFIX + "%(progress.status)s|%(progress.postprocessor)s"
];

function isProgressLine(line) {
  var s = (line || "").trim();
  return s.indexOf(PROG_PREFIX) === 0 || s.indexOf(PROG_PP_PREFIX) === 0;
}

// Parse one progress line into the host's DownloadResolveProgress shape, or
// null when the line isn't one of ours. Pure.
//
// `isVideo` only colours the label: a video download runs the same two phases
// (fetch, then merge) and naming them is most of the value here.
function parseProgressLine(line, isVideo) {
  var s = (line || "").trim();
  if (s.indexOf(PROG_PP_PREFIX) === 0) {
    var pp = s.substring(PROG_PP_PREFIX.length).split("|");
    var name = (pp[1] || "").trim();
    if (/^(NA)?$/.test(name)) name = "";
    // No percentage exists for a merge — yt-dlp reports start/finish only, so
    // reporting a number here would be inventing one.
    return {
      percent: null,
      label: /merger/i.test(name) ? "Merging audio and video…"
        : /extractaudio|ffmpegextract/i.test(name) ? "Extracting audio…"
        : "Processing…",
      detail: null
    };
  }
  if (s.indexOf(PROG_PREFIX) !== 0) return null;
  var f = s.substring(PROG_PREFIX.length).split("|");
  // yt-dlp spells "don't know yet" three ways across these fields — a bare NA,
  // a formatted "N/A" (the _str variants), and "Unknown B/s" for speed before
  // the first sample. All three must read as absent: "1.0MiB / N/A at Unknown
  // B/s" is worse than showing nothing.
  function val(v) {
    var t = (v || "").trim();
    if (!t || /^n\/?a$/i.test(t) || /unknown/i.test(t)) return null;
    return t;
  }
  var pctStr = val(f[0]);
  var pct = pctStr ? parseFloat(pctStr.replace("%", "")) : NaN;
  var got = val(f[1]), total = val(f[2]), speed = val(f[3]);
  var etaStr = val(f[4]);
  var eta = etaStr ? parseInt(etaStr, 10) : NaN;
  var vcodec = val(f[5]);
  var detail = [got && total ? got + " / " + total : got, speed ? speed : null]
    .filter(Boolean).join(" at ");
  // vcodec "none" is the audio half of a split download; a real codec is the
  // video half. Absent (older yt-dlp, muxed stream) falls back to the caller's
  // own idea of what it asked for.
  var label = vcodec
    ? (vcodec === "none" ? "Downloading audio" : "Downloading video")
    : (isVideo ? "Downloading video" : "Downloading audio");
  return {
    percent: isFinite(pct) ? pct : null,
    label: label,
    detail: detail || null,
    etaSecs: isFinite(eta) ? eta : null
  };
}

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
    args = ["-f", videoFormatSelector(opts.maxHeight || 0), "--merge-output-format", MERGE_CONTAINERS];
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
  return args.concat(ENCODING_ARGS).concat(PROGRESS_ARGS).concat([
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
  // Forward yt-dlp's own progress to the host so the download modal shows a real
  // bar instead of an unexplained spinner. Throttled: yt-dlp emits a line per
  // downloaded block, and every one of those would be a host re-render.
  var lastReport = 0, lastPct = -1;
  var onOutput = function (line) {
    if (!api.downloads || typeof api.downloads.reportProgress !== "function") return;
    var p = parseProgressLine(line, !!opts.video);
    if (!p) return;
    var now = Date.now();
    var pct = typeof p.percent === "number" ? p.percent : -1;
    if (pct >= 0 && now - lastReport < 250 && Math.abs(pct - lastPct) < 1) return;
    lastReport = now; lastPct = pct;
    api.downloads.reportProgress(p);
  };
  var attempt = async function () {
    var args = buildDownloadArgs({ url: url, video: opts.video, audioFormat: opts.audioFormat, maxHeight: opts.maxHeight }, outDir, convSeq++, !!ffmpegVersion);
    api.log("info", "Running: " + formatCmd("yt-dlp", args), "ytdlp");
    try {
      return await api.system.exec("yt-dlp", args, { cwd: null, onOutput: onOutput });
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      // The host kills the process when the user cancels the download. That is
      // not a broken install, so it must not be reported as one — rethrow it
      // verbatim and let the host recognise its own cancellation.
      if (msg.trim() === "Cancelled") throw e;
      api.log("error", "yt-dlp download exec failed: " + msg, "ytdlp");
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
    await logExtractionDiagnostics(api, url);
    throw new Error(await withOutdatedHint(api, classifyYtdlpError(res.stderr)));
  }
  // stdout: the META_PRINT line (extraction time), then the after_move
  // filepath line. Anything that doesn't end in an absolute path means no
  // file actually landed. Progress lines share this stream, so they are
  // dropped first — otherwise the metadata line is no longer the first one.
  var lines = (res.stdout || "").split("\n").filter(function (l) {
    return l.trim() && !isProgressLine(l);
  });
  var last = lines.length ? lines[lines.length - 1].trim() : "";
  if (!looksLikePath(last)) {
    api.log("warn", "yt-dlp returned no file path — likely SABR/PO-token", "ytdlp");
    await logExtractionDiagnostics(api, url);
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
// Pure: split the two `--print` lines getDirectUrl asks for into a playable
// stream. `%(urls)s` is newline-separated when a selector picks more than one
// format, so the URL is the FIRST http line and the headers are the LAST line
// that parses as a JSON object — which holds whether one or several were
// printed. Bad/absent header JSON degrades to no headers, never to no URL.
// Exported for tests.
function parseDirectOutput(stdout) {
  var lines = String(stdout || "").split("\n"), url = null, headers = null;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i].trim();
    if (!l) continue;
    if (!url && isHttpUrl(l)) { url = l; continue; }
    if (l.charAt(0) === "{") {
      try {
        var parsed = JSON.parse(l);
        if (parsed && typeof parsed === "object" && Object.keys(parsed).length) headers = parsed;
      } catch (e) { /* not the header line — leave headers null */ }
    }
  }
  return { url: url, headers: headers };
}

// Get a direct stream URL. audio: bestaudio; video: a single muxed stream
// (streamable without a local merge). Returns `{ url, headers }` or null.
//
// `--print` rather than `-g`, because -g prints URLs and nothing else: signed
// CDN links are commonly bound to the User-Agent that minted them, so the host
// needs `http_headers` to hand mpv alongside the URL (see the plugin API's
// StreamResolveResult.headers). Both come from ONE extraction — asking twice
// would mint a second, differently-signed URL.
//
// Video falls back to the HLS MASTER playlist when no muxed stream exists —
// see getHlsMasterUrl.
async function getDirectUrl(api, url, isVideo) {
  var fmt = isVideo ? "best[ext=mp4]/best" : "bestaudio[ext=m4a]/bestaudio";
  var args = ["-f", fmt, "--print", "%(urls)s", "--print", "%(http_headers)j",
              "--no-warnings", "--no-playlist", url];
  api.log("info", "Running: " + formatCmd("yt-dlp", args), "ytdlp");
  var res;
  try { res = await api.system.exec("yt-dlp", args, { cwd: null }); }
  catch (e) { api.log("warn", "yt-dlp direct-url exec failed: " + (e && e.message ? e.message : e), "ytdlp"); return null; }
  if (res.exitCode === 0 && res.stdout) {
    var out = parseDirectOutput(res.stdout);
    if (out.url) return { url: out.url, headers: out.headers };
  }
  if (res.exitCode !== 0) {
    var reason = await withOutdatedHint(api, classifyYtdlpError(res.stderr));
    api.log("warn", "yt-dlp direct stream failed (exit " + res.exitCode + "): " + reason, "ytdlp");
    console.error("[ytdlp] direct stream failed (exit " + res.exitCode + "):", (res.stderr || "").trim() || "no stderr");
  } else {
    api.log("warn", "yt-dlp direct stream returned no usable URL", "ytdlp");
    console.warn("[ytdlp] direct stream returned no usable URL");
  }
  noteBotGate(api, res.stderr);
  // Some sites (e.g. Reddit) have NO muxed video+audio format at all — only
  // split DASH/HLS streams — so `best` matches nothing. The HLS MASTER
  // playlist is one URL carrying the video renditions + the audio group,
  // playable by mpv and the macOS webview alike.
  if (isVideo) {
    var master = await getHlsMasterUrl(api, url);
    if (master) return { url: master, headers: null };
  }
  // Nothing playable came out of this source. Probe only HERE, not at the
  // classification above: for video the HLS master often rescues the resolve,
  // and diagnosing a failure that then succeeded would be noise.
  maybeDeepDiagnostics(api, url, res.stderr);
  return null;
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

// Pure: map a yt-dlp `--dump-json` formats array to the host's StreamCandidate
// menu. The host's selectStream picks per its active engine — the native mpv
// engine pairs a hi-res video-only stream with a separate audio-only stream;
// the browser engine takes a self-contained muxed stream. `maxHeight` (0 = no
// cap) drops video/muxed streams taller than the user's setting. Exported for
// tests.
function candidatesFromFormats(formats, maxHeight) {
  if (!formats || !formats.length) return [];
  var out = [];
  for (var i = 0; i < formats.length; i++) {
    var f = formats[i];
    if (!f || !isHttpUrl(f.url)) continue;
    var hasV = f.vcodec && f.vcodec !== "none";
    var hasA = f.acodec && f.acodec !== "none";
    var kind = hasV && hasA ? "muxed" : hasV ? "video" : hasA ? "audio" : null;
    if (!kind) continue;
    var height = typeof f.height === "number" ? f.height : undefined;
    if (kind !== "audio" && maxHeight > 0 && height && height > maxHeight) continue;
    var c = { url: f.url, kind: kind };
    if (height) c.height = height;
    if (f.ext) c.container = f.ext;
    if (hasV) c.vcodec = f.vcodec;
    if (hasA) c.acodec = f.acodec;
    if (typeof f.tbr === "number") c.tbr = f.tbr;
    if (f.http_headers && typeof f.http_headers === "object") c.headers = f.http_headers;
    out.push(c);
  }
  // Sources with no progressive muxed stream (e.g. Reddit) still need a
  // self-contained option for the browser engine — the HLS master carries the
  // renditions + audio group in one URL. Add it as a muxed candidate.
  var hasMuxed = out.some(function (c) { return c.kind === "muxed"; });
  if (!hasMuxed) {
    var master = pickHlsMaster(formats);
    if (master) out.push({ url: master, kind: "muxed", container: "m3u8" });
  }
  return out;
}

// Pure: the self-contained stream from a candidate menu — what the host's
// `StreamResolveResult.url` has to be, since that field predates candidates and
// is still what an older host (or the browser engine) plays. Prefers a
// browser-safe muxed mp4, then any muxed, and only then a bare video stream,
// which is the last resort precisely because it has no audio: it is better than
// failing the resolve outright, but every caller that can should be picking from
// the candidate list instead. Null when the menu holds nothing self-contained.
// Exported for tests.
function selfContainedUrl(candidates) {
  if (!candidates || !candidates.length) return null;
  var muxed = [], anyVideo = null;
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (c.kind === "muxed") muxed.push(c);
    else if (c.kind === "video" && !anyVideo) anyVideo = c;
  }
  for (var j = 0; j < muxed.length; j++) {
    if (muxed[j].container === "mp4") return muxed[j].url;
  }
  if (muxed.length) return muxed[0].url;
  return anyVideo ? anyVideo.url : null;
}

// ---------------------------------------------------------------------------
// Seek-preview storyboards
// ---------------------------------------------------------------------------

// Sheets to download for one track. YouTube publishes the same ~2-10s interval at
// every level and grows the SHEET COUNT instead of the interval, so a 3-hour video
// is 45 sheets at 160x90 but only 1 at 48x27. This caps the download; the picker
// trades tile size for staying under it.
var STORYBOARD_MAX_SHEETS = 8;
// Below this a tile is too small to read in the host's hover bubble (~176px wide).
var STORYBOARD_MIN_TILE_W = 120;

// Pure: choose a storyboard level from a yt-dlp formats array and describe it in the
// host's `Storyboard` shape, with `sheets` still holding REMOTE urls (the caller
// downloads them). Returns null when the source publishes none — short clips often
// don't, which is not an error.
//
// yt-dlp exposes storyboards as `sb0`-`sb3` formats carrying `rows`, `columns` and a
// `fragments` array of sheet urls. The true tile interval is a fragment's duration
// divided by its tiles-per-sheet; `sb3` is special (always one 10x10 sheet, so its
// interval is duration/100 — an overview strip, useless on long videos).
function storyboardFromFormats(formats) {
  if (!formats || !formats.length) return null;
  var levels = [];
  for (var i = 0; i < formats.length; i++) {
    var f = formats[i];
    if (!f || typeof f.format_id !== "string" || f.format_id.indexOf("sb") !== 0) continue;
    var cols = f.columns, rows = f.rows;
    var frags = f.fragments;
    if (!cols || !rows || !frags || !frags.length) continue;
    var perSheet = cols * rows;
    var fragDur = typeof frags[0].duration === "number" ? frags[0].duration : 0;
    if (!(fragDur > 0)) continue;
    var urls = [];
    for (var j = 0; j < frags.length; j++) {
      if (frags[j] && isHttpUrl(frags[j].url)) urls.push(frags[j].url);
    }
    if (!urls.length) continue;
    levels.push({
      id: f.format_id,
      sheets: urls,
      cols: cols,
      rows: rows,
      count: perSheet * urls.length,
      tileW: f.width || 0,
      tileH: f.height || 0,
      startSecs: 0,
      intervalSecs: fragDur / perSheet
    });
  }
  if (!levels.length) return null;

  // Prefer a readable tile size within the sheet budget; largest tile wins, fewest
  // sheets breaks ties. If nothing qualifies, take whatever needs fewest downloads
  // (a long video's only cheap level is the coarse one).
  var eligible = levels.filter(function (l) {
    return l.sheets.length <= STORYBOARD_MAX_SHEETS && l.tileW >= STORYBOARD_MIN_TILE_W;
  });
  var pool = eligible.length ? eligible : levels.slice();
  pool.sort(function (a, b) {
    if (eligible.length && b.tileW !== a.tileW) return b.tileW - a.tileW;
    return a.sheets.length - b.sheets.length;
  });
  return pool[0];
}

// ---------------------------------------------------------------------------
// Storyboard descriptor cache
// ---------------------------------------------------------------------------
// The sheet BYTES have always been cached. What wasn't cached was the knowledge of
// what those bytes are — the grid, the tile size, the interval — so every play paid a
// full `yt-dlp -j` to rediscover it. Measured at ~12s on a dev machine, which is long
// enough that the host's resolve budget expired first and the filmstrip simply never
// appeared. Caching the descriptor makes a repeat play a couple of file checks.
var STORYBOARD_CACHE_KEY = "storyboardCache";
// Bounded so a heavy listener's cache can't grow forever. Entries are tiny (a grid
// plus at most STORYBOARD_MAX_SHEETS names), so this is a few tens of KB.
var STORYBOARD_CACHE_MAX = 200;
// Bump when the cached shape or the level picker changes, so entries written by an
// older build are ignored rather than replayed against new expectations.
var STORYBOARD_CACHE_VERSION = 1;

// Pure: insert `entry` under `stem`, dropping the oldest entries past `max`. Re-putting
// an existing stem refreshes it in place rather than adding a duplicate.
//
// `at` orders eviction, NOT expiry: a published storyboard never changes, so an entry
// is only ever stale because its sheet files are gone — which cachedStoryboard()
// detects directly rather than guessing at with a TTL.
function putStoryboardCache(map, stem, entry, max, at) {
  var next = {};
  var keys = Object.keys(map || {});
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] !== stem) next[keys[i]] = map[keys[i]];
  }
  next[stem] = Object.assign({}, entry, { at: at });

  var all = Object.keys(next);
  if (all.length <= max) return next;
  all.sort(function (a, b) { return (next[a].at || 0) - (next[b].at || 0); });
  for (var j = 0; j < all.length - max; j++) delete next[all[j]];
  return next;
}

async function readStoryboardCache(api) {
  try {
    var raw = await api.storage.get(STORYBOARD_CACHE_KEY);
    return raw && typeof raw === "object" ? raw : {};
  } catch (e) { return {}; }
}

// Rebuild a host descriptor from a cache entry, or null when there isn't a usable one.
// Sheet NAMES are cached, never the absolute paths: a path embeds the profile
// directory, which differs per profile and per machine, while the name is stable.
async function cachedStoryboard(api, stem) {
  var map = await readStoryboardCache(api);
  var hit = map[stem];
  if (!hit || hit.v !== STORYBOARD_CACHE_VERSION || !hit.names || !hit.names.length) return null;

  var local = [];
  for (var i = 0; i < hit.names.length; i++) {
    var segs = ["storyboards", hit.names[i]];
    try {
      // Self-heal. Plugin storage can be cleared independently of this map, and a
      // descriptor pointing at deleted files would render an empty filmstrip — worse
      // than no filmstrip, because nothing would ever retry.
      if (!(await api.storage.files.exists(segs))) return null;
      local.push(await api.storage.files.getPath(segs));
    } catch (e) { return null; }
  }
  return {
    sheets: local,
    cols: hit.cols,
    rows: hit.rows,
    count: hit.count,
    tileW: hit.tileW,
    tileH: hit.tileH,
    startSecs: hit.startSecs,
    intervalSecs: hit.intervalSecs
  };
}

async function writeStoryboardCache(api, stem, board, names) {
  try {
    var map = await readStoryboardCache(api);
    var entry = {
      v: STORYBOARD_CACHE_VERSION,
      names: names,
      cols: board.cols,
      rows: board.rows,
      count: board.count,
      tileW: board.tileW,
      tileH: board.tileH,
      startSecs: board.startSecs,
      intervalSecs: board.intervalSecs
    };
    await api.storage.set(
      STORYBOARD_CACHE_KEY,
      putStoryboardCache(map, stem, entry, STORYBOARD_CACHE_MAX, Date.now())
    );
  } catch (e) {
    // Non-fatal: the caller already holds a working storyboard, and failing to
    // remember it only costs the next play the discovery pass again.
    api.log("warn", "storyboard: cache write failed: " + (e && e.message ? e.message : e), "ytdlp");
  }
}

// Fetch a source's storyboard and cache the SHEET BYTES under plugin storage.
// Caching the bytes rather than the urls is essential: YouTube signs storyboard urls
// with a short-lived `sqp` parameter while the images themselves never change, so a
// cached url is dead within hours and cached pixels last forever.
async function resolveStoryboard(api, url, refId) {
  var stem = cacheStem(refId || url);

  // Short-circuit the entire discovery pass when we already know this source.
  var cached = await cachedStoryboard(api, stem);
  if (cached) return cached;

  var args = ["-j", "--no-warnings", "--no-playlist", url];
  var res;
  try { res = await api.system.exec("yt-dlp", args, { cwd: null }); }
  catch (e) { api.log("warn", "storyboard: yt-dlp exec failed: " + (e && e.message ? e.message : e), "ytdlp"); return null; }
  if (res.exitCode !== 0 || !res.stdout) { noteBotGate(api, res.stderr); return null; }

  var board;
  try {
    var info = JSON.parse(res.stdout.split("\n")[0]);
    board = storyboardFromFormats(info.formats || []);
  } catch (e) {
    api.log("warn", "storyboard: parse failed: " + (e && e.message ? e.message : e), "ytdlp");
    return null;
  }
  // Deliberately NOT cached as a negative. A miss here can be transient — a bot gate,
  // a network blip — and a sticky negative would mean this source never gets a
  // filmstrip again. The cost of retrying is one discovery pass.
  if (!board) { api.log("info", "No storyboard published for " + url, "ytdlp"); return null; }

  var local = [];
  var names = [];
  for (var i = 0; i < board.sheets.length; i++) {
    var name = stem + "-sb" + i + ".jpg";
    var segs = ["storyboards", name];
    try {
      if (!(await api.storage.files.exists(segs))) {
        await api.storage.files.download(segs, board.sheets[i]);
      }
      local.push(await api.storage.files.getPath(segs));
      names.push(name);
    } catch (e) {
      api.log("warn", "storyboard: sheet " + i + " failed: " + (e && e.message ? e.message : e), "ytdlp");
      return null; // a partial sheet set would mis-address later tiles
    }
  }

  // Only after every sheet landed — a half-written entry would be a cache hit that
  // resolves to a broken strip.
  await writeStoryboardCache(api, stem, board, names);
  api.log("info", "Storyboard " + board.id + " for " + url + ": " + board.count +
    " tiles, " + local.length + " sheet(s), every " + board.intervalSecs.toFixed(1) + "s", "ytdlp");
  return {
    sheets: local,
    cols: board.cols,
    rows: board.rows,
    count: board.count,
    tileW: board.tileW,
    tileH: board.tileH,
    startSecs: board.startSecs,
    intervalSecs: board.intervalSecs
  };
}

// Enumerate a source's streams as a StreamCandidate menu via ONE `yt-dlp -j`
// call (formats carry directly-usable URLs). Returns [] on any failure so the
// caller can fall back to the single-stream muxed path.
async function enumerateFormats(api, url, maxHeight) {
  var args = ["-j", "--no-warnings", "--no-playlist", url];
  api.log("info", "Running: " + formatCmd("yt-dlp", args), "ytdlp");
  var res;
  try { res = await api.system.exec("yt-dlp", args, { cwd: null }); }
  catch (e) { api.log("warn", "yt-dlp -j exec failed: " + (e && e.message ? e.message : e), "ytdlp"); return []; }
  if (res.exitCode !== 0 || !res.stdout) {
    noteBotGate(api, res.stderr);
    return [];
  }
  try {
    var info = JSON.parse(res.stdout.split("\n")[0]);
    return candidatesFromFormats(info.formats || [], maxHeight || 0);
  } catch (e) {
    api.log("warn", "yt-dlp -j parse failed: " + (e && e.message ? e.message : e), "ytdlp");
    return [];
  }
}

// Download the source media to cache/<stem>.<ext>. audio: bestaudio; video:
// bestvideo+bestaudio merged (needs ffmpeg) into an .mp4, or .mkv when the source
// has no H.264/AAC pair — see videoFormatSelector. Returns the file path or null.
async function downloadToCache(api, url, isVideo) {
  var stem = cacheStem(url, isVideo);
  var cached = await findCachedDownload(api, stem);
  if (cached) { api.log("info", "Using cached download: " + cached, "ytdlp"); return cached; }

  var cacheDir = await ensureDir(api, "cache");
  if (!cacheDir) { api.log("error", "Cache dir unavailable — cannot download", "ytdlp"); return null; }
  var args;
  if (isVideo) {
    // "Download then play" honors the streaming resolution cap.
    args = ["-f", videoFormatSelector(maxVideoHeight), "--merge-output-format", MERGE_CONTAINERS];
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
      await logExtractionDiagnostics(api, url);
      return null;
    }
    filePath = res.stdout ? res.stdout.trim() || null : null;
  } catch (e) {
    api.log("error", "yt-dlp exec failed: " + (e && e.message ? e.message : e), "ytdlp");
    return null;
  }
  if (!filePath) {
    api.log("warn", "yt-dlp returned no file path (exit 0, no output) — likely SABR/PO-token", "ytdlp");
    await logExtractionDiagnostics(api, url);
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

// Resolve a source URL to a PLAYABLE url. Returns { url, downloaded, headers }
// or null. `headers` is set only for a direct stream (a downloaded file needs
// none) and only when the source asked for some.
//
// "stream" mode returns a direct URL only — it does NOT fall back to downloading
// on failure. A download of the same source doesn't fix a codec the engine can't
// play (that's the mpv engine's job), and downloading the whole file first is
// slow; so a direct-stream failure fails cleanly and the host surfaces an error.
// Users who want the reliability of a local copy pick "Download then play".
async function resolvePlayable(api, url, isVideo, fresh) {
  if (playbackMode === "stream") {
    // Keyed per (source, kind) exactly like the download cache: the two format
    // selectors differ, so an audio resolve must never serve a video's URL.
    var key = cacheStem(url, isVideo);
    // `fresh` = the host is retrying because what we last handed it wouldn't
    // play. A signed URL that has been refused stays refused, so the remembered
    // one is worse than useless here: serving it would burn the retry and make
    // the failure look permanent. Drop it and mint a new one.
    if (fresh) delete streamUrlCache[key];
    var hit = cacheGet(streamUrlCache, key, Date.now());
    if (hit) {
      api.log("info", "Streaming directly (cached resolve, no yt-dlp call): " + url, "ytdlp");
      return { url: hit.url, downloaded: false, headers: hit.headers };
    }
    var direct = await getDirectUrl(api, url, isVideo);
    if (direct && direct.url) {
      var expiresAt = streamUrlExpiry(direct.url, Date.now());
      // null = the URL is already near its own deadline, so caching it would
      // only guarantee a dead hit later. Play it now, resolve again next time.
      if (expiresAt) {
        cachePut(streamUrlCache, key, { url: direct.url, headers: direct.headers || null }, expiresAt, CACHE_MAX_ENTRIES);
      }
      api.log("info", "Streaming directly: " + url, "ytdlp");
      return { url: direct.url, downloaded: false, headers: direct.headers || null };
    }
    api.log("warn", "Direct stream unavailable: " + url, "ytdlp");
    return null;
  }
  // "download" mode: fetch a local copy (browser-friendly m4a / merged mp4).
  var filePath = await downloadToCache(api, url, isVideo);
  if (!filePath) return null;
  return { url: "file://" + filePath, downloaded: true, filePath: filePath };
}

// Turn a resolvePlayable result into what onResolveStreamByUri should return.
//
// A bare URL string is the simpler half of that contract and stays the answer
// whenever the stream needs no headers. When it DOES, a candidate list is the
// only shape that can carry them (`StreamCandidate.headers`) — so wrap the one
// stream yt-dlp already picked in a single-element list rather than enumerating
// every format and handing selection to the host. Enumerating would change
// WHICH stream plays; this is a headers fix, not a quality change.
//
// `kind` follows what was asked for: `muxed` for video (splitting video from
// audio is the externalAudio path's job, not this one), `audio` otherwise.
// Container and codecs are deliberately absent — we never measured them here,
// and with a single candidate they'd only feed a browser-safe preference that
// has nothing to choose between.
//
// Downloads ("download then play") and the HLS-master fallback both come back
// headerless, so both keep returning a plain URL exactly as before.
// Pure; exported for tests.
function streamUriResult(playable, isVideo) {
  if (!playable || !playable.url) return null;
  if (!playable.headers) return playable.url;
  return { candidates: [{ url: playable.url, kind: isVideo ? "muxed" : "audio", headers: playable.headers }] };
}

// Produce the host download-resolve result for a source URL + chosen format.
// Always downloads locally so yt-dlp can embed tags (using its rich metadata)
// into a correctly-named file. `caller` carries any AUTHORITATIVE
// metadata the host already has (e.g. a library track's real title/artist/album),
// which overrides yt-dlp's guesses; when absent, yt-dlp's own metadata is used.
// Throws (via downloadForDownload) with a user-facing reason on failure.
async function resolveDownload(api, url, format, caller) {
  var fmt = format || "original";
  var vf = parseVideoFormat(fmt);
  var isVideo = vf.isVideo;
  var audioFormat = null;
  if (!isVideo && TRANSCODE_FORMATS[fmt]) {
    if (ffmpegVersion) audioFormat = fmt;
    else api.log("warn", "ffmpeg missing — downloading original audio instead of " + fmt, "ytdlp");
  }

  var dl = await downloadForDownload(api, url, { video: isVideo, audioFormat: audioFormat, maxHeight: vf.maxHeight });
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
    api.storage.get("resolverSource"),
    api.storage.get("maxVideoHeight"),
    api.storage.get("debugScoring"),
    api.storage.get("scoringAudio"),
    api.storage.get("scoringVideo")
  ]);
  if (stored[0] != null && typeof stored[0] === "number") cacheMaxMb = stored[0];
  if (stored[1] === "download" || stored[1] === "stream") playbackMode = stored[1];
  if (stored[2] && SOURCES[stored[2]]) searchSource = stored[2];
  if (stored[3] && SOURCES[stored[3]]) resolverSource = stored[3];
  if (stored[4] != null && typeof stored[4] === "number") maxVideoHeight = stored[4];
  if (stored[5] === true) debugScoring = true;
  // Scoring profiles: stored values merged over the defaults (missing/new keys
  // keep their default), so tuning survives restarts and future param additions.
  scoringAudio = normalizeProfile("audio", stored[6]);
  scoringVideo = normalizeProfile("video", stored[7]);

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
    var fresh = !!(opts && opts.fresh);
    try {
      // preferVideo → rank with the VIDEO profile (official MV / VEVO); plain
      // audio playback → the AUDIO profile (clean official-audio / Topic).
      var cand = await searchByMetadata(api, title, artistName, durationSecs, preferVideo ? "video" : "audio");
      if (!cand) { api.log("warn", "No match for: " + title, "ytdlp"); return null; }
      if (preferVideo) {
        // The host can merge a separate audio track (native mpv engine): hand it
        // the whole menu so it can pair a hi-res video-only stream with an
        // audio-only one. Without this the answer is whatever `getDirectUrl`
        // finds with `best[ext=mp4]/best` — a MUXED stream — and YouTube's only
        // muxed format is itag 18 at 360p, so "Watch YouTube video" was capped
        // there on every engine no matter how good the source was.
        if (opts && opts.externalAudio && playbackMode === "stream") {
          var menu = await enumerateFormats(api, cand.url, maxVideoHeight);
          var selfContained = selfContainedUrl(menu);
          if (menu.length && selfContained) {
            api.log("info", "Resolved " + menu.length + " stream candidate(s) for " + cand.url, "ytdlp");
            return { url: selfContained, candidates: menu, label: "yt-dlp (video)", sourceUrl: cand.url, video: true };
          }
          api.log("warn", "No candidates enumerated — falling back to muxed stream", "ytdlp");
        }
        var vid = await resolvePlayable(api, cand.url, true, fresh);
        // `headers` rides along so the host can hand them to mpv: a signed CDN
        // URL is often bound to the User-Agent that minted it, and this path
        // (unlike the by-URI candidate list) has no other way to carry them.
        if (vid) return { url: vid.url, label: "yt-dlp (video)", sourceUrl: cand.url, video: true, headers: vid.headers || undefined };
        api.log("warn", "No video stream — falling back to audio: " + cand.url, "ytdlp");
      }
      var playable = await resolvePlayable(api, cand.url, false, fresh);
      if (!playable) return null;
      return { url: playable.url, label: "yt-dlp", sourceUrl: cand.url, headers: playable.headers || undefined };
    } catch (e) {
      api.log("error", "Stream resolve failed: " + (e && e.message ? e.message : e), "ytdlp");
      return null;
    }
  });

  // ---- Playback: ytdlp:// scheme resolver (exact source, audio or video) ----
  api.playback.onResolveStreamByUri("ytdlp", async function (id, quality, opts) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) { api.log("warn", "URI resolve skipped — yt-dlp not available", "ytdlp"); return null; }
    var ref = decodeRef(id);
    if (!ref) { api.log("warn", "URI resolve: bad ref " + id, "ytdlp"); return null; }
    try {
      // The host can attach a separate audio track (native mpv engine + video):
      // return the full candidate menu so it can pick a hi-res video-only +
      // audio-only pair. Only in "stream" mode — "download then play" already
      // fetches a full-res merged file below. On enumeration failure fall
      // through to the single muxed stream.
      if (ref.isVideo && opts && opts.externalAudio && playbackMode === "stream") {
        var candidates = await enumerateFormats(api, ref.url, maxVideoHeight);
        if (candidates.length) {
          api.log("info", "Resolved " + candidates.length + " stream candidate(s) for " + ref.url, "ytdlp");
          return { candidates: candidates };
        }
        api.log("warn", "No candidates enumerated — falling back to muxed stream", "ytdlp");
      }
      var playable = await resolvePlayable(api, ref.url, ref.isVideo, opts && opts.fresh);
      return streamUriResult(playable, ref.isVideo);
    } catch (e) {
      api.log("error", "URI resolve failed: " + (e && e.message ? e.message : e), "ytdlp");
      return null;
    }
  });

  // ---- Playback: seek-preview storyboards ----
  // Uses YouTube's OWN published sprite sheets instead of extracting frames: no
  // decoding, no second stream of the video, ~58 KB for a couple of hundred tiles.
  // Guarded: an older host has no such method, and an unguarded call would throw
  // inside activate() and take every other feature down with it.
  if (typeof api.playback.onResolveStoryboard === "function") {
  api.playback.onResolveStoryboard("ytdlp", async function (id) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) return null;
    var ref = decodeRef(id);
    if (!ref) return null;
    try {
      return await resolveStoryboard(api, ref.url, id);
    } catch (e) {
      api.log("warn", "Storyboard resolve failed: " + (e && e.message ? e.message : e), "ytdlp");
      return null;
    }
  });
  }

  // ---- Playback: legacy youtube:// compatibility ----
  api.playback.onResolveStreamByUri("youtube", async function (id, quality, opts) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) return null;
    if (!YT_ID_RE.test(id)) { api.log("warn", "Legacy youtube:// resolve: bad id " + id, "ytdlp"); return null; }
    try {
      var playable = await resolvePlayable(api, youtubeWatchUrl(id), false, opts && opts.fresh);
      return streamUriResult(playable, false);
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
      // Video download options mirror the streaming resolution choices: best +
      // per-resolution caps. Each merges the best H.264 video ≤ cap with the best
      // AAC audio into an .mp4. The host defaults to the first `video:true` option
      // when the item being downloaded is itself a video.
      for (var i = 0; i < VIDEO_RESOLUTIONS.length; i++) {
        var r = VIDEO_RESOLUTIONS[i];
        q.push({
          value: r.height === 0 ? "video" : "video-" + r.height,
          label: "Video · MP4 · " + (r.height === 0 ? "Best" : r.label),
          video: true,
          description: (r.height === 0
            ? "Downloads the best video and merges it with the best audio into an .mp4. "
            : "Downloads the best video up to " + r.label + " and merges it with the best audio into an .mp4. ")
            + "Prefers H.264 + AAC so the file plays everywhere — a higher-resolution AV1/VP9 stream is skipped, since most players can't decode those. Sources with no H.264 are saved as .mkv instead."
        });
      }
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
      // Downloads are audio unless a video format was requested — match the
      // scoring profile so a video download ranks toward the actual MV.
      var dlProfile = parseVideoFormat(format).isVideo ? "video" : "audio";
      var cand = await searchByMetadata(api, title, artistName, durationSecs, dlProfile);
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
    if (s === "__tune") { tuneOpen = true; resolveOpen = false; renderSearchView(api); return; }
    if (s === "__resolve") { resolveOpen = true; tuneOpen = false; renderSearchView(api); return; }
    if (s && SOURCES[s]) {
      tuneOpen = false; resolveOpen = false;
      searchSource = s; api.storage.set("searchSource", s); renderSearchView(api);
    }
  });

  // ---- Tuning tab (visible only while debug scoring is on) ----
  function activeTuneProfile() { return tuneProfile === "video" ? scoringVideo : scoringAudio; }
  function persistTuneProfile(api) {
    api.storage.set(tuneProfile === "video" ? "scoringVideo" : "scoringAudio", activeTuneProfile())
      .catch(function (e) { console.error("[ytdlp] persist scoring profile failed:", e); });
  }
  api.ui.onAction("ytdlp-tune-profile", function (data) {
    var p = data && (data.tabId || data.value);
    if (p !== "audio" && p !== "video") return;
    tuneProfile = p; tuneParamText = {}; // inputs re-derive from the new profile
    renderSearchView(api);
  });
  // Param edit: store the raw text so the input keeps exactly what was typed, and
  // apply the parsed number to the LIVE profile (so real resolves change too).
  // Registered once per param key.
  for (var pi = 0; pi < SCORING_PARAMS.length; pi++) {
    (function (key) {
      api.ui.onAction("ytdlp-tune-p-" + key, function (data) {
        var raw = data && data.value != null ? String(data.value) : "";
        tuneParamText[key] = raw;
        var v = parseFloat(raw);
        if (isFinite(v)) { activeTuneProfile()[key] = v; persistTuneProfile(api); }
        renderSearchView(api);
      });
    })(SCORING_PARAMS[pi].key);
  }
  api.ui.onAction("ytdlp-tune-target", function (data) {
    tuneTargetRaw = data && data.value != null ? String(data.value) : "";
    tuneTarget = parseDurationInput(tuneTargetRaw);
    renderSearchView(api);
  });
  api.ui.onAction("ytdlp-tune-reset", function () {
    if (tuneProfile === "video") scoringVideo = defaultProfile("video");
    else scoringAudio = defaultProfile("audio");
    tuneParamText = {};
    persistTuneProfile(api);
    renderSearchView(api);
  });
  api.ui.onAction("ytdlp-tune-run", async function (data) {
    if (tuneBusy) return;
    tuneQuery = data && typeof data.query === "string" ? data.query : "";
    if (!tuneQuery.trim()) { tuneResults = null; renderSearchView(api); return; }
    await ensureToolStatus(api);
    if (!ytDlpVersion) { renderSearchView(api); return; }
    // Match the real resolve source per profile: video → YouTube, audio → the
    // configured fallback source. 12 candidates so the ranking has something to
    // reorder.
    var src = tuneProfile === "video" ? "youtube" : resolverSource;
    tuneBusy = true; renderSearchView(api);
    try {
      tuneResults = await runSearchRaw(api, src, tuneQuery, 12);
    } catch (e) {
      api.log("error", "Tuning search failed: " + (e && e.message ? e.message : e), "ytdlp");
      tuneResults = [];
    }
    tuneBusy = false; renderSearchView(api);
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
    if (results) {
      for (var i = 0; i < results.length; i++) {
        if (encodeRef(results[i].url, false) === refId || results[i].url === refId) return results[i];
      }
    }
    // Fall back to the "Last resolve" debug panel candidates so its Play / Watch
    // / Download row actions work even though they're not in the search list.
    if (lastResolve && lastResolve.candidates) {
      for (var k = 0; k < lastResolve.candidates.length; k++) {
        var rc = lastResolve.candidates[k];
        if (encodeRef(rc.url, false) === refId || rc.url === refId) return rc;
      }
    }
    // ...and the Tuning tab's ranked candidates, so Play / Watch / Download work
    // straight from the tuning result list.
    if (tuneResults) {
      for (var t = 0; t < tuneResults.length; t++) {
        var tc = tuneResults[t];
        if (encodeRef(tc.url, false) === refId || tc.url === refId) return tc;
      }
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
  api.ui.onAction("ytdlp-max-res", async function (data) {
    var v = parseInt(typeof data === "string" ? data : data && data.value, 10);
    if (isNaN(v) || v < 0) return;
    maxVideoHeight = v; await api.storage.set("maxVideoHeight", v); renderSettings(api);
  });
  api.ui.onAction("ytdlp-resolver-source", async function (data) {
    var v = data && data.value;
    if (!v || !SOURCES[v]) return;
    resolverSource = v; await api.storage.set("resolverSource", v); renderSettings(api);
  });
  api.ui.onAction("ytdlp-debug-scoring", async function (data) {
    debugScoring = !!(data && data.value);
    await api.storage.set("debugScoring", debugScoring);
    if (!debugScoring) { lastResolve = null; tuneOpen = false; resolveOpen = false; } // drop debug capture + close debug tabs
    renderSettings(api); renderSearchView(api);
  });
  api.ui.onAction("ytdlp-clear-resolve", function () {
    lastResolve = null; renderSearchView(api);
  });

  registerGlobalSearch(api);

  renderSettings(api);
  renderSearchView(api);

  // Populate dependency status AFTER activation (next tick), never during it.
  setTimeout(function () {
    ensureToolStatus(api).then(function () {
      renderSettings(api);
      renderSearchView(api);
      // Status is only known now, and it decides whether we can search at all.
      registerGlobalSearch(api);
    });
  }, 0);
}

// ---------------------------------------------------------------------------
// Global search (host Cmd+K)
// ---------------------------------------------------------------------------
// The host offers this catalog as a row in its search dropdown and queries it
// only when the user picks that row — it never fires while they type, which is
// what makes it acceptable to shell out to yt-dlp here (a search takes seconds).
//
// Registered at runtime rather than in the manifest, and only once yt-dlp is
// known to be present: a provider that can't work should not be offered. Called
// again after the dependency status loads, hence the idempotency guard.
var globalSearchRegistered = false;
function registerGlobalSearch(api) {
  // Guard the whole namespace: older hosts have no api.search at all.
  if (!api.search || typeof api.search.registerProvider !== "function") return;
  if (globalSearchRegistered) return;
  // Before the status load, ytDlpVersion is null and we simply wait — the
  // post-load call re-runs this.
  if (!statusLoaded || !ytDlpVersion) return;
  globalSearchRegistered = true;

  api.search.registerProvider({ id: "ytdlp-search", name: "yt-dlp" });
  // Worth a line: whether this provider is offered depends on host version AND
  // on yt-dlp being present, so "why is yt-dlp missing from Cmd+K" is otherwise
  // unanswerable from a log.
  api.log("info", "Global search provider registered (yt-dlp " + ytDlpVersion + ")", "ytdlp");

  api.search.onQuery("ytdlp-search", async function (query, limit) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) {
      return { status: "error", message: "yt-dlp isn't installed" };
    }
    var q = (query || "").trim();
    if (!q) return { status: "empty" };
    // "Link" is a paste-a-URL tab with no search extractor, so free text has to
    // go to a source that actually searches — same substitution the download
    // modal's manual search makes.
    var source = searchSource === "link" ? resolverSource : searchSource;
    if (source === "link") source = "youtube";
    try {
      // runSearch absorbs exec failures and non-zero exits into an empty
      // candidate list (and notifies on a bot gate), so "empty" here covers both
      // a genuine miss and a blocked search — same as the sidebar view. The
      // catch below is a backstop, not the normal failure path.
      var candidates = await runSearch(api, source, q, limit || 6);
      if (!candidates || candidates.length === 0) return { status: "empty" };
      var tracks = [];
      for (var i = 0; i < candidates.length; i++) {
        // Audio identity — the global search plays songs. Watching a video is
        // the context menu's "Watch YouTube video" job.
        tracks.push(buildTrack(candidates[i], false));
      }
      return { status: "ok", tracks: tracks };
    } catch (e) {
      api.log("error", "Global search failed: " + (e && e.message ? e.message : e), "ytdlp");
      return { status: "error", message: e && e.message ? e.message : "search failed" };
    }
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function makeMissingDepNote() {
  if (!statusLoaded || ytDlpVersion) return null;
  return { type: "text", className: "ds-banner ds-banner--error",
    content: "yt-dlp isn't installed. Install it from Settings → Dependencies to search, play or download." };
}

// Build one track-row-list item from a search/resolve candidate at display
// position `pos`. Folds the view count — and, when debug scoring is on, the
// score breakdown — into the subtitle. `opts.chosen` marks the row the resolver
// actually picked (leading ✓). `opts.profile` folds the PROFILE score breakdown
// (Tuning tab) instead of the view-rerank one. Shared by the search list, the
// "Last resolve" debug panel and the Tuning tab so all render identically.
function buildResultRow(c, pos, opts) {
  opts = opts || {};
  var parsed = parseTrackTitle(c.title, c.uploader);
  var artist = parsed.artist || c.uploader || "";
  // Fold the view count into the subtitle line ("Artist · 1.5B views").
  // track-row-list has no dedicated views field, and views is the signal the
  // user wants to see to spot the real music video.
  var viewsLabel = formatViews(c.views);
  var subtitle = artist && viewsLabel ? artist + " · " + viewsLabel : (artist || viewsLabel);
  // Fold the ranking score breakdown into the subtitle so you can see why this
  // result placed where it did — the profile breakdown in the Tuning tab, else
  // (when debug scoring is on) the view-rerank one.
  var dbg = opts.profile ? formatProfileScore(c) : (debugScoring ? formatScoreDebug(c, pos) : "");
  if (dbg) subtitle = subtitle ? subtitle + "  ·  " + dbg : dbg;
  return {
    id: encodeRef(c.url, false),
    title: (opts.chosen ? "✓ " : "") + (parsed.title || c.title || c.url),
    subtitle: subtitle,
    duration: formatDuration(c.durationSecs),
    imageUrl: thumbFor(c.url, c.thumbnail),
    action: "ytdlp-play-one",
    // Carry the audio ref + metadata so the host builds a native right-click
    // menu (Play / Enqueue / Play Next), resolves artwork by name, and allows
    // drag-to-queue — all without a DB id.
    path: encodeRef(c.url, false),
    artistName: artist || null,
    durationSecs: c.durationSecs != null ? c.durationSecs : null
  };
}

// The "Last resolve" tab: the candidates the most recent AUTOMATED resolve
// (playback/download fallback or "Watch YouTube video") considered, ranked by
// the profile it used, with the winning pick ✓ and the same per-signal
// breakdown as the Tuning tab. Shows an empty state until something resolves.
function appendResolveView(children) {
  var lr = lastResolve;
  children.push({
    type: "toolbar", title: "Last resolve",
    buttons: lr ? [{ label: "Clear", action: "ytdlp-clear-resolve", icon: "✕" }] : []
  });
  if (!lr) {
    children.push({
      type: "text", className: "ds-empty",
      content: "No automated resolve captured yet. Play a track that resolves through yt-dlp — a Spotify track, a library miss, or the “Watch YouTube video” action — and the candidates it scored (and the one it picked) appear here."
    });
    return;
  }
  var srcLabel = (SOURCES[lr.source] && SOURCES[lr.source].label) || lr.source;
  var profileLabel = lr.profile ? (lr.profile.charAt(0).toUpperCase() + lr.profile.slice(1)) : "—";
  var meta = ["Profile: " + profileLabel, "source: " + srcLabel];
  if (lr.target != null) meta.push("target " + formatDuration(lr.target));
  meta.push((lr.candidates ? lr.candidates.length : 0) + " candidate" + ((lr.candidates && lr.candidates.length === 1) ? "" : "s"));
  children.push({ type: "text", content: lr.kind + " · “" + lr.query + "”" });
  children.push({ type: "text", content: meta.join("  ·  "), className: "ds-empty" });
  if (lr.candidates && lr.candidates.length) {
    var rows = [];
    for (var r = 0; r < lr.candidates.length; r++) {
      var rc = lr.candidates[r];
      rows.push(buildResultRow(rc, r, { profile: true, chosen: !!(lr.chosen && rc.url === lr.chosen.url) }));
    }
    children.push({
      type: "track-row-list", selectable: true, items: rows,
      actions: [
        { id: "ytdlp-play", label: "Play", icon: "▶" },
        { id: "ytdlp-watch", label: "Watch", icon: "🎬" },
        { id: "ytdlp-download", label: "Download", icon: "⬇" }
      ]
    });
  } else {
    children.push({ type: "text", content: "No candidates were returned for this resolve.", className: "ds-empty" });
  }
}

// The Tuning tab: pick a profile, run a real search, and see it ranked by that
// profile with a full per-signal breakdown — editing any weight re-ranks live.
// The edited profile IS the live one, so tuning changes real resolves too.
// Build the ranked-results column node(s) for the current tuning state.
function buildTuningResults(profile) {
  if (tuneBusy) return [{ type: "loading", message: "Searching…" }];
  if (tuneResults == null) {
    return [{ type: "text", className: "ds-empty", content: "Enter a query and press Run to rank candidates with this profile." }];
  }
  if (tuneResults.length === 0) {
    return [{ type: "text", className: "ds-empty", content: "No results for that query." }];
  }
  var ranked = rankByProfile(tuneResults, profile, tuneTarget);
  var items = [];
  for (var r = 0; r < ranked.length; r++) items.push(buildResultRow(ranked[r], r, { profile: true, chosen: r === 0 }));
  return [{
    type: "track-row-list", selectable: true, items: items,
    actions: [
      { id: "ytdlp-play", label: "Play", icon: "▶" },
      { id: "ytdlp-watch", label: "Watch", icon: "🎬" },
      { id: "ytdlp-download", label: "Download", icon: "⬇" }
    ]
  }];
}

function appendTuningView(children) {
  var profile = tuneProfile === "video" ? scoringVideo : scoringAudio;
  var realPath = tuneProfile === "video"
    ? "the “Watch YouTube video” action and preferVideo streaming"
    : "playback / download fallback (Spotify tracks, library misses)";

  // Full-width header.
  children.push({
    type: "toolbar", title: "Scoring tuning",
    buttons: [{ label: "Reset " + tuneProfile + " to defaults", action: "ytdlp-tune-reset", icon: "↺" }]
  });
  children.push({
    type: "text", className: "ds-empty",
    content: "Rank a real search with the " + tuneProfile + " profile to see why each pick wins. " +
      "Edit any weight and the results re-rank instantly. This is exactly how " + realPath + " chooses its result."
  });

  // Left column: all the controls (profile, query, target, weights, signals).
  var controls = [];
  controls.push({
    type: "tabs", action: "ytdlp-tune-profile", activeTab: tuneProfile,
    tabs: [{ id: "audio", label: "Audio profile" }, { id: "video", label: "Video profile" }]
  });
  controls.push({
    type: "search-input", action: "ytdlp-tune-run", value: tuneQuery,
    placeholder: "Search query, e.g. creep radiohead",
    buttonLabel: tuneBusy ? "…" : "Run"
  });
  controls.push({
    type: "settings-row", label: "Target duration",
    description: "Optional — the known track length the duration-match weight scores against (e.g. 3:58 or 238). Blank ignores duration.",
    control: {
      type: "text-input", action: "ytdlp-tune-target",
      placeholder: "m:ss or seconds",
      value: tuneTargetRaw != null ? tuneTargetRaw : (tuneTarget != null ? String(tuneTarget) : "")
    }
  });
  // Param editors, grouped by kind. Each input shows the raw typed text if the
  // user has touched it this session, else the live profile value.
  var weightRows = [], flagRows = [];
  for (var i = 0; i < SCORING_PARAMS.length; i++) {
    var sp = SCORING_PARAMS[i];
    var val = tuneParamText[sp.key] != null ? tuneParamText[sp.key] : String(profile[sp.key]);
    var row = {
      type: "settings-row", label: sp.label,
      control: { type: "text-input", action: "ytdlp-tune-p-" + sp.key, value: val, placeholder: "0" }
    };
    (sp.type === "weight" ? weightRows : flagRows).push(row);
  }
  controls.push({ type: "section", title: "Weights (multipliers)", children: weightRows });
  controls.push({ type: "section", title: "Keyword & channel signals (+ favor / − penalize)", children: flagRows });

  // Right column: the live ranked results.
  var results = [{ type: "section", title: "Ranked results", children: buildTuningResults(profile) }];

  // Two columns side by side (stacks on a narrow view — see plugin-layout-columns).
  children.push({
    type: "layout", direction: "horizontal", className: "plugin-layout-columns",
    children: [
      { type: "layout", direction: "vertical", children: controls },
      { type: "layout", direction: "vertical", children: results }
    ]
  });
}

function renderSearchView(api) {
  var children = [];
  var note = makeMissingDepNote();
  if (note) children.push(note);

  // Source tabs (which extractor the search box queries) + the debug-only Tuning
  // and Last-resolve tabs that only exist while debug scoring is on.
  var sourceTabs = [];
  for (var i = 0; i < SOURCE_ORDER.length; i++) {
    var k = SOURCE_ORDER[i];
    sourceTabs.push({ id: k, label: SOURCES[k].label });
  }
  if (debugScoring) {
    sourceTabs.push({ id: "__tune", label: "🔧 Tuning" });
    sourceTabs.push({ id: "__resolve", label: "🧭 Last resolve" });
  }
  var activeTab = (resolveOpen && debugScoring) ? "__resolve"
    : (tuneOpen && debugScoring) ? "__tune" : searchSource;
  children.push({ type: "tabs", tabs: sourceTabs, activeTab: activeTab, action: "ytdlp-source" });

  // The debug tabs replace the search UI within the same sidebar item.
  if (tuneOpen && debugScoring) {
    appendTuningView(children);
    api.ui.setViewData("ytdlp-search", { type: "layout", direction: "vertical", children: children }, { scrollKey: "__tune" });
    return;
  }
  if (resolveOpen && debugScoring) {
    appendResolveView(children);
    api.ui.setViewData("ytdlp-search", { type: "layout", direction: "vertical", children: children }, { scrollKey: "__resolve" });
    return;
  }

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
    for (var j = 0; j < results.length; j++) items.push(buildResultRow(results[j], j));
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
        }, {
          type: "settings-row",
          label: "Max video quality",
          description: "Highest video resolution to stream or download. Streaming above 720p needs the native (mpv) playback engine — it merges the separate video and audio streams; the browser engine tops out at the muxed 360–720p stream. Also the default for video downloads.",
          control: {
            type: "select", action: "ytdlp-max-res", value: String(maxVideoHeight),
            options: VIDEO_RESOLUTIONS.map(function (r) {
              return { value: String(r.height), label: r.height === 0 ? "Best available" : r.label };
            })
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
      },
      {
        type: "section", title: "Debugging", children: [{
          type: "settings-row",
          label: "Show scoring in results",
          description: "Annotate each search result with its ranking score, show a \"Last resolve\" panel of what the automated picks considered, and add a \"🔧 Tuning\" tab to the yt-dlp sidebar. In Tuning you can rank a real search with the Audio or Video profile, see the full per-signal breakdown, and edit the weights live — the same weights that drive which video the automated audio (playback/download) and video (Watch / preferVideo) resolves pick.",
          control: {
            type: "toggle", action: "ytdlp-debug-scoring", checked: debugScoring
          }
        }]
      }
    ]
  });
}

function deactivate() {
  ytDlpVersion = null; ffmpegVersion = null; statusLoaded = false;
  // The host drops our provider + handler on unload, so a disable/enable cycle
  // has to register again — leaving this set would silently lose the provider.
  globalSearchRegistered = false;
  inFlightFiles = {}; lastSourceFile = null;
  tabState = {}; searching = false; searchingSource = null; searchGen = 0;
  botGateNotified = false; deepDiagnosticsRun = false; lastResolve = null;
  // Drop both caches: a disable/enable cycle is the user's way of saying "start
  // over", and a stale signed URL surviving it would be the first thing to fail.
  streamUrlCache = {}; searchCache = {};
  scoringAudio = null; scoringVideo = null;
  resolveOpen = false;
  tuneOpen = false; tuneProfile = "audio"; tuneQuery = ""; tuneTarget = null;
  tuneResults = null; tuneBusy = false; tuneParamText = {}; tuneTargetRaw = null;
}

return {
  activate: activate,
  deactivate: deactivate,
  // Exposed for the test harness.
  _parseTrackTitle: parseTrackTitle,
  _formatDuration: formatDuration,
  _formatViews: formatViews,
  _scoreCandidates: scoreCandidates,
  _rerankByViews: rerankByViews,
  _formatScoreDebug: formatScoreDebug,
  _SCORING_PARAMS: SCORING_PARAMS,
  _defaultProfile: defaultProfile,
  _normalizeProfile: normalizeProfile,
  _durationScore: durationScore,
  _parseDurationInput: parseDurationInput,
  _candidateSignals: candidateSignals,
  _scoreWithProfile: scoreWithProfile,
  _rankByProfile: rankByProfile,
  _formatProfileScore: formatProfileScore,
  _buildResultRow: buildResultRow,
  _encodeRef: encodeRef,
  _decodeRef: decodeRef,
  _cacheStem: cacheStem,
  _buildDownloadArgs: buildDownloadArgs,
  _parseMetadataLine: parseMetadataLine,
  _parseProgressLine: parseProgressLine,
  _isProgressLine: isProgressLine,
  _thumbFor: thumbFor,
  _parseSearchOutput: parseSearchOutput,
  _decodeHtmlEntities: decodeHtmlEntities,
  _classifyYtdlpError: classifyYtdlpError,
  _warrantsDeepDiagnostics: warrantsDeepDiagnostics,
  _cacheGet: cacheGet,
  _cachePut: cachePut,
  _streamUrlExpiry: streamUrlExpiry,
  _cloneSearchResult: cloneSearchResult,
  _isOlderVersion: isOlderVersion,
  _pickHlsMaster: pickHlsMaster,
  _parseDirectOutput: parseDirectOutput,
  _streamUriResult: streamUriResult,
  _candidatesFromFormats: candidatesFromFormats,
  _selfContainedUrl: selfContainedUrl,
  _storyboardFromFormats: storyboardFromFormats,
  _putStoryboardCache: putStoryboardCache,
  _parseVideoFormat: parseVideoFormat,
  _videoFormatSelector: videoFormatSelector,
  _dropSoundcloudPreviews: dropSoundcloudPreviews,
  _loadToolStatus: loadToolStatus
};
