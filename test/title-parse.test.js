const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

test("parseTrackTitle splits 'Artist - Title'", () => {
  assert.deepEqual(plugin._parseTrackTitle("Radiohead - Creep", "RadioheadVEVO"), { artist: "Radiohead", title: "Creep" });
});

test("parseTrackTitle strips trailing noise tags", () => {
  const r = plugin._parseTrackTitle("Daft Punk - Get Lucky (Official Music Video)", "DaftPunkVEVO");
  assert.equal(r.artist, "Daft Punk");
  assert.equal(r.title, "Get Lucky");
});

test("parseTrackTitle falls back to uploader when there is no separator", () => {
  assert.deepEqual(plugin._parseTrackTitle("Some Song", "Cool Band"), { artist: "Cool Band", title: "Some Song" });
});

test("parseTrackTitle handles en-dash and em-dash separators", () => {
  assert.deepEqual(plugin._parseTrackTitle("Björk – Jóga", "x"), { artist: "Björk", title: "Jóga" });
  assert.deepEqual(plugin._parseTrackTitle("A — B", "x"), { artist: "A", title: "B" });
});

test("formatDuration formats seconds and hours", () => {
  assert.equal(plugin._formatDuration(0), "0:00");
  assert.equal(plugin._formatDuration(65), "1:05");
  assert.equal(plugin._formatDuration(3661), "1:01:01");
  assert.equal(plugin._formatDuration(null), "");
  assert.equal(plugin._formatDuration(-1), "");
});
