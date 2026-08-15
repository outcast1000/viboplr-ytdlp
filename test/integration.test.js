const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

// Exec rules: version rules FIRST (getDependency picks the first cmd match), then
// the behavioral rules for -g / download / search.
function toolsPresent(extra) {
  return [
    { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.01.01" } },
    { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 7.0" } },
    ...(extra || []),
  ];
}

const DIRECT_URL = "https://direct.example/media.m4a";
// view_count is col 5 (after thumbnail); row a outranks row b on views so the
// view re-ranker keeps source order and the order-dependent assertions hold.
const SEARCH_STDOUT =
  "https://www.youtube.com/watch?v=aaaaaaaaaaa\t213\tRadiohead\tRadiohead - Creep\thttps://i.ytimg.com/x.jpg\t1000000\n" +
  "https://www.youtube.com/watch?v=bbbbbbbbbbb\t180\tBjork\tBjork - Joga\tNA\t5000";

// getDirectUrl asks for two --print lines in one extraction: the media url, then
// that format's http_headers as JSON. `%(urls)s` identifies the call.
const DIRECT_HEADERS = { "User-Agent": "Mozilla/5.0 (mock)", Referer: "https://example/" };
const DIRECT_STDOUT = DIRECT_URL + "\n" + JSON.stringify(DIRECT_HEADERS);

const BEHAVIOR = [
  { match: { cmd: "yt-dlp", argsInclude: ["%(urls)s"] }, result: { exitCode: 0, stdout: DIRECT_STDOUT } },
  { match: { cmd: "yt-dlp", argsInclude: ["after_move:filepath"] }, result: { exitCode: 0, stdout: "/mock-plugin-data/cache/abc.m4a" } },
  { match: { cmd: "yt-dlp", argsInclude: ["--flat-playlist"] }, result: { exitCode: 0, stdout: SEARCH_STDOUT } },
];

async function activated(config) {
  const api = makeApi(config);
  const plugin = loadPlugin();
  await plugin.activate(api);
  // activate() defers its first dependency-status load to a setTimeout(…, 0);
  // flush it so synchronous readers (onGetQualities) see the loaded status,
  // mirroring the real app where the download modal opens long after activation.
  await new Promise((r) => setTimeout(r, 5));
  return { api, plugin };
}

// index.js ships verbatim in the release zip and is executed by the host, so a
// stray control byte lands on users' machines. One got in via a hand-typed
// separator that looked like a space and was a NUL: JS accepted it inside a
// string literal, every test passed, and the only visible symptom was `file`
// reporting the source as binary and grep silently refusing to match it.
test("index.js is clean text — no control bytes", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"));
  const bad = [];
  for (const [i, b] of src.entries()) {
    if (b < 0x09 || (b > 0x0d && b < 0x20)) bad.push({ byte: b, offset: i });
  }
  assert.deepEqual(bad, [], "control bytes in shipped source");
});

test("registers all expected handlers", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR), fetch: { "direct.example": { status: 200 } } });
  const expected = [
    "stream:ytdlp-fallback", "streamuri:ytdlp", "streamuri:youtube",
    "uri:ytdlp-download", "meta:ytdlp-download", "qual:ytdlp-download",
    "isearch:ytdlp-download", "iresolve:ytdlp-download",
    "action:ytdlp-search-submit", "action:ytdlp-play", "action:ytdlp-watch",
    "action:ytdlp-queue-video", "action:ytdlp-download",
    "action:ytdlp-playback-mode", "action:ytdlp-cache-size",
    "ctx:ytdlp-watch-video",
  ];
  for (const h of expected) assert.ok(api._handlers[h], "missing handler: " + h);
});

