const { test } = require("node:test");
const assert = require("node:assert");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();

// ---------------------------------------------------------------------------
// formatViews (pure)
// ---------------------------------------------------------------------------

test("formatViews: compact units, floored like YouTube", () => {
  assert.equal(plugin._formatViews(1521543229), "1.5B views");
  assert.equal(plugin._formatViews(16569584), "16M views");
  assert.equal(plugin._formatViews(4381950), "4.3M views");
  assert.equal(plugin._formatViews(573200), "573K views");
  assert.equal(plugin._formatViews(1200), "1.2K views");
  assert.equal(plugin._formatViews(42), "42 views");
  assert.equal(plugin._formatViews(1), "1 view");
  assert.equal(plugin._formatViews(0), "0 views");
});

test("formatViews: null/NaN/negative -> empty string", () => {
  assert.equal(plugin._formatViews(null), "");
  assert.equal(plugin._formatViews(undefined), "");
  assert.equal(plugin._formatViews(NaN), "");
  assert.equal(plugin._formatViews(-5), "");
});

// ---------------------------------------------------------------------------
// rerankByViews (pure)
// ---------------------------------------------------------------------------

function urls(cands) {
  return cands.map((c) => c.url);
}

test("rerankByViews floats a much-more-popular result up past nearer-but-obscure ones", () => {
  // rel order: cover(500K), lyric(2M), OFFICIAL(500M), live(5M).
  const cands = [
    { url: "cover", views: 500000 },
    { url: "lyric", views: 2000000 },
    { url: "official", views: 500000000 },
    { url: "live", views: 5000000 },
  ];
  const out = plugin._rerankByViews(cands.slice());
  assert.equal(out[0].url, "official", "the 500M-view official video wins the top spot");
});

test("rerankByViews is gentle: a modest view edge does not reshuffle relevance", () => {
  // The top relevance result also has the most views -> order unchanged.
  const cands = [
    { url: "a", views: 1521543229 },
    { url: "b", views: 16569584 },
    { url: "c", views: 4381950 },
    { url: "d", views: 14874837 },
    { url: "e", views: 16212488 },
  ];
  const out = plugin._rerankByViews(cands.slice());
  assert.deepEqual(urls(out), ["a", "b", "c", "d", "e"]);
});

test("rerankByViews no-ops when fewer than two candidates report views", () => {
  const cands = [
    { url: "a", views: null },
    { url: "b", views: 9999999 },
    { url: "c", views: null },
  ];
  assert.deepEqual(urls(plugin._rerankByViews(cands.slice())), ["a", "b", "c"]);
});

test("rerankByViews no-ops on 0/1 candidates and preserves the array", () => {
  assert.deepEqual(plugin._rerankByViews([]), []);
  assert.deepEqual(urls(plugin._rerankByViews([{ url: "solo", views: 5 }])), ["solo"]);
});

test("rerankByViews is deterministic: equal views keep relevance order", () => {
  const cands = [
    { url: "a", views: 1000 },
    { url: "b", views: 1000 },
    { url: "c", views: 1000 },
  ];
  assert.deepEqual(urls(plugin._rerankByViews(cands.slice())), ["a", "b", "c"]);
});

test("rerankByViews stamps each candidate with its score breakdown", () => {
  const cands = [
    { url: "cover", views: 500000 },
    { url: "official", views: 500000000 },
  ];
  const out = plugin._rerankByViews(cands.slice());
  // Every candidate carries a _score, and rel is its PRE-rerank position.
  const official = out.find((c) => c.url === "official");
  const cover = out.find((c) => c.url === "cover");
  assert.equal(official._score.rel, 1, "official was 2nd by relevance");
  assert.equal(cover._score.rel, 0, "cover was 1st by relevance");
  assert.ok(official._score.score > cover._score.score, "official outscores cover");
  assert.equal(out[0].url, "official");
});

