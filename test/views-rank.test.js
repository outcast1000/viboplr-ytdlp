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
