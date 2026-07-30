const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// A representative candidate set for "Creep" by Radiohead: the auto-generated
// audio (Topic), the official music video (VEVO, huge views), a lyric video, a
// live performance and a cover — in yt-dlp's relevance order.
function creepCandidates() {
  return [
    { url: "lyric", title: "Creep (Lyrics)", uploader: "LyricChannel", durationSecs: 238, views: 20000000 },
    { url: "topic", title: "Creep", uploader: "Radiohead - Topic", durationSecs: 238, views: 8000000 },
    { url: "official", title: "Radiohead - Creep (Official Video)", uploader: "RadioheadVEVO", durationSecs: 240, views: 500000000 },
    { url: "live", title: "Creep (Live at Glastonbury)", uploader: "FanUploads", durationSecs: 300, views: 5000000 },
    { url: "cover", title: "Creep (Acoustic Cover)", uploader: "SomeSinger", durationSecs: 250, views: 1000000 },
  ];
}

function urls(cands) {
  return cands.map((c) => c.url);
}

// ---------------------------------------------------------------------------
// SCORING_PARAMS + profile defaults
// ---------------------------------------------------------------------------

test("SCORING_PARAMS: weights first, every entry has both profile defaults", () => {
  const params = plugin._SCORING_PARAMS;
  assert.ok(params.length >= 10);
  assert.deepEqual(params.slice(0, 3).map((p) => p.key), ["w_rel", "w_views", "w_dur"]);
  for (const p of params) {
    assert.equal(typeof p.audio, "number", p.key + " audio default");
    assert.equal(typeof p.video, "number", p.key + " video default");
    assert.ok(p.type === "weight" || p.type === "flag", p.key + " type");
  }
});

test("defaultProfile fills every param key from its kind", () => {
  const audio = plugin._defaultProfile("audio");
  const video = plugin._defaultProfile("video");
  for (const p of plugin._SCORING_PARAMS) {
    assert.equal(audio[p.key], p.audio);
    assert.equal(video[p.key], p.video);
  }
  // The two profiles must actually differ, or the split is pointless.
  assert.notDeepEqual(audio, video);
});

test("normalizeProfile merges stored over defaults; drops unknown/NaN keys", () => {
  const merged = plugin._normalizeProfile("audio", { w_dur: 9, topic: 1, bogus: 5, w_rel: NaN });
  const def = plugin._defaultProfile("audio");
  assert.equal(merged.w_dur, 9, "stored numeric wins");
  assert.equal(merged.topic, 1, "stored numeric wins");
  assert.equal(merged.w_rel, def.w_rel, "NaN falls back to default");
  assert.equal(merged.bogus, undefined, "unknown key dropped");
  // A missing key still gets its default.
  assert.equal(merged.w_views, def.w_views);
});

test("normalizeProfile tolerates null/garbage stored value", () => {
  assert.deepEqual(plugin._normalizeProfile("video", null), plugin._defaultProfile("video"));
  assert.deepEqual(plugin._normalizeProfile("video", "nope"), plugin._defaultProfile("video"));
});

// ---------------------------------------------------------------------------
// durationScore (pure)
// ---------------------------------------------------------------------------

test("durationScore: exact = +1, decays to 0 at 15s, floors at -1 by 30s", () => {
  assert.equal(plugin._durationScore(200, 200), 1);
  assert.equal(plugin._durationScore(203, 200), 1 - 3 / 15);
  assert.ok(Math.abs(plugin._durationScore(215, 200) - 0) < 1e-9);
  assert.equal(plugin._durationScore(230, 200), -1);
  assert.equal(plugin._durationScore(999, 200), -1, "clamped");
});

test("durationScore: neutral 0 when either duration unknown", () => {
  assert.equal(plugin._durationScore(null, 200), 0);
  assert.equal(plugin._durationScore(200, null), 0);
  assert.equal(plugin._durationScore(200, 0), 0);
});

// ---------------------------------------------------------------------------
// candidateSignals (pure)
// ---------------------------------------------------------------------------

test("candidateSignals: Topic channel audio upload", () => {
  const s = plugin._candidateSignals({ title: "Creep", uploader: "Radiohead - Topic" });
  assert.equal(s.topic, 1);
  assert.equal(s.vevo, 0);
  assert.equal(s.officialVideo, 0);
});

test("candidateSignals: official music video / VEVO", () => {
  const s = plugin._candidateSignals({ title: "Radiohead - Creep (Official Video)", uploader: "RadioheadVEVO" });
  assert.equal(s.official, 1);
  assert.equal(s.officialVideo, 1);
  assert.equal(s.vevo, 1);
  assert.equal(s.topic, 0);
});

test("candidateSignals: official audio is distinct from official video", () => {
  const s = plugin._candidateSignals({ title: "Song (Official Audio)", uploader: "Artist" });
  assert.equal(s.officialAudio, 1);
  assert.equal(s.officialVideo, 0);
  assert.equal(s.official, 1);
});

test("candidateSignals: penalized keyword flags", () => {
  assert.equal(plugin._candidateSignals({ title: "Creep (Live at X)" }).live, 1);
  assert.equal(plugin._candidateSignals({ title: "Creep (Acoustic Cover)" }).cover, 1);
  assert.equal(plugin._candidateSignals({ title: "Creep (Remix)" }).remix, 1);
  assert.equal(plugin._candidateSignals({ title: "Creep - Instrumental" }).instrumental, 1);
  assert.equal(plugin._candidateSignals({ title: "Creep (Lyrics)" }).lyrics, 1);
  assert.equal(plugin._candidateSignals({ title: "Creep (Sped Up)" }).effects, 1);
  assert.equal(plugin._candidateSignals({ title: "Creep (8D Audio)" }).effects, 1);
  assert.equal(plugin._candidateSignals({ title: "Creep (Nightcore)" }).effects, 1);
});

