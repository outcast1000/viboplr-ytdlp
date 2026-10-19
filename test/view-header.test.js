const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

const plugin = loadPlugin();
const vh = plugin._viewHeaderFor;

// viewHeaderFor backs the host-drawn header over the sidebar view: one status
// word plus which tools were found. The fix for a missing yt-dlp stays in the
// view's own banner, so the header never carries an action for it.

test("viewHeaderFor returns null until the tool status is known", () => {
  assert.equal(vh(null), null);
  assert.equal(vh({ loaded: false, ytdlp: null }), null);
});

test("viewHeaderFor: yt-dlp missing is an error status, no actions", () => {
  const h = vh({ loaded: true, ytdlp: null, ffmpeg: "7.0" });
  assert.deepEqual(h.status, { variant: "error", label: "yt-dlp missing" });
  assert.deepEqual(h.actions, []);
  assert.match(h.subtitle, /1000\+ other sites/);
});

test("viewHeaderFor: ready names the yt-dlp version and ffmpeg", () => {
  const h = vh({ loaded: true, ytdlp: "2026.09.01", ffmpeg: "7.0", latest: "2026.09.01" });
  assert.deepEqual(h.status, { variant: "success", label: "Ready" });
  assert.equal(h.subtitle, "yt-dlp 2026.09.01 · ffmpeg found");
});

test("viewHeaderFor: missing ffmpeg is still ready, and says what it costs", () => {
  const h = vh({ loaded: true, ytdlp: "2026.09.01", ffmpeg: null });
  assert.equal(h.status.label, "Ready");
  assert.equal(h.subtitle, "yt-dlp 2026.09.01 · no ffmpeg (no merging or conversion)");
});

test("viewHeaderFor: an older yt-dlp than the host's cached latest warns", () => {
  const h = vh({ loaded: true, ytdlp: "2026.01.01", ffmpeg: "7.0", latest: "2026.09.01" });
  assert.deepEqual(h.status, { variant: "warning", label: "Update available" });
});

test("viewHeaderFor: an unknown version reads as installed, never outdated", () => {
  const h = vh({ loaded: true, ytdlp: "unknown", ffmpeg: "unknown", latest: "2026.09.01" });
  assert.equal(h.subtitle, "yt-dlp installed · ffmpeg found");
  assert.equal(h.status.label, "Ready");
});

test("viewHeaderFor stays inside the host's limits", () => {
  const states = [
    { loaded: true, ytdlp: null, ffmpeg: null },
    { loaded: true, ytdlp: "2026.09.01", ffmpeg: null },
    { loaded: true, ytdlp: "2026.01.01", ffmpeg: "7.0", latest: "2026.09.01" },
  ];
  for (const s of states) {
    const h = vh(s);
    assert.ok(h.subtitle.length <= 160);
    assert.ok(h.status.label.length <= 32);
    assert.ok(h.actions.length <= 2);
  }
});

async function activatedWithHeader(exec) {
  const api = makeApi({ exec });
  api.calls.setViewHeader = [];
  api.ui.setViewHeader = (id, header) => { api.calls.setViewHeader.push({ id, header }); };
  const p = loadPlugin();
  await p.activate(api);
  await new Promise((r) => setTimeout(r, 5));
  return api;
}

