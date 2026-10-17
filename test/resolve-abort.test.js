// The host's resolve signal (opts.signal on onStreamResolve /
// onResolveStreamByUri) must kill the yt-dlp run it started for that call and
// refuse the resolve's later steps — a search on a bad network otherwise ran on
// for minutes after the host had stopped waiting.

const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// An exec that stays running until the host-side handle cancels it, as the
// real `api.system.exec` does (rejects "Cancelled").
function makeApi() {
  const calls = { exec: [], cancelled: 0, logs: [] };
  const api = {
    log: (level, msg) => calls.logs.push(level + " " + msg),
    system: {
      exec: (cmd, args, opts) => new Promise((resolve, reject) => {
        calls.exec.push({ cmd, args, opts });
        if (opts && typeof opts.onStart === "function") {
          opts.onStart({ cancel: () => { calls.cancelled++; reject(new Error("Cancelled")); return Promise.resolve(true); } });
        }
        // Never finishes on its own — only a cancel ends it.
      }),
    },
  };
  return { api, calls };
}

test("aborting the signal kills the running yt-dlp and rejects with Cancelled", async () => {
  const { api, calls } = makeApi();
  const ctrl = new AbortController();
  const trace = plugin._startTrace(api, "stream resolve by metadata", "x", {}, ctrl.signal);
  const run = plugin._execLogged(api, trace, "search", ["ytsearch7:x"], undefined);
  ctrl.abort();
  await assert.rejects(run, /Cancelled/);
  assert.equal(calls.cancelled, 1);
  // `undefined` opts stay without a cwd key — only onStart is added.
  assert.deepEqual(Object.keys(calls.exec[0].opts), ["onStart"]);
});

test("a step after the abort never spawns", async () => {
  const { api, calls } = makeApi();
  const ctrl = new AbortController();
  ctrl.abort();
  const trace = plugin._startTrace(api, "stream resolve by uri", "x", {}, ctrl.signal);
  await assert.rejects(plugin._execLogged(api, trace, "direct-url", [], { cwd: null }), /Cancelled/);
  assert.equal(calls.exec.length, 0);
});

test("the caller's own exec options are kept alongside onStart", async () => {
  const { api, calls } = makeApi();
  const ctrl = new AbortController();
  const onOutput = () => {};
  const trace = plugin._startTrace(api, "stream resolve by uri", "x", {}, ctrl.signal);
  const run = plugin._execLogged(api, trace, "download", [], { cwd: null, onOutput });
  const opts = calls.exec[0].opts;
  assert.equal(opts.cwd, null);
  assert.equal(opts.onOutput, onOutput);
  assert.equal(typeof opts.onStart, "function");
  ctrl.abort();
  await assert.rejects(run, /Cancelled/);
});

test("without a signal the options pass through verbatim", async () => {
  let seen;
  const api = { log: () => {}, system: { exec: async (cmd, args, opts) => { seen = opts; return { exitCode: 0, stdout: "", stderr: "" }; } } };
  const trace = plugin._startTrace(api, "download", "x", {});
  const opts = { cwd: null };
  await plugin._execLogged(api, trace, "formats-json", [], opts);
  assert.equal(seen, opts);
  await plugin._execLogged(api, null, "storyboard", [], undefined);
  assert.equal(seen, undefined);
});
