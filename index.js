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

// Sidebar search view state.
var searchQuery = "";
var searchKind = "audio"; // "audio" | "video" — what Play/Queue/Download produce
var searchResults = null; // array of candidates, or null before first search
var searching = false;
// Bumped on every search start AND on cancel; an in-flight search compares its
// captured generation and discards its result if the value has moved on.
var searchGen = 0;

// Cache-eviction bookkeeping (see cleanupCache).
var inFlightFiles = {};
var lastSourceFile = null;
var cleanupChain = Promise.resolve();
var convSeq = 0; // monotonic counter for unique temp filenames

// ---------------------------------------------------------------------------
// Search sources
// ---------------------------------------------------------------------------
// prefix: the yt-dlp search extractor ("" ⇒ no search, URL/paste only).
var SOURCES = {
  youtube:    { label: "YouTube",    prefix: "ytsearch" },
  soundcloud: { label: "SoundCloud", prefix: "scsearch" }
};
// Ordered list for the source tabs.
var SOURCE_ORDER = ["youtube", "soundcloud"];

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
    image_url: c.thumbnail || undefined
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
  var q = (query || "").trim();
  if (!q) return [];
  var n = count || 25;
  var target;
  if (isHttpUrl(q)) {
    // Pasted URL — resolve that exact item (Bandcamp/Vimeo/etc. have no search
    // prefix, but a direct URL always works). --no-playlist keeps it to one item.
    target = q;
  } else {
    var src = SOURCES[source] || SOURCES.youtube;
    if (!src.prefix) return [];
    target = src.prefix + n + ":" + q;
  }
  var args = [
    target,
    "--flat-playlist",
    "--no-playlist",
    "--no-warnings",
    // Comma fields = first non-null. thumbnail is best-effort.
    "--print", "%(url,webpage_url)s\t%(duration)s\t%(uploader,channel,uploader_id)s\t%(title)s\t%(thumbnail)s"
  ];
  api.log("info", "Running: " + formatCmd("yt-dlp", args), "ytdlp");
  var res;
  try {
    res = await api.system.exec("yt-dlp", args);
  } catch (e) {
    api.log("warn", "yt-dlp search exec failed: " + (e && e.message ? e.message : e), "ytdlp");
    return [];
  }
  if (res.exitCode !== 0 || !res.stdout) {
    api.log("warn", "yt-dlp search returned no results (exit " + res.exitCode + ")" +
      (res.stderr ? ": " + res.stderr.trim() : ""), "ytdlp");
    return [];
  }
  var lines = res.stdout.split("\n"), out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line || !line.trim()) continue;
    var cols = line.split("\t");
    var url = cols[0];
    if (!isHttpUrl(url)) continue;
    var durRaw = cols[1];
    var dur = durRaw && durRaw !== "NA" ? parseInt(durRaw, 10) : NaN;
    var uploader = cols[2] && cols[2] !== "NA" ? cols[2] : "";
    var title = cols[3] && cols[3] !== "NA" ? cols[3] : null;
    var thumb = cols[4] && cols[4] !== "NA" && isHttpUrl(cols[4]) ? cols[4] : null;
    out.push({ url: url, title: title, uploader: uploader, durationSecs: isNaN(dur) ? null : dur, thumbnail: thumb });
  }
  return out;
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
  var candidates = await runSearch(api, "youtube", query, 7);
  return pickBestCandidate(candidates, durationSecs, api);
}

// ---------------------------------------------------------------------------
// Format probing + conversion (audio) — mirrors the proven youtube path
// ---------------------------------------------------------------------------
var AUDIO_FORMATS = {
  aac:  { ext: "m4a",  encoder: "aac",        copyCodecs: ["aac"] },
  m4a:  { ext: "m4a",  encoder: "aac",        copyCodecs: ["aac"] },
  mp3:  { ext: "mp3",  encoder: "libmp3lame", copyCodecs: ["mp3"] },
  flac: { ext: "flac", encoder: "flac",       copyCodecs: ["flac"] },
  opus: { ext: "opus", encoder: "libopus",    copyCodecs: ["opus"] }
};