test("qualities: original always; transcodes + video only when ffmpeg present", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR) });
  const q = api._handlers["qual:ytdlp-download"]();
  const values = q.map((x) => x.value);
  // Audio (opus dropped in v1.8.0) + video "Best" plus one capped option per
  // resolution (v1.9.0 — mirrors the streaming resolution choices).
  assert.deepEqual(
    values,
    ["original", "aac", "mp3", "flac", "video", "video-2160", "video-1080", "video-720", "video-480"],
  );
  // Labels lead with the type; every option carries a description for newer hosts.
  for (const opt of q) {
    assert.match(opt.label, /^(Audio|Video) · /, opt.value + " label starts with its type");
    assert.ok(opt.description && opt.description.length > 0, opt.value + " has a description");
  }
  // Every video option is flagged so the modal defaults to one for a video item.
  for (const opt of q.filter((x) => x.value.startsWith("video"))) {
    assert.equal(opt.video, true, opt.value + " is flagged video");
  }

  // yt-dlp present but ffmpeg absent -> only "original".
  const noff = await activated({
    exec: [{ match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.01.01" } }],
  });
  const q2 = noff.api._handlers["qual:ytdlp-download"]();
  assert.deepEqual(q2.map((x) => x.value), ["original"]);
});

// A ytdlp:// audio track (sidebar search, Cmd+K, a saved playlist of either)
// resolves here, not through the metadata fallback. A single URL string cannot
// carry headers, so when the stream needs them the answer is a one-element
// candidate list — the only shape in the host contract that can.
test("stream URI resolve returns one candidate carrying the stream's headers", async () => {
  const { api, plugin } = await activated({ exec: toolsPresent(BEHAVIOR) });
  const page = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
  const id = plugin._encodeRef(page, false).slice("ytdlp://".length);
  const res = await api._handlers["streamuri:ytdlp"](id);
  assert.deepEqual(res, {
    candidates: [{ url: DIRECT_URL, kind: "audio", headers: DIRECT_HEADERS }],
    sourceUrl: page,
  });
  // Still ONE extraction — no separate preflight, and no format enumeration.
  assert.equal(api.calls.exec.filter((call) => call.args.includes("%(urls)s")).length, 1);
  assert.ok(!api.calls.exec.some((c) => c.args.includes("-j")), "no format enumeration for a plain audio resolve");
});

// Caching is about yt-dlp INVOCATIONS, not just latency: each extraction is a
// request to the source, and YouTube rate-gates a device that makes too many.
test("a repeat resolve of the same track runs no yt-dlp at all", async () => {
  const { api, plugin } = await activated({ exec: toolsPresent(BEHAVIOR) });
  const id = plugin._encodeRef("https://www.youtube.com/watch?v=aaaaaaaaaaa", false).slice("ytdlp://".length);
  const resolves = () => api.calls.exec.filter((c) => c.args.includes("%(urls)s")).length;

  const first = await api._handlers["streamuri:ytdlp"](id);
  assert.equal(resolves(), 1);
  const second = await api._handlers["streamuri:ytdlp"](id);
  assert.equal(resolves(), 1, "second resolve served from cache");
  assert.deepEqual(second, first, "and it is the same answer, headers included");
});

test("audio and video of one source are cached separately", async () => {
  // The two use different format selectors, so an audio resolve must never be
  // served a video URL just because the source page matches.
  const { api, plugin } = await activated({ exec: toolsPresent(BEHAVIOR) });
  const url = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
  await api._handlers["streamuri:ytdlp"](plugin._encodeRef(url, false).slice("ytdlp://".length));
  await api._handlers["streamuri:ytdlp"](plugin._encodeRef(url, true).slice("ytdlp://".length));
  assert.equal(api.calls.exec.filter((c) => c.args.includes("%(urls)s")).length, 2);
});

test("a repeat search runs no yt-dlp, and an empty one is never cached", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR) });
  const searches = () => api.calls.exec.filter((c) => c.args.includes("--flat-playlist")).length;

  const first = await api._handlers["isearch:ytdlp-download"]("radiohead", 10);
  assert.equal(searches(), 1);
  const second = await api._handlers["isearch:ytdlp-download"]("radiohead", 10);
  assert.equal(searches(), 1, "repeat query served from cache");
  assert.deepEqual(second, first);

  // A different query is a different key.
  await api._handlers["isearch:ytdlp-download"]("bjork", 10);
  assert.equal(searches(), 2);
});

