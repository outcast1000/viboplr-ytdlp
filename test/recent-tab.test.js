// The "Recent" tab keeps the last requests' traces whole, so a user can see
// what yt-dlp did for a track without opening the app log. These pin what is
// recorded, how a trace reads at a glance, and what the tab renders.

const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const quietApi = { log: () => {} };

function clear() {
  plugin._recentTraces().splice(0);
}

test("a trace records every line, flagging the exec plumbing", async () => {
  clear();
  const api = {
    log: () => {},
    system: { exec: async () => ({ exitCode: 0, stdout: "https://x\n", stderr: "" }) },
  };
  const trace = plugin._startTrace(api, "stream resolve by metadata", "Song — Artist (200s)", {});
  await plugin._execLogged(api, trace, "direct-url", ["-f", "140"], { cwd: null });
  plugin._traceDone(trace, "audio stream");

  const recorded = plugin._recentTraces();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0], trace);
  const commands = trace.lines.filter((l) => l.command).map((l) => l.msg);
  assert.equal(commands.length, 2, commands.join("\n"));
  assert.match(commands[0], /^run direct-url: yt-dlp/);
  assert.match(commands[1], /^direct-url: exit 0 in/);
});

test("a failed exit is not hidden as plumbing", async () => {
  clear();
  const api = {
    log: () => {},
    system: { exec: async () => ({ exitCode: 1, stdout: "", stderr: "ERROR: Video unavailable" }) },
  };
  const trace = plugin._startTrace(api, "stream resolve by uri", "https://www.youtube.com/watch?v=x (audio)", {});
  await plugin._execLogged(api, trace, "direct-url", [], { cwd: null });
  const exit = trace.lines.find((l) => /exit 1/.test(l.msg));
  assert.ok(exit && !exit.command, "the failure stays visible");
  assert.ok(plugin._recentTraceLines(trace, false).some((l) => /exit 1/.test(l)));
});

test("recentTraceLines skips the header, hides commands unless asked, and marks problems", () => {
  const trace = {
    startedAt: 1_000,
    lines: [
      { at: 1_000, level: "info", msg: "stream resolve by metadata — Song", command: false },
      { at: 1_000, level: "info", msg: "  engine=mpv/single", command: false },
      { at: 1_100, level: "info", msg: "run search: yt-dlp ytsearch7:Song", command: true },
      { at: 3_600, level: "info", msg: "1. search youtube → 7 hit(s)", command: false },
      { at: 3_700, level: "warn", msg: "2. direct audio URL → failed", command: false },
    ],
  };
  assert.deepEqual(plugin._recentTraceLines(trace, false), [
    "+2.6s   1. search youtube → 7 hit(s)",
    "+2.7s ⚠ 2. direct audio URL → failed",
  ]);
  assert.equal(plugin._recentTraceLines(trace, true)[0], "+0.1s   run search: yt-dlp ytsearch7:Song");
});

test("recentStatus reads running, handed over, nothing playable, failed and cancelled", () => {
  assert.equal(plugin._recentStatus({ result: null }).label, "Running");
  assert.equal(plugin._recentStatus({ result: { level: "info" } }).label, "Handed to the app");
  assert.equal(plugin._recentStatus({ result: { level: "warn" } }).label, "Nothing playable");
  assert.equal(plugin._recentStatus({ result: { level: "error" } }).label, "Failed");
  assert.equal(plugin._recentStatus({ result: { level: "info" }, cancelled: true }).label, "Cancelled");
});

test("a cancel is recorded as the app's decision, anything else as a failure", () => {
  clear();
  const cancelled = plugin._startTrace(quietApi, "stream resolve by uri", "a", {});
  assert.equal(plugin._traceCancelledOrThrew(cancelled, "uri resolve", new Error("Cancelled")), true);
  assert.equal(plugin._recentStatus(cancelled).label, "Cancelled");
  assert.match(cancelled.result.outcome, /app stopped waiting/);

  const failed = plugin._startTrace(quietApi, "stream resolve by uri", "b", {});
  assert.equal(plugin._traceCancelledOrThrew(failed, "uri resolve", new Error("boom")), false);
  assert.equal(plugin._recentStatus(failed).label, "Failed");
  assert.equal(failed.result.outcome, "uri resolve threw — boom");
});

test("recentTraceMeta names the request kind, time, duration and outcome", () => {
  const start = new Date(2026, 9, 18, 23, 55, 29).getTime();
  const done = { kind: "stream resolve by metadata", startedAt: start, result: { level: "info", outcome: "audio stream", at: start + 7700 } };
  assert.equal(plugin._recentTraceMeta(done, start + 9000),
    "Playback fallback — found by name · 23:55:29 · took 7.7s · Handed to the app — audio stream");
  const running = { kind: "watch video", startedAt: start, result: null };
  assert.equal(plugin._recentTraceMeta(running, start + 2500), "Watch YouTube video · 23:55:29 · running for 2.5s · Running");
});

test("only the last 25 requests are kept", () => {
  clear();
  for (let i = 0; i < 30; i++) plugin._startTrace(quietApi, "stream resolve by uri", "track " + i, {});
  const kept = plugin._recentTraces();
  assert.equal(kept.length, 25);
  assert.equal(kept[0].subject, "track 5");
  assert.equal(kept[24].subject, "track 29");
});

test("the tab lists requests newest first, with their log escaped", () => {
  clear();
  const empty = [];
  plugin._appendRecentView(empty);
  assert.ok(empty.some((n) => n.type === "text" && /Nothing yet/.test(n.content)));

  const older = plugin._startTrace(quietApi, "stream resolve by uri", "Older", {});
  plugin._traceDone(older, "single stream");
  const newer = plugin._startTrace(quietApi, "stream resolve by metadata", "Newer <b>", {});
  newer.lines.push({ at: newer.startedAt, level: "warn", msg: "odd <script> in a title", command: false });
  plugin._traceDone(newer, "no playable stream", "warn");

  const nodes = [];
  plugin._appendRecentView(nodes);
  const sections = nodes.filter((n) => n.type === "section");
  assert.deepEqual(sections.map((s) => s.title), ["⚠ Newer <b>", "✓ Older"]);
  const pre = sections[0].children.find((c) => /<pre/.test(c.content)).content;
  assert.ok(pre.includes("odd &lt;script&gt; in a title"), pre);
  assert.ok(!pre.includes("<script>"));
});
