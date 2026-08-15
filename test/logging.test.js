// What a resolve writes to the log. The plugin's whole failure surface is
// "the wrong stream played, or none did", and the only evidence a user can send
// back is the app log — so these assertions are about the log being READABLE
// after the fact: which formats existed, what was attempted in what order, and
// which engine the answer was shaped for.

const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");
const { makeApi } = require("./harness/mock-api.js");

const plugin = loadPlugin();

// ---------------------------------------------------------------------------
// Pure formatters
// ---------------------------------------------------------------------------

test("engineLabel names the only engine signal the host sends", () => {
  // externalAudio is set exactly when native mpv will render this as video, and
  // it is the difference between "menu of split streams" and "one muxed stream"
  // — i.e. between 1080p and YouTube's 360p muxed itag.
  assert.match(plugin._engineLabel(true), /native mpv/);
  assert.match(plugin._engineLabel(false), /self-contained/);
});

test("describeContext carries every decision input the argv doesn't show", () => {
  const line = plugin._describeContext({
    externalAudio: true, mode: "stream", preferVideo: true, fresh: true,
    maxHeight: 1080, ytDlp: "2026.07.04", ffmpeg: "7.0",
  });
  assert.match(line, /engine=native mpv/);
  assert.match(line, /playback=stream/);
  assert.match(line, /preferVideo=yes/);
  assert.match(line, /fresh=yes/);
  assert.match(line, /cap=1080p/);
  assert.match(line, /yt-dlp=2026\.07\.04/);
  assert.match(line, /ffmpeg=7\.0/);
});

test("describeContext reports missing tools rather than an empty field", () => {
  const line = plugin._describeContext({ maxHeight: 0 });
  assert.match(line, /cap=none/);
  assert.match(line, /yt-dlp=missing/);
  assert.match(line, /ffmpeg=missing/);
});

test("describeContext omits the engine when there was no such hint to report", () => {
  // A download resolve involves no playback engine. Naming one would be an
  // invented fact, which is worse in a diagnostic than a missing one.
  const line = plugin._describeContext({ mode: "stream", maxHeight: 0 });
  assert.ok(!/engine=/.test(line), line);
  assert.match(plugin._describeContext({ externalAudio: false }), /engine=browser/);
});

test("fmtMs keeps millisecond resolution below a second", () => {
  assert.equal(plugin._fmtMs(420), "420ms");
  assert.equal(plugin._fmtMs(1800), "1.8s");
  assert.equal(plugin._fmtMs(null), "?");
});

test("stderrGist prefers the ERROR: line over the first line of noise", () => {
  const stderr = "[debug] some chatter\nWARNING: nothing\nERROR: [youtube] x: Video unavailable\ntrailing";
  assert.equal(plugin._stderrGist(stderr), "ERROR: [youtube] x: Video unavailable");
  assert.equal(plugin._stderrGist("just a line"), "just a line");
  assert.equal(plugin._stderrGist(""), "");
  assert.equal(plugin._stderrGist("x".repeat(300)).length, 201, "truncated with an ellipsis");
});

const FORMATS = [
  { format_id: "sb2", ext: "mhtml", vcodec: "none", acodec: "none", url: "https://x/sb.mhtml" },
  { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 129, filesize: 3 * 1024 * 1024, url: "https://x/140.m4a" },
  { format_id: "251", ext: "webm", vcodec: "none", acodec: "opus", tbr: 160, url: "https://x/251.webm" },
  { format_id: "18", ext: "mp4", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360, width: 640, tbr: 600, url: "https://x/18.mp4" },
  { format_id: "137", ext: "mp4", vcodec: "avc1.640028", acodec: "none", height: 1080, width: 1920, fps: 30, tbr: 4500, filesize: 110 * 1024 * 1024, url: "https://x/137.mp4" },
  { format_id: "313", ext: "webm", vcodec: "vp9", acodec: "none", height: 2160, width: 3840, fps: 30, tbr: 20000, format_note: "2160p", url: "https://x/313.webm" },
];