test("a failed search is not cached, so a retry really retries", async () => {
  // This is the bot-gate guard: during a gate EVERY search comes back empty, and
  // caching that would pin the outage in place for the whole TTL — precisely
  // when a user retries most.
  const failing = [
    { match: { cmd: "yt-dlp", argsInclude: ["--flat-playlist"] }, result: { exitCode: 1, stderr: "Sign in to confirm you’re not a bot" } },
    ...BEHAVIOR,
  ];
  const { api } = await activated({ exec: toolsPresent(failing) });
  const searches = () => api.calls.exec.filter((c) => c.args.includes("--flat-playlist")).length;

  assert.deepEqual(await api._handlers["isearch:ytdlp-download"]("radiohead", 10), []);
  assert.equal(searches(), 1);
  assert.deepEqual(await api._handlers["isearch:ytdlp-download"]("radiohead", 10), []);
  assert.equal(searches(), 2, "the empty result was not cached");
});

test("a headerless stream still resolves to the same URL, and still names its page", async () => {
  const noHeaders = [
    { match: { cmd: "yt-dlp", argsInclude: ["%(urls)s"] }, result: { exitCode: 0, stdout: DIRECT_URL } },
    ...BEHAVIOR,
  ];
  const { api, plugin } = await activated({ exec: toolsPresent(noHeaders) });
  const page = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
  const id = plugin._encodeRef(page, false).slice("ytdlp://".length);
  assert.deepEqual(await api._handlers["streamuri:ytdlp"](id), {
    candidates: [{ url: DIRECT_URL, kind: "audio" }],
    sourceUrl: page,
  });
});

test("download mode skips the direct-url extraction and downloads directly", async () => {
  const { api, plugin } = await activated({
    exec: toolsPresent(BEHAVIOR),
    storage: { kv: { playbackMode: "download" } },
  });
  const id = plugin._encodeRef("https://www.youtube.com/watch?v=aaaaaaaaaaa", false).slice("ytdlp://".length);
  const res = await api._handlers["streamuri:ytdlp"](id);
  assert.equal(res.candidates[0].url, "file:///mock-plugin-data/cache/abc.m4a");
  // No direct-url extraction should have been attempted.
  assert.ok(!api.calls.exec.some((c) => c.args.includes("%(urls)s")));
});

test("legacy youtube:// scheme still resolves, with headers", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR), fetch: { "direct.example": { status: 200 } } });
  const res = await api._handlers["streamuri:youtube"]("dQw4w9WgXcQ");
  assert.deepEqual(res, {
    candidates: [{ url: DIRECT_URL, kind: "audio", headers: DIRECT_HEADERS }],
    // The legacy scheme carries only the video id, so the watch URL it stands
    // for is the page — same attribution a ytdlp:// track gets.
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  });
  // Bad id is rejected.
  assert.equal(await api._handlers["streamuri:youtube"]("not-an-id"), null);
});

test("interactive search parses rows into results with encoded ids", async () => {
  const { api, plugin } = await activated({ exec: toolsPresent(BEHAVIOR) });
  const results = await api._handlers["isearch:ytdlp-download"]("radiohead", 10);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Creep");
  assert.equal(results[0].artistName, "Radiohead");
  assert.equal(results[0].durationSecs, 213);
  assert.equal(results[0].id, plugin._encodeRef("https://www.youtube.com/watch?v=aaaaaaaaaaa", false));
  // Flat search yields no thumbnail ("NA") -> deterministic per-video fallback.
  assert.equal(results[1].coverUrl, "https://i.ytimg.com/vi/bbbbbbbbbbb/mqdefault.jpg");
});

// yt-dlp's own metadata (real artist/album/year) is embedded and returned; the
// caller's authoritative fields (title/artist) win over yt-dlp's guesses.
// The metadata line is printed by the DOWNLOAD RUN itself (before the
// after_move filepath line) — there is no separate metadata fetch anymore.
const META_STDOUT = "Creep\tRadiohead\tPablo Honey\t1992\tCreep";
function withMeta(extra) {
  return [
    // Must precede BEHAVIOR's generic single-line after_move rule.
    { match: { cmd: "yt-dlp", argsInclude: ["after_move:filepath"] }, result: { exitCode: 0, stdout: META_STDOUT + "\n/mock-plugin-data/cache/abc.m4a" } },
    ...BEHAVIOR,
    ...(extra || []),
  ];
}