test("activate pushes the header once the status loads, and only on change", async () => {
  const api = await activatedWithHeader([
    { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.09.01" } },
  ]);
  assert.equal(api.calls.setViewHeader.length, 1);
  assert.equal(api.calls.setViewHeader[0].id, "ytdlp-search");
  assert.equal(api.calls.setViewHeader[0].header.subtitle, "yt-dlp 2026.09.01 · no ffmpeg (no merging or conversion)");
  // Another render with nothing changed must not re-push.
  await api._handlers["action:ytdlp-source"]({ tab: "soundcloud" });
  assert.equal(api.calls.setViewHeader.length, 1);
});

test("hosts without setViewHeader are unaffected", async () => {
  const api = makeApi({ exec: [] });
  const p = loadPlugin();
  await p.activate(api);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(api.calls.setViewData.length > 0);
});

// A missing tool gets a button that opens the host's own install dialog
// (requestAction "require-dependency"); the plugin then re-reads the host's
// status until the tool shows up, since nothing tells it an install finished.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("viewHeaderFor: missing ffmpeg offers to install it", () => {
  const h = vh({ loaded: true, ytdlp: "2026.09.01", ffmpeg: null });
  assert.deepEqual(h.actions, [{ label: "Install ffmpeg", action: "ytdlp-install-ffmpeg", variant: "secondary" }]);
  assert.deepEqual(vh({ loaded: true, ytdlp: "2026.09.01", ffmpeg: "7.0" }).actions, []);
});

function bannerOf(api) {
  const last = api.calls.setViewData.filter((c) => c.id === "ytdlp-search").pop();
  let found = null;
  (function walk(n) {
    if (found || !n || typeof n !== "object") return;
    if (typeof n.className === "string" && n.className.includes("ds-banner")) { found = n; return; }
    for (const c of n.children || []) walk(c);
  })(last && last.data);
  return found;
}

test("the missing-yt-dlp banner carries the Install button", async () => {
  const api = makeApi({ exec: [] });
  const p = loadPlugin();
  await p.activate(api);
  await sleep(5);
  const banner = bannerOf(api);
  assert.ok(banner, "banner shown");
  const button = banner.children.find((c) => c.type === "button");
  assert.equal(button.action, "ytdlp-install-ytdlp");
  assert.doesNotMatch(JSON.stringify(banner), /Settings → Dependencies/);
  p.deactivate();
});

test("Install ffmpeg asks the host, then picks the tool up once installed", async () => {
  let ffmpegInstalled = false;
  const api = makeApi({
    exec: [
      { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.09.01" } },
      { match: { cmd: "ffmpeg" }, result: () => (ffmpegInstalled ? { exitCode: 0, stdout: "7.1" } : { exitCode: 1, stdout: "" }) },
    ],
  });
  api.calls.setViewHeader = [];
  api.ui.setViewHeader = (id, header) => { api.calls.setViewHeader.push({ id, header }); };
  const p = loadPlugin();
  p._setToolRecheckInterval(5);
  await p.activate(api);
  await sleep(5);

  await api._handlers["action:ytdlp-install-ffmpeg"]();
  assert.deepEqual(api.calls.requestAction.at(-1), { action: "require-dependency", payload: { name: "ffmpeg" } });

  await sleep(25);
  assert.match(api.calls.setViewHeader.at(-1).header.subtitle, /no ffmpeg/, "still missing before the install");

  ffmpegInstalled = true;
  await sleep(40);
  const header = api.calls.setViewHeader.at(-1).header;
  assert.match(header.subtitle, /ffmpeg found/);
  assert.deepEqual(header.actions, []);
  p.deactivate();
});

test("the re-check stops when the plugin is deactivated", async () => {
  const api = makeApi({ exec: [] });
  const p = loadPlugin();
  p._setToolRecheckInterval(5);
  await p.activate(api);
  await sleep(5);
  await api._handlers["action:ytdlp-install-ffmpeg"]();
  p.deactivate();
  const probes = api.calls.exec.length;
  let reads = 0;
  const original = api.system.getDependency;
  api.system.getDependency = async (name) => { reads += 1; return original(name); };
  await sleep(30);
  assert.equal(reads, 0, "no status reads after deactivate");
  assert.equal(api.calls.exec.length, probes);
});

test("Install yt-dlp names the plugin as the feature", async () => {
  const api = makeApi({ exec: [] });
  const p = loadPlugin();
  await p.activate(api);
  await api._handlers["action:ytdlp-install-ytdlp"]();
  assert.deepEqual(api.calls.requestAction.at(-1), {
    action: "require-dependency",
    payload: { name: "yt-dlp", feature: "The yt-dlp plugin" },
  });
  p.deactivate();
});
