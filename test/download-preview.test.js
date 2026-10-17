const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

const plugin = loadPlugin();

// The formats yt-dlp -j reported for Pearl Jam "Alive" (trimmed to the ones
// that matter): H.264 tops out at 480p, the best audio-only stream is Opus.
const ALIVE_FORMATS = [
  { format_id: "140", vcodec: "none", acodec: "mp4a.40.2", abr: 129.5 },
  { format_id: "251", vcodec: "none", acodec: "opus", abr: 130.45 },
  { format_id: "18", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360 },
  { format_id: "134", vcodec: "avc1.4d401e", acodec: "none", height: 360 },
  { format_id: "135", vcodec: "avc1.4d401f", acodec: "none", height: 480 },
  { format_id: "244", vcodec: "vp9", acodec: "none", height: 480 },
];

test("qualityOptionsForFormats: offers only the sizes the video has", () => {
  const q = plugin._qualityOptionsForFormats(ALIVE_FORMATS, true);
  const values = q.map((o) => o.value);
  assert.deepEqual(values, ["original", "aac", "mp3", "flac", "video"]);
  const best = q.find((o) => o.value === "video");
  assert.equal(best.label, "Video · MP4 · Best (480p)");
  assert.equal(best.video, true);
  assert.equal(q[0].label, "Audio · Original — Opus 130 kbps");
});

test("qualityOptionsForFormats: smaller caps below the best, and a note on skipped AV1/VP9", () => {
  const formats = [
    { vcodec: "none", acodec: "opus", abr: 160 },
    { vcodec: "avc1.640028", acodec: "none", height: 1080 },
    { vcodec: "vp09.00.51.08", acodec: "none", height: 2160 },
  ];
  const q = plugin._qualityOptionsForFormats(formats, true);
  const video = q.filter((o) => o.video).map((o) => o.label);
  assert.deepEqual(video, ["Video · MP4 · Best (1080p)", "Video · MP4 · 720p", "Video · MP4 · 480p"]);
  assert.match(q.find((o) => o.value === "video").description, /2160p in AV1\/VP9/);
});

test("qualityOptionsForFormats: no H.264 means an .mkv best", () => {
  const q = plugin._qualityOptionsForFormats([
    { vcodec: "none", acodec: "opus", abr: 128 },
    { vcodec: "vp9", acodec: "none", height: 720 },
  ], true);
  assert.equal(q.find((o) => o.value === "video").label, "Video · MKV · Best (720p)");
});

test("qualityOptionsForFormats: audio-only source, no ffmpeg, nothing usable", () => {
  const audioOnly = plugin._qualityOptionsForFormats([{ vcodec: "none", acodec: "mp3", abr: 128 }], true);
  assert.ok(audioOnly.every((o) => !o.video), "no video options for an audio-only source");
  assert.equal(audioOnly[0].label, "Audio · Original — MP3 128 kbps");
  assert.deepEqual(plugin._qualityOptionsForFormats(ALIVE_FORMATS, false).map((o) => o.value), ["original"]);
  assert.equal(plugin._qualityOptionsForFormats([], true), null);
  assert.equal(plugin._qualityOptionsForFormats([{ format_id: "sb0", vcodec: "none", acodec: "none" }], true), null);
});

test("staticQualityOptions keeps the fixed list older hosts show", () => {
  const values = plugin._staticQualityOptions(true).map((o) => o.value);
  assert.deepEqual(values, ["original", "aac", "mp3", "flac", "video", "video-2160", "video-1080", "video-720", "video-480"]);
  assert.deepEqual(plugin._staticQualityOptions(false).map((o) => o.value), ["original"]);
});

test("recallPick: same song whatever the case and accents, preferring the asked kind", () => {
  const now = 1_000_000;
  const table = {};
  table[plugin._pickKey("Jóga", "Björk", false)] = { cand: { url: "a" }, video: false, at: now - 1000 };
  table[plugin._pickKey("Joga", "Bjork", true)] = { cand: { url: "v" }, video: true, at: now - 1000 };
  assert.equal(plugin._recallPick(table, "JOGA", "bjork", true, now).cand.url, "v");
  assert.equal(plugin._recallPick(table, "joga", "Björk", false, now).cand.url, "a");
  assert.equal(plugin._recallPick(table, "Hunter", "Björk", false, now), null);
  assert.equal(plugin._recallPick(table, "Joga", "Bjork", true, now + 7 * 60 * 60 * 1000), null, "stale after the TTL");
});

