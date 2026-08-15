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

// --- selfContainedUrl --------------------------------------------------------
// The metadata resolver answers `opts.externalAudio` with a candidate menu, but
// StreamResolveResult.url is still required and must be something an older host
// (or the browser engine) can play on its own.

test("selfContainedUrl prefers a browser-safe mp4 muxed stream over other muxed ones", () => {
  const url = plugin._selfContainedUrl([
    { url: "https://h/master.m3u8", kind: "muxed", container: "m3u8" },
    { url: "https://v/mux360", kind: "muxed", container: "mp4" },
    { url: "https://v/v1080", kind: "video" },
  ]);
  assert.equal(url, "https://v/mux360");
});

test("selfContainedUrl falls back to a non-mp4 muxed stream when that's all there is", () => {
  const url = plugin._selfContainedUrl([
    { url: "https://v/v1080", kind: "video" },
    { url: "https://h/master.m3u8", kind: "muxed", container: "m3u8" },
  ]);
  assert.equal(url, "https://h/master.m3u8");
});

test("selfContainedUrl uses a video-only stream only as a last resort", () => {
  // Silent, but a picture beats failing the resolve outright — and any host that
  // understands candidates will have picked a pair from the menu instead.
  const url = plugin._selfContainedUrl([
    { url: "https://a/m4a", kind: "audio" },
    { url: "https://v/v1080", kind: "video" },
  ]);
  assert.equal(url, "https://v/v1080");
});

test("selfContainedUrl returns null when nothing is self-contained", () => {
  assert.equal(plugin._selfContainedUrl([{ url: "https://a/m4a", kind: "audio" }]), null);
  assert.equal(plugin._selfContainedUrl([]), null);
  assert.equal(plugin._selfContainedUrl(null), null);
});

