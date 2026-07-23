const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

test("buildConvertArgs remuxes (codec copy) when the source codec matches the target", () => {
  const c = plugin._buildConvertArgs("/src.m4a", "/dst.m4a", "aac", { codec: "aac", bitrateKbps: 256 });
  assert.equal(c.mode, "copy");
  assert.ok(c.args.includes("copy"));
  assert.ok(!c.args.includes("-b:a"));
});

test("buildConvertArgs re-encodes when the source codec differs", () => {
  const c = plugin._buildConvertArgs("/src.webm", "/dst.m4a", "aac", { codec: "opus", bitrateKbps: 160 });
  assert.equal(c.mode, "encode");
  assert.ok(c.args.includes("aac"));
  assert.ok(c.args.includes("-b:a"));
});

test("buildConvertArgs clamps the target bitrate into [96, 320]", () => {
  const hi = plugin._buildConvertArgs("/s", "/d.mp3", "mp3", { codec: "opus", bitrateKbps: 999 });
  assert.equal(hi.bitrate, 320);
  const lo = plugin._buildConvertArgs("/s", "/d.mp3", "mp3", { codec: "opus", bitrateKbps: 32 });
  assert.equal(lo.bitrate, 96);
});

test("buildConvertArgs always re-encodes FLAC", () => {
  const c = plugin._buildConvertArgs("/s.m4a", "/d.flac", "flac", { codec: "aac" });
  assert.equal(c.mode, "encode");
  assert.ok(c.args.includes("flac"));
});

test("buildConvertArgs returns null for an unknown format", () => {
  assert.equal(plugin._buildConvertArgs("/s", "/d", "ogg", null), null);
});
