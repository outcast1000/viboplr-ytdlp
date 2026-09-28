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
