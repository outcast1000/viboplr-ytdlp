const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

test("encodeRef/decodeRef round-trips an audio URL", () => {
  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const ref = plugin._encodeRef(url, false);
  assert.ok(ref.startsWith("ytdlp://"));
  const decoded = plugin._decodeRef(ref.slice("ytdlp://".length));
  assert.deepEqual(decoded, { url, isVideo: false });
});

test("encodeRef/decodeRef round-trips a video URL with .mp4 suffix", () => {
  const url = "https://vimeo.com/12345678";
  const ref = plugin._encodeRef(url, true);
  assert.ok(ref.endsWith(".mp4"));
  const decoded = plugin._decodeRef(ref.slice("ytdlp://".length));
  assert.deepEqual(decoded, { url, isVideo: true });
});

test("encoded audio id has no literal dot (so host video-detection can't false-trip)", () => {
  // youtu.be contains a dot that must be escaped in the encoded form.
  const ref = plugin._encodeRef("https://youtu.be/abcDEF", false);
  const id = ref.slice("ytdlp://".length);
  assert.equal(id.indexOf("."), -1, "audio id should contain no literal '.'");
});

test("encoded video id has exactly one literal dot (the .mp4 suffix)", () => {
  const ref = plugin._encodeRef("https://youtu.be/abcDEF", true);
  const id = ref.slice("ytdlp://".length);
  assert.equal((id.match(/\./g) || []).length, 1);
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

test("cacheStem separates audio and video of the same URL", () => {
  const url = "https://example.com/track";
  assert.notEqual(plugin._cacheStem(url, false), plugin._cacheStem(url, true));
  assert.match(plugin._cacheStem(url, false), /^[a-z0-9]+$/);
});
