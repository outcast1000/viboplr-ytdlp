const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// Shape mirrors `yt-dlp -j` .formats entries (each carries a directly-usable url).
const FORMATS = [
  { format_id: "140", url: "https://a/m4a", vcodec: "none", acodec: "mp4a.40.2", ext: "m4a", tbr: 129 },
  { format_id: "251", url: "https://a/opus", vcodec: "none", acodec: "opus", ext: "webm", tbr: 129 },
  { format_id: "18", url: "https://v/mux360", vcodec: "avc1.42001E", acodec: "mp4a.40.2", ext: "mp4", height: 360, tbr: 360 },
  { format_id: "299", url: "https://v/v1080", vcodec: "avc1.64002a", acodec: "none", ext: "mp4", height: 1080, tbr: 3248 },
  { format_id: "315", url: "https://v/v2160", vcodec: "vp9", acodec: "none", ext: "webm", height: 2160, tbr: 17000 },
  { format_id: "sb0", url: "https://v/storyboard", vcodec: "none", acodec: "none", ext: "mhtml" }, // no media → dropped
  { format_id: "bad", vcodec: "avc1", acodec: "none", ext: "mp4", height: 720 }, // no url → dropped
];

test("candidatesFromFormats maps kinds and drops url-less / media-less rows", () => {
  const c = plugin._candidatesFromFormats(FORMATS, 0);
  const byUrl = Object.fromEntries(c.map((x) => [x.url, x]));
  assert.equal(byUrl["https://a/m4a"].kind, "audio");
  assert.equal(byUrl["https://v/mux360"].kind, "muxed");
  assert.equal(byUrl["https://v/v1080"].kind, "video");
  assert.equal(byUrl["https://v/v1080"].height, 1080);
  assert.ok(!byUrl["https://v/storyboard"], "media-less format dropped");
  assert.ok(!c.some((x) => x.format_id === "bad"), "url-less format dropped");
});

test("candidatesFromFormats caps video/muxed by maxHeight but keeps audio", () => {
  const c = plugin._candidatesFromFormats(FORMATS, 1080);
  assert.ok(!c.some((x) => x.height && x.height > 1080), "2160p dropped");
  assert.ok(c.some((x) => x.url === "https://v/v1080"), "1080p kept");
  assert.equal(c.filter((x) => x.kind === "audio").length, 2, "audio never capped");
});

test("candidatesFromFormats adds an HLS master as muxed when no progressive muxed exists", () => {
  const noMux = [
    { url: "https://v/v1080", vcodec: "avc1", acodec: "none", ext: "mp4", height: 1080 },
    { url: "https://a/m4a", vcodec: "none", acodec: "mp4a", ext: "m4a" },
    { protocol: "m3u8_native", manifest_url: "https://h/master.m3u8", ext: "mp4" },
  ];
  const c = plugin._candidatesFromFormats(noMux, 0);
  const mux = c.find((x) => x.kind === "muxed");
  assert.ok(mux, "an HLS master fills in for the missing muxed stream");
  assert.equal(mux.url, "https://h/master.m3u8");
});