test("summarizeFormats counts every kind and tabulates the playable ones", () => {
  const out = plugin._summarizeFormats(FORMATS, 0);
  assert.match(out, /6 format\(s\): 2 video-only · 2 audio-only · 1 muxed · 1 other/);
  assert.match(out, /video\s+137\s+mp4\s+1920x1080@30\s+avc1\.640028\s+4500k\s+110 MB/);
  assert.match(out, /audio\s+140\s+m4a\s+mp4a\.40\.2\s+129k\s+3 MB/);
  assert.match(out, /muxed\s+18\s+mp4\s+640x360\s+avc1\.42001E \+ mp4a\.40\.2/);
  // Storyboards are counted but never tabulated — they are numerous, never
  // playable, and they are what makes a raw format dump unreadable.
  assert.ok(!/sb2/.test(out), "storyboard rows stay out of the table");
});

test("summarizeFormats names what the resolution cap hid, instead of omitting it", () => {
  // A format the user's own setting removed is the most confusing kind of
  // absence: the source did publish 4K, we chose not to use it.
  const out = plugin._summarizeFormats(FORMATS, 1080);
  assert.match(out, /cap 1080p hides 1 video format\(s\): 2160p/);
  assert.ok(/313/.test(out), "the hidden format is still listed, just flagged");
});

test("summarizeFormats caps the table and says how many it dropped", () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ format_id: "f" + i, ext: "mp4", vcodec: "avc1", acodec: "none", height: 720 });
  const out = plugin._summarizeFormats(many, 0);
  assert.match(out, /\(\+10 more\)/);
});

test("summarizeFormats survives an empty or junk format list", () => {
  assert.match(plugin._summarizeFormats([], 0), /^0 format\(s\)/);
  assert.match(plugin._summarizeFormats(null, 0), /^0 format\(s\)/);
});

test("summarizeCandidates reports the menu the host actually chooses from", () => {
  const menu = [
    { url: "u1", kind: "video", height: 1080, container: "mp4", vcodec: "avc1.640028", tbr: 4500 },
    { url: "u2", kind: "video", height: 720, container: "mp4", vcodec: "avc1", tbr: 2000 },
    { url: "u3", kind: "audio", container: "webm", acodec: "opus", tbr: 160 },
    { url: "u4", kind: "muxed", height: 360, container: "mp4" },
  ];
  const out = plugin._summarizeCandidates(menu);
  assert.match(out, /^4 candidate\(s\):/);
  assert.match(out, /video 2 \(best video 1080p mp4 avc1\.640028 4500k\)/);
  assert.match(out, /audio 1 \(best audio webm opus 160k\)/);
  assert.match(out, /muxed 1 \(best muxed 360p mp4\)/);
  assert.equal(plugin._summarizeCandidates([]), "0 candidates");
});

test("parseChosenFormat reads back the tagged --print line", () => {
  const stdout = [
    "https://cdn.example/stream.mp4?sig=1",
    '{"User-Agent":"Mozilla"}',
    "ytdlp-fmt\t18\tmp4\tavc1.42001E\tmp4a.40.2\t360\t600.5\thttps\t18 - 640x360 (360p)",
  ].join("\n");
  const f = plugin._parseChosenFormat(stdout);
  assert.deepEqual(f, {
    id: "18", ext: "mp4", vcodec: "avc1.42001E", acodec: "mp4a.40.2",
    height: 360, tbr: 600.5, protocol: "https", format: "18 - 640x360 (360p)",
  });
  assert.match(plugin._describeChosenFormat(f), /id 18 · 360p · mp4 · v:avc1\.42001E · a:mp4a\.40\.2 · 601k · https/);
});

test("parseChosenFormat degrades to null when yt-dlp printed no such line", () => {
  // An older yt-dlp, or an extraction that died before format selection. The
  // resolve must still report the URL it got, not blow up on the missing line.
  assert.equal(plugin._parseChosenFormat("https://cdn.example/x.mp4\n"), null);
  assert.equal(plugin._parseChosenFormat(""), null);
  assert.match(plugin._describeChosenFormat(null), /not reported/);
});

test("parseChosenFormat treats NA columns as absent", () => {
  const f = plugin._parseChosenFormat("ytdlp-fmt\t140\tm4a\tnone\tmp4a.40.2\tNA\t129\thttps\tNA");
  assert.equal(f.height, null);
  assert.equal(f.format, null);
  assert.equal(f.acodec, "mp4a.40.2");
  // "none" is yt-dlp's word for the absent half of a split stream — printing
  // "v:none" would read as a codec instead of "this one is audio only".
  assert.ok(!/none/.test(plugin._describeChosenFormat(f)), plugin._describeChosenFormat(f));
});

