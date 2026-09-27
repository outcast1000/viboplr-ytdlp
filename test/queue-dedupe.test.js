const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// splitAlreadyQueued backs the play_url assistant tool's enqueue: a tool call
// must skip what's already queued rather than raise the host's duplicate
// banner, and it must match on exactly the key the host compares (`path`).

test("splitAlreadyQueued skips tracks whose path is already queued", () => {
  const tracks = [{ path: "ytdlp://a", title: "A" }, { path: "ytdlp://b", title: "B" }];
  const queue = [{ path: "ytdlp://b" }, { path: "file:///x.mp3" }];
  const r = plugin._splitAlreadyQueued(tracks, queue);
  assert.deepEqual(r.fresh.map((t) => t.title), ["A"]);
  assert.deepEqual(r.skipped.map((t) => t.title), ["B"]);
});

test("splitAlreadyQueued keeps everything against an empty queue", () => {
  const tracks = [{ path: "ytdlp://a" }, { path: "ytdlp://b" }];
  const r = plugin._splitAlreadyQueued(tracks, []);
  assert.equal(r.fresh.length, 2);
  assert.equal(r.skipped.length, 0);
});

test("splitAlreadyQueued never treats path-less entries as duplicates", () => {
  // The host's own check would match null against null; a missing path is not
  // an identity, so neither side of the comparison may use it.
  const tracks = [{ path: null, title: "no-path" }, { path: "ytdlp://a", title: "A" }];
  const queue = [{ path: null }, { path: undefined }];
  const r = plugin._splitAlreadyQueued(tracks, queue);
  assert.deepEqual(r.fresh.map((t) => t.title), ["no-path", "A"]);
});

test("splitAlreadyQueued preserves order and tolerates holes in the queue", () => {
  const tracks = [{ path: "ytdlp://c" }, { path: "ytdlp://a" }, { path: "ytdlp://b" }];
  const r = plugin._splitAlreadyQueued(tracks, [null, { path: "ytdlp://a" }]);
  assert.deepEqual(r.fresh.map((t) => t.path), ["ytdlp://c", "ytdlp://b"]);
});
