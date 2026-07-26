const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

test("buildDownloadArgs: 'original' with ffmpeg extracts losslessly (-x --audio-format best)", () => {
  const args = plugin._buildDownloadArgs({ url: "u", audioFormat: null }, "/tmp", 3, true);
  assert.ok(args.includes("-x"));
  assert.equal(args[args.indexOf("--audio-format") + 1], "best"); // copy, not re-encode
  assert.equal(args[args.length - 1], "u");
});

test("buildDownloadArgs: 'original' without ffmpeg falls back to raw bestaudio (no -x)", () => {
  const args = plugin._buildDownloadArgs({ url: "u", audioFormat: null }, "/tmp", 3, false);
  assert.ok(!args.includes("-x"));
  assert.ok(args.includes("bestaudio/best"));
  assert.ok(!args.includes("--embed-metadata"));
});

test("buildDownloadArgs: audioFormat re-encodes via -x --audio-format", () => {
  const args = plugin._buildDownloadArgs({ url: "u", audioFormat: "flac" }, "/tmp", 1, true);
  assert.ok(args.includes("-x"));
  assert.equal(args[args.indexOf("--audio-format") + 1], "flac");
  assert.ok(args.includes("--audio-quality"));
});

test("buildDownloadArgs: video merges to mp4", () => {
  const args = plugin._buildDownloadArgs({ url: "u", video: true }, "/tmp", 2, true);
  assert.equal(args[args.indexOf("--merge-output-format") + 1], "mp4");
  assert.ok(args.join(" ").includes("bestvideo"));
});

test("buildDownloadArgs: embeds metadata (never cover art) when ffmpeg present, omits when absent", () => {
  const on = plugin._buildDownloadArgs({ url: "u" }, "/tmp", 0, true);
  assert.ok(on.includes("--embed-metadata"), "tags embedded via ffmpeg");
  assert.ok(!on.includes("--embed-thumbnail"), "cover art is never embedded (avoids the mutagen dependency)");
  const off = plugin._buildDownloadArgs({ url: "u" }, "/tmp", 0, false);
  assert.ok(!off.includes("--embed-metadata") && !off.includes("--embed-thumbnail"));
});

test("buildDownloadArgs: video merge never embeds cover art either", () => {
  const args = plugin._buildDownloadArgs({ url: "u", video: true }, "/tmp", 0, true);
  assert.ok(!args.includes("--embed-thumbnail"));
});

test("buildDownloadArgs: output dir + template wired", () => {
  const args = plugin._buildDownloadArgs({ url: "u" }, "/out", 7, false);
  assert.equal(args[args.indexOf("-P") + 1], "/out");
  assert.equal(args[args.indexOf("-o") + 1], "dl.7.%(ext)s");
});

test("buildDownloadArgs forces --encoding utf-8 (yt-dlp's own preferredencoding() mojibakes non-ASCII titles on Windows)", () => {
  const args = plugin._buildDownloadArgs({ url: "u" }, "/tmp", 0, true);
  assert.equal(args[args.indexOf("--encoding") + 1], "utf-8");
});

test("buildDownloadArgs prints metadata AND filepath in the one run", () => {
  const args = plugin._buildDownloadArgs({ url: "u" }, "/tmp", 0, true);
  const prints = args.reduce((acc, a, i) => (a === "--print" ? [...acc, args[i + 1]] : acc), []);
  assert.equal(prints.length, 2);
  assert.ok(prints[0].includes("%(track,title)s"), "metadata template printed at extraction time");
  assert.equal(prints[1], "after_move:filepath");
});

test("classifyYtdlpError maps common failures to friendly reasons", () => {
  assert.match(plugin._classifyYtdlpError("ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies-from-browser ..."), /bot check/);
  assert.match(plugin._classifyYtdlpError("ERROR: [Reddit] x: Account authentication is required. Use --cookies ..."), /signed-in account/);
  assert.match(plugin._classifyYtdlpError("ERROR: [youtube] x: Requested format is not available"), /format isn't available/);
  assert.match(plugin._classifyYtdlpError("ERROR: [youtube] x: Video unavailable"), /unavailable/);
  assert.match(plugin._classifyYtdlpError("ERROR: unable to download video data: HTTP Error 403: Forbidden"), /HTTP 403/);
  // Unknown errors fall back to the last ERROR line, extractor prefix stripped.
  assert.equal(plugin._classifyYtdlpError("ERROR: [foo] abc123: something odd happened"), "yt-dlp: something odd happened");
  assert.equal(plugin._classifyYtdlpError(""), "yt-dlp could not download this item.");
});

test("parseMetadataLine picks real music metadata over the channel name", () => {
  // track \t artist \t album \t year \t title
  const m = plugin._parseMetadataLine("Hey\tPixies\tDoolittle\t1989\tHey");
  assert.deepEqual(m, { title: "Hey", artist: "Pixies", album: "Doolittle", year: 1989 });
});

test("parseMetadataLine treats NA as empty and falls back title <- video title", () => {
  const m = plugin._parseMetadataLine("NA\tNA\tNA\tNA\tSome Video");
  assert.deepEqual(m, { title: "Some Video" });
});

test("parseMetadataLine ignores a non-4-digit year (e.g. upload_date)", () => {
  const m = plugin._parseMetadataLine("T\tA\tB\t20200102\tT");
  assert.equal(m.year, undefined);
});