test("'original' downloads locally, embeds tags (not cover art), returns a file with real metadata", async () => {
  const { api } = await activated({ exec: toolsPresent(withMeta()) });
  const result = await api._handlers["meta:ytdlp-download"]("Creep", "Radiohead", null, 213, "original");
  assert.ok(result.url.startsWith("file://"));
  assert.equal(result.metadata.title, "Creep");     // caller-authoritative
  assert.equal(result.metadata.artist, "Radiohead"); // caller-authoritative
  assert.equal(result.metadata.album, "Pablo Honey"); // from yt-dlp (caller album was null)
  assert.equal(result.metadata.year, 1992);           // from yt-dlp
  const dl = api.calls.exec.find((c) => c.cmd === "yt-dlp" && c.args.includes("after_move:filepath"));
  assert.ok(dl.args.includes("--embed-metadata"));
  // Cover art is never embedded — `--embed-thumbnail` needs mutagen (missing
  // under the managed zipapp's Python) and would abort the whole download.
  assert.ok(!dl.args.includes("--embed-thumbnail"));
  // original = lossless extract (copy) into a non-webm container, not a transcode.
  assert.equal(dl.args[dl.args.indexOf("--audio-format") + 1], "best");
});

test("'flac' re-encodes via yt-dlp -x --audio-format (real transcode, not a rename)", async () => {
  const { api } = await activated({ exec: toolsPresent(withMeta()) });
  const result = await api._handlers["meta:ytdlp-download"]("Creep", "Radiohead", null, 213, "flac");
  assert.ok(result.url.startsWith("file://"));
  const dl = api.calls.exec.find((c) => c.cmd === "yt-dlp" && c.args.includes("after_move:filepath"));
  assert.ok(dl.args.includes("-x"));
  assert.equal(dl.args[dl.args.indexOf("--audio-format") + 1], "flac");
});

test("interactive resolve of a ytdlp:// uri uses yt-dlp's own metadata", async () => {
  const { api, plugin } = await activated({ exec: toolsPresent(withMeta()) });
  const matchId = plugin._encodeRef("https://www.youtube.com/watch?v=aaaaaaaaaaa", false);
  const result = await api._handlers["iresolve:ytdlp-download"](matchId, "original");
  assert.ok(result.url.startsWith("file://"));
  assert.equal(result.metadata.artist, "Radiohead"); // yt-dlp metadata, not the channel
  assert.equal(result.metadata.album, "Pablo Honey");
});

test("metadata rides the download run — no separate --skip-download fetch", async () => {
  const { api } = await activated({ exec: toolsPresent(withMeta()) });
  const result = await api._handlers["meta:ytdlp-download"]("Creep", "Radiohead", null, 213, "original");
  assert.equal(result.metadata.album, "Pablo Honey");
  assert.ok(!api.calls.exec.some((c) => c.args.includes("--skip-download")),
    "one extraction per download — a second metadata run provokes YouTube's bot gate");
});

test("by-URI download failure PROPAGATES a user-facing reason (YouTube bot check)", async () => {
  const BOT_STDERR = "ERROR: [youtube] obLk8Y--wgw: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.";
  const { api, plugin } = await activated({
    exec: toolsPresent([
      { match: { cmd: "yt-dlp", argsInclude: ["after_move:filepath"] }, result: { exitCode: 1, stderr: BOT_STDERR } },
      ...BEHAVIOR,
    ]),
  });
  const uri = plugin._encodeRef("https://www.youtube.com/watch?v=aaaaaaaaaaa", false);
  await assert.rejects(
    () => api._handlers["uri:ytdlp-download"](uri, "original"),
    (e) => /bot check/.test(e.message),
  );
});