// ---------------------------------------------------------------------------
// Integration: the log a real resolve leaves behind
// ---------------------------------------------------------------------------

const VIDEO_URL = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const INFO_JSON = JSON.stringify({ formats: FORMATS });

function rules(extra) {
  return [
    { match: { cmd: "yt-dlp", argsInclude: ["--version"] }, result: { exitCode: 0, stdout: "2026.07.04" } },
    { match: { cmd: "ffmpeg", argsInclude: ["-version"] }, result: { exitCode: 0, stdout: "ffmpeg version 7.0" } },
    ...(extra || []),
  ];
}

async function activated(config) {
  const api = makeApi(config);
  const p = loadPlugin();
  await p.activate(api);
  await new Promise((r) => setTimeout(r, 5));
  return { api, plugin: p };
}

const logText = (api) => api.calls.log.map((l) => l.msg).join("\n");

test("a video resolve logs the engine, the formats offered and the menu returned", async () => {
  const { api, plugin: p } = await activated({
    exec: rules([{ match: { cmd: "yt-dlp", argsInclude: ["-j"] }, result: { exitCode: 0, stdout: INFO_JSON } }]),
  });
  const id = p._encodeRef(VIDEO_URL, true).slice("ytdlp://".length);
  const out = await api._handlers["streamuri:ytdlp"](id, null, { externalAudio: true });
  assert.ok(out && out.candidates.length, "the resolve succeeded");

  const log = logText(api);
  assert.match(log, /stream resolve by uri — https:\/\/www\.youtube\.com/);
  assert.match(log, /engine=native mpv/, "which engine shaped the answer");
  assert.match(log, /cap=1080p/, "the resolution cap in force");
  assert.match(log, /6 format\(s\): 2 video-only/, "the full format table");
  assert.match(log, /cap 1080p hides 1 video format\(s\): 2160p/);
  assert.match(log, /enumerate formats → \d+ candidate\(s\):/, "the menu handed to the host");
  assert.match(log, /done: candidate menu/, "the trace is closed");
});

test("every line of one resolve shares a trace id, and steps are numbered in order", async () => {
  // Two resolves overlap constantly — the host preloads the next track while
  // the current one plays — so lines without an id are unattributable.
  const { api, plugin: p } = await activated({
    exec: rules([{ match: { cmd: "yt-dlp", argsInclude: ["-j"] }, result: { exitCode: 0, stdout: INFO_JSON } }]),
  });
  const id = p._encodeRef(VIDEO_URL, true).slice("ytdlp://".length);
  await api._handlers["streamuri:ytdlp"](id, null, { externalAudio: true });
  await api._handlers["streamuri:ytdlp"](id, null, { externalAudio: true });

  const ids = api.calls.log.map((l) => (l.msg.match(/^\[(r\d+)\]/) || [])[1]).filter(Boolean);
  const unique = [...new Set(ids)];
  assert.equal(unique.length, 2, "one id per resolve");
  assert.notEqual(unique[0], unique[1], "and the two resolves are told apart");
  assert.ok(ids.length >= 4, "the whole resolve is attributed, not just its header");
});

test("a failed extraction logs the exit code, the reason and the fallback that followed", async () => {
  const { api, plugin: p } = await activated({
    exec: rules([
      { match: { cmd: "yt-dlp", argsInclude: ["%(urls)s"] }, result: { exitCode: 1, stderr: "ERROR: [youtube] x: Requested format is not available" } },
      { match: { cmd: "yt-dlp", argsInclude: ["%(formats)j"] }, result: { exitCode: 0, stdout: JSON.stringify(FORMATS) } },
    ]),
  });
  const id = p._encodeRef(VIDEO_URL, true).slice("ytdlp://".length);
  await api._handlers["streamuri:ytdlp"](id);

  const log = logText(api);
  assert.match(log, /direct-url: exit 1 in .* — ERROR: \[youtube\] x: Requested format is not available/);
  assert.match(log, /direct .* URL \(selector best\[ext=mp4\]\/best\) → failed \(exit 1\)/);
  assert.match(log, /HLS master lookup/, "the fallback attempt is logged as its own step");
  assert.match(log, /6 format\(s\):/, "and it shows what the source really published");
});

