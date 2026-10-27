// Some uploads have every stream URL refused (HTTP 403) however often it is
// minted, while the browser still plays them. The host's retries replayed the
// same upload three times and gave up; these pin that, on a retry, the plugin
// checks the fresh URL, moves on to the next search result when it is refused,
// and never serves a cached URL of a refused upload again.

const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

const A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const B = "https://www.youtube.com/watch?v=bbbbbbbbbbb";
const SEARCH_STDOUT =
  A + "\t95\tLa Dispute\tSuch Small Hands\tNA\t1000000\n" +
  B + "\t131\tSomeone\tSuch Small Hands (live)\tNA\t5000";

// A signed URL that lives for hours, so the plugin caches it.
const expire = () => Math.floor(Date.now() / 1000) + 6 * 3600;
const streamFor = (watchUrl) => "https://cdn.example/" + watchUrl.slice(-11) + "?expire=" + expire();

function behavior() {
  return [
    { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.10.26" } },
    { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 7.0" } },
    {
      match: { cmd: "yt-dlp", argsInclude: ["%(urls)s"] },
      result: (cmd, args) => ({ exitCode: 0, stdout: streamFor(args[args.length - 1]) + "\n" + JSON.stringify({ "User-Agent": "UA" }) }),
    },
    { match: { cmd: "yt-dlp", argsInclude: ["--flat-playlist"] }, result: { exitCode: 0, stdout: SEARCH_STDOUT } },
  ];
}

// `refused` = the video ids whose streams answer 403.
async function activated(refused) {
  const probes = [];
  const api = makeApi({ exec: behavior() });
  api.network.fetch = async (url, init) => {
    probes.push({ url, init });
    const id = url.slice("https://cdn.example/".length, "https://cdn.example/".length + 11);
    return { status: refused.includes(id) ? 403 : 206, headers: {}, text: async () => "" };
  };
  const plugin = loadPlugin();
  await plugin.activate(api);
  await new Promise((r) => setTimeout(r, 5));
  return { api, plugin, probes, resolve: (opts) => api._handlers["stream:ytdlp-fallback"]("Such Small Hands", "La Dispute", null, 95, opts) };
}

const directCalls = (api) => api.calls.exec.filter((c) => c.args.includes("%(urls)s")).map((c) => c.args[c.args.length - 1]);

test("probe verdicts: only an answer a new URL can't change counts as refused", (t) => {
  const plugin = loadPlugin();
  assert.equal(plugin._probeVerdict(206), "ok");
  assert.equal(plugin._probeVerdict(200), "ok");
  assert.equal(plugin._probeVerdict(403), "refused");
  assert.equal(plugin._probeVerdict(401), "refused");
  assert.equal(plugin._probeVerdict(410), "refused");
  assert.equal(plugin._probeVerdict(500), "unknown");
  assert.equal(plugin._probeVerdict(429), "unknown");
  assert.equal(plugin._probeVerdict(302), "unknown");
});

test("a refused source is remembered for its TTL, and the table stays bounded", () => {
  const plugin = loadPlugin();
  const table = {};
  plugin._markRefusedSource(table, A, 1000);
  assert.equal(plugin._isRefusedSource(table, A, 1000 + plugin._REFUSED_SOURCE_TTL_MS - 1), true);
  assert.equal(plugin._isRefusedSource(table, A, 1000 + plugin._REFUSED_SOURCE_TTL_MS), false);
  assert.equal(plugin._isRefusedSource(table, B, 1000), false);
  for (let i = 0; i < plugin._REFUSED_SOURCE_MAX + 5; i++) plugin._markRefusedSource(table, "u" + i, 2000 + i);
  assert.equal(Object.keys(table).length, plugin._REFUSED_SOURCE_MAX);
  assert.equal(plugin._isRefusedSource(table, A, 2000), false, "the oldest entry goes first");
});

test("pickUnskipped takes the best candidate the skip rule leaves", () => {
  const plugin = loadPlugin();
  const ranked = [{ url: A }, { url: B }];
  assert.deepEqual(plugin._pickUnskipped(ranked, null), { cand: ranked[0], skipped: 0 });
  assert.deepEqual(plugin._pickUnskipped(ranked, (u) => u === A), { cand: ranked[1], skipped: 1 });
  assert.deepEqual(plugin._pickUnskipped(ranked, () => true), { cand: null, skipped: 2 });
});

test("a first play is not probed", async () => {
  const { resolve, probes } = await activated(["aaaaaaaaaaa"]);
  const r = await resolve();
  assert.ok(r.url.includes("aaaaaaaaaaa"));
  assert.equal(probes.length, 0);
});

test("on the host's retry, a refused upload is passed over for the next search result", async () => {
  const { api, resolve, probes } = await activated(["aaaaaaaaaaa"]);
  await resolve();
  const r = await resolve({ fresh: true });
  assert.ok(r.url.includes("bbbbbbbbbbb"), "plays the second upload");
  assert.equal(r.sourceUrl, B);
  assert.deepEqual(directCalls(api), [A, A, B]);
  assert.equal(probes.length, 2, "the fresh A and the alternate B are both checked");
  assert.equal(probes[0].init.headers.Range, "bytes=0-0");
  assert.equal(probes[0].init.headers["User-Agent"], "UA", "probed with the engine's headers");
  assert.equal(api.calls.exec.filter((c) => c.args.includes("--flat-playlist")).length, 1, "the search is served from cache");
});

test("after a refusal the next play goes straight to another upload, never the cached URL", async () => {
  const { api, resolve } = await activated(["aaaaaaaaaaa"]);
  await resolve();
  await resolve({ fresh: true });
  const before = directCalls(api).length;
  const r = await resolve();
  assert.ok(r.url.includes("bbbbbbbbbbb"));
  // B's URL was cached by the retry, so this play needs no extraction at all.
  assert.equal(directCalls(api).length, before);
});

test("a retry whose fresh URL works plays the same upload", async () => {
  const { api, resolve } = await activated([]);
  await resolve();
  const r = await resolve({ fresh: true });
  assert.ok(r.url.includes("aaaaaaaaaaa"));
  assert.deepEqual(directCalls(api), [A, A]);
});

test("every upload refused: the resolve gives up with nothing rather than a dead stream", async () => {
  const { resolve, api } = await activated(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
  await resolve();
  const r = await resolve({ fresh: true });
  assert.equal(r, null);
  assert.ok(api.calls.log.some((l) => /every one refused|every upload found was refused/.test(l.msg)));
});

test("a probe that gets no answer hands the stream over as before", async () => {
  const { api, resolve } = await activated([]);
  api.network.fetch = async () => { throw new Error("timed out"); };
  const r = await resolve({ fresh: true });
  assert.ok(r.url.includes("aaaaaaaaaaa"));
});

test("a refused ytdlp:// track, which names one upload, resolves to nothing", async () => {
  const { api, plugin } = await activated(["aaaaaaaaaaa"]);
  const id = plugin._encodeRef(A, false).slice("ytdlp://".length);
  const first = await api._handlers["streamuri:ytdlp"](id, null, {});
  assert.ok(first.candidates[0].url.includes("aaaaaaaaaaa"));
  const retry = await api._handlers["streamuri:ytdlp"](id, null, { fresh: true });
  assert.equal(retry, null);
  // The next ordinary play neither serves the URL cached before the refusal
  // nor hands over a fresh one unchecked.
  const before = directCalls(api).length;
  assert.equal(await api._handlers["streamuri:ytdlp"](id, null, {}), null);
  assert.equal(directCalls(api).length, before + 1, "minted again rather than served from cache");
});

test("a refused upload plays again once the site serves it", async () => {
  const refused = ["aaaaaaaaaaa"];
  const { api, plugin } = await activated(refused);
  const id = plugin._encodeRef(A, false).slice("ytdlp://".length);
  await api._handlers["streamuri:ytdlp"](id, null, {});
  assert.equal(await api._handlers["streamuri:ytdlp"](id, null, { fresh: true }), null);
  refused.length = 0;
  const again = await api._handlers["streamuri:ytdlp"](id, null, {});
  assert.ok(again.candidates[0].url.includes("aaaaaaaaaaa"));
});

test("the yt-dlp version is re-read once it is a minute old", () => {
  const plugin = loadPlugin();
  const ttl = plugin._TOOL_STATUS_TTL_MS;
  assert.equal(plugin._toolStatusStale(false, 0, 5), true);
  assert.equal(plugin._toolStatusStale(true, 1000, 1000 + ttl - 1), false);
  assert.equal(plugin._toolStatusStale(true, 1000, 1000 + ttl), true);
});

test("the trace names the yt-dlp version installed now, not the one at activation", async () => {
  const rules = behavior();
  const api = makeApi({ exec: rules });
  const plugin = loadPlugin();
  await plugin.activate(api);
  await new Promise((r) => setTimeout(r, 5));
  rules[0].result = { exitCode: 0, stdout: "2026.12.01" };
  const realNow = Date.now;
  Date.now = () => realNow() + plugin._TOOL_STATUS_TTL_MS + 1;
  try {
    await api._handlers["stream:ytdlp-fallback"]("Such Small Hands", "La Dispute", null, 95);
  } finally {
    Date.now = realNow;
  }
  assert.ok(api.calls.log.some((l) => l.msg.includes("yt-dlp=2026.12.01")), "trace context carries the new version");
});
