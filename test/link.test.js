const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

const plugin = loadPlugin();

// ---------------------------------------------------------------------------
// parseSearchOutput (pure)
// ---------------------------------------------------------------------------

test("parseSearchOutput parses candidates without playlist fields", () => {
  const stdout =
    "https://www.youtube.com/watch?v=aaaaaaaaaaa\t213\tRadiohead\tRadiohead - Creep\thttps://i.ytimg.com/x.jpg\n" +
    "https://www.youtube.com/watch?v=bbbbbbbbbbb\tNA\tNA\tNA\tNA\n" +
    "not-a-url\t1\tx\ty\tNA\n";
  const r = plugin._parseSearchOutput(stdout, false);
  assert.equal(r.candidates.length, 2); // invalid-url line skipped
  assert.deepEqual(r.candidates[0], {
    url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    title: "Radiohead - Creep",
    uploader: "Radiohead",
    durationSecs: 213,
    thumbnail: "https://i.ytimg.com/x.jpg",
  });
  assert.equal(r.candidates[1].durationSecs, null);
  assert.equal(r.candidates[1].uploader, "");
  assert.equal(r.meta, null);
});

test("parseSearchOutput extracts playlist meta from the first non-NA line", () => {
  const stdout =
    "https://x.example/a\t10\tU\tA\tNA\tMy Mix\t42\n" +
    "https://x.example/b\t20\tU\tB\tNA\tMy Mix\t42\n";
  const r = plugin._parseSearchOutput(stdout, true);
  assert.equal(r.candidates.length, 2);
  assert.deepEqual(r.meta, { title: "My Mix", count: 42 });
});

test("parseSearchOutput: single video (NA playlist fields) yields no meta", () => {
  const stdout = "https://x.example/a\t10\tU\tA\tNA\tNA\tNA\n";
  const r = plugin._parseSearchOutput(stdout, true);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.meta, null);
});

test("parseSearchOutput: playlist title without a count still yields meta", () => {
  const r = plugin._parseSearchOutput("https://x.example/a\t10\tU\tA\tNA\tMy Mix\tNA\n", true);
  assert.deepEqual(r.meta, { title: "My Mix", count: null });
});

// ---------------------------------------------------------------------------
// Link tab integration
// ---------------------------------------------------------------------------