async function probeAudio(api, filePath) {
  try {
    var probe = await api.system.exec("ffmpeg", ["-i", filePath, "-hide_banner"]);
    var stderr = probe.stderr || "", lines = stderr.split("\n"), streamLine = null;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("Audio:") !== -1) { streamLine = lines[i]; break; }
    }
    if (!streamLine) return null;
    var codecMatch = streamLine.match(/Audio:\s*([a-zA-Z0-9_]+)/);
    var brMatch = streamLine.match(/(\d+)\s*kb\/s/);
    return {
      codec: codecMatch ? codecMatch[1].toLowerCase() : null,
      bitrateKbps: brMatch ? parseInt(brMatch[1], 10) : null
    };
  } catch (e) {
    api.log("warn", "probeAudio failed: " + (e && e.message ? e.message : e), "ytdlp");
    return null;
  }
}

function buildConvertArgs(srcPath, destPath, fmt, probe) {
  var spec = AUDIO_FORMATS[fmt];
  if (!spec) return null;
  var codec = probe ? probe.codec : null;
  if (codec && spec.copyCodecs.indexOf(codec) !== -1) {
    return { mode: "copy", args: ["-i", srcPath, "-vn", "-c:a", "copy", "-y", destPath] };
  }
  if (spec.encoder === "flac") return { mode: "encode", args: ["-i", srcPath, "-vn", "-c:a", "flac", "-y", destPath] };
  var bitrateKbps = probe && probe.bitrateKbps ? probe.bitrateKbps : 160;
  var targetKbps = Math.max(96, Math.min(320, bitrateKbps));
  return { mode: "encode", bitrate: targetKbps, args: ["-i", srcPath, "-vn", "-c:a", spec.encoder, "-b:a", targetKbps + "k", "-y", destPath] };
}