function toolsPresent(extra) {
  return [
    { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.01.01" } },
    { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 7.0" } },
    ...(extra || []),
  ];
}

const INFO = {
  title: "Pearl Jam - Alive (Official Video)", uploader: "PearlJamVEVO", duration: 341,
  thumbnail: "https://i.ytimg.com/vi/qM0zINtulhM/hq.jpg", formats: ALIVE_FORMATS,
};

async function activated(extra) {
  const api = makeApi({ exec: toolsPresent(extra) });
  const p = loadPlugin();
  await p.activate(api);
  await new Promise((r) => setTimeout(r, 5));
  return api;
}

test("preview by URI names the video and its real qualities", async () => {
  const api = await activated([
    { match: { cmd: "yt-dlp", argsInclude: ["-j"] }, result: { exitCode: 0, stdout: JSON.stringify(INFO) } },
  ]);
  const uri = plugin._encodeRef("https://www.youtube.com/watch?v=qM0zINtulhM");
  const r = await api._handlers["preview:ytdlp-download"]({ uri, title: "Alive", artistName: "Pearl Jam", albumName: null, durationSecs: null, isVideo: true });
  assert.equal(r.match.title, "Pearl Jam - Alive (Official Video)");
  assert.equal(r.match.artistName, "PearlJamVEVO");
  assert.equal(r.match.durationSecs, 341);
  assert.equal(r.qualities.find((o) => o.value === "video").label, "Video · MP4 · Best (480p)");
  assert.equal(r.note, null);
});

test("preview by name reuses what the fallback resolver just played", async () => {
  const SEARCH = "https://www.youtube.com/watch?v=qM0zINtulhM\t341\tPearlJamVEVO\tPearl Jam - Alive (Official Video)\tNA\t9000000";
  let searches = 0;
  const api = await activated([
    { match: { cmd: "yt-dlp", argsInclude: ["--flat-playlist"] }, result: () => { searches++; return { exitCode: 0, stdout: SEARCH }; } },
    { match: { cmd: "yt-dlp", argsInclude: ["%(urls)s"] }, result: { exitCode: 0, stdout: "https://direct.example/a.m4a\n{}" } },
    { match: { cmd: "yt-dlp", argsInclude: ["-j"] }, result: { exitCode: 0, stdout: JSON.stringify(INFO) } },
  ]);
  await api._handlers["stream:ytdlp-fallback"]("Alive", "Pearl Jam", null, 341);
  assert.equal(searches, 1);
  const r = await api._handlers["preview:ytdlp-download"]({ uri: null, title: "Alive", artistName: "Pearl Jam", albumName: null, durationSecs: 341, isVideo: false });
  assert.equal(searches, 1, "no second search");
  assert.equal(r.note, "The same upload you just listened to");
  assert.match(r.match.id, /^ytdlp:\/\//);
});

test("preview surfaces yt-dlp's reason when the lookup fails", async () => {
  const api = await activated([
    { match: { cmd: "yt-dlp", argsInclude: ["-j"] }, result: { exitCode: 1, stderr: "ERROR: [youtube] x: Video unavailable" } },
  ]);
  const uri = plugin._encodeRef("https://www.youtube.com/watch?v=qM0zINtulhM");
  await assert.rejects(
    api._handlers["preview:ytdlp-download"]({ uri, title: "Alive", artistName: null, albumName: null, durationSecs: null, isVideo: false }),
    /unavailable/,
  );
});

test("slimInfo keeps only what the preview reads", () => {
  const big = { ...INFO, description: "x".repeat(10000), formats: [{ ...ALIVE_FORMATS[1], url: "https://signed.example/very-long", http_headers: { a: "b" } }] };
  const slim = plugin._slimInfo(big);
  assert.deepEqual(Object.keys(slim).sort(), ["channel", "duration", "formats", "thumbnail", "title", "uploader"]);
  assert.deepEqual(slim.formats, [{ vcodec: "none", acodec: "opus", height: undefined, abr: 130.45, tbr: undefined }]);
  assert.equal(slim.title, INFO.title);
});

async function activatedWith(extra) {
  const api = makeApi({ exec: toolsPresent(extra) });
  const p = loadPlugin();
  await p.activate(api);
  await new Promise((r) => setTimeout(r, 5));
  return { api, p };
}

test("download by name fetches the upload the fallback resolver just played", async () => {
  const SEARCH = "https://www.youtube.com/watch?v=qM0zINtulhM\t341\tPearlJamVEVO\tPearl Jam - Alive (Official Video)\tNA\t9000000";
  let searches = 0;
  const { api, p } = await activatedWith([
    { match: { cmd: "yt-dlp", argsInclude: ["--flat-playlist"] }, result: () => { searches++; return { exitCode: 0, stdout: SEARCH }; } },
    { match: { cmd: "yt-dlp", argsInclude: ["%(urls)s"] }, result: { exitCode: 0, stdout: "https://direct.example/a.m4a\n{}" } },
  ]);
  await api._handlers["stream:ytdlp-fallback"]("Alive", "Pearl Jam", null, 341);
  assert.equal(searches, 1);
  // The download itself fails in the mock; what matters is which URL it ran on.
  await api._handlers["meta:ytdlp-download"]("Alive", "Pearl Jam", null, 341, "original").catch(() => {});
  assert.equal(searches, 1, "no second search");
  // The search cache would also spare a second exec — the trace shows whether
  // the download searched at all.
  const t = p._recentTraces().find((x) => x.kind === "download resolve by metadata");
  assert.ok(!t.lines.some((l) => /search/i.test(l.msg)), t.lines.map((l) => l.msg).join("\n"));
  const dl = api.calls.exec.find((c) => c.cmd === "yt-dlp" && c.args.includes("https://www.youtube.com/watch?v=qM0zINtulhM") && !c.args.includes("%(urls)s"));
  assert.ok(dl, "the download ran on the played upload");
});