test("first download after the temp wipe self-heals the missing dir (-P null regression)", async () => {
  const { api } = await activated({ exec: toolsPresent(withMeta()) });
  // Mirror the HOST's getPath semantics: null for paths that don't exist on
  // disk (the startup cleanup removes the whole temp dir).
  let tempExists = false;
  const realGetPath = api.storage.files.getPath;
  const realWriteText = api.storage.files.writeText;
  api.storage.files.getPath = async (segs) => (segs[0] === "temp" && !tempExists ? null : realGetPath(segs));
  api.storage.files.writeText = async (segs, text) => { if (segs[0] === "temp") tempExists = true; return realWriteText(segs, text); };

  const result = await api._handlers["meta:ytdlp-download"]("Creep", "Radiohead", null, 213, "original");
  assert.ok(result && result.url.startsWith("file://"), "download must succeed after materializing the dir");
  const dl = api.calls.exec.find((c) => c.args.includes("after_move:filepath"));
  assert.notEqual(String(dl.args[dl.args.indexOf("-P") + 1]), "null", "argv must never carry a null out dir");
});

test("HTTP 403 on download retries ONCE with a fresh extraction and succeeds", async () => {
  let calls = 0;
  const { api } = await activated({
    exec: toolsPresent([
      {
        match: { cmd: "yt-dlp", argsInclude: ["after_move:filepath"] },
        result: () => (++calls === 1
          ? { exitCode: 1, stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden" }
          : { exitCode: 0, stdout: META_STDOUT + "\n/mock-plugin-data/cache/abc.m4a" }),
      },
      ...BEHAVIOR,
    ]),
  });
  const result = await api._handlers["meta:ytdlp-download"]("Creep", "Radiohead", null, 213, "original");
  assert.ok(result && result.url.startsWith("file://"), "retry must succeed");
  assert.equal(calls, 2, "exactly one retry");
});

test("non-403 download failure does NOT retry", async () => {
  let calls = 0;
  const { api } = await activated({
    exec: toolsPresent([
      {
        match: { cmd: "yt-dlp", argsInclude: ["after_move:filepath"] },
        result: () => { calls++; return { exitCode: 1, stderr: "ERROR: [youtube] x: Video unavailable" }; },
      },
      ...BEHAVIOR,
    ]),
  });
  const r = await api._handlers["meta:ytdlp-download"]("Creep", "Radiohead", null, 213, "original");
  assert.equal(r, null);
  assert.equal(calls, 1, "no retry for non-403 failures");
});

test("isOlderVersion compares dotted date-style versions", async () => {
  const p = loadPlugin();
  assert.equal(p._isOlderVersion("2026.03.17", "2026.07.04"), true);
  assert.equal(p._isOlderVersion("2026.07.04", "2026.07.04"), false);
  assert.equal(p._isOlderVersion("2026.07.04", "2026.03.17"), false);
  assert.equal(p._isOlderVersion("7.0", "7.0.1"), true);
  assert.equal(p._isOlderVersion("unknown", "2026.07.04"), false);
});

test("by-metadata download failure still returns null (chain semantics)", async () => {
  const { api } = await activated({
    exec: toolsPresent([
      { match: { cmd: "yt-dlp", argsInclude: ["after_move:filepath"] }, result: { exitCode: 1, stderr: "ERROR: nope" } },
      ...BEHAVIOR,
    ]),
  });
  const r = await api._handlers["meta:ytdlp-download"]("Creep", "Radiohead", null, 213, "original");
  assert.equal(r, null, "the provider chain must be able to fall through to the next provider");
});

test("stream resolve skips cleanly when yt-dlp is unavailable", async () => {
  const { api } = await activated({ exec: [] }); // no tools
  const r = await api._handlers["stream:ytdlp-fallback"]("Creep", "Radiohead", null, 213);
  assert.equal(r, null);
});

test("sidebar Play produces an AUDIO track; Watch produces a VIDEO (.mp4) track", async () => {
  const { api, plugin } = await activated({ exec: toolsPresent(BEHAVIOR) });
  await api._handlers["action:ytdlp-search-submit"]({ query: "radiohead" });
  const url = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
  const rowId = plugin._encodeRef(url, false); // rows are keyed by the audio ref

  api._handlers["action:ytdlp-play"]({ selectedIds: [rowId] });
  assert.equal(api.calls.playTracks.length, 1);
  assert.equal(api.calls.playTracks[0].tracks[0].path, plugin._encodeRef(url, false));
  assert.ok(!api.calls.playTracks[0].tracks[0].path.endsWith(".mp4"));

  api._handlers["action:ytdlp-watch"]({ selectedIds: [rowId] });
  assert.equal(api.calls.playTracks.length, 2);
  assert.equal(api.calls.playTracks[1].tracks[0].path, plugin._encodeRef(url, true));
  assert.ok(api.calls.playTracks[1].tracks[0].path.endsWith(".mp4"));
});

test("context-menu 'Watch YouTube video' searches YouTube and plays a VIDEO (.mp4) track", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR) });
  // Universal track target — title/artist only, no DB id. Handler is sync but
  // kicks off an async YouTube search, so let it settle before asserting.
  api._handlers["ctx:ytdlp-watch-video"]({ kind: "track", title: "Creep", artistName: "Radiohead" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(api.calls.playTracks.length, 1);
  const path = api.calls.playTracks[0].tracks[0].path;
  assert.ok(path.startsWith("ytdlp://"), "must be a ytdlp:// ref");
  assert.ok(path.endsWith(".mp4"), "watched track must be a video ref");
  // Always searches YouTube (ytsearch:), regardless of the Fallback source setting.
  const searched = api.calls.exec.find((c) => c.args.some((a) => typeof a === "string" && a.indexOf("ytsearch") === 0));
  assert.ok(searched, "context watch should use ytsearch:");
});

