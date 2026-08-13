const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

// A ytdlp:// ref for a video (the ".mp4" suffix is how encodeRef flags video-ness).
const URL = "https://www.youtube.com/watch?v=hTWKbfoikeg";
const REF = "ytdlp://" + encodeURIComponent(URL).replace(/\./g, "%2E") + ".mp4";
const ID = REF.slice("ytdlp://".length);

// One `sb1`-style level: 2 sheets, tiles big enough to clear STORYBOARD_MIN_TILE_W.
const INFO = JSON.stringify({
  duration: 278,
  formats: [
    { format_id: "140", url: "https://a/m4a", vcodec: "none", acodec: "mp4a.40.2" },
    {
      format_id: "sb1", width: 160, height: 90, columns: 5, rows: 5, ext: "mhtml",
      fragments: [
        { url: "https://i.ytimg.com/sb/x/M0.jpg?sqp=sig", duration: 49.3 },
        { url: "https://i.ytimg.com/sb/x/M1.jpg?sqp=sig", duration: 49.3 },
      ],
    },
  ],
});

function rules() {
  return [
    { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.01.01" } },
    { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 7.0" } },
    { match: { cmd: "yt-dlp", argsInclude: ["-j"] }, result: { exitCode: 0, stdout: INFO } },
  ];
}

async function activated(config) {
  const api = makeApi(config);
  const plugin = loadPlugin();
  await plugin.activate(api);
  await new Promise((r) => setTimeout(r, 5));
  return { api, plugin };
}

/** How many times yt-dlp was asked to dump metadata — the ~12s call being cached. */
function dumpCalls(api) {
  return api.calls.exec.filter((c) => c.cmd === "yt-dlp" && c.args.indexOf("-j") !== -1).length;
}

test("first resolve dumps metadata and downloads the sheets", async () => {
  const { api } = await activated({ exec: rules() });
  const board = await api._handlers["storyboard:ytdlp"](ID);

  assert.ok(board, "expected a storyboard");
  assert.equal(board.sheets.length, 2);
  assert.equal(board.cols, 5);
  assert.equal(board.count, 50);
  assert.equal(dumpCalls(api), 1);
  assert.equal(api._storage._downloads.length, 2, "both sheets fetched");
});

test("a repeat resolve serves the cache without re-running yt-dlp", async () => {
  // This is the whole point: yt-dlp -j measured ~12s on a real machine, and it ran
  // on EVERY play because only the sheet bytes were cached, never the descriptor.
  const { api } = await activated({ exec: rules() });

  const first = await api._handlers["storyboard:ytdlp"](ID);
  const second = await api._handlers["storyboard:ytdlp"](ID);

  assert.deepEqual(second, first, "cached descriptor must match the fresh one");
  assert.equal(dumpCalls(api), 1, "yt-dlp must not run a second time");
  assert.equal(api._storage._downloads.length, 2, "sheets must not be re-downloaded");
});

test("a missing sheet file re-resolves instead of returning dead paths", async () => {
  const { api } = await activated({ exec: rules() });
  const first = await api._handlers["storyboard:ytdlp"](ID);

  // Simulate the user clearing plugin storage: descriptor survives, bytes don't.
  const names = Object.keys(api._storage._dirs.storyboards);
  delete api._storage._dirs.storyboards[names[0]];

  const second = await api._handlers["storyboard:ytdlp"](ID);
  assert.deepEqual(second, first, "must rebuild to the same descriptor");
  assert.equal(dumpCalls(api), 2, "a stale entry must fall through to a real resolve");
});

test("a source with no storyboard is not cached as a hit", async () => {
  const noSb = JSON.stringify({ formats: [{ format_id: "140", url: "https://a/m4a" }] });
  const { api } = await activated({
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.01.01" } },
      { match: { cmd: "yt-dlp", argsInclude: ["-j"] }, result: { exitCode: 0, stdout: noSb } },
    ],
  });

  assert.equal(await api._handlers["storyboard:ytdlp"](ID), null);
  assert.equal(await api._handlers["storyboard:ytdlp"](ID), null);
  // Only positives are cached — a miss may be transient (bot gate, network), and a
  // sticky negative would mean "never a filmstrip for this video, ever".
  assert.equal(dumpCalls(api), 2);
});

test("audio and video refs for one url cache separately", async () => {
  const { api } = await activated({ exec: rules() });
  const audioId = ID.replace(/\.mp4$/, "");

  await api._handlers["storyboard:ytdlp"](ID);
  await api._handlers["storyboard:ytdlp"](audioId);

  assert.equal(dumpCalls(api), 2, "distinct refs must not share a cache entry");
});

test("the cache is bounded, evicting the oldest entries", () => {
  const plugin = loadPlugin();
  let map = {};
  for (let i = 0; i < 5; i++) map = plugin._putStoryboardCache(map, "stem" + i, { names: ["n"] }, 3, i);

  const keys = Object.keys(map);
  assert.equal(keys.length, 3, "must not grow past the cap");
  assert.ok(!keys.includes("stem0") && !keys.includes("stem1"), "oldest evicted first");
  assert.ok(keys.includes("stem4"), "newest kept");
});

test("re-putting an existing stem refreshes it rather than duplicating", () => {
  const plugin = loadPlugin();
  let map = {};
  map = plugin._putStoryboardCache(map, "a", { names: ["1"] }, 2, 1);
  map = plugin._putStoryboardCache(map, "b", { names: ["2"] }, 2, 2);
  map = plugin._putStoryboardCache(map, "a", { names: ["3"] }, 2, 3);
  map = plugin._putStoryboardCache(map, "c", { names: ["4"] }, 2, 4);

  // "a" was refreshed at t=3 so "b" (t=2) is the oldest and goes first.
  assert.deepEqual(Object.keys(map).sort(), ["a", "c"]);
  assert.deepEqual(map.a.names, ["3"], "refresh must overwrite the entry");
});
