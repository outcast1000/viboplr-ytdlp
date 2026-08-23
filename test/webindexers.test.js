const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadPlugin } = require("./harness/sandbox.js");

const plugin = loadPlugin();
const WEB_DEFS = plugin._WEB_DEFS;
const runWebDefOnBody = plugin._runWebDefOnBody;
const validateWebIndexerDef = plugin._validateWebIndexerDef;
const webSearchAll = plugin._webSearchAll;
const jsonPath = plugin._jsonPath;
const parseMarkup = plugin._parseMarkup;
const selectAll = plugin._selectAll;
const parseSelector = plugin._parseSelector;
const applyWebFilters = plugin._applyWebFilters;
const interleaveBySite = plugin._interleaveBySite;

const fix = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const defById = (id) => WEB_DEFS.filter((d) => d.id === id)[0];

// ---------------------------------------------------------------------------
// Bundled definitions — each pinned against a saved REAL response. These are
// the tests that catch a site redesign (or a parser regression) as a failing
// build rather than a silent zero-results search.
// ---------------------------------------------------------------------------

test("the bundled set is dailymotion, archive, peertube — and every def validates", () => {
  assert.deepEqual(WEB_DEFS.map((d) => d.id), ["dailymotion", "archive", "peertube"]);
  for (const def of WEB_DEFS) {
    assert.deepEqual(validateWebIndexerDef(def, {}), [], def.id);
  }
});

test("dailymotion (json): rows incl. the literal dotted key owner.screenname", () => {
  const rows = runWebDefOnBody(defById("dailymotion"), fix("dailymotion-search.json"));
  assert.equal(rows.length, 5);
  const first = rows[0];
  assert.equal(first.title, "Björk - HYPERBALLAD -");
  assert.equal(first.url, "https://www.dailymotion.com/video/xy5an");
  assert.equal(first.durationSecs, 238);
  // "owner.screenname" is ONE flat key in the response, not a nested object.
  assert.equal(first.uploader, "BUB.art");
  assert.ok(first.thumbnail.startsWith("https://s1.dmcdn.net/"), first.thumbnail);
  assert.equal(first.views, 1486);
  assert.equal(first.site, "Dailymotion");
  assert.equal(rows[1].views, 6964);
});

test("archive (json): identifier becomes the details URL and the thumbnail; downloads become views", () => {
  const rows = runWebDefOnBody(defById("archive"), fix("archive-search.json"));
  assert.equal(rows.length, 1);
  const first = rows[0];
  assert.equal(first.title, "Björk Hyperballad");
  assert.equal(first.url, "https://archive.org/details/bjork-hyperballad");
  assert.equal(first.thumbnail, "https://archive.org/services/img/bjork-hyperballad");
  assert.equal(first.views, 44);
  // This doc reports no creator and the search API never reports duration —
  // both stay honestly absent instead of becoming "" -> 0.
  assert.equal(first.uploader, "");
  assert.equal(first.durationSecs, null);
  assert.equal(first.site, "Internet Archive");
});

test("peertube (json): nested account.displayName, per-instance URLs", () => {
  const rows = runWebDefOnBody(defById("peertube"), fix("sepiasearch-search.json"));
  assert.equal(rows.length, 3);
  assert.equal(rows[1].title, "Björk - Ma Télévision");
  assert.equal(rows[1].url, "https://skeptikon.fr/videos/watch/626da0a4-5d86-4f2c-a7e8-39ece9214d18");
  assert.equal(rows[1].durationSecs, 224);
  assert.equal(rows[1].views, 3752);
  // A REAL nested path (unlike dailymotion's flat dotted key).
  assert.equal(rows[1].uploader, "Christophe Michel");
  assert.equal(rows[2].site, "PeerTube");
});

// ---------------------------------------------------------------------------
// jsonPath
// ---------------------------------------------------------------------------

