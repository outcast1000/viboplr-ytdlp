const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

const plugin = loadPlugin();

// ---------------------------------------------------------------------------
// decodeHtmlEntities / pickHlsMaster (pure)
// ---------------------------------------------------------------------------

test("decodeHtmlEntities decodes the common entities", () => {
  assert.equal(plugin._decodeHtmlEntities("Clips &amp; Rocking"), "Clips & Rocking");
  assert.equal(plugin._decodeHtmlEntities("&lt;b&gt;bold&lt;/b&gt;"), "<b>bold</b>");
  assert.equal(plugin._decodeHtmlEntities("It&#39;s &quot;here&quot;"), 'It\'s "here"');
  assert.equal(plugin._decodeHtmlEntities("A&#x2013;B"), "A–B");
  assert.equal(plugin._decodeHtmlEntities("plain title"), "plain title");
  // &amp; decodes LAST: "&amp;lt;" is the literal text "&lt;", not "<".
  assert.equal(plugin._decodeHtmlEntities("&amp;lt;"), "&lt;");
});

test("parseSearchOutput decodes entities in title, uploader and playlist title", () => {
  // cols: url, dur, uploader, title, thumbnail, view_count, playlist_title, playlist_count
  const stdout = "https://x.example/a\t10\tA &amp; B\tClips &amp; More\tNA\tNA\tMix &amp; Match\t3\n";
  const r = plugin._parseSearchOutput(stdout, true);
  assert.equal(r.candidates[0].title, "Clips & More");
  assert.equal(r.candidates[0].uploader, "A & B");
  assert.equal(r.meta.title, "Mix & Match");
});

test("pickHlsMaster returns the best m3u8 format's manifest_url", () => {
  const formats = [
    { protocol: "https", url: "https://x/dash_a.m4a" },
    { protocol: "m3u8_native", manifest_url: "https://x/master.m3u8", url: "https://x/low.m3u8" },
    { protocol: "https", url: "https://x/dash_v.mp4" },
    { protocol: "m3u8_native", manifest_url: "https://x/master.m3u8", url: "https://x/high.m3u8" },
  ];
  assert.equal(plugin._pickHlsMaster(formats), "https://x/master.m3u8");
  assert.equal(plugin._pickHlsMaster([{ protocol: "https", url: "https://x/a.mp4" }]), null);
  assert.equal(plugin._pickHlsMaster([]), null);
  assert.equal(plugin._pickHlsMaster(null), null);
});

// ---------------------------------------------------------------------------
// Integration: video stream resolve falls back to the HLS master
// ---------------------------------------------------------------------------

const REDDIT_URL = "https://www.reddit.com/r/pearljam/comments/xyz/post/";
const MASTER = "https://v.redd.it/abc/HLSPlaylist.m3u8?a=1";
const FORMATS_JSON = JSON.stringify([
  { protocol: "https", url: "https://v.redd.it/abc/DASH_AUDIO_128.mp4" },
  { protocol: "m3u8_native", manifest_url: MASTER, url: "https://v.redd.it/abc/HLS_480.m3u8" },
]);

function rules(extra) {
  return [
    { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.07.04" } },
    { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 7.0" } },
    ...(extra || []),
  ];
}

async function activated(config) {
  const api = makeApi(config);
  const p = loadPlugin();
  await p.activate(api);
  await new Promise((r) => setTimeout(r, 5));
  return { api, plugin: p };
}

test("video resolve: no muxed stream -> direct-url extraction fails -> HLS master is returned", async () => {
  const { api, plugin: p } = await activated({
    exec: rules([
      // The direct-url extraction with the muxed selector fails (Reddit: no combined format).
      { match: { cmd: "yt-dlp", argsInclude: ["%(urls)s", "best[ext=mp4]/best"] }, result: { exitCode: 1, stderr: "Requested format is not available" } },
      // The formats dump carries the m3u8 master.
      { match: { cmd: "yt-dlp", argsInclude: ["%(formats)j"] }, result: { exitCode: 0, stdout: FORMATS_JSON } },
    ]),
    fetch: { "v.redd.it": { status: 200 } },
  });
  const id = p._encodeRef(REDDIT_URL, true).slice("ytdlp://".length);
  const url = await api._handlers["streamuri:ytdlp"](id);
  assert.equal(url, MASTER);
});

test("video resolve still prefers a muxed direct URL when one exists (no formats dump)", async () => {
  const { api, plugin: p } = await activated({
    exec: rules([
      { match: { cmd: "yt-dlp", argsInclude: ["%(urls)s", "best[ext=mp4]/best"] }, result: { exitCode: 0, stdout: "https://direct.example/muxed.mp4" } },
    ]),
    fetch: { "direct.example": { status: 200 } },
  });
  const id = p._encodeRef("https://www.youtube.com/watch?v=aaaaaaaaaaa", true).slice("ytdlp://".length);
  const url = await api._handlers["streamuri:ytdlp"](id);
  assert.equal(url, "https://direct.example/muxed.mp4");
  assert.ok(!api.calls.exec.some((c) => c.args.includes("%(formats)j")), "no fallback lookup when the direct-url extraction succeeds");
});

test("YouTube bot gate on stream resolve notifies the user ONCE per session", async () => {
  const BOT = "ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser ...";
  const { api, plugin: p } = await activated({
    exec: rules([
      { match: { cmd: "yt-dlp", argsInclude: ["%(urls)s"] }, result: { exitCode: 1, stderr: BOT } },
      { match: { cmd: "yt-dlp", argsInclude: ["%(formats)j"] }, result: { exitCode: 1, stderr: BOT } },
    ]),
  });
  const id = p._encodeRef("https://www.youtube.com/watch?v=aaaaaaaaaaa", false).slice("ytdlp://".length);
  assert.equal(await api._handlers["streamuri:ytdlp"](id), null);
  assert.equal(await api._handlers["streamuri:ytdlp"](id), null);
  const gate = api.calls.showNotification.filter((m) => /rate-limiting/.test(m));
  assert.equal(gate.length, 1, "notified exactly once, not per failure");
});

test("audio resolve does NOT fall back to the HLS master (audio extraction failure fails cleanly)", async () => {
  const { api, plugin: p } = await activated({
    exec: rules([
      { match: { cmd: "yt-dlp", argsInclude: ["%(urls)s"] }, result: { exitCode: 1, stderr: "no formats" } },
      { match: { cmd: "yt-dlp", argsInclude: ["%(formats)j"] }, result: { exitCode: 0, stdout: FORMATS_JSON } },
    ]),
  });
  const id = p._encodeRef(REDDIT_URL, false).slice("ytdlp://".length);
  const url = await api._handlers["streamuri:ytdlp"](id);
  assert.equal(url, null);
  assert.ok(!api.calls.exec.some((c) => c.args.includes("%(formats)j")), "audio path must not run the formats dump");
});
