const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

// The host's global search (Cmd+K) offers this catalog as a row and queries it
// only when the user picks that row — never while they type. That is what makes
// it acceptable to shell out to yt-dlp here, so these tests pin the contract the
// host relies on: registered only when usable, and every answer is one of
// ok / empty / error.

const SEARCH_STDOUT =
  "https://www.youtube.com/watch?v=aaaaaaaaaaa\t213\tRadiohead\tRadiohead - Creep\thttps://i.ytimg.com/x.jpg\t1000000\n" +
  "https://www.youtube.com/watch?v=bbbbbbbbbbb\t180\tBjork\tBjork - Joga\tNA\t5000";

function rules(opts) {
  opts = opts || {};
  const out = [{ match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 7.0" } }];
  // The harness's getDependency matches on cmd alone, so ANY successful yt-dlp
  // rule makes it report the binary as installed. "Missing" therefore means no
  // yt-dlp rules at all — which is also honest: with no binary there is nothing
  // to search with.
  if (opts.ytdlp === false) return out;
  out.push({ match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.01.01" } });
  out.push({
    match: { cmd: "yt-dlp", argsInclude: ["--flat-playlist"] },
    result: opts.searchFails
      ? { exitCode: 1, stdout: "", stderr: "ERROR: something broke" }
      : { exitCode: 0, stdout: opts.stdout !== undefined ? opts.stdout : SEARCH_STDOUT },
  });
  return out;
}

async function activated(config) {
  const api = makeApi(config);
  const plugin = loadPlugin();
  await plugin.activate(api);
  // Registration waits for the dependency status, which activate() defers to a
  // setTimeout(…, 0) — flush it, exactly as the real app's first paint does.
  await new Promise((r) => setTimeout(r, 5));
  return { api, plugin };
}

test("registers the provider and its query handler when yt-dlp is present", async () => {
  const { api } = await activated({ exec: rules() });
  assert.deepStrictEqual(api.calls.registerProvider, [{ id: "ytdlp-search", name: "yt-dlp" }]);
  assert.ok(api._handlers["search:ytdlp-search"], "query handler not registered");
});

test("does not offer the provider when yt-dlp is missing", async () => {
  // A provider that cannot answer must not appear in the dropdown at all —
  // offering it would promise a search that always fails.
  const { api } = await activated({ exec: rules({ ytdlp: false }) });
  assert.strictEqual(api.calls.registerProvider, undefined);
  assert.ok(!api._handlers["search:ytdlp-search"]);
});

test("degrades silently on a host with no api.search", async () => {
  // minAppVersion keeps this from happening in the gallery, but a sideloaded or
  // downgraded host must not break activation.
  const { api } = await activated({ exec: rules(), noSearchApi: true });
  assert.strictEqual(api.search, undefined);
  assert.ok(api._handlers["stream:ytdlp-fallback"], "activation aborted early");
});

test("returns ok with playable tracks the host can queue directly", async () => {
  const { api } = await activated({ exec: rules() });
  const result = await api._handlers["search:ytdlp-search"]("radiohead creep", 6);
  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.tracks.length, 2);
  const first = result.tracks[0];
  assert.strictEqual(first.title, "Creep");
  assert.strictEqual(first.artist_name, "Radiohead");
  assert.strictEqual(first.duration_secs, 213);
  // A path the host can resolve is the whole point — a metadata-only row would
  // need the fallback resolver to search all over again.
  assert.match(first.path, /^ytdlp:\/\//);
});

test("passes the host's limit through to the search", async () => {
  const { api } = await activated({ exec: rules() });
  await api._handlers["search:ytdlp-search"]("creep", 6);
  const call = api.calls.exec.find((c) => c.args.join(" ").includes("--flat-playlist"));
  assert.ok(call, "no search exec recorded");
  assert.ok(call.args.includes("ytsearch6:creep"), "expected ytsearch6, got: " + call.args.join(" "));
});

test("reports a blank query as empty without shelling out", async () => {
  const { api } = await activated({ exec: rules() });
  const before = api.calls.exec.length;
  assert.deepStrictEqual(await api._handlers["search:ytdlp-search"]("   ", 6), { status: "empty" });
  assert.strictEqual(api.calls.exec.length, before, "spawned yt-dlp for an empty query");
});

test("reports no matches as empty", async () => {
  const { api } = await activated({ exec: rules({ stdout: "" }) });
  assert.deepStrictEqual(await api._handlers["search:ytdlp-search"]("nothing here", 6), { status: "empty" });
});

test("reports a failed search as empty, since runSearch absorbs the failure", async () => {
  // Documents real behaviour rather than an aspiration: runSearchFull swallows a
  // non-zero exit and returns no candidates, so the host shows "no results".
  // Change this test if the plugin starts distinguishing the two.
  const { api } = await activated({ exec: rules({ searchFails: true }) });
  assert.deepStrictEqual(await api._handlers["search:ytdlp-search"]("creep", 6), { status: "empty" });
});
