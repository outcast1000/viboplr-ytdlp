// YouTube releases some clients' stream URLs only at `available_at` (the end of
// the pre-roll ad the client is expected to watch); fetched earlier the CDN
// answers 403, which mpv reports as "loading failed (-13)". These pin how long
// the plugin waits before handing such a URL to the host.

const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const NOW = 1_792_273_474_000; // ms

test("parseChosenFormat reads available_at off the tagged line", () => {
  const f = plugin._parseChosenFormat(
    "ytdlp-fmt\t140\tm4a\tnone\tmp4a.40.2\tNA\t129.5\thttps\t140 - audio only (medium)\t1792273477",
  );
  assert.equal(f.availableAt, 1792273477);
  assert.equal(f.format, "140 - audio only (medium)");
});

test("a line from a yt-dlp that prints no available_at has none", () => {
  assert.equal(plugin._parseChosenFormat("ytdlp-fmt\t140\tm4a\tnone\tmp4a.40.2\tNA\t129\thttps\tx").availableAt, null);
  assert.equal(plugin._parseChosenFormat("ytdlp-fmt\t140\tm4a\tnone\tmp4a.40.2\tNA\t129\thttps\tx\tNA").availableAt, null);
});

test("waits until available_at plus a small margin", () => {
  // available_at 2.8s from now → 2.8s + 250ms margin
  assert.equal(plugin._streamReleaseWaitMs(1792273476.8, NOW), 3050);
  // yt-dlp prints it as text; the direct path parses, the cache keeps a number
  assert.equal(plugin._streamReleaseWaitMs("1792273476.8", NOW), 3050);
});

test("no wait for a URL that is already released, or carries no time", () => {
  assert.equal(plugin._streamReleaseWaitMs(1792273470, NOW), 0);
  assert.equal(plugin._streamReleaseWaitMs(null, NOW), 0);
  assert.equal(plugin._streamReleaseWaitMs(undefined, NOW), 0);
  assert.equal(plugin._streamReleaseWaitMs("NA", NOW), 0);
  assert.equal(plugin._streamReleaseWaitMs(0, NOW), 0);
});

test("never holds a URL longer than the cap", () => {
  // An hour-away available_at is not an ad gate — hand the URL over and let the
  // host's retry deal with it rather than freeze playback.
  assert.equal(plugin._streamReleaseWaitMs(NOW / 1000 + 3600, NOW), 15000);
});

test("latestAvailableAt takes the latest across a format list", () => {
  assert.equal(plugin._latestAvailableAt([
    { format_id: "251", available_at: 1792273477 },
    { format_id: "137", available_at: 1792273479 },
    { format_id: "sb0" },
  ]), 1792273479);
  assert.equal(plugin._latestAvailableAt([{ format_id: "18" }]), null);
  assert.equal(plugin._latestAvailableAt([]), null);
  assert.equal(plugin._latestAvailableAt(null), null);
});