test("the direct-URL extraction reports which format it handed over", async () => {
  const FMT_LINE = "ytdlp-fmt\t18\tmp4\tavc1.42001E\tmp4a.40.2\t360\t600\thttps\t18 - 640x360 (360p)";
  const { api, plugin: p } = await activated({
    exec: rules([{
      match: { cmd: "yt-dlp", argsInclude: ["%(urls)s"] },
      result: { exitCode: 0, stdout: "https://cdn.example/muxed.mp4\n" + FMT_LINE },
    }]),
  });
  const id = p._encodeRef(VIDEO_URL, true).slice("ytdlp://".length);
  const out = await api._handlers["streamuri:ytdlp"](id);
  assert.equal(out.candidates[0].url, "https://cdn.example/muxed.mp4", "the extra --print does not disturb the parse");

  const run = api.calls.exec.find((c) => c.args.includes("%(urls)s"));
  assert.ok(run.args.includes(p._CHOSEN_FMT_PRINT), "the format print rides the SAME extraction");
  assert.match(logText(api), /got a stream — id 18 · 360p · mp4/);
});

const DL_STDOUT = [
  "Song\tArtist\tAlbum\t2020\tSong",
  "ytdlp-fmt\t140\tm4a\tnone\tmp4a.40.2\tNA\t129\thttps\t140 - audio only",
  "/tmp/out.m4a",
].join("\n");

test("a completed download names the format it actually fetched", async () => {
  // The selectors are fallback chains, so the argv never says which tier won —
  // which is the whole of "why is my download only 480p / why is it an .mkv".
  const { api } = await activated({
    exec: rules([{ match: { cmd: "yt-dlp", argsInclude: ["after_move:filepath"] }, result: { exitCode: 0, stdout: DL_STDOUT } }]),
  });
  const res = await api._handlers["uri:ytdlp-download"]("ytdlp://" + encodeURIComponent(VIDEO_URL).replace(/\./g, "%2E"), "original");
  assert.equal(res.url, "file:///tmp/out.m4a", "the extra --print does not disturb the filepath parse");
  assert.deepEqual(res.metadata.title, "Song", "nor the metadata line's position");
  assert.match(logText(api), /saved \/tmp\/out\.m4a after 1 attempt\(s\) — id 140 · m4a · a:mp4a\.40\.2 · 129k · https/);
});

test("download-then-play mode still finds the file path past the format line", async () => {
  // downloadToCache reads the path off stdout too, and it gained the same print.
  const { api, plugin: p } = await activated({
    storage: { kv: { playbackMode: "download" } },
    exec: rules([{
      match: { cmd: "yt-dlp", argsInclude: ["after_move:filepath"] },
      result: { exitCode: 0, stdout: "ytdlp-fmt\t137\tmp4\tavc1.640028\tnone\t1080\t4500\thttps\t137+140\n/tmp/cache/abc.mp4" },
    }]),
  });
  const id = p._encodeRef(VIDEO_URL, true).slice("ytdlp://".length);
  const out = await api._handlers["streamuri:ytdlp"](id);
  assert.equal(out.candidates[0].url, "file:///tmp/cache/abc.mp4");
  assert.match(logText(api), /saved \/tmp\/cache\/abc\.mp4 — id 137 · 1080p · mp4/);
});

test("a 403 retry is logged as a second numbered attempt, not as a repeat of the first", async () => {
  let n = 0;
  const { api } = await activated({
    exec: rules([{
      match: { cmd: "yt-dlp", argsInclude: ["--print", "after_move:filepath"] },
      result: () => (++n === 1
        ? { exitCode: 1, stderr: "ERROR: unable to download video data: HTTP Error 403: Forbidden" }
        : { exitCode: 0, stdout: DL_STDOUT }),
    }]),
  });
  const res = await api._handlers["uri:ytdlp-download"]("ytdlp://" + encodeURIComponent(VIDEO_URL).replace(/\./g, "%2E"), "original");
  assert.match(res.url, /out\.m4a$/);

  const log = logText(api);
  assert.match(log, /download attempt 1: exit 1 in .* — ERROR: .*403/);
  assert.match(log, /run download attempt 2 \(403 retry\)/);
  assert.match(log, /saved \/tmp\/out\.m4a after 2 attempt\(s\)/);
});
