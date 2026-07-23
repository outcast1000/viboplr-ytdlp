// In-memory fake of the viboplr host `api` bridge. Only the surface index.js uses
// is implemented. makeApi(config) returns the api plus `calls` (recorded
// invocations) and `_handlers` (callbacks the plugin registered).

const ROOT = "/mock-plugin-data";

function joinSegs(segs) { return ROOT + "/" + segs.join("/"); }

function makeStorage(seed) {
  const dirs = { cache: {}, temp: {} };
  if (seed && seed.files) {
    for (const dir of Object.keys(seed.files)) {
      dirs[dir] = dirs[dir] || {};
      for (const f of seed.files[dir]) dirs[dir][f.name] = { size: f.size || 0, modifiedAt: f.modifiedAt || 0 };
    }
  }
  const kv = new Map(Object.entries((seed && seed.kv) || {}));
  function dirOf(segs) { return dirs[segs[0]] || (dirs[segs[0]] = {}); }

  return {
    _dirs: dirs,
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    set: async (k, v) => { kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
    files: {
      list: async (segs) => {
        const d = dirs[segs[0]];
        if (!d) throw new Error("ENOENT");
        return Object.keys(d).map((name) => ({ name, isDir: false, size: d[name].size, modifiedAt: d[name].modifiedAt }));
      },
      remove: async (segs) => {
        if (segs.length === 1) { dirs[segs[0]] = {}; return; }
        const d = dirs[segs[0]];
        if (d) delete d[segs[1]];
      },
      writeText: async (segs, text) => {
        const d = dirOf(segs.slice(0, 1));
        const name = segs[segs.length - 1];
        d[name] = { size: (text || "").length, modifiedAt: 0 };
        return joinSegs(segs);
      },
      getPath: async (segs) => joinSegs(segs),
    },
  };
}

function execMatches(entry, cmd, args) {
  if (entry.match.cmd !== cmd) return false;
  const inc = entry.match.argsInclude || [];
  const joined = args.join(" ");
  return inc.every((s) => joined.includes(s));
}

function makeApi(config) {
  config = config || {};
  const calls = { exec: [], log: [], setViewData: [], playTracks: [], insertTracks: [], enqueue: [], requestAction: [], showNotification: [] };
  const handlers = {};
  const storage = makeStorage(config.storage);
  const execRules = config.exec || [];
  const fetchRules = config.fetch || {};

  const api = {
    calls,
    _handlers: handlers,
    _storage: storage,
    appVersion: config.appVersion || "0.9.169",
    log: (level, msg, section) => { calls.log.push({ level, msg, section }); },
    system: {
      exec: async (cmd, args, opts) => {
        args = args || [];
        calls.exec.push({ cmd, args });
        for (const rule of execRules) {
          if (execMatches(rule, cmd, args)) {
            let r = typeof rule.result === "function" ? rule.result(cmd, args) : rule.result;
            if (r && typeof r.then === "function") r = await r;
            return Object.assign({ exitCode: 0, stdout: "", stderr: "" }, r);
          }
        }
        return { exitCode: 1, stdout: "", stderr: "" };
      },
      getDependency: async (name) => {
        const verArg = name === "ffmpeg" ? "-version" : "--version";
        for (const rule of execRules) {
          if (rule.match.cmd === name) {
            const r = (typeof rule.result === "function" ? rule.result(name, [verArg]) : rule.result) || {};
            if ((r.exitCode == null || r.exitCode === 0) && r.stdout) {
              return { name, installed: true, version: (r.stdout.split("\n")[0] || "").trim(), origin: "system", latest: null };
            }
          }
        }
        return { name, installed: false, version: null, origin: null, latest: null };
      },
    },
    network: {
      fetch: async (url, init) => {
        for (const key of Object.keys(fetchRules)) {
          if (url.includes(key)) {
            const v = fetchRules[key];
            const resolved = typeof v === "function" ? v(url, init) : v;
            return Object.assign({ status: 200, json: async () => resolved, text: async () => (typeof resolved === "string" ? resolved : JSON.stringify(resolved)) }, typeof resolved === "object" && resolved && "status" in resolved ? { status: resolved.status } : {});
          }
        }
        return { status: 200, json: async () => ({}), text: async () => "" };
      },
      openUrl: () => {},
    },
    storage,
    playback: {
      onStreamResolve: (id, fn) => { handlers["stream:" + id] = fn; },
      onResolveStreamByUri: (scheme, fn) => { handlers["streamuri:" + scheme] = fn; },
      playTracks: (tracks, startIndex, context) => { calls.playTracks.push({ tracks, startIndex, context }); },
      insertTracks: (tracks, position) => { calls.insertTracks.push({ tracks, position }); },
    },
    downloads: {
      onResolveByUri: (id, fn) => { handlers["uri:" + id] = fn; },
      onResolveByMetadata: (id, fn) => { handlers["meta:" + id] = fn; },
      onGetQualities: (id, fn) => { handlers["qual:" + id] = fn; },
      onInteractiveSearch: (id, fn) => { handlers["isearch:" + id] = fn; },
      onInteractiveResolve: (id, fn) => { handlers["iresolve:" + id] = fn; },
      enqueue: async (request) => { calls.enqueue.push(request); return calls.enqueue.length; },
    },
    ui: {
      onAction: (id, fn) => { handlers["action:" + id] = fn; },
      setViewData: (id, data, opts) => { calls.setViewData.push({ id, data, opts }); },
      requestAction: (action, payload) => { calls.requestAction.push({ action, payload }); },
      showNotification: (message) => { calls.showNotification.push(message); },
    },
  };

  return api;
}

module.exports = { makeApi };