test("candidateSignals: a plain official-video title trips no penalties", () => {
  const s = plugin._candidateSignals({ title: "Radiohead - Creep (Official Video)", uploader: "RadioheadVEVO" });
  assert.equal(s.live + s.cover + s.remix + s.instrumental + s.effects + s.lyrics, 0);
});

// ---------------------------------------------------------------------------
// scoreWithProfile / rankByProfile (the actual pick)
// ---------------------------------------------------------------------------

test("AUDIO profile picks the Topic upload with a matching duration", () => {
  const audio = plugin._defaultProfile("audio");
  const ranked = plugin._rankByProfile(creepCandidates(), audio, 238);
  assert.equal(ranked[0].url, "topic",
    "clean Topic audio at the right length beats the huge-view official video");
});

test("VIDEO profile picks the official VEVO music video", () => {
  const video = plugin._defaultProfile("video");
  const ranked = plugin._rankByProfile(creepCandidates(), video, 238);
  assert.equal(ranked[0].url, "official",
    "official video + VEVO + views wins for video intent");
});

test("the two profiles disagree on the same candidate set", () => {
  const cands = creepCandidates();
  const audioTop = plugin._rankByProfile(cands.slice(), plugin._defaultProfile("audio"), 238)[0].url;
  const videoTop = plugin._rankByProfile(cands.slice(), plugin._defaultProfile("video"), 238)[0].url;
  assert.notEqual(audioTop, videoTop, "the audio and video picks must differ here");
});

test("AUDIO profile: a wrong-length live version loses to an exact-length audio", () => {
  const audio = plugin._defaultProfile("audio");
  const cands = [
    { url: "live", title: "Song (Live)", uploader: "X", durationSecs: 400, views: 9000000 },
    { url: "topic", title: "Song", uploader: "Artist - Topic", durationSecs: 200, views: 100000 },
  ];
  const ranked = plugin._rankByProfile(cands, audio, 200);
  assert.equal(ranked[0].url, "topic");
});

test("rankByProfile is stable on ties (keeps relevance order)", () => {
  // Zero everything -> every score is 0 -> original order preserved.
  const flat = {};
  for (const p of plugin._SCORING_PARAMS) flat[p.key] = 0;
  const ranked = plugin._rankByProfile(creepCandidates(), flat, null);
  assert.deepEqual(urls(ranked), urls(creepCandidates()));
});

test("rankByProfile stamps _profileScore for the debug readout", () => {
  const ranked = plugin._rankByProfile(creepCandidates(), plugin._defaultProfile("video"), 238);
  assert.equal(ranked[0]._profileScore.pos, 0);
  assert.equal(typeof ranked[0]._profileScore.score, "number");
  assert.ok(ranked[0]._profileScore.parts);
});

test("rankByProfile handles empty / single lists", () => {
  assert.deepEqual(plugin._rankByProfile([], plugin._defaultProfile("audio"), null), []);
  const one = plugin._rankByProfile([{ url: "a", title: "a" }], plugin._defaultProfile("audio"), null);
  assert.equal(one.length, 1);
  assert.equal(one[0]._profileScore.pos, 0);
});

// ---------------------------------------------------------------------------
// formatProfileScore (pure)
// ---------------------------------------------------------------------------

test("formatProfileScore: shows position, move, score and nonzero contributions", () => {
  const ranked = plugin._rankByProfile(creepCandidates(), plugin._defaultProfile("audio"), 238);
  const top = plugin._formatProfileScore(ranked[0]);
  assert.match(top, /^#1/);
  assert.match(top, /score /);
  // The Topic winner moved up from a lower relevance slot -> "was #".
  assert.match(top, /was #\d/);
  assert.match(top, /topic \+/, "the topic bonus is listed");
});

test("formatProfileScore: '' when no profile score is stamped", () => {
  assert.equal(plugin._formatProfileScore({ url: "x" }), "");
  assert.equal(plugin._formatProfileScore(null), "");
});

// ---------------------------------------------------------------------------
// parseDurationInput (pure)
// ---------------------------------------------------------------------------

test("parseDurationInput: seconds, m:ss and h:mm:ss", () => {
  assert.equal(plugin._parseDurationInput("238"), 238);
  assert.equal(plugin._parseDurationInput("3:58"), 238);
  assert.equal(plugin._parseDurationInput("1:02:03"), 3723);
  assert.equal(plugin._parseDurationInput(" 4:00 "), 240);
});

test("parseDurationInput: blank / garbage -> null", () => {
  assert.equal(plugin._parseDurationInput(""), null);
  assert.equal(plugin._parseDurationInput("   "), null);
  assert.equal(plugin._parseDurationInput(null), null);
  assert.equal(plugin._parseDurationInput("abc"), null);
  assert.equal(plugin._parseDurationInput("3:xx"), null);
  assert.equal(plugin._parseDurationInput("-5"), null);
});

// ---------------------------------------------------------------------------
// buildResultRow with the profile breakdown (Tuning tab)
// ---------------------------------------------------------------------------

test("buildResultRow(opts.profile): folds the profile-score breakdown + ✓ pick", () => {
  const ranked = plugin._rankByProfile(creepCandidates(), plugin._defaultProfile("audio"), 238);
  const top = plugin._buildResultRow(ranked[0], 0, { profile: true, chosen: true });
  assert.match(top.title, /^✓ /, "the chosen pick is checked");
  assert.match(top.subtitle, /score /, "the profile score is in the subtitle");
  assert.match(top.subtitle, /#1/);
});
