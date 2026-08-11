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

// mp4 alone would force incompatible codecs (AV1/VP9 + Opus) into a container
// nothing can open; the list lets yt-dlp drop to .mkv and keep the name honest.
test("buildDownloadArgs: video merges to mp4, with an mkv fallback", () => {
  const args = plugin._buildDownloadArgs({ url: "u", video: true }, "/tmp", 2, true);
  assert.equal(args[args.indexOf("--merge-output-format") + 1], "mp4/mkv");
  assert.ok(args.join(" ").includes("bestvideo"));
});

test("buildDownloadArgs: capped video selector limits height", () => {
  const args = plugin._buildDownloadArgs({ url: "u", video: true, maxHeight: 1080 }, "/tmp", 2, true);
  const sel = args[args.indexOf("-f") + 1];
  assert.ok(sel.includes("[height<=1080]"), "height cap applied to both split and muxed fallback");
  assert.ok(sel.includes("bestvideo*[height<=1080]+bestaudio"));
});

test("parseVideoFormat: 'video' = best, 'video-720' = capped, else not video", () => {
  assert.deepEqual(plugin._parseVideoFormat("video"), { isVideo: true, maxHeight: 0 });
  assert.deepEqual(plugin._parseVideoFormat("video-720"), { isVideo: true, maxHeight: 720 });
  assert.deepEqual(plugin._parseVideoFormat("flac"), { isVideo: false, maxHeight: 0 });
  assert.deepEqual(plugin._parseVideoFormat("original"), { isVideo: false, maxHeight: 0 });
});

test("videoFormatSelector: uncapped vs capped", () => {
  assert.equal(
    plugin._videoFormatSelector(0),
    "bestvideo*[vcodec^=avc1]+bestaudio[acodec^=mp4a]/bestvideo*[vcodec^=h264]+bestaudio[acodec^=aac]/bestvideo*+bestaudio/best"
  );
  assert.equal(
    plugin._videoFormatSelector(720),
    "bestvideo*[vcodec^=avc1][height<=720]+bestaudio[acodec^=mp4a]/bestvideo*[vcodec^=h264][height<=720]+bestaudio[acodec^=aac]/bestvideo*[height<=720]+bestaudio/best[height<=720]"
  );
});

// A bare bestvideo*+bestaudio picks AV1+Opus (yt-dlp ranks those codecs first),
// which forced into --merge-output-format mp4 produces a file QuickTime and the
// webview show as audio-only. H.264/AAC must be tried before the open fallback.
test("videoFormatSelector: H.264 + AAC are preferred over the codec-agnostic best", () => {
  const tiers = plugin._videoFormatSelector(0).split("/");
  assert.ok(tiers[0].includes("vcodec^=avc1") && tiers[0].includes("acodec^=mp4a"));
  const openTier = tiers.findIndex((t) => t === "bestvideo*+bestaudio");
  assert.ok(openTier > 0, "codec-agnostic tier exists as a fallback");
  assert.ok(
    tiers.slice(0, openTier).every((t) => /vcodec\^=(avc1|h264)/.test(t)),
    "every tier before the fallback pins a playable video codec"
  );
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

// --- Download progress -----------------------------------------------------
// A download resolve fetches the whole file, so a real progress bar in the host
// depends entirely on these lines parsing. They also share stdout with the
// --print output, which is why isProgressLine has to be exact.

test("buildDownloadArgs: asks for machine-readable progress on its own lines", () => {
  const args = plugin._buildDownloadArgs({ url: "u", video: true }, "/tmp", 0, true);
  // --quiet suppresses the progress display unless --progress is given, and the
  // default carriage-return redraw never completes a line for a line reader.
  assert.ok(args.includes("--progress"));
  assert.ok(args.includes("--newline"));
  const templates = args.filter((a, i) => args[i - 1] === "--progress-template");
  assert.equal(templates.length, 2, "one template for the download, one for postprocessing");
  assert.ok(templates.some((t) => t.startsWith("download:")));
  assert.ok(templates.some((t) => t.startsWith("postprocess:")));
});

// Field spellings below are copied from a real run (yt-dlp 2026.03.17), not
// invented — the padding, "N/A" and "Unknown B/s" are all things it really emits.
test("parseProgressLine: a download line yields percent, detail and eta", () => {
  const p = plugin._parseProgressLine("[vbprog]  3.4%| 789.28KiB|  22.52MiB| 121.35KiB/s|183|avc1.4d401f", true);
  assert.equal(p.percent, 3.4);
  assert.equal(p.label, "Downloading video");
  assert.equal(p.detail, "789.28KiB / 22.52MiB at 121.35KiB/s");
  assert.equal(p.etaSecs, 183);
});

// A hi-res video is TWO downloads (video-only, then audio-only) and each runs
// 0→100%, so the bar restarts halfway through. vcodec is what lets the label
// explain that instead of the progress looking broken.
test("parseProgressLine: vcodec names which half of a split download is running", () => {
  const video = plugin._parseProgressLine("[vbprog] 50.0%|1.0MiB|2.0MiB|1.0MiB/s|1|avc1.4d401f", true);
  const audio = plugin._parseProgressLine("[vbprog] 50.0%|1.0MiB|2.0MiB|1.0MiB/s|1|none", true);
  assert.equal(video.label, "Downloading video");
  assert.equal(audio.label, "Downloading audio");
});

// yt-dlp spells "not known yet" three ways across these fields: a bare NA, a
// formatted "N/A", and "Unknown B/s" before the first speed sample. All must
// read as absent — a 0% bar and "0:00 left" are both lies the user would act on,
// and "1.00KiB / N/A at Unknown B/s" is worse than showing nothing.
test("parseProgressLine: unknown fields become null rather than zero or noise", () => {
  const p = plugin._parseProgressLine("[vbprog]  0.2%|   1.00KiB|       N/A| Unknown B/s|NA|none", false);
  assert.equal(p.percent, 0.2);
  assert.equal(p.etaSecs, null);
  assert.equal(p.detail, "1.00KiB", "no total, no speed — just what has landed");
  assert.equal(p.label, "Downloading audio");
});

// The last line of a stream reports 100% with the byte count already dropped.
test("parseProgressLine: the terminal 100% line still reports its percentage", () => {
  const p = plugin._parseProgressLine("[vbprog]100.0%|NA|   3.15MiB|112.29KiB/s|NA|none", true);
  assert.equal(p.percent, 100);
  assert.equal(p.etaSecs, null);
});

// The merge is the second half of a video download and reports no percentage,
// so the label carries the phase and percent stays null.
test("parseProgressLine: a postprocess line names the phase with no percentage", () => {
  const p = plugin._parseProgressLine("[vbprog-pp]started|Merger", true);
  assert.equal(p.percent, null);
  assert.equal(p.label, "Merging audio and video…");
});

// Progress shares stdout with --print (the metadata line and the final
// filepath), and the parse there takes the FIRST line as metadata and the last
// as the path — so a progress line that slipped through would break both.
test("isProgressLine: matches only our own prefixes, so --print output survives", () => {
  assert.ok(plugin._isProgressLine("[vbprog] 10.0%|a|b|c|1|none"));
  assert.ok(plugin._isProgressLine("[vbprog-pp]started|Merger"));
  assert.ok(!plugin._isProgressLine("/Users/x/Music/dl.0.mp4"));
  assert.ok(!plugin._isProgressLine("Hey\tPixies\tDoolittle\t1989\tHey"));
  assert.equal(plugin._parseProgressLine("/Users/x/Music/dl.0.mp4", false), null);
});
