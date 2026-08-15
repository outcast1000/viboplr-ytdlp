const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// Shape mirrors `yt-dlp -j` .formats entries (each carries a directly-usable url).
const FORMATS = [
  { format_id: "140", url: "https://a/m4a", vcodec: "none", acodec: "mp4a.40.2", ext: "m4a", tbr: 129, http_headers: { "User-Agent": "yt-dlp" } },
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
  assert.deepEqual(byUrl["https://a/m4a"].headers, { "User-Agent": "yt-dlp" });
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

// --- parseDirectOutput -------------------------------------------------------
// getDirectUrl asks yt-dlp for two --print lines in ONE extraction: `%(urls)s`
// then `%(http_headers)j`. Signed CDN links are commonly bound to the UA that
// minted them, so the headers must survive to the host — but never at the cost
// of the URL, which is the thing that actually plays.

test("parseDirectOutput: takes the url and the header JSON", () => {
  const out = plugin._parseDirectOutput(
    'https://cdn.example/media.m4a\n{"User-Agent": "Mozilla/5.0", "Referer": "https://x/"}',
  );
  assert.equal(out.url, "https://cdn.example/media.m4a");
  assert.deepEqual(out.headers, { "User-Agent": "Mozilla/5.0", Referer: "https://x/" });
});

test("parseDirectOutput: a multi-url selection still yields the FIRST url and the headers", () => {
  // %(urls)s is newline-separated when a selector picks more than one format, so
  // the header line is not simply "the second line".
  const out = plugin._parseDirectOutput(
    'https://cdn.example/video.mp4\nhttps://cdn.example/audio.m4a\n{"User-Agent": "ua"}',
  );
  assert.equal(out.url, "https://cdn.example/video.mp4");
  assert.deepEqual(out.headers, { "User-Agent": "ua" });
});

test("parseDirectOutput: malformed or absent headers still yield the url", () => {
  for (const stdout of [
    "https://cdn.example/media.m4a",             // older yt-dlp: no header line
    "https://cdn.example/media.m4a\n{not json",  // truncated
    "https://cdn.example/media.m4a\nNA",         // template resolved to nothing
    "https://cdn.example/media.m4a\n{}",         // empty object is not headers
  ]) {
    const out = plugin._parseDirectOutput(stdout);
    assert.equal(out.url, "https://cdn.example/media.m4a", stdout);
    assert.equal(out.headers, null, stdout);
  }
});

test("parseDirectOutput: no url means no result, whatever else printed", () => {
  assert.equal(plugin._parseDirectOutput('{"User-Agent": "ua"}').url, null);
  assert.equal(plugin._parseDirectOutput("").url, null);
  assert.equal(plugin._parseDirectOutput("ERROR: nope").url, null);
});

// --- streamUriResult ---------------------------------------------------------
// onResolveStreamByUri may answer with a URL string or a candidate list. Only
// the list can carry headers, so the shape is chosen by whether there are any.

test("streamUriResult: a headerless stream stays a plain url", () => {
  // Covers "download then play" (a local file) and the HLS-master fallback,
  // both of which resolve without headers and must behave exactly as before.
  assert.equal(plugin._streamUriResult({ url: "https://a/x.m4a" }, false), "https://a/x.m4a");
  assert.equal(plugin._streamUriResult({ url: "file:///tmp/x.m4a", downloaded: true }, false), "file:///tmp/x.m4a");
  assert.equal(plugin._streamUriResult({ url: "https://a/m.m3u8", headers: null }, true), "https://a/m.m3u8");
});

test("streamUriResult: headers force the candidate-list shape, kind following the request", () => {
  const h = { "User-Agent": "ua" };
  assert.deepEqual(plugin._streamUriResult({ url: "https://a/x.m4a", headers: h }, false), {
    candidates: [{ url: "https://a/x.m4a", kind: "audio", headers: h }],
  });
  assert.deepEqual(plugin._streamUriResult({ url: "https://a/x.mp4", headers: h }, true), {
    candidates: [{ url: "https://a/x.mp4", kind: "muxed", headers: h }],
  });
});

test("streamUriResult: nothing resolved means null", () => {
  assert.equal(plugin._streamUriResult(null, false), null);
  assert.equal(plugin._streamUriResult({ url: null }, false), null);
});