test("jsonPath: nested walk, flat dotted key fallback, root, missing", () => {
  assert.equal(jsonPath({ a: { b: 7 } }, "a.b"), 7);
  assert.equal(jsonPath({ "a.b": 7 }, "a.b"), 7);
  // A partial flat key deeper in: walk one level, then flat remainder.
  assert.equal(jsonPath({ a: { "b.c": 9 } }, "a.b.c"), 9);
  assert.deepEqual(jsonPath([1, 2], ""), [1, 2]);
  assert.equal(jsonPath({ a: 1 }, "b"), undefined);
  assert.equal(jsonPath(null, "a"), undefined);
  // Nested wins over flat when both exist.
  assert.equal(jsonPath({ a: { b: 1 }, "a.b": 2 }, "a.b"), 1);
});

// ---------------------------------------------------------------------------
// Markup parser + selector engine (the html/rss def types)
// ---------------------------------------------------------------------------

const SOUP =
  '<table class="hits"><tbody>' +
  "<tr><td class=t><a href='/watch/1'>First &amp; Best</a><td class=d>3:58<td class=v>1,234 views" +
  "<tr><td class=t><a href='/watch/2'>Second</a><td class=d>1:02:03<td class=v>77 views" +
  "<script>var x = '</table>';</script>" +
  "</tbody></table>";

test("parseMarkup: tag soup (unclosed td/tr), entities, raw-text script", () => {
  const root = parseMarkup(SOUP, true);
  const cells = selectAll(root, "tr > td.t a");
  assert.equal(cells.length, 2);
  assert.equal(plugin._nodeText(cells[0]), "First & Best");
  assert.equal(cells[0].attrs.href, "/watch/1");
  // The script's "</table>" stayed raw text and closed nothing.
  const rows = selectAll(root, "table.hits tr");
  assert.equal(rows.length, 2);
});

test("parseMarkup: CDATA text survives undecoded", () => {
  const root = parseMarkup("<item><title><![CDATA[A & B <ok>]]></title></item>", false);
  const item = selectAll(root, "item")[0];
  assert.equal(plugin._nodeText(plugin._childByTag(item, "title")), "A & B <ok>");
});

test("selector engine: nth-child, attr ops, and loud errors for the unsupported", () => {
  const root = parseMarkup("<ul><li><a href='magnet:x'>m</a></li><li class='x y'>two</li><li>three</li></ul>", true);
  assert.equal(selectAll(root, "li:nth-child(2)").length, 1);
  assert.equal(plugin._nodeText(selectAll(root, "li:nth-child(2)")[0]), "two");
  assert.equal(selectAll(root, "a[href^=magnet]").length, 1);
  assert.equal(selectAll(root, "li.x.y").length, 1);
  assert.equal(selectAll(root, "ul > li").length, 3);
  assert.ok(parseSelector(":not(.x)").error);
  assert.ok(parseSelector("a, b").error);
  assert.ok(parseSelector("a + b").error);
  assert.ok(parseSelector("td[").error);
});

test("an html definition end-to-end, incl. attribute extraction and junk-row drops", () => {
  const def = {
    schemaVersion: 1,
    id: "soup",
    name: "Soup",
    siteUrl: "https://soup.example",
    type: "html",
    search: { url: "https://soup.example/s?q={q}" },
    rows: { selector: "table.hits tr" },
    fields: {
      title: { selector: "td.t a" },
      url: { selector: "td.t a", attribute: "href", filters: [["prepend", "https://soup.example"]] },
      durationSecs: { selector: "td.d", filters: [["parseDuration"]] },
      views: { selector: "td.v", filters: [["regex", "^[\\d,]+"], ["parseInt"]] }
    }
  };
  assert.deepEqual(validateWebIndexerDef(def, {}), []);
  const rows = runWebDefOnBody(def, SOUP);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "First & Best");
  assert.equal(rows[0].url, "https://soup.example/watch/1");
  assert.equal(rows[0].durationSecs, 238);
  assert.equal(rows[0].views, 1234);
  assert.equal(rows[1].durationSecs, 3723);
  assert.equal(rows[1].site, "Soup");
  // A row whose url doesn't become http(s) is dropped, not emitted broken.
  const noPrepend = JSON.parse(JSON.stringify(def));
  noPrepend.fields.url = { selector: "td.t a", attribute: "href" };
  assert.equal(runWebDefOnBody(noPrepend, SOUP).length, 0);
});

