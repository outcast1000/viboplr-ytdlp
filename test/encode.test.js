const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

test("encodeRef/decodeRef round-trips a URL", () => {
  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const ref = plugin._encodeRef(url);
  assert.ok(ref.startsWith("ytdlp://"));
  const decoded = plugin._decodeRef(ref.slice("ytdlp://".length));
  assert.deepEqual(decoded, { url, isVideo: false });
});

test("decodeRef still reads the legacy .mp4 suffix — persisted queues carry it forever", () => {
  const url = "https://vimeo.com/12345678";
  // Pre-1.23.0 refs: encoded URL + a literal ".mp4" marking video intent.
  const legacy = encodeURIComponent(url).replace(/\./g, "%2E") + ".mp4";
  assert.deepEqual(plugin._decodeRef(legacy), { url, isVideo: true });
});

test("no ref carries a literal dot — kind no longer rides the URI", () => {
  // youtu.be contains a dot that must be escaped in the encoded form, and the
  // fake ".mp4" video suffix is retired (PluginTrack.kind + opts.video carry
  // the claim now), so no ref of either kind can trip the host's
  // path-extension video detection.
  const id = plugin._encodeRef("https://youtu.be/abcDEF").slice("ytdlp://".length);
  assert.equal(id.indexOf("."), -1, "no literal '.' in any ref");
});

test("decodeRef detects non-mp4 video containers", () => {
  const decoded = plugin._decodeRef("https%3A%2F%2Fx%2Ecom%2Fa.webm");
  assert.equal(decoded.isVideo, true);
  assert.equal(decoded.url, "https://x.com/a");
});

test("decodeRef rejects non-http refs (guards exec)", () => {
  const enc = encodeURIComponent("file:///etc/passwd").replace(/\./g, "%2E");
  assert.equal(plugin._decodeRef(enc), null);
});

test("decodeRef returns null for empty/garbage", () => {
  assert.equal(plugin._decodeRef(""), null);
  assert.equal(plugin._decodeRef("%%%not-valid%%"), null);
});

test("thumbFor falls back to a deterministic per-video YouTube thumbnail (flat search gives none)", () => {
  assert.equal(
    plugin._thumbFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "NA"),
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"
  );
  // youtu.be short links too
  assert.equal(
    plugin._thumbFor("https://youtu.be/dQw4w9WgXcQ", null),
    "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"
  );
});

test("thumbFor prefers a real thumbnail URL when yt-dlp provides one", () => {
  assert.equal(plugin._thumbFor("https://youtu.be/dQw4w9WgXcQ", "https://x/t.jpg"), "https://x/t.jpg");
});

test("thumbFor returns undefined for non-YouTube sources without a thumbnail", () => {
  assert.equal(plugin._thumbFor("https://soundcloud.com/a/b", "NA"), undefined);
});

test("dropSoundcloudPreviews removes ~30s SoundCloud results, keeps full tracks + unknown durations", () => {
  const cands = [
    { url: "a", durationSecs: 30 },   // preview
    { url: "b", durationSecs: 246 },  // full track
    { url: "c", durationSecs: null }, // unknown -> keep
    { url: "d", durationSecs: 31 },   // preview (edge)
  ];
  const kept = plugin._dropSoundcloudPreviews(cands, "soundcloud", false);
  assert.deepEqual(kept.map((c) => c.url), ["b", "c"]);
});

test("dropSoundcloudPreviews leaves YouTube results untouched (30s clips are real there)", () => {
  const cands = [{ url: "a", durationSecs: 30 }];
  assert.equal(plugin._dropSoundcloudPreviews(cands, "youtube", false).length, 1);
});

test("dropSoundcloudPreviews does not filter a directly pasted SoundCloud URL", () => {
  const cands = [{ url: "a", durationSecs: 30 }];
  assert.equal(plugin._dropSoundcloudPreviews(cands, "soundcloud", true).length, 1);
});

test("cacheStem separates audio and video of the same URL", () => {
  const url = "https://example.com/track";
  assert.notEqual(plugin._cacheStem(url, false), plugin._cacheStem(url, true));
  assert.match(plugin._cacheStem(url, false), /^[a-z0-9]+$/);
});

test("buildTrack declares its kind, and the path carries no suffix", () => {
  // `kind` (PluginTrack.kind) is the one channel for audio-vs-video; audio and
  // video of the same page share one ref.
  const video = plugin._buildTrack({ url: "https://youtu.be/abc", title: "Clip" }, true);
  const audio = plugin._buildTrack({ url: "https://youtu.be/abc", title: "Song" }, false);
  assert.equal(video.kind, "video");
  assert.equal(audio.kind, "audio");
  assert.equal(video.path, audio.path, "one identity per page URL");
  assert.ok(!/\.mp4$/.test(video.path));
});