test("context-menu 'Watch YouTube video' notifies and does not play when yt-dlp is unavailable", async () => {
  const { api } = await activated({ exec: [] }); // no tools
  api._handlers["ctx:ytdlp-watch-video"]({ kind: "track", title: "Creep", artistName: "Radiohead" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(api.calls.playTracks.length, 0);
  assert.ok(api.calls.showNotification.some((m) => /yt-dlp isn't installed/.test(m)));
});

test("fallback resolver searches YouTube by default", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR), fetch: { "direct.example": { status: 200 } } });
  await api._handlers["stream:ytdlp-fallback"]("Creep", "Radiohead", null, 213);
  const searched = api.calls.exec.find((c) => c.args.some((a) => typeof a === "string" && a.indexOf("ytsearch") === 0));
  assert.ok(searched, "default fallback resolver should use ytsearch:");
});

test("prefer-video hint → fallback resolver returns a video stream flagged video:true", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR), fetch: { "direct.example": { status: 200 } } });
  const r = await api._handlers["stream:ytdlp-fallback"]("Creep", "Radiohead", null, 213, { preferVideo: true });
  assert.equal(r.video, true);
  assert.equal(r.url, DIRECT_URL);
  // Used the video (muxed) format selector, not bestaudio.
  assert.ok(api.calls.exec.some((c) => c.args.includes("%(urls)s") && c.args.join(" ").includes("best[ext=mp4]/best")));
});

test("no hint → fallback resolver returns audio (no video flag)", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR), fetch: { "direct.example": { status: 200 } } });
  const r = await api._handlers["stream:ytdlp-fallback"]("Creep", "Radiohead", null, 213);
  assert.equal(r.url, DIRECT_URL);
  assert.ok(!r.video);
});

// The metadata fallback resolver is the path a plain library track takes, and it
// returns ONE url rather than the by-URI resolver's candidate list — so this is
// its only way to tell the host which headers the signed url needs. Without them
// the host hands mpv a bare url and a UA-bound CDN answers 403.
test("fallback resolver carries the stream's http_headers to the host", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR), fetch: { "direct.example": { status: 200 } } });

  const audio = await api._handlers["stream:ytdlp-fallback"]("Creep", "Radiohead", null, 213);
  assert.deepEqual(audio.headers, DIRECT_HEADERS);

  const video = await api._handlers["stream:ytdlp-fallback"]("Creep", "Radiohead", null, 213, { preferVideo: true });
  assert.deepEqual(video.headers, DIRECT_HEADERS);
});

