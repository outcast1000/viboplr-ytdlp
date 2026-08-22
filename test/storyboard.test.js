const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// Shape mirrors yt-dlp's `sb*` formats. Measured from a real 213s video: every level
// shares the same ~2s interval and grows SHEET COUNT rather than the interval.
function sb(id, w, h, cols, rows, sheets, fragDur) {
  const fragments = [];
  for (let i = 0; i < sheets; i++) {
    fragments.push({ url: `https://i.ytimg.com/sb/${id}/M${i}.jpg?sqp=sig`, duration: fragDur });
  }
  return { format_id: id, width: w, height: h, columns: cols, rows, fragments, ext: "mhtml" };
}

// A 213s video, as measured: sb3 is one 10x10 sheet; sb0-sb2 share ~1.97s.
const SHORT = [
  { format_id: "140", url: "https://a/m4a", vcodec: "none", acodec: "mp4a.40.2" },
  sb("sb3", 48, 27, 10, 10, 1, 213.0),
  sb("sb2", 80, 45, 10, 10, 2, 197.22),
  sb("sb1", 160, 90, 5, 5, 5, 49.3),
  sb("sb0", 320, 180, 3, 3, 12, 17.75),
];

test("picks the cheapest readable tile within the sheet budget", () => {
  const b = plugin._storyboardFromFormats(SHORT);
  // sb0 has bigger tiles but costs 12 sheets against sb1's 5 for no visible gain
  // in the 240px bubble; sb2/sb3 tiles are too small to read. sb1 is the fit.
  assert.equal(b.id, "sb1");
  assert.equal(b.tileW, 160);
  assert.equal(b.sheets.length, 5);
  assert.equal(b.cols, 5);
  assert.equal(b.count, 125); // 5 sheets x 25
});

test("derives the interval from fragment duration, not sheet count", () => {
  const b = plugin._storyboardFromFormats(SHORT);
  // 49.3s per sheet / 25 tiles = ~1.97s — the real tile spacing.
  assert.ok(Math.abs(b.intervalSecs - 1.972) < 0.01, `got ${b.intervalSecs}`);
  assert.equal(b.startSecs, 0);
});

test("keeps remote urls for the caller to download", () => {
  const b = plugin._storyboardFromFormats(SHORT);
  assert.ok(b.sheets.every((u) => u.startsWith("https://")));
  // The signed sqp param is why the caller must cache BYTES, not urls.
  assert.ok(b.sheets[0].includes("sqp="));
});

test("an hour-long video still gets the readable sb1", () => {
  // ~1h at the 10s ceiling interval: sb1 is 15 sheets — inside the raised budget.
  // Under the old cap of 8 this fell all the way to sb3 (48x27, 36s/tile).
  const HOUR = [
    sb("sb3", 48, 27, 10, 10, 1, 3565.0),
    sb("sb2", 80, 45, 10, 10, 4, 999.0),
    sb("sb1", 160, 90, 5, 5, 15, 249.0),
  ];
  const b = plugin._storyboardFromFormats(HOUR);
  assert.equal(b.id, "sb1");
  assert.equal(b.sheets.length, 15);
});

test("falls back to the biggest in-budget tile when nothing readable fits", () => {
  // A 3-hour video: sb1 would be 45 sheets (over budget), sb0 even more. sb2 at
  // 12 sheets keeps the ~10s interval; sb3's interval is duration/100 (111s/tile
  // here) — an overview strip, useless for seeking — so it must NOT win on being
  // the single cheapest sheet.
  const LONG = [
    sb("sb3", 48, 27, 10, 10, 1, 11138.0),
    sb("sb2", 80, 45, 10, 10, 12, 999.0),
    sb("sb1", 160, 90, 5, 5, 45, 49.3),
  ];
  const b = plugin._storyboardFromFormats(LONG);
  assert.equal(b.id, "sb2", "biggest tile within the sheet budget wins");
  assert.equal(b.sheets.length, 12);
});

test("only when no level fits the budget does fewest downloads win", () => {
  const HUGE = [
    sb("sb2", 80, 45, 10, 10, 40, 999.0),
    sb("sb1", 160, 90, 5, 5, 120, 49.3),
  ];
  const b = plugin._storyboardFromFormats(HUGE);
  assert.equal(b.id, "sb2");
});

test("returns null when the source publishes no storyboards", () => {
  // Measured: a 19s clip offers no sb* formats at all. Not an error.
  assert.equal(plugin._storyboardFromFormats([{ format_id: "140", url: "https://a/m4a" }]), null);
  assert.equal(plugin._storyboardFromFormats([]), null);
  assert.equal(plugin._storyboardFromFormats(null), null);
});

test("skips malformed levels rather than emitting a broken descriptor", () => {
  const bad = [
    { format_id: "sb0", columns: 10, rows: 10, fragments: [] },                 // no sheets
    { format_id: "sb1", columns: 0, rows: 10, fragments: [{ url: "https://x", duration: 1 }] }, // no grid
    { format_id: "sb2", columns: 10, rows: 10, fragments: [{ url: "https://x", duration: 0 }] }, // no duration
    { format_id: "sb3", columns: 10, rows: 10, fragments: [{ url: "ftp://x", duration: 10 }] },  // not http
  ];
  assert.equal(plugin._storyboardFromFormats(bad), null);
});

test("a level with only some usable fragments keeps just those", () => {
  const mixed = [{
    format_id: "sb1", width: 160, height: 90, columns: 5, rows: 5,
    fragments: [
      { url: "https://i/a.jpg", duration: 49.3 },
      { url: "not-a-url", duration: 49.3 },
      { url: "https://i/c.jpg", duration: 49.3 },
    ],
  }];
  const b = plugin._storyboardFromFormats(mixed);
  assert.equal(b.sheets.length, 2);
  assert.equal(b.count, 50, "count must follow the sheets actually kept");
});
