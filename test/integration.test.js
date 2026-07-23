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
const SEARCH_STDOUT =
  "https://www.youtube.com/watch?v=aaaaaaaaaaa\t213\tRadiohead\tRadiohead - Creep\thttps://i.ytimg.com/x.jpg\n" +
  "https://www.youtube.com/watch?v=bbbbbbbbbbb\t180\tBjork\tBjork - Joga\tNA";

const BEHAVIOR = [
  { match: { cmd: "yt-dlp", argsInclude: ["-g"] }, result: { exitCode: 0, stdout: DIRECT_URL } },
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

test("registers all expected handlers", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR), fetch: { "direct.example": { status: 200 } } });
  const expected = [
    "stream:ytdlp-fallback", "streamuri:ytdlp", "streamuri:youtube",
    "uri:ytdlp-download", "meta:ytdlp-download", "qual:ytdlp-download",
    "isearch:ytdlp-download", "iresolve:ytdlp-download",
    "action:ytdlp-search-submit", "action:ytdlp-play", "action:ytdlp-download",
    "action:ytdlp-playback-mode", "action:ytdlp-cache-size",
  ];
  for (const h of expected) assert.ok(api._handlers[h], "missing handler: " + h);
});

test("qualities: original always; transcodes + video only when ffmpeg present", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR) });
  const q = api._handlers["qual:ytdlp-download"]();
  const values = q.map((x) => x.value);
  assert.ok(values.includes("original"));
  assert.ok(values.includes("video"));
  assert.ok(values.includes("flac"));

  // yt-dlp present but ffmpeg absent -> only "original".
  const noff = await activated({
    exec: [{ match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.01.01" } }],
  });
  const q2 = noff.api._handlers["qual:ytdlp-download"]();
  assert.deepEqual(q2.map((x) => x.value), ["original"]);
});

test("stream URI resolve returns a validated direct URL in stream mode", async () => {
  const { api, plugin } = await activated({ exec: toolsPresent(BEHAVIOR), fetch: { "direct.example": { status: 200 } } });
  const id = plugin._encodeRef("https://www.youtube.com/watch?v=aaaaaaaaaaa", false).slice("ytdlp://".length);
  const url = await api._handlers["streamuri:ytdlp"](id);
  assert.equal(url, DIRECT_URL);
});

test("stream URI resolve falls back to download when the direct URL fails validation", async () => {
  const { api, plugin } = await activated({ exec: toolsPresent(BEHAVIOR), fetch: { "direct.example": { status: 403 } } });
  const id = plugin._encodeRef("https://www.youtube.com/watch?v=aaaaaaaaaaa", false).slice("ytdlp://".length);
  const url = await api._handlers["streamuri:ytdlp"](id);
  assert.equal(url, "file:///mock-plugin-data/cache/abc.m4a");
});

test("download mode skips -g and downloads directly", async () => {
  const { api, plugin } = await activated({
    exec: toolsPresent(BEHAVIOR),
    storage: { kv: { playbackMode: "download" } },
  });
  const id = plugin._encodeRef("https://www.youtube.com/watch?v=aaaaaaaaaaa", false).slice("ytdlp://".length);
  const url = await api._handlers["streamuri:ytdlp"](id);
  assert.equal(url, "file:///mock-plugin-data/cache/abc.m4a");
  // No -g should have been attempted.
  assert.ok(!api.calls.exec.some((c) => c.args.includes("-g")));
});

test("legacy youtube:// scheme still resolves", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR), fetch: { "direct.example": { status: 200 } } });
  const url = await api._handlers["streamuri:youtube"]("dQw4w9WgXcQ");
  assert.equal(url, DIRECT_URL);
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
  assert.equal(results[1].coverUrl, undefined); // "NA" thumbnail -> undefined
});

test("metadata download resolve of 'original' returns a direct URL with ext auto", async () => {
  const { api } = await activated({ exec: toolsPresent(BEHAVIOR), fetch: { "direct.example": { status: 200 } } });
  const result = await api._handlers["meta:ytdlp-download"]("Creep", "Radiohead", null, 213, "original");
  assert.equal(result.url, DIRECT_URL);
  assert.equal(result.ext, "auto");
  assert.equal(result.metadata.title, "Creep");
});

test("stream resolve skips cleanly when yt-dlp is unavailable", async () => {
  const { api } = await activated({ exec: [] }); // no tools
  const r = await api._handlers["stream:ytdlp-fallback"]("Creep", "Radiohead", null, 213);
  assert.equal(r, null);
});

test("sidebar play builds tracks with ytdlp:// paths for the selected kind", async () => {
  const { api, plugin } = await activated({ exec: toolsPresent(BEHAVIOR) });
  // Run a search so the view has results to select from.
  await api._handlers["action:ytdlp-search-submit"]({ query: "radiohead" });
  const audioId = plugin._encodeRef("https://www.youtube.com/watch?v=aaaaaaaaaaa", false);
  api._handlers["action:ytdlp-play"]({ selectedIds: [audioId] });
  assert.equal(api.calls.playTracks.length, 1);
  assert.equal(api.calls.playTracks[0].tracks[0].path, audioId);
});