test("fallback resolver omits headers when the extraction reported none", async () => {
  // An extractor with no per-format headers must not produce `headers: {}` — the
  // host would set an empty http-header-fields on mpv instead of leaving it alone.
  const noHeaders = [
    { match: { cmd: "yt-dlp", argsInclude: ["%(urls)s"] }, result: { exitCode: 0, stdout: DIRECT_URL } },
    ...BEHAVIOR,
  ];
  const { api } = await activated({ exec: toolsPresent(noHeaders), fetch: { "direct.example": { status: 200 } } });
  const r = await api._handlers["stream:ytdlp-fallback"]("Creep", "Radiohead", null, 213);
  assert.equal(r.url, DIRECT_URL);
  assert.equal(r.headers, undefined);
});

test("Fallback source setting switches the resolver to SoundCloud", async () => {
  const { api } = await activated({
    exec: toolsPresent(BEHAVIOR),
    fetch: { "direct.example": { status: 200 } },
    storage: { kv: { resolverSource: "soundcloud" } },
  });
  await api._handlers["stream:ytdlp-fallback"]("Creep", "Radiohead", null, 213);
  const searched = api.calls.exec.find((c) => c.args.some((a) => typeof a === "string" && a.indexOf("scsearch") === 0));
  assert.ok(searched, "resolver should use scsearch: when Fallback source is SoundCloud");
});

test("clicking the SoundCloud source tab switches the search backend to scsearch", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR) });
  // The tabs control sends { tabId }, not { value }.
  api._handlers["action:ytdlp-source"]({ tabId: "soundcloud" });
  await api._handlers["action:ytdlp-search-submit"]({ query: "daft punk" });
  const searched = api.calls.exec.find(
    (c) => c.args.some((a) => typeof a === "string" && a.indexOf("scsearch") === 0)
  );
  assert.ok(searched, "search should use the scsearch: prefix after selecting SoundCloud");
});

test("Link tab: pasting a URL expands via yt-dlp, capped at 100, with no search prefix", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR) });
  api._handlers["action:ytdlp-source"]({ tabId: "link" });
  const url = "https://www.youtube.com/playlist?list=PLxxxxxxxx";
  await api._handlers["action:ytdlp-search-submit"]({ query: url });
  const call = api.calls.exec.find(
    (c) => c.cmd === "yt-dlp" && c.args.includes("--flat-playlist") && c.args.includes(url)
  );
  assert.ok(call, "should run yt-dlp on the pasted URL");
  const iIdx = call.args.indexOf("-I");
  assert.ok(iIdx >= 0 && call.args[iIdx + 1] === "1:100", "URL fetch must be capped with -I 1:100");
  // No search extractor prefix — the URL is fetched directly.
  assert.ok(!call.args.some((a) => typeof a === "string" && /^(yt|sc)search/.test(a)));
});

test("a plain text query does NOT get the -I playlist cap (search, not a URL)", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR) });
  await api._handlers["action:ytdlp-search-submit"]({ query: "radiohead" });
  const call = api.calls.exec.find(
    (c) => c.cmd === "yt-dlp" && c.args.some((a) => typeof a === "string" && a.indexOf("ytsearch") === 0)
  );
  assert.ok(call, "text query should use the ytsearch: prefix");
  assert.ok(!call.args.includes("-I"), "a search query must not be capped with -I");
});

test("sidebar Queue video enqueues a VIDEO (.mp4) track", async () => {
  const { api, plugin } = await activated({ exec: toolsPresent(BEHAVIOR) });
  await api._handlers["action:ytdlp-search-submit"]({ query: "radiohead" });
  const url = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
  const rowId = plugin._encodeRef(url, false);
  api._handlers["action:ytdlp-queue-video"]({ selectedIds: [rowId] });
  assert.equal(api.calls.insertTracks.length, 1);
  assert.equal(api.calls.insertTracks[0].tracks[0].path, plugin._encodeRef(url, true));
  assert.ok(api.calls.insertTracks[0].tracks[0].path.endsWith(".mp4"));
});