// ---------------------------------------------------------------------------
// Cache management (LRU by mtime, budget = cacheMaxMb)
// ---------------------------------------------------------------------------
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
async function getDirectUrl(api, url, isVideo) {
  var fmt = isVideo ? "best[ext=mp4]/best" : "bestaudio[ext=m4a]/bestaudio";
  var args = ["-g", "-f", fmt, "--no-warnings", "--no-playlist", url];
  api.log("info", "Running: " + formatCmd("yt-dlp", args), "ytdlp");
  var res;
  try { res = await api.system.exec("yt-dlp", args, { cwd: null }); }
  catch (e) { api.log("warn", "yt-dlp -g exec failed: " + (e && e.message ? e.message : e), "ytdlp"); return null; }
  if (res.exitCode !== 0 || !res.stdout) return null;
  // -g prints one URL per selected stream. For our single-stream selectors the
  // last non-empty line is the (only) media URL.
  var lines = res.stdout.split("\n"), direct = null;
  for (var i = lines.length - 1; i >= 0; i--) { var l = lines[i].trim(); if (l) { direct = l; break; } }
  return isHttpUrl(direct) ? direct : null;
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

  var cacheDir = await api.storage.files.getPath(["cache"]);
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

// Resolve a source URL to a PLAYABLE url per the hybrid policy. Returns
// { url, downloaded } or null. `downloaded` marks a file:// result.
async function resolvePlayable(api, url, isVideo) {
  if (playbackMode === "stream") {
    var direct = await getDirectUrl(api, url, isVideo);
    if (direct && await validateDirectUrl(api, direct)) {
      api.log("info", "Streaming directly: " + url, "ytdlp");
      return { url: direct, downloaded: false };
    }
    api.log("info", "Direct stream unavailable — falling back to download: " + url, "ytdlp");
  }
  var filePath = await downloadToCache(api, url, isVideo);
  if (!filePath) return null;
  return { url: "file://" + filePath, downloaded: true, filePath: filePath };
}

// Produce the host download-resolve result for a source URL + chosen format.
// "original" / "video" → fast direct URL (backend downloads, no transcode/merge
// needed for muxed video is the exception — video always downloads+merges).
async function resolveDownload(api, url, format, title, artistName, albumName) {
  var fmt = format || "original";

  // Video: always download+merge locally to a real mp4, then serve file://.
  if (fmt === "video") {
    if (!ffmpegVersion) api.log("warn", "ffmpeg missing — video merge may fail", "ytdlp");
    var vPath = await downloadToCache(api, url, true);
    if (!vPath) return null;
    return await withCacheProtection(api, vPath, function () {
      return { url: "file://" + vPath, headers: null, ext: extOf(vPath) || "mp4",
        metadata: { title: title, artist: artistName || undefined, album: albumName || undefined } };
    });
  }

  // Original audio (no transcode): hand the backend a direct URL to stream to
  // disk. ext:"auto" makes it sniff the true container. Sidesteps resolve caps.
  if (fmt === "original" || !AUDIO_FORMATS[fmt] || !ffmpegVersion) {
    if (fmt !== "original" && !ffmpegVersion) api.log("warn", "ffmpeg missing — serving original audio instead of " + fmt, "ytdlp");
    var direct = await getDirectUrl(api, url, false);
    if (direct) {
      return { url: direct, headers: null, ext: "auto",
        metadata: { title: title, artist: artistName || undefined, album: albumName || undefined } };
    }
    // Fall through to a local download if -g failed.
    var aPath0 = await downloadToCache(api, url, false);
    if (!aPath0) return null;
    return await withCacheProtection(api, aPath0, function () {
      return { url: "file://" + aPath0, headers: null, ext: extOf(aPath0) || "auto",
        metadata: { title: title, artist: artistName || undefined, album: albumName || undefined } };
    });
  }

  // Transcoded audio (aac/mp3/flac/opus): download source, convert with ffmpeg.
  var srcPath = await downloadToCache(api, url, false);
  if (!srcPath) return null;
  return await withCacheProtection(api, srcPath, async function () {
    var spec = AUDIO_FORMATS[fmt];
    var srcExt = extOf(srcPath);
    var probe = await probeAudio(api, srcPath);
    var destName = cacheStem(url, false) + "." + (convSeq++) + "." + spec.ext;
    var destPath = await api.storage.files.writeText(["temp", destName], "");
    var conv = buildConvertArgs(srcPath, destPath, fmt, probe);
    var finalPath = srcPath;
    if (conv && !(conv.mode === "copy" && srcExt === spec.ext)) {
      var label = conv.mode === "copy" ? "Remuxing (codec copy)" : "Transcoding to " + fmt + (conv.bitrate ? " @ " + conv.bitrate + "k" : "");
      api.log("info", label + " -> " + destPath, "ytdlp");
      var ff = await api.system.exec("ffmpeg", conv.args);
      if (ff.exitCode === 0) finalPath = destPath;
      else api.log("error", "Conversion failed (exit " + ff.exitCode + "): " + (ff.stderr || "").trim() + " — serving source", "ytdlp");
    }
    return { url: "file://" + finalPath, headers: null, ext: extOf(finalPath) || undefined,
      metadata: { title: title, artist: artistName || undefined, album: albumName || undefined } };
  });
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
async function activate(api) {
  var stored = await Promise.all([
    api.storage.get("cacheMaxMb"),
    api.storage.get("playbackMode"),
    api.storage.get("searchSource")
  ]);
  if (stored[0] != null && typeof stored[0] === "number") cacheMaxMb = stored[0];
  if (stored[1] === "download" || stored[1] === "stream") playbackMode = stored[1];
  if (stored[2] && SOURCES[stored[2]]) searchSource = stored[2];

  // Startup cleanup: wipe transcoded temp files; keep cached source downloads.
  scheduleCleanup(api, true).catch(function (e) { api.log("warn", "Startup cache cleanup failed: " + (e && e.message ? e.message : e), "ytdlp"); });

  // ---- Playback: metadata fallback resolver (the "youtube-fallback" role) ----
  api.playback.onStreamResolve("ytdlp-fallback", async function (title, artistName, albumName, durationSecs) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) { api.log("warn", "Stream resolve skipped — yt-dlp not available", "ytdlp"); return null; }
    title = stripRemasterSuffix(title);
    try {
      var cand = await searchByMetadata(api, title, artistName, durationSecs);
      if (!cand) { api.log("warn", "No match for: " + title, "ytdlp"); return null; }
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

  // ---- Download provider: qualities ----
  api.downloads.onGetQualities("ytdlp-download", function () {
    var q = [{ value: "original", label: "Original audio (no re-encode)" }];
    if (ffmpegVersion) {
      q.push({ value: "aac", label: "AAC (matches source bitrate)" });
      q.push({ value: "mp3", label: "MP3 (matches source bitrate)" });
      q.push({ value: "opus", label: "Opus (matches source bitrate)" });
      q.push({ value: "flac", label: "FLAC (lossless re-encode)" });
      q.push({ value: "video", label: "Video (MP4, best quality)" });
    }
    return q;
  });

  // ---- Download provider: by URI (ytdlp:// or legacy youtube://) ----
  api.downloads.onResolveByUri("ytdlp-download", async function (uri, format) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) return null;
    var url = null, videoTitle = null;
    if (uri && uri.indexOf("ytdlp://") === 0) {
      var ref = decodeRef(uri.substring("ytdlp://".length));
      if (ref) { url = ref.url; if (ref.isVideo && !format) format = "video"; }
    } else if (uri && uri.indexOf("youtube://") === 0) {
      var yid = uri.substring("youtube://".length);
      if (YT_ID_RE.test(yid)) url = youtubeWatchUrl(yid);
    }
    if (!url) { api.log("warn", "Download URI resolve: unrecognized uri " + uri, "ytdlp"); return null; }
    try { return await resolveDownload(api, url, format, videoTitle || url, null, null); }
    catch (e) { console.error("[ytdlp] download URI resolve failed:", e, e.stack || ""); return null; }
  });

  // ---- Download provider: by metadata (stream-resolver-win fallback path) ----
  api.downloads.onResolveByMetadata("ytdlp-download", async function (title, artistName, albumName, durationSecs, format) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) return null;
    title = stripRemasterSuffix(title);
    try {
      var cand = await searchByMetadata(api, title, artistName, durationSecs);
      if (!cand) return null;
      return await resolveDownload(api, cand.url, format, title, artistName, albumName);
    } catch (e) { console.error("[ytdlp] download resolve failed:", e, e.stack || ""); return null; }
  });

  // ---- Download provider: interactive (download modal manual search) ----
  api.downloads.onInteractiveSearch("ytdlp-download", async function (query, limit) {
    await ensureToolStatus(api);
    if (!ytDlpVersion) return [];
    var candidates = await runSearch(api, searchSource, query, limit || 10);
    var out = [];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i], parsed = parseTrackTitle(c.title, c.uploader);
      out.push({
        id: encodeRef(c.url, false), // audio identity; video handled via the sidebar
        title: parsed.title || c.title || c.url,
        artistName: parsed.artist || c.uploader || undefined,
        durationSecs: c.durationSecs != null ? c.durationSecs : undefined,
        coverUrl: c.thumbnail || undefined
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
    var result = await resolveDownload(api, url, format, url, null, null);
    if (!result) throw new Error("Failed to download " + url);
    return result;
  });

  // ---- Sidebar search view ----
  api.ui.onAction("ytdlp-source", function (data) {
    var s = data && data.value;
    if (s && SOURCES[s]) { searchSource = s; api.storage.set("searchSource", s); renderSearchView(api); }
  });
  api.ui.onAction("ytdlp-kind", function (data) {
    var k = data && data.value;
    if (k === "audio" || k === "video") { searchKind = k; renderSearchView(api); }
  });

  api.ui.onAction("ytdlp-search-submit", async function (data) {
    if (searching) { // click while searching = cancel
      searchGen++; searching = false; renderSearchView(api); return;
    }
    searchQuery = data && typeof data.query === "string" ? data.query : "";
    if (!searchQuery.trim()) { searchResults = null; renderSearchView(api); return; }
    await ensureToolStatus(api);
    if (!ytDlpVersion) { renderSearchView(api); return; }
    var gen = ++searchGen;
    searching = true; renderSearchView(api);
    try {
      var results = await runSearch(api, searchSource, searchQuery, 25);
      if (gen !== searchGen) return; // cancelled/superseded
      searchResults = results;
    } catch (e) {
      if (gen !== searchGen) return;
      api.log("error", "Search failed: " + (e && e.message ? e.message : e), "ytdlp");
      searchResults = [];
    }
    searching = false; renderSearchView(api);
  });

  function findResult(refId) {
    if (!searchResults) return null;
    for (var i = 0; i < searchResults.length; i++) {
      if (encodeRef(searchResults[i].url, false) === refId || searchResults[i].url === refId) return searchResults[i];
    }
    return null;
  }
  function selectedResults(data) {
    var ids = data && data.selectedIds ? data.selectedIds : [], out = [];
    for (var i = 0; i < ids.length; i++) { var c = findResult(ids[i]); if (c) out.push(c); }
    return out;
  }

  api.ui.onAction("ytdlp-play", function (data) {
    var chosen = selectedResults(data);
    if (chosen.length === 0 || !ytDlpVersion) return;
    var isVideo = searchKind === "video", tracks = [];
    for (var i = 0; i < chosen.length; i++) tracks.push(buildTrack(chosen[i], isVideo));
    api.playback.playTracks(tracks, 0);
  });
  api.ui.onAction("ytdlp-queue", function (data) {
    var chosen = selectedResults(data);
    if (chosen.length === 0 || !ytDlpVersion) return;
    var isVideo = searchKind === "video", tracks = [];
    for (var i = 0; i < chosen.length; i++) tracks.push(buildTrack(chosen[i], isVideo));
    api.playback.insertTracks(tracks, -1);
  });
  api.ui.onAction("ytdlp-play-one", function (data) {
    var id = data && data.itemId;
    if (!id || !ytDlpVersion) return;
    var c = findResult(id);
    if (c) api.playback.playTracks([buildTrack(c, searchKind === "video")], 0);
  });
  api.ui.onAction("ytdlp-download", function (data) {
    var chosen = selectedResults(data);
    if (chosen.length === 0) return;
    if (!ytDlpVersion) { api.ui.showNotification("yt-dlp isn't installed — see Settings → Dependencies."); return; }
    var isVideo = searchKind === "video", tracks = [];
    for (var i = 0; i < chosen.length; i++) {
      var t = buildTrack(chosen[i], isVideo);
      tracks.push({ title: t.title, artist_name: t.artist_name, album_title: null, uri: t.path, durationSecs: t.duration_secs });
    }
    api.ui.requestAction("download-tracks", { providerId: "ytdlp:ytdlp-download", providerName: "yt-dlp", tracks: tracks });
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

  // Audio / Video kind toggle.
  children.push({ type: "tabs", tabs: [
    { id: "audio", label: "Audio" }, { id: "video", label: "Video" }
  ], activeTab: searchKind, action: "ytdlp-kind" });

  children.push({
    type: "search-input",
    placeholder: "Search " + (SOURCES[searchSource] ? SOURCES[searchSource].label : "") + ", or paste a URL…",
    action: "ytdlp-search-submit",
    value: searchQuery,
    buttonLabel: searching ? "Cancel" : "Search"
  });

  if (searching) {
    children.push({ type: "loading", message: "Searching…" });
  } else if (searchResults && searchResults.length > 0) {
    var items = [];
    for (var j = 0; j < searchResults.length; j++) {
      var c = searchResults[j], parsed = parseTrackTitle(c.title, c.uploader);
      items.push({
        id: encodeRef(c.url, false),
        title: parsed.title || c.title || c.url,
        subtitle: parsed.artist || c.uploader || "",
        duration: formatDuration(c.durationSecs),
        imageUrl: c.thumbnail || undefined,
        action: "ytdlp-play-one"
      });
    }
    children.push({
      type: "track-row-list",
      selectable: true,
      items: items,
      actions: [
        { id: "ytdlp-play", label: "Play", icon: "▶" },
        { id: "ytdlp-queue", label: "Queue", icon: "+" },
        { id: "ytdlp-download", label: "Download", icon: "⬇" }
      ]
    });
  } else if (searchResults && searchResults.length === 0) {
    children.push({ type: "text", content: "No results.", className: "ds-empty" });
  } else {
    children.push({ type: "text", content: "Search or paste a link to play or download " + searchKind + ".", className: "ds-empty" });
  }

  api.ui.setViewData("ytdlp-search", { type: "layout", direction: "vertical", children: children }, { scrollKey: searchSource + ":" + searchKind });
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
  searchQuery = ""; searchResults = null; searching = false; searchGen = 0;
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
  _buildConvertArgs: buildConvertArgs,
  _loadToolStatus: loadToolStatus
};