test("selfContainedUrl picks a real muxed stream out of a full YouTube menu", () => {
  // The end-to-end shape: the menu the resolver actually returns for a watch URL.
  const url = plugin._selfContainedUrl(plugin._candidatesFromFormats(FORMATS, 0));
  assert.equal(url, "https://v/mux360", "itag 18 is YouTube's only self-contained format");
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
// the list can carry headers OR the source URL, so this always uses it — the
// host treats a one-candidate list exactly like a bare URL.

test("streamUriResult: always the candidate-list shape, kind following the request", () => {
  // Headerless covers "download then play" (a local file) and the HLS-master
  // fallback; both must still resolve to exactly the same playable URL.
  assert.deepEqual(plugin._streamUriResult({ url: "https://a/x.m4a" }, false), {
    candidates: [{ url: "https://a/x.m4a", kind: "audio" }],
  });
  assert.deepEqual(plugin._streamUriResult({ url: "file:///tmp/x.m4a", downloaded: true }, false), {
    candidates: [{ url: "file:///tmp/x.m4a", kind: "audio" }],
  });
  assert.deepEqual(plugin._streamUriResult({ url: "https://a/m.m3u8", headers: null }, true), {
    candidates: [{ url: "https://a/m.m3u8", kind: "muxed" }],
  });
});

test("streamUriResult: headers ride on the candidate", () => {
  const h = { "User-Agent": "ua" };
  assert.deepEqual(plugin._streamUriResult({ url: "https://a/x.m4a", headers: h }, false), {
    candidates: [{ url: "https://a/x.m4a", kind: "audio", headers: h }],
  });
  assert.deepEqual(plugin._streamUriResult({ url: "https://a/x.mp4", headers: h }, true), {
    candidates: [{ url: "https://a/x.mp4", kind: "muxed", headers: h }],
  });
});

test("streamUriResult: the source webpage is reported separately from the stream", () => {
  // The host shows this in the source panel and opens it from there. Without it
  // a ytdlp:// track is attributed by its own URI — the same webpage URL, but
  // percent-encoded behind a scheme, so unreadable and un-openable.
  const page = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const r = plugin._streamUriResult({ url: "https://cdn/x.m4a" }, false, page);
  assert.equal(r.sourceUrl, page);
  assert.equal(r.candidates[0].url, "https://cdn/x.m4a", "the stream URL is untouched");
  // Omitted rather than sent as undefined when there is nothing to report.
  assert.ok(!("sourceUrl" in plugin._streamUriResult({ url: "https://cdn/x.m4a" }, false)));
});

test("streamUriResult: nothing resolved means null", () => {
  assert.equal(plugin._streamUriResult(null, false), null);
  assert.equal(plugin._streamUriResult({ url: null }, false), null);
});

// --- caches ------------------------------------------------------------------
// These cut yt-dlp INVOCATIONS, not just latency: every extraction is a request
// to the source, and YouTube rate-gates a device that makes too many.

test("cacheGet: returns a live value and drops an expired one", () => {
  const store = {};
  plugin._cachePut(store, "k", "v", 1000, 10);
  assert.equal(plugin._cacheGet(store, "k", 999), "v");
  assert.equal(plugin._cacheGet(store, "k", 1000), null, "expiry is exclusive of the deadline");
  assert.deepEqual(Object.keys(store), [], "an expired entry is deleted on read, not left to rot");
  assert.equal(plugin._cacheGet(store, "missing", 0), null);
});

test("cachePut: evicts the soonest-to-expire past the cap, not the oldest inserted", () => {
  const store = {};
  plugin._cachePut(store, "dies-first", "a", 100, 2);
  plugin._cachePut(store, "lives-long", "b", 9000, 2);
  plugin._cachePut(store, "middle", "c", 500, 2);
  // The entries worth keeping are the ones with the most life left.
  assert.deepEqual(Object.keys(store).sort(), ["lives-long", "middle"]);
});

test("cachePut: re-putting a key refreshes rather than duplicating", () => {
  const store = {};
  plugin._cachePut(store, "k", "old", 100, 10);
  plugin._cachePut(store, "k", "new", 900, 10);
  assert.equal(Object.keys(store).length, 1);
  assert.equal(plugin._cacheGet(store, "k", 500), "new");
});

test("streamUrlExpiry: honours the URL's own expire, minus a safety margin", () => {
  const now = 1_000_000_000_000;              // epoch ms
  const expireSecs = Math.floor(now / 1000) + 6 * 3600; // YouTube's 6h window
  const got = plugin._streamUrlExpiry(`https://x/v?id=1&expire=${expireSecs}&ip=1.2.3.4`, now);
  // 6h out, less the 15min margin — but clamped by the 30min hard ceiling.
  assert.equal(got, now + 30 * 60 * 1000);
});

test("streamUrlExpiry: a signed deadline nearer than the ceiling wins", () => {
  const now = 1_000_000_000_000;
  const expireSecs = Math.floor(now / 1000) + 20 * 60; // 20min out
  const got = plugin._streamUrlExpiry(`https://x/v?expire=${expireSecs}`, now);
  assert.equal(got, expireSecs * 1000 - 15 * 60 * 1000, "20min − 15min margin = 5min");
});

test("streamUrlExpiry: refuses to cache a url already inside the margin", () => {
  const now = 1_000_000_000_000;
  // Ten minutes left is less than the margin: caching it only guarantees a dead
  // hit later, mid-track, which is worse than one more extraction.
  const soon = Math.floor(now / 1000) + 10 * 60;
  assert.equal(plugin._streamUrlExpiry(`https://x/v?expire=${soon}`, now), null);
  const past = Math.floor(now / 1000) - 60;
  assert.equal(plugin._streamUrlExpiry(`https://x/v?expire=${past}`, now), null);
});

test("streamUrlExpiry: a url with no expire falls back to the hard ceiling", () => {
  const now = 1_000_000_000_000;
  // Non-YouTube sources often publish no deadline; they still must not be
  // cached indefinitely, because a network change silently invalidates them.
  assert.equal(plugin._streamUrlExpiry("https://bandcamp.example/track.mp3", now), now + 30 * 60 * 1000);
  assert.equal(plugin._streamUrlExpiry("https://x/v?expire=notanumber", now), now + 30 * 60 * 1000);
});

test("cloneSearchResult: hands out independent candidate objects", () => {
  // rankByProfile stamps _profileScore onto candidates and the sidebar keeps
  // results in view state, so a shared object would leak one caller's ranking
  // into another's list.
  const cached = { candidates: [{ url: "u", title: "t" }], meta: { title: "m" } };
  const a = plugin._cloneSearchResult(cached);
  a.candidates[0]._profileScore = { pos: 0 };
  a.candidates.push({ url: "extra" });
  const b = plugin._cloneSearchResult(cached);
  assert.equal(b.candidates.length, 1, "the cached array is not appended to");
  assert.equal(b.candidates[0]._profileScore, undefined, "the cached object is not stamped");
});