// ---------------------------------------------------------------------------
// scoreCandidates (pure)
// ---------------------------------------------------------------------------

test("scoreCandidates: score = -rel + 1.5*log10(views+1) when views are in play", () => {
  const bd = plugin._scoreCandidates([
    { url: "a", views: 1000 },     // rel 0
    { url: "b", views: 1000000 },  // rel 1
  ]);
  assert.equal(bd.length, 2);
  assert.ok(bd.every((b) => b.viewsActive));
  // a: -0 + 1.5*log10(1001) ≈ 4.5015
  assert.ok(Math.abs(bd[0].score - (0 + 1.5 * Math.log10(1001))) < 1e-9);
  // b: -1 + 1.5*log10(1000001) ≈ 8.0000
  assert.ok(Math.abs(bd[1].score - (-1 + 1.5 * Math.log10(1000001))) < 1e-9);
  assert.equal(bd[0].rel, 0);
  assert.equal(bd[1].rel, 1);
});

test("scoreCandidates: viewsActive false when <2 report views -> boost 0, pure relevance", () => {
  const bd = plugin._scoreCandidates([
    { url: "a", views: null },
    { url: "b", views: 9999999 },
    { url: "c", views: 0 },
  ]);
  assert.ok(bd.every((b) => !b.viewsActive));
  assert.ok(bd.every((b) => b.viewBoost === 0));
  assert.deepEqual(bd.map((b) => b.score), [0, -1, -2]);
});

test("scoreCandidates: empty input -> empty breakdown", () => {
  assert.deepEqual(plugin._scoreCandidates([]), []);
  assert.deepEqual(plugin._scoreCandidates(null), []);
});

// ---------------------------------------------------------------------------
// formatScoreDebug (pure)
// ---------------------------------------------------------------------------

test("formatScoreDebug: shows position, move, score and view boost", () => {
  const cands = [
    { url: "cover", views: 500000 },
    { url: "official", views: 500000000 },
  ];
  const out = plugin._rerankByViews(cands.slice());
  const top = plugin._formatScoreDebug(out[0], 0); // official, moved from #2 to #1
  assert.match(top, /^#1 · was #2 · score /);
  assert.match(top, /boost \+/);
});

test("formatScoreDebug: no view data annotation when views aren't in play", () => {
  const bd = plugin._scoreCandidates([{ url: "a", views: null }, { url: "b", views: null }]);
  const c = { url: "a", _score: bd[0] };
  assert.match(plugin._formatScoreDebug(c, 0), /no view data/);
});

test("formatScoreDebug: empty string when candidate has no score", () => {
  assert.equal(plugin._formatScoreDebug({ url: "x" }, 0), "");
  assert.equal(plugin._formatScoreDebug(null, 0), "");
});

// ---------------------------------------------------------------------------
// buildResultRow (row shape shared by search list + resolve panel)
// ---------------------------------------------------------------------------

test("buildResultRow: folds views into subtitle and carries a playable ref", () => {
  const c = { url: "https://youtu.be/abc", title: "Artist - Song", uploader: "Artist", durationSecs: 200, views: 1500000, thumbnail: null };
  const row = plugin._buildResultRow(c, 0);
  assert.equal(row.title, "Song");
  assert.match(row.subtitle, /1\.5M views/);
  assert.equal(row.action, "ytdlp-play-one");
  assert.ok(row.path && row.path === row.id, "carries an encoded ref as both id and path");
  assert.equal(row.durationSecs, 200);
});

test("buildResultRow: opts.chosen marks the row with a leading check", () => {
  const c = { url: "https://youtu.be/abc", title: "Song", uploader: "Artist", durationSecs: 200, views: 5 };
  assert.ok(!plugin._buildResultRow(c, 0).title.startsWith("✓"), "unmarked by default");
  assert.ok(plugin._buildResultRow(c, 0, { chosen: true }).title.startsWith("✓ "), "chosen gets a ✓");
});