function toolsPresent(extra) {
  return [
    { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.01.01" } },
    { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 7.0" } },
    ...(extra || []),
  ];
}

const SEARCH_STDOUT =
  "https://www.youtube.com/watch?v=aaaaaaaaaaa\t213\tRadiohead\tRadiohead - Creep\thttps://i.ytimg.com/x.jpg\n" +
  "https://www.youtube.com/watch?v=bbbbbbbbbbb\t180\tBjork\tBjork - Joga\tNA";

const PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLtest";
const PLAYLIST_STDOUT =
  "https://www.youtube.com/watch?v=aaaaaaaaaaa\t213\tRadiohead\tRadiohead - Creep\thttps://i.ytimg.com/a.jpg\tOK Mix\t142\n" +
  "https://www.youtube.com/watch?v=bbbbbbbbbbb\t180\tBjork\tBjork - Joga\tNA\tOK Mix\t142";

const VIDEO_URL = "https://vimeo.com/12345";
const VIDEO_STDOUT = "https://vimeo.com/12345\t300\tSomeone\tA Film\tNA\tNA\tNA";

const RULES = [
  { match: { cmd: "yt-dlp", argsInclude: [PLAYLIST_URL] }, result: { exitCode: 0, stdout: PLAYLIST_STDOUT } },
  { match: { cmd: "yt-dlp", argsInclude: [VIDEO_URL] }, result: { exitCode: 0, stdout: VIDEO_STDOUT } },
  { match: { cmd: "yt-dlp", argsInclude: ["--flat-playlist"] }, result: { exitCode: 0, stdout: SEARCH_STDOUT } },
];

async function activated() {
  const api = makeApi({ exec: toolsPresent(RULES) });
  const p = loadPlugin();
  await p.activate(api);
  await new Promise((r) => setTimeout(r, 5));
  return { api, plugin: p };
}

function lastView(api) {
  const views = api.calls.setViewData.filter((v) => v.id === "ytdlp-search");
  return views[views.length - 1].data;
}

test("Link fetch of a playlist shows a header toolbar with title + true count and numbered rows", async () => {
  const { api } = await activated();
  api._handlers["action:ytdlp-source"]({ tabId: "link" });
  await api._handlers["action:ytdlp-search-submit"]({ query: PLAYLIST_URL });

  // The URL fetch must request the playlist fields; plain searches must not.
  const call = api.calls.exec.find((c) => c.args.includes(PLAYLIST_URL));
  const printArg = call.args[call.args.indexOf("--print") + 1];
  assert.ok(printArg.includes("%(playlist_title)s"), "URL fetch requests playlist_title");
  assert.ok(printArg.includes("%(playlist_count)s"), "URL fetch requests playlist_count");
  assert.equal(call.args[call.args.indexOf("--encoding") + 1], "utf-8",
    "must force UTF-8 or non-Latin titles (e.g. Greek, on Windows) come back as mojibake");

  const view = lastView(api);
  const input = view.children.find((c) => c.type === "search-input");
  assert.equal(input.pasteButton, true, "Link tab offers the paste-and-fetch button");
  assert.equal(input.stateKey, "link");
  const toolbar = view.children.find((c) => c.type === "toolbar");
  assert.ok(toolbar, "playlist fetch must render a header toolbar");
  assert.ok(toolbar.title.includes("OK Mix"), "header carries the playlist title");
  assert.ok(toolbar.title.includes("142"), "header carries the TRUE count, not the capped row count");
  assert.deepEqual(toolbar.buttons.map((b) => b.action), ["ytdlp-link-play-all", "ytdlp-link-queue-all"]);

  const list = view.children.find((c) => c.type === "track-row-list");
  assert.equal(list.numbered, true, "playlist rows are numbered (source order)");
});

test("Play all plays every fetched track with playlist context (name + cover + source)", async () => {
  const { api, plugin } = await activated();
  api._handlers["action:ytdlp-source"]({ tabId: "link" });
  await api._handlers["action:ytdlp-search-submit"]({ query: PLAYLIST_URL });

  api._handlers["action:ytdlp-link-play-all"]({});
  assert.equal(api.calls.playTracks.length, 1);
  const { tracks, startIndex, context } = api.calls.playTracks[0];
  assert.equal(tracks.length, 2);
  assert.equal(startIndex, 0);
  assert.equal(tracks[0].path, plugin._encodeRef("https://www.youtube.com/watch?v=aaaaaaaaaaa", false));
  assert.equal(context.name, "OK Mix");
  assert.equal(context.source, "playlist");
  assert.equal(context.coverUrl, "https://i.ytimg.com/a.jpg");
});

test("Queue all inserts every fetched track at the queue end", async () => {
  const { api } = await activated();
  api._handlers["action:ytdlp-source"]({ tabId: "link" });
  await api._handlers["action:ytdlp-search-submit"]({ query: PLAYLIST_URL });

  api._handlers["action:ytdlp-link-queue-all"]({});
  assert.equal(api.calls.insertTracks.length, 1);
  assert.equal(api.calls.insertTracks[0].tracks.length, 2);
  assert.equal(api.calls.insertTracks[0].position, -1);
});

test("Link fetch of a single video: no header toolbar, no numbering", async () => {
  const { api } = await activated();
  api._handlers["action:ytdlp-source"]({ tabId: "link" });
  await api._handlers["action:ytdlp-search-submit"]({ query: VIDEO_URL });

  const view = lastView(api);
  assert.ok(!view.children.some((c) => c.type === "toolbar"), "single video gets no playlist header");
  const list = view.children.find((c) => c.type === "track-row-list");
  assert.equal(list.items.length, 1);
  assert.ok(!list.numbered, "a single row is not numbered");
});

test("tab state is per-source: flipping tabs never shows another tab's results", async () => {
  const { api } = await activated();
  // Search on the YouTube tab…
  await api._handlers["action:ytdlp-search-submit"]({ query: "radiohead" });
  let list = lastView(api).children.find((c) => c.type === "track-row-list");
  assert.equal(list.items.length, 2);

  // …flip to Link: no results there yet, just the hint (not YouTube's rows).
  api._handlers["action:ytdlp-source"]({ tabId: "link" });
  let view = lastView(api);
  assert.ok(!view.children.some((c) => c.type === "track-row-list"), "Link tab must not show YouTube results");

  // Fetch a playlist on Link, flip back to YouTube: its results survived.
  await api._handlers["action:ytdlp-search-submit"]({ query: PLAYLIST_URL });
  api._handlers["action:ytdlp-source"]({ tabId: "youtube" });
  view = lastView(api);
  list = view.children.find((c) => c.type === "track-row-list");
  assert.equal(list.items.length, 2);
  assert.ok(!view.children.some((c) => c.type === "toolbar"), "YouTube tab must not show the Link playlist header");
  const input = view.children.find((c) => c.type === "search-input");
  assert.equal(input.value, "radiohead", "each tab keeps its own query");
  assert.equal(input.stateKey, "youtube", "stateKey follows the active tab so the host keeps per-tab text");
  assert.equal(input.pasteButton, false, "no paste button outside the Link tab");

  // …and the Link fetch is still there too.
  api._handlers["action:ytdlp-source"]({ tabId: "link" });
  view = lastView(api);
  assert.ok(view.children.some((c) => c.type === "toolbar"), "Link results survive the tab flip");
});