test("an rss definition end-to-end, incl. namespaced tags", () => {
  const def = {
    schemaVersion: 1,
    id: "feed",
    name: "Feed",
    siteUrl: "https://feed.example",
    type: "rss",
    search: { url: "https://feed.example/rss?q={q}" },
    rows: { tag: "item" },
    fields: {
      title: { tag: "title" },
      url: { tag: "link" },
      durationSecs: { tag: "itunes:duration", filters: [["parseDuration"]] }
    }
  };
  assert.deepEqual(validateWebIndexerDef(def, {}), []);
  const rss =
    "<?xml version='1.0'?><rss><channel>" +
    "<item><title>One</title><link>https://feed.example/1</link><itunes:duration>3:58</itunes:duration></item>" +
    "<item><title>No link — dropped</title></item>" +
    "</channel></rss>";
  const rows = runWebDefOnBody(def, rss);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "One");
  assert.equal(rows[0].url, "https://feed.example/1");
  assert.equal(rows[0].durationSecs, 238);
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test("filters: parseDuration, parseInt with separators, regex, querystring, replace", () => {
  assert.equal(applyWebFilters("3:58", [["parseDuration"]]), 238);
  assert.equal(applyWebFilters("1:02:03", [["parseDuration"]]), 3723);
  assert.equal(applyWebFilters("238", [["parseDuration"]]), 238);
  assert.equal(applyWebFilters("junk", [["parseDuration"]]), null);
  assert.equal(applyWebFilters("1,234,567 views", [["parseInt"]]), 1234567);
  assert.equal(applyWebFilters("x=9", [["regex", "x=(\\d+)"]]), "9");
  assert.equal(applyWebFilters("/p?id=a%20b&z=1", [["querystring", "id"]]), "a b");
  assert.equal(applyWebFilters("a-b-c", [["replace", "-", "/"]]), "a/b/c");
  assert.equal(applyWebFilters(" x ", [["trim"], ["prepend", "<"], ["append", ">"]]), "<x>");
  // Unknown filter names degrade to a no-op at runtime (validation rejects
  // them at paste time) — one bad custom def must not throw mid-sweep.
  assert.equal(applyWebFilters("x", [["bogus"]]), "x");
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validateWebIndexerDef speaks plainly about what's wrong", () => {
  const problems = (d, ids) => validateWebIndexerDef(d, ids || {});
  assert.ok(problems({}).length >= 4);
  const base = defById("dailymotion");
  // Duplicate id.
  assert.ok(problems(base, { dailymotion: true }).some((p) => p.includes("already taken")));
  // Missing {q}.
  const noQ = JSON.parse(JSON.stringify(base));
  noQ.search.url = "https://api.dailymotion.com/videos";
  assert.ok(problems(noQ).some((p) => p.includes("{q}")));
  // Unknown field and unknown filter.
  const weird = JSON.parse(JSON.stringify(base));
  weird.fields.seeders = { path: "x" };
  weird.fields.title.filters = [["explode"]];
  assert.ok(problems(weird).some((p) => p.includes("unknown field “seeders”")));
  assert.ok(problems(weird).some((p) => p.includes("unknown filter “explode”")));
  // A bad selector is an error at paste time, not a silent mismatch later.
  const badSel = {
    id: "b", name: "B", siteUrl: "https://b.example", type: "html",
    search: { url: "https://b.example/s?q={q}" },
    rows: { selector: "tr:not(.ad)" },
    fields: { title: { selector: "td" }, url: { selector: "a", attribute: "href" } }
  };
  assert.ok(problems(badSel).some((p) => p.includes("rows.selector")));
  // Required fields.
  const noUrl = JSON.parse(JSON.stringify(base));
  delete noUrl.fields.url;
  assert.ok(problems(noUrl).some((p) => p.includes("fields.url")));
  // Bounds.
  const bigLimit = JSON.parse(JSON.stringify(base));
  bigLimit.limit = 500;
  assert.ok(problems(bigLimit).some((p) => p.includes("limit")));
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

test("webSearchAll: parallel sweep, failure isolation, round-robin merge, site stamps", async () => {
  const bodies = {
    "api.dailymotion.com": fix("dailymotion-search.json"),
    "sepiasearch.org": fix("sepiasearch-search.json")
  };
  const stub = async (url) => {
    if (url.indexOf("archive.org") !== -1) return { status: 403, text: async () => "" };
    for (const host in bodies) {
      if (url.indexOf(host) !== -1) return { status: 200, text: async () => bodies[host], url };
    }
    throw new Error("unmapped " + url);
  };
  const res = await webSearchAll(WEB_DEFS, "bjork", stub, { minGapMs: 0 });
  // 5 dailymotion + 3 peertube rows, archive isolated as a per-engine error.
  assert.equal(res.candidates.length, 8);
  assert.deepEqual(res.engines.map((e) => [e.id, e.count, e.error && "HTTP " + e.status]), [
    ["dailymotion", 5, null],
    ["archive", 0, "HTTP 403"],
    ["peertube", 3, null]
  ]);
  // Round-robin: each site's best row surfaces before anyone's third.
  assert.equal(res.candidates[0].site, "Dailymotion");
  assert.equal(res.candidates[1].site, "PeerTube");
  assert.equal(res.candidates[2].site, "Dailymotion");
  assert.ok(res.candidates.every((c) => c.url.indexOf("http") === 0));
});

test("webSearchAll: an empty query or def list asks nobody", async () => {
  const boom = async () => { throw new Error("should not fetch"); };
  assert.deepEqual(await webSearchAll(WEB_DEFS, "  ", boom), { candidates: [], engines: [] });
  assert.deepEqual(await webSearchAll([], "x", boom), { candidates: [], engines: [] });
});

test("redirectHijack names the host that answered instead", () => {
  const hijack = plugin._redirectHijack;
  assert.equal(hijack("https://archive.org/x", "https://blockpage.example/notice"), "blockpage.example");
  assert.equal(hijack("https://a.example/x", "https://www.a.example/x"), null);
  assert.equal(hijack("https://a.example/x", undefined), null);
});

test("interleaveBySite honors the cap", () => {
  const merged = interleaveBySite([[1, 2, 3], [4, 5], [6]], 4);
  assert.deepEqual(merged, [1, 4, 6, 2]);
});

test("webEngineSummary reads per site — and a hijack's message survives its 200", () => {
  const line = plugin._webEngineSummary([
    { name: "Dailymotion", count: 25, error: null, status: 200 },
    { name: "PeerTube", count: 0, error: "HTTP 403", status: 403 },
    { name: "Blocked", count: 0, error: "redirected to blockpage.example — the site looks blocked on your network", status: 200 }
  ]);
  assert.ok(line.includes("Dailymotion 25"));
  assert.ok(line.includes("PeerTube: HTTP 403"));
  assert.ok(line.includes("Blocked: redirected to blockpage.example"));
});

// ---------------------------------------------------------------------------
// The catalog (webindexers/catalog.json) — the one-click way to add a site.
// Its entries are held to the SAME bar as the bundled defs: every one must
// validate and be pinned against a saved real response, because a catalog
// site is one click from being live in someone's search.
// ---------------------------------------------------------------------------

const parseWebCatalog = plugin._parseWebCatalog;
const catalogRaw = fs.readFileSync(path.join(__dirname, "..", "webindexers", "catalog.json"), "utf8");

test("the shipped catalog parses clean: every entry valid, described, and un-bundled", () => {
  const cat = parseWebCatalog(catalogRaw);
  assert.deepEqual(cat.problems, []);
  assert.deepEqual(cat.entries.map((e) => e.id), ["mixcloud", "niconico", "archive-video"]);
  for (const entry of cat.entries) {
    // No catalog id may shadow a bundled def — Add would then be a no-op
    // that validateWebIndexerDef rejects as "already taken".
    assert.equal(WEB_DEFS.some((d) => d.id === entry.id), false, entry.id);
    assert.ok(entry.description, entry.id + " needs a description for the catalog UI");
  }
});

test("catalog defs are pinned against real responses, like the bundled ones", () => {
  const cat = parseWebCatalog(catalogRaw);
  const byId = (id) => cat.entries.filter((e) => e.id === id)[0];

  const mix = runWebDefOnBody(byId("mixcloud"), fix("mixcloud-search.json"));
  assert.equal(mix.length, 3);
  assert.equal(mix[0].title, "Björk: Jazz Muse & Hyperballadeer [Mondo Jazz Ep. 73]");
  assert.ok(mix[0].url.startsWith("https://www.mixcloud.com/MondoJazz/"), mix[0].url);
  assert.equal(mix[0].durationSecs, 8692);
  assert.equal(mix[0].uploader, "Mondo Jazz");
  assert.equal(mix[0].views, 2032);
  assert.equal(mix[0].site, "Mixcloud");

  const nico = runWebDefOnBody(byId("niconico"), fix("niconico-search.json"));
  assert.equal(nico.length, 3);
  assert.equal(nico[0].url, "https://www.nicovideo.jp/watch/sm1254058");
  assert.equal(nico[0].durationSecs, 292);
  assert.equal(nico[0].views, 58316);
  assert.ok(nico[0].thumbnail.startsWith("https://nicovideo.cdn.nimg.jp/"), nico[0].thumbnail);

  const av = runWebDefOnBody(byId("archive-video"), fix("archive-video-search.json"));
  assert.equal(av.length, 3);
  assert.equal(av[0].url, "https://archive.org/details/Good_Guy_Award_2013_-_Steve_Bjork");
  assert.equal(av[0].uploader, "WCTV");
  assert.equal(av[0].views, 39);
});

test("parseWebCatalog isolates a bad entry instead of sinking the rest", () => {
  const good = JSON.parse(catalogRaw).indexers[0];
  const body = JSON.stringify({ version: 1, indexers: [good, { id: "broken", name: "Broken" }] });
  const cat = parseWebCatalog(body);
  assert.deepEqual(cat.entries.map((e) => e.id), ["mixcloud"]);
  assert.equal(cat.problems.length, 1);
  assert.ok(cat.problems[0].startsWith("“Broken”:"), cat.problems[0]);
  // Junk shapes fail loudly, not silently-empty.
  assert.ok(parseWebCatalog("not json").problems[0].includes("valid JSON"));
  assert.ok(parseWebCatalog("{}").problems[0].includes("indexers"));
});

// The merged rows feed the SAME row builder / track builder as every other
// tab — prove a web candidate renders and builds a playable ytdlp:// track.
test("a web candidate flows through buildResultRow and buildTrack untouched", () => {
  const rows = runWebDefOnBody(defById("peertube"), fix("sepiasearch-search.json"));
  const row = plugin._buildResultRow(rows[1], 0, {});
  assert.ok(row.subtitle.includes("PeerTube"), row.subtitle);
  assert.ok(row.id.startsWith("ytdlp://"));
  const track = plugin._buildTrack(rows[1], false);
  assert.equal(track.kind, "audio");
  assert.ok(track.path.startsWith("ytdlp://"));
  assert.equal(track.duration_secs, 224);
});
