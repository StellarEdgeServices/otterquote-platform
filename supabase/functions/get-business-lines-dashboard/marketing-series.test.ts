// gh-1469 (#1340 phase 2a) — 12-week marketing series helpers.
//
// get-business-lines-dashboard/index.ts is a single-file EF with no exports
// (same shape ga4-report/index.ts, exhibit-a-shapes.test.ts, and
// starter-template.test.ts already work around), so this test extracts the
// pure weekly-bucketing functions from the source the same way those tests
// do: read index.ts as text, pull out the named consts/types/interfaces/
// functions, re-export them, and import the result via a data: URL. That
// keeps the production file's public shape (one default-exported handler,
// no test-only exports) unchanged while still exercising the real
// implementations — not a re-implementation of them.
//
// Deliberately does NOT exercise the handler itself (auth, the Supabase
// reads, fetchAllActivity, fetchRevenueMtd, the live GA4 fetch behind
// fetchGa4SessionsByDay): those need live credentials and network access and
// are out of scope for a pure-unit, --allow-net-free lane. What IS covered
// here is every pure function gh-1469 added — buildWeekWindows, countByWeek,
// kindForTotal, buildWeeklySeries, notRunSeries, buildGroupedWeeklySeries,
// firstEventPerGroup — plus, as of gh-1574 (#1340 phase 5), the pure GA4
// visits-series functions: ga4DateToIso, sumByWeek, buildVisitsSeries. The
// GA4 *response-parsing* pure function (parseSessionsByDayResponse) lives in
// ga4.ts, which is a real module with real exports (not a single-file EF),
// so it is tested directly in ga4.test.ts instead of via this extraction.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { AUDIENCE_PREFIX_NOTE } from "./ga4.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

// gh-1639 (#1340 phase 5c): buildAudienceVisitsSeries (extracted below)
// calls two REAL runtime exports of ga4.ts (bucketPagePath,
// AUDIENCE_PREFIX_NOTE) — unlike a type-only reference (e.g.
// Ga4SessionsByDayResult, erased at compile time and already safely left
// unresolved elsewhere in this file's extraction), those are values
// actually invoked at runtime, so the extracted module needs a real import
// of them. A relative "./ga4.ts" import would not resolve inside a data:
// URL module (it has no meaningful base path to resolve against), so this
// builds an absolute file:// import statement instead, the same
// new URL(..., import.meta.url) trick the readTextFile call above uses.
const ga4ModuleUrl = new URL("./ga4.ts", import.meta.url).href;

// Same string/template-literal-aware brace counter as ga4-report/index.test.ts
// (a plain counter misfires on any function whose body contains a quoted
// "{" or "}" — none of the functions below do today, but this is the
// convention this repo already settled on for source-extraction tests).
function grabBlock(marker: string): string {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`not found: ${marker}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  let inStr: '"' | "'" | "`" | null = null;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (c === "\\") { j++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced: ${marker}`);
}

function grabConst(name: string): string {
  const marker = `const ${name} =`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`not found: ${name}`);
  const end = src.indexOf(";\n", start);
  if (end === -1) throw new Error(`unterminated: ${name}`);
  return src.slice(start, end + 1);
}

function grabType(name: string): string {
  const marker = `type ${name} =`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`not found: ${name}`);
  const end = src.indexOf(";\n", start);
  if (end === -1) throw new Error(`unterminated: ${name}`);
  return src.slice(start, end + 1);
}

const mod = [
  grabConst("WEEK_MS").replace("const WEEK_MS", "export const WEEK_MS"),
  grabConst("MARKETING_WEEKS").replace("const MARKETING_WEEKS", "export const MARKETING_WEEKS"),
  grabBlock("interface WeekWindow").replace("interface WeekWindow", "export interface WeekWindow"),
  grabConst("UNSPECIFIED_GROUP").replace("const UNSPECIFIED_GROUP", "export const UNSPECIFIED_GROUP"),
  grabBlock("function buildWeekWindows(").replace(
    "function buildWeekWindows(",
    "export function buildWeekWindows(",
  ),
  grabType("SeriesKind").replace("type SeriesKind =", "export type SeriesKind ="),
  grabBlock("function kindForTotal(").replace("function kindForTotal(", "export function kindForTotal("),
  grabBlock("interface DatedRow").replace("interface DatedRow", "export interface DatedRow"),
  grabBlock("function countByWeek(").replace("function countByWeek(", "export function countByWeek("),
  grabBlock("interface WeeklySeries").replace("interface WeeklySeries", "export interface WeeklySeries"),
  grabBlock("function buildWeeklySeries(").replace(
    "function buildWeeklySeries(",
    "export function buildWeeklySeries(",
  ),
  grabBlock("function notRunSeries(").replace("function notRunSeries(", "export function notRunSeries("),
  grabBlock("interface GroupedRow").replace("interface GroupedRow", "export interface GroupedRow"),
  grabBlock("interface WeeklySeriesGroup").replace(
    "interface WeeklySeriesGroup",
    "export interface WeeklySeriesGroup",
  ),
  grabBlock("interface GroupedWeeklySeries").replace(
    "interface GroupedWeeklySeries",
    "export interface GroupedWeeklySeries",
  ),
  grabBlock("function buildGroupedWeeklySeries(").replace(
    "function buildGroupedWeeklySeries(",
    "export function buildGroupedWeeklySeries(",
  ),
  grabBlock("interface FirstEventRow").replace("interface FirstEventRow", "export interface FirstEventRow"),
  grabBlock("interface FirstEventResult").replace(
    "interface FirstEventResult",
    "export interface FirstEventResult",
  ),
  grabBlock("function firstEventPerGroup(").replace(
    "function firstEventPerGroup(",
    "export function firstEventPerGroup(",
  ),
  // gh-1574 (#1340 phase 5) — GA4 visits weekly series.
  grabConst("GA4_VISITS_CAVEAT").replace("const GA4_VISITS_CAVEAT", "export const GA4_VISITS_CAVEAT"),
  grabConst("GA4_VISITS_NOTE").replace("const GA4_VISITS_NOTE", "export const GA4_VISITS_NOTE"),
  // gh-1639 fix — the declared invariant tolerance and its payload block.
  grabConst("GA4_INVARIANT_TOLERANCE_PCT").replace(
    "const GA4_INVARIANT_TOLERANCE_PCT",
    "export const GA4_INVARIANT_TOLERANCE_PCT",
  ),
  grabConst("GA4_INVARIANT_TOLERANCE_RULE").replace(
    "const GA4_INVARIANT_TOLERANCE_RULE",
    "export const GA4_INVARIANT_TOLERANCE_RULE",
  ),
  grabBlock("interface VisitsInvariant").replace("interface VisitsInvariant", "export interface VisitsInvariant"),
  grabBlock("function invariantWithout(").replace("function invariantWithout(", "export function invariantWithout("),
  grabBlock("function ga4DateToIso(").replace("function ga4DateToIso(", "export function ga4DateToIso("),
  grabBlock("interface WeightedDatedRow").replace(
    "interface WeightedDatedRow",
    "export interface WeightedDatedRow",
  ),
  grabBlock("function sumByWeek(").replace("function sumByWeek(", "export function sumByWeek("),
  grabBlock("function buildVisitsSeries(").replace(
    "function buildVisitsSeries(",
    "export function buildVisitsSeries(",
  ),
  // gh-1639 (#1340 phase 5c) — per-audience visits denominators.
  `import { AUDIENCE_PREFIX_NOTE, bucketPagePath, isUnresolvedLandingPage } from "${ga4ModuleUrl}";`,
  grabBlock("function sumInvariantMismatches(").replace(
    "function sumInvariantMismatches(",
    "export function sumInvariantMismatches(",
  ),
  grabBlock("function invariantToleranceValues(").replace(
    "function invariantToleranceValues(",
    "export function invariantToleranceValues(",
  ),
  grabBlock("function buildAudienceVisitsSeries(").replace(
    "function buildAudienceVisitsSeries(",
    "export function buildAudienceVisitsSeries(",
  ),
].join("\n\n");
const url = "data:application/typescript," + encodeURIComponent(mod);
const {
  buildWeekWindows,
  kindForTotal,
  countByWeek,
  buildWeeklySeries,
  notRunSeries,
  buildGroupedWeeklySeries,
  firstEventPerGroup,
  UNSPECIFIED_GROUP,
  WEEK_MS,
  MARKETING_WEEKS,
  GA4_VISITS_CAVEAT,
  GA4_VISITS_NOTE,
  GA4_INVARIANT_TOLERANCE_RULE,
  ga4DateToIso,
  sumByWeek,
  buildVisitsSeries,
  sumInvariantMismatches,
  invariantToleranceValues,
  buildAudienceVisitsSeries,
  // deno-lint-ignore no-explicit-any
} = await import(url) as any;

// A fixed instant so every test is deterministic: 2026-09-01T18:00:00Z.
const NOW = Date.parse("2026-09-01T18:00:00.000Z");

// --- buildWeekWindows --------------------------------------------------

Deno.test("buildWeekWindows: returns MARKETING_WEEKS windows, oldest first, last window ending at now", () => {
  const windows = buildWeekWindows(NOW, MARKETING_WEEKS);
  assertEquals(windows.length, 12);
  assertEquals(windows[11].week_end, new Date(NOW).toISOString());
  assertEquals(windows[0].week_start, new Date(NOW - 12 * WEEK_MS).toISOString());
});

Deno.test("buildWeekWindows: windows are contiguous 7-day slices with no gap or overlap", () => {
  const windows = buildWeekWindows(NOW, MARKETING_WEEKS);
  for (let i = 0; i < windows.length; i++) {
    const start = Date.parse(windows[i].week_start);
    const end = Date.parse(windows[i].week_end);
    assertEquals(end - start, WEEK_MS);
    if (i > 0) assertEquals(windows[i].week_start, windows[i - 1].week_end);
  }
});

// --- kindForTotal --------------------------------------------------------

Deno.test("kindForTotal: zero is measured_zero, any positive total is measured", () => {
  assertEquals(kindForTotal(0), "measured_zero");
  assertEquals(kindForTotal(1), "measured");
  assertEquals(kindForTotal(1000), "measured");
});

// --- countByWeek -----------------------------------------------------------

Deno.test("countByWeek: buckets a row into the window whose [start, end) contains its timestamp", () => {
  const windows = buildWeekWindows(NOW, 12);
  // Middle of the most recent (last) window.
  const midLastWeek = new Date(NOW - WEEK_MS / 2).toISOString();
  const values = countByWeek([{ iso: midLastWeek }], windows);
  assertEquals(values, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

Deno.test("countByWeek: window start is inclusive, window end is exclusive (no double-count on the boundary)", () => {
  const windows = buildWeekWindows(NOW, 12);
  // Exactly on the boundary between window[10] and window[11] — must land
  // in window[11] (its start), not window[10] (whose end this equals).
  const boundary = windows[11].week_start;
  const values = countByWeek([{ iso: boundary }], windows);
  assertEquals(values[10], 0);
  assertEquals(values[11], 1);
});

Deno.test("countByWeek: a row with no timestamp, or an unparsable one, is dropped rather than mis-bucketed", () => {
  const windows = buildWeekWindows(NOW, 12);
  const values = countByWeek([{ iso: null }, { iso: "not-a-date" }], windows);
  assertEquals(values.reduce((a: number, b: number) => a + b, 0), 0);
});

Deno.test("countByWeek: a timestamp older than all 12 windows is dropped, not folded into window[0]", () => {
  const windows = buildWeekWindows(NOW, 12);
  const ancient = new Date(NOW - 52 * WEEK_MS).toISOString();
  const values = countByWeek([{ iso: ancient }], windows);
  assertEquals(values.reduce((a: number, b: number) => a + b, 0), 0);
});

// --- buildWeeklySeries -----------------------------------------------------

Deno.test("buildWeeklySeries: empty input is a real measured_zero, not an absent series", () => {
  const windows = buildWeekWindows(NOW, 12);
  const series = buildWeeklySeries("things", [], windows);
  assertEquals(series.kind, "measured_zero");
  assertEquals(series.total, 0);
  assertEquals(series.values.length, 12);
  assertEquals(series.unit, "things");
});

Deno.test("buildWeeklySeries: total is the sum of the weekly values and kind flips to measured", () => {
  const windows = buildWeekWindows(NOW, 12);
  const rows = [
    { iso: new Date(NOW - WEEK_MS / 2).toISOString() }, // last window
    { iso: new Date(NOW - WEEK_MS / 2).toISOString() }, // last window again
    { iso: new Date(NOW - 5 * WEEK_MS).toISOString() }, // an earlier window
  ];
  const series = buildWeeklySeries("things", rows, windows);
  assertEquals(series.kind, "measured");
  assertEquals(series.total, 3);
  assertEquals(series.values.reduce((a: number, b: number) => a + b, 0), 3);
  assertEquals(series.values[11], 2);
});

// --- notRunSeries ------------------------------------------------------

Deno.test("notRunSeries: carries a reason and is distinct from a measured_zero series", () => {
  const windows = buildWeekWindows(NOW, 12);
  const series = notRunSeries("visits", windows, "GA4 not wired in yet (#1331)");
  assertEquals(series.kind, "not_run");
  assertEquals(series.reason, "GA4 not wired in yet (#1331)");
  assertEquals(series.values, new Array(12).fill(0));
  assertEquals(series.total, 0);
});

// --- buildGroupedWeeklySeries --------------------------------------------

Deno.test("buildGroupedWeeklySeries: splits by group, sorted alphabetically by key", () => {
  const windows = buildWeekWindows(NOW, 12);
  const rows = [
    { iso: new Date(NOW - WEEK_MS / 2).toISOString(), group: "referral" },
    { iso: new Date(NOW - WEEK_MS / 2).toISOString(), group: "google" },
    { iso: new Date(NOW - WEEK_MS / 2).toISOString(), group: "google" },
  ];
  const series = buildGroupedWeeklySeries("leads", rows, windows);
  assertEquals(series.groups.map((g: { key: string }) => g.key), ["google", "referral"]);
  assertEquals(series.groups[0].total, 2);
  assertEquals(series.groups[1].total, 1);
  assertEquals(series.total, 3);
  assertEquals(series.kind, "measured");
});

Deno.test("buildGroupedWeeklySeries: null or blank group falls into UNSPECIFIED_GROUP, never dropped", () => {
  const windows = buildWeekWindows(NOW, 12);
  const rows = [
    { iso: new Date(NOW - WEEK_MS / 2).toISOString(), group: null },
    { iso: new Date(NOW - WEEK_MS / 2).toISOString(), group: "   " },
  ];
  const series = buildGroupedWeeklySeries("leads", rows, windows);
  assertEquals(series.groups.length, 1);
  assertEquals(series.groups[0].key, UNSPECIFIED_GROUP);
  assertEquals(series.groups[0].total, 2);
});

Deno.test("buildGroupedWeeklySeries: no rows at all is a real measured_zero with an empty group list", () => {
  const windows = buildWeekWindows(NOW, 12);
  const series = buildGroupedWeeklySeries("leads", [], windows);
  assertEquals(series.kind, "measured_zero");
  assertEquals(series.groups, []);
  assertEquals(series.total, 0);
});

// --- firstEventPerGroup --------------------------------------------------

Deno.test("firstEventPerGroup: picks the earliest timestamp per group, not the last", () => {
  const rows = [
    { group: "contractor-a", iso: "2026-08-10T00:00:00.000Z" },
    { group: "contractor-a", iso: "2026-07-01T00:00:00.000Z" }, // earlier — this one wins
    { group: "contractor-a", iso: "2026-08-20T00:00:00.000Z" },
  ];
  const { firsts, excludedNoTimestamp } = firstEventPerGroup(rows);
  assertEquals(firsts.length, 1);
  assertEquals(firsts[0].iso, "2026-07-01T00:00:00.000Z");
  assertEquals(excludedNoTimestamp, 0);
});

Deno.test("firstEventPerGroup: a group with no valid timestamp anywhere is excluded and counted, not invented", () => {
  const rows = [
    { group: "contractor-legacy", iso: null },
    { group: "contractor-b", iso: "2026-07-01T00:00:00.000Z" },
  ];
  const { firsts, excludedNoTimestamp } = firstEventPerGroup(rows);
  assertEquals(firsts.length, 1);
  assertEquals(excludedNoTimestamp, 1);
});

Deno.test("firstEventPerGroup: multiple groups each contribute exactly one first-event row", () => {
  const rows = [
    { group: "a", iso: "2026-07-01T00:00:00.000Z" },
    { group: "a", iso: "2026-07-05T00:00:00.000Z" },
    { group: "b", iso: "2026-08-01T00:00:00.000Z" },
  ];
  const { firsts, excludedNoTimestamp } = firstEventPerGroup(rows);
  assertEquals(firsts.length, 2);
  assertEquals(excludedNoTimestamp, 0);
});

// --- gh-1574 (#1340 phase 5): GA4 visits weekly series --------------------

// --- ga4DateToIso -----------------------------------------------------

Deno.test("ga4DateToIso: converts a GA4 YYYYMMDD date to midnight-UTC ISO", () => {
  assertEquals(ga4DateToIso("20260901"), "2026-09-01T00:00:00.000Z");
});

Deno.test("ga4DateToIso: rejects anything that isn't exactly 8 digits", () => {
  for (const bad of ["2026-09-01", "202609011", "2026901", "", "today", "2026090a"]) {
    assertEquals(ga4DateToIso(bad), null);
  }
});

// --- sumByWeek ----------------------------------------------------------

Deno.test("sumByWeek: sums each row's value into the window whose [start, end) contains its timestamp", () => {
  const windows = buildWeekWindows(NOW, 12);
  const midLastWeek = new Date(NOW - WEEK_MS / 2).toISOString();
  const values = sumByWeek([{ iso: midLastWeek, value: 250 }], windows);
  assertEquals(values, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 250]);
});

Deno.test("sumByWeek: multiple rows in the same window accumulate rather than overwrite", () => {
  const windows = buildWeekWindows(NOW, 12);
  const midLastWeek = new Date(NOW - WEEK_MS / 2).toISOString();
  const values = sumByWeek(
    [{ iso: midLastWeek, value: 100 }, { iso: midLastWeek, value: 50 }],
    windows,
  );
  assertEquals(values[11], 150);
});

Deno.test("sumByWeek: a row with no timestamp, or one older than all windows, is dropped rather than mis-bucketed", () => {
  const windows = buildWeekWindows(NOW, 12);
  const ancient = new Date(NOW - 52 * WEEK_MS).toISOString();
  const values = sumByWeek([{ iso: null, value: 999 }, { iso: ancient, value: 999 }], windows);
  assertEquals(values.reduce((a: number, b: number) => a + b, 0), 0);
});

// --- buildVisitsSeries ----------------------------------------------------

// gh-1637: fetchGa4SessionsByDay's result now carries property_id + hosts on
// BOTH branches (ok:true and ok:false) — these fixtures match that shape.
const GA4_HOSTS_FIXTURE = ["otterquote.com", "www.otterquote.com", "app.otterquote.com"];
// gh-1649: both branches also carry `exclusions` (what the wire filter removed).
const GA4_EXCLUSIONS_FIXTURE = {
  source_substrings: ["netlify.app"],
  sources_exact: ["accounts.google.com"],
  cities: ["Glenview", "Council Bluffs"],
  residual: "fixture residual",
};

Deno.test("buildVisitsSeries: a successful GA4 fetch with sessions produces a measured series carrying the caveat and note", () => {
  const windows = buildWeekWindows(NOW, 12);
  const dayInLastWindow = "20260901"; // NOW is 2026-09-01T18:00:00Z
  const series = buildVisitsSeries(
    {
      ok: true,
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE,
      exclusions: GA4_EXCLUSIONS_FIXTURE,
      rows: [],
      site_rows: [{ date: dayInLastWindow, sessions: 421 }],
    },
    windows,
  );
  assertEquals(series.kind, "measured");
  assertEquals(series.unit, "sessions");
  assertEquals(series.total, 421);
  // gh-1639 fix: the site total IS the reference the buckets are checked
  // against, and says so.
  assertEquals(series.invariant.status, "reference");
  assertEquals(series.invariant.rule, GA4_INVARIANT_TOLERANCE_RULE);
  assertEquals(series.values[11], 421);
  assertEquals(series.caveat, GA4_VISITS_CAVEAT);
  assertEquals(series.note, GA4_VISITS_NOTE);
  // gh-1649: the exclusions the client applied ride through to the payload.
  assertEquals(series.exclusions, GA4_EXCLUSIONS_FIXTURE);
});

Deno.test("buildVisitsSeries: a successful GA4 fetch with no rows is a real measured_zero, not not_run", () => {
  const windows = buildWeekWindows(NOW, 12);
  const series = buildVisitsSeries(
    { ok: true, property_id: "541423859", hosts: GA4_HOSTS_FIXTURE,
      exclusions: GA4_EXCLUSIONS_FIXTURE, rows: [], site_rows: [] },
    windows,
  );
  assertEquals(series.kind, "measured_zero");
  assertEquals(series.total, 0);
});

Deno.test("buildVisitsSeries: a GA4 fetch failure is not_run with the reason attached — never a fabricated zero series", () => {
  const windows = buildWeekWindows(NOW, 12);
  const series = buildVisitsSeries(
    {
      ok: false,
      reason: "GA4 Data API returned 403 for property 541423859",
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE,
      exclusions: GA4_EXCLUSIONS_FIXTURE,
    },
    windows,
  );
  assertEquals(series.kind, "not_run");
  assertEquals(series.reason, "GA4 Data API returned 403 for property 541423859");
  assertEquals(series.values, new Array(12).fill(0));
  assertEquals(series.total, 0);
  // The caveat/note are still carried even when unmeasured — they describe
  // the series' meaning and scope, not its measured state.
  assertEquals(series.caveat, GA4_VISITS_CAVEAT);
  assertEquals(series.note, GA4_VISITS_NOTE);
});

Deno.test("buildVisitsSeries: sessions from multiple days land in their own respective weeks, not all in one bucket", () => {
  const windows = buildWeekWindows(NOW, 12);
  const series = buildVisitsSeries(
    {
      ok: true,
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE,
      exclusions: GA4_EXCLUSIONS_FIXTURE,
      rows: [],
      site_rows: [
        { date: "20260901", sessions: 100 }, // last window (NOW's day)
        { date: "20260701", sessions: 50 },  // an earlier window
      ],
    },
    windows,
  );
  assertEquals(series.kind, "measured");
  assertEquals(series.total, 150);
  assertEquals(series.values[11], 100);
  assertEquals(series.values.slice(0, 11).reduce((a: number, b: number) => a + b, 0), 50);
});

// --- gh-1637 (#1340 phase 5a): scope / property_id / hosts on the payload -

Deno.test("buildVisitsSeries: a successful GA4 fetch declares scope/property_id/hosts on the series — the pinned #1638/#1639 payload contract", () => {
  const windows = buildWeekWindows(NOW, 12);
  const series = buildVisitsSeries(
    { ok: true, property_id: "541423859", hosts: GA4_HOSTS_FIXTURE,
      exclusions: GA4_EXCLUSIONS_FIXTURE, rows: [], site_rows: [{ date: "20260901", sessions: 10 }] },
    windows,
  );
  assertEquals(series.scope, "production");
  assertEquals(series.property_id, "541423859");
  assertEquals(series.hosts, GA4_HOSTS_FIXTURE);
});

Deno.test("buildVisitsSeries: a not_run result STILL carries scope/property_id/hosts — the page must be able to say what it would have counted", () => {
  const windows = buildWeekWindows(NOW, 12);
  const series = buildVisitsSeries(
    {
      ok: false,
      reason: "GA4_SERVICE_ACCOUNT_JSON is not set or is not a complete service account",
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE,
      exclusions: GA4_EXCLUSIONS_FIXTURE,
    },
    windows,
  );
  assertEquals(series.kind, "not_run");
  assertEquals(series.scope, "production");
  assertEquals(series.property_id, "541423859");
  assertEquals(series.hosts, GA4_HOSTS_FIXTURE);
});

// gh-1639 fix: v13's visits_site_total summed the pagePath-dimensioned rows
// (1,464 over 84 days) instead of the site's sessions (827). The site total
// must now come from `site_rows` (the [date]-only read) and NEVER from the
// dimensioned `rows` — this fixture makes the two disagree by the measured
// 1.77x so summing the wrong one is a red test.
Deno.test("buildVisitsSeries: the site total is summed from site_rows (the date-only read), never from the landingPage-dimensioned rows (gh-1639 fix — v13 summed 1,464 where the site had 827)", () => {
  const windows = buildWeekWindows(NOW, 12);
  const series = buildVisitsSeries(
    {
      ok: true,
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE,
      exclusions: GA4_EXCLUSIONS_FIXTURE,
      rows: [
        { date: "20260901", landingPage: "/", sessions: 639 },
        { date: "20260901", landingPage: "/recruit", sessions: 431 },
        { date: "20260901", landingPage: "/partners", sessions: 250 },
        { date: "20260901", landingPage: "/login", sessions: 144 },
      ], // sums to 1,464 — the v13 inflation
      site_rows: [{ date: "20260901", sessions: 827 }],
    },
    windows,
  );
  assertEquals(series.total, 827);
  assertEquals(series.values[11], 827);
});

// --- gh-1639 (#1340 phase 5c): sumInvariantMismatches ----------------------
//
// A synthetic row set whose buckets SUM (the happy path buildAudienceVisits
// Series always produces, since its partition is total) and a synthetic row
// set whose buckets do NOT sum (the failure this function exists to catch,
// per the issue's closes-on clause 1 — unreachable through
// buildAudienceVisitsSeries itself since bucketPagePath is a total function
// that never drops or duplicates a row, but this is exactly the guard that
// would catch a FUTURE regression of that guarantee).

Deno.test("sumInvariantMismatches: buckets that sum correctly to the site total, window by window, report no mismatches", () => {
  const windows = [
    { week_start: "2026-08-01T00:00:00.000Z", week_end: "2026-08-08T00:00:00.000Z" },
    { week_start: "2026-08-08T00:00:00.000Z", week_end: "2026-08-15T00:00:00.000Z" },
  ];
  // homeowner + contractor + referral_partner + unattributed, per window.
  const buckets = [
    [10, 20],
    [5, 0],
    [0, 3],
    [1, 1],
  ];
  const siteTotals = [16, 24]; // 10+5+0+1=16, 20+0+3+1=24
  assertEquals(sumInvariantMismatches(buckets, siteTotals, [0, 0], windows), []);
});

Deno.test("sumInvariantMismatches: a synthetic row set whose buckets do NOT sum to the site total fails closed with a reason naming the discrepancy", () => {
  const windows = [
    { week_start: "2026-08-01T00:00:00.000Z", week_end: "2026-08-08T00:00:00.000Z" },
    { week_start: "2026-08-08T00:00:00.000Z", week_end: "2026-08-15T00:00:00.000Z" },
  ];
  const buckets = [
    [10, 20],
    [5, 0],
    [0, 3],
    [1, 1],
  ];
  // Window 1's true bucket sum is 24 (see the passing test above) but the
  // "independently computed" site total disagrees — simulating a dropped or
  // double-counted row somewhere in the mapping.
  const siteTotals = [16, 30];
  const mismatches = sumInvariantMismatches(buckets, siteTotals, [0, 0], windows);
  assertEquals(mismatches.length, 1);
  assertEquals(mismatches[0].includes("window 1"), true);
  assertEquals(mismatches[0].includes("buckets sum to 24"), true);
  assertEquals(mismatches[0].includes("site total is 30"), true);
  assertEquals(mismatches[0].includes("tolerance 0"), true);
});

// gh-1639 fix: the tolerance is per window and inclusive — a difference
// exactly AT the tolerance passes, one past it fails.
Deno.test("sumInvariantMismatches: a difference within (or exactly at) the window's tolerance is not a mismatch; one past it is", () => {
  const windows = [
    { week_start: "a0", week_end: "a1" },
    { week_start: "b0", week_end: "b1" },
    { week_start: "c0", week_end: "c1" },
  ];
  const buckets = [[331, 64, 97]]; // measured 2026-09-05 window -0: 331 landingPage vs 311 date-only
  const siteTotals = [311, 64, 97];
  assertEquals(sumInvariantMismatches(buckets, siteTotals, [20, 0, 0], windows), []); // exactly at tolerance
  assertEquals(sumInvariantMismatches(buckets, siteTotals, [26, 2, 2], windows), []); // within
  const over = sumInvariantMismatches(buckets, siteTotals, [19, 0, 0], windows); // one past
  assertEquals(over.length, 1);
  assertEquals(over[0].includes("window 0"), true);
  assertEquals(over[0].includes("tolerance 19"), true);
});

Deno.test("sumInvariantMismatches: the tolerance is symmetric — a bucket sum BELOW the site total by more than the tolerance is a mismatch too (a short denominator inflates conversion)", () => {
  const windows = [{ week_start: "a0", week_end: "a1" }];
  assertEquals(sumInvariantMismatches([[300]], [311], [10], windows), []);
  assertEquals(sumInvariantMismatches([[290]], [311], [10], windows).length, 1);
});

Deno.test("invariantToleranceValues: per window, max(unresolved landing sessions, ceil(2% of the date-only total)) — both components, declared in GA4_INVARIANT_TOLERANCE_RULE", () => {
  // window 0: measured 2026-09-05 current day — 23 unresolved beats ceil(0.02*311)=7
  // window 1: 0 unresolved, ceil(0.02*64)=2 floor applies
  // window 2: 4 unresolved vs ceil(0.02*97)=2 -> 4
  // window 3: an empty window is tolerance 0, not NaN
  assertEquals(invariantToleranceValues([23, 0, 4, 0], [311, 64, 97, 0]), [23, 2, 4, 0]);
  assertEquals(GA4_INVARIANT_TOLERANCE_RULE.includes("max("), true);
  assertEquals(GA4_INVARIANT_TOLERANCE_RULE.includes("2%"), true);
  assertEquals(GA4_INVARIANT_TOLERANCE_RULE.includes("(not set)"), true);
});

Deno.test("sumInvariantMismatches: multiple disagreeing windows are all named, not just the first", () => {
  const windows = [
    { week_start: "a0", week_end: "a1" },
    { week_start: "b0", week_end: "b1" },
  ];
  const buckets = [[1, 1]];
  const siteTotals = [2, 3]; // window 0 agrees (1===2? no) -- both disagree
  const mismatches = sumInvariantMismatches(buckets, siteTotals, [0, 0], windows);
  assertEquals(mismatches.length, 2);
});

// --- gh-1639: buildAudienceVisitsSeries ------------------------------------

const GA4_HOSTS_FIXTURE_1639 = ["otterquote.com", "www.otterquote.com", "app.otterquote.com"];

// gh-1639 fix: a synthetic [date]-only site read that is ADDITIVE with the
// given landingPage rows — what GA4 measurably returns for closed days (61/61
// exact on 2026-09-05). The negative controls below deliberately do NOT use
// it, handing in a site total that disagrees instead.
function additiveSiteRows(
  rows: Array<{ date: string; landingPage?: string; sessions: number }>,
): Array<{ date: string; sessions: number }> {
  const byDate = new Map<string, number>();
  for (const r of rows) byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.sessions);
  return [...byDate.entries()].map(([date, sessions]) => ({ date, sessions }));
}

Deno.test("buildAudienceVisitsSeries: a GA4 fetch failure is not_run on ALL FOUR audiences, each still carrying scope/property_id/hosts/note", () => {
  const windows = buildWeekWindows(NOW, 12);
  const result = buildAudienceVisitsSeries(
    {
      ok: false,
      reason: "GA4 Data API returned 403 for property 541423859",
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE_1639,
    },
    windows,
  );
  for (const aud of ["homeowner", "contractor", "referral_partner", "unattributed"] as const) {
    assertEquals(result[aud].kind, "not_run");
    assertEquals(result[aud].reason, "GA4 Data API returned 403 for property 541423859");
    assertEquals(result[aud].scope, "production");
    assertEquals(result[aud].property_id, "541423859");
    assertEquals(result[aud].hosts, GA4_HOSTS_FIXTURE_1639);
    assertEquals(result[aud].note, AUDIENCE_PREFIX_NOTE[aud]);
  }
});

Deno.test("buildAudienceVisitsSeries: buckets rows by landingPage into the correct audience and each carries its own note", () => {
  const windows = buildWeekWindows(NOW, 12);
  const dayInLastWindow = "20260901"; // NOW is 2026-09-01T18:00:00Z
  const result = buildAudienceVisitsSeries(
    {
      ok: true,
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE_1639,
      rows: [
        { date: dayInLastWindow, landingPage: "/get-started", sessions: 100 }, // homeowner
        { date: dayInLastWindow, landingPage: "/contractor-join", sessions: 50 }, // contractor
        { date: dayInLastWindow, landingPage: "/ref", sessions: 10 }, // referral_partner
        { date: dayInLastWindow, landingPage: "/login", sessions: 5 }, // unattributed
      ],
      site_rows: additiveSiteRows([
        { date: dayInLastWindow, landingPage: "/get-started", sessions: 100 }, // homeowner
        { date: dayInLastWindow, landingPage: "/contractor-join", sessions: 50 }, // contractor
        { date: dayInLastWindow, landingPage: "/ref", sessions: 10 }, // referral_partner
        { date: dayInLastWindow, landingPage: "/login", sessions: 5 }, // unattributed
      ]),
    },
    windows,
  );
  assertEquals(result.homeowner.total, 100);
  assertEquals(result.contractor.total, 50);
  assertEquals(result.referral_partner.total, 10);
  assertEquals(result.unattributed.total, 5);
  assertEquals(result.homeowner.kind, "measured");
  assertEquals(result.unattributed.kind, "measured");
  for (const aud of ["homeowner", "contractor", "referral_partner", "unattributed"] as const) {
    assertEquals(result[aud].note, AUDIENCE_PREFIX_NOTE[aud]);
    assertEquals(result[aud].scope, "production");
    assertEquals(result[aud].caveat, GA4_VISITS_CAVEAT);
  }
});

Deno.test("buildAudienceVisitsSeries: the four buckets agree, window by window, with the SEPARATE date-only site read (item 5's invariant, exercised end to end, gh-1639 fix)", () => {
  const windows = buildWeekWindows(NOW, 12);
  const dayInLastWindow = "20260901";
  const earlierDay = "20260701";
  const result = buildAudienceVisitsSeries(
    {
      ok: true,
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE_1639,
      rows: [
        { date: dayInLastWindow, landingPage: "/get-started", sessions: 100 },
        { date: dayInLastWindow, landingPage: "/contractor-join", sessions: 50 },
        { date: earlierDay, landingPage: "/ref", sessions: 10 },
        { date: earlierDay, landingPage: "/some-future-page", sessions: 5 },
      ],
      site_rows: additiveSiteRows([
        { date: dayInLastWindow, landingPage: "/get-started", sessions: 100 },
        { date: dayInLastWindow, landingPage: "/contractor-join", sessions: 50 },
        { date: earlierDay, landingPage: "/ref", sessions: 10 },
        { date: earlierDay, landingPage: "/some-future-page", sessions: 5 },
      ]),
    },
    windows,
  );
  const siteTotal = 100 + 50 + 10 + 5;
  const bucketTotal = result.homeowner.total + result.contractor.total + result.referral_partner.total +
    result.unattributed.total;
  assertEquals(bucketTotal, siteTotal);
  // Never not_run when the invariant holds, and the payload says so with
  // the numbers it was checked against.
  for (const aud of ["homeowner", "contractor", "referral_partner", "unattributed"] as const) {
    assertEquals(result[aud].kind !== "not_run", true);
    assertEquals(result[aud].invariant.status, "passed");
    assertEquals(result[aud].invariant.rule, GA4_INVARIANT_TOLERANCE_RULE);
    assertEquals(result[aud].invariant.mismatches, []);
    assertEquals(result[aud].invariant.bucket_sum_values[11], 150);
    assertEquals(result[aud].invariant.site_total_values[11], 150);
  }
});

// --- gh-1639 fix: the NON-tautological invariant, negative controls --------
//
// The v13 defect, replayed as a fixture: the four buckets carry the measured
// pagePath-dimensioned totals (639/431/250/144 = 1,464 over 84 days) while
// the separate date-only read says 827. v13's invariant summed the same rows
// on both sides and passed; this one must fail closed.
Deno.test("buildAudienceVisitsSeries NEGATIVE CONTROL: a non-additive row set (v13's measured 1,464 pagePath buckets vs 827 site-wide) fails the invariant closed — all four not_run, invariant.status 'failed', reason names the window", () => {
  const windows = buildWeekWindows(NOW, 12);
  const result = buildAudienceVisitsSeries(
    {
      ok: true,
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE_1639,
      rows: [
        { date: "20260901", landingPage: "/", sessions: 639 },
        { date: "20260901", landingPage: "/recruit", sessions: 431 },
        { date: "20260901", landingPage: "/partners", sessions: 250 },
        { date: "20260901", landingPage: "/login", sessions: 144 },
      ],
      site_rows: [{ date: "20260901", sessions: 827 }],
    },
    windows,
  );
  for (const aud of ["homeowner", "contractor", "referral_partner", "unattributed"] as const) {
    assertEquals(result[aud].kind, "not_run");
    assertEquals(result[aud].total, 0);
    assertEquals(result[aud].invariant.status, "failed");
    assertEquals(result[aud].invariant.bucket_sum_values[11], 1464);
    assertEquals(result[aud].invariant.site_total_values[11], 827);
    assertEquals(result[aud].invariant.tolerance_values[11], 17); // ceil(0.02 * 827), no unresolved rows
    assertEquals(result[aud].invariant.mismatches.length, 1);
    assertEquals(String(result[aud].reason).includes("gh-1639 sum invariant failed"), true);
    assertEquals(String(result[aud].reason).includes("buckets sum to 1464"), true);
    assertEquals(String(result[aud].reason).includes("date-only site total is 827"), true);
    assertEquals(String(result[aud].reason).includes("window 11"), true);
  }
});

// The measured 2026-09-05 current-day shape: landingPage buckets 331 vs
// date-only 311 with 23 blank/"(not set)" landing rows. Within the declared
// tolerance (23 unresolved >= the 20 gap) -> passes, and the unresolved rows
// are unattributed, not dropped.
Deno.test("buildAudienceVisitsSeries: an intraday gap bounded by unresolved (blank / '(not set)') landing rows is within the declared tolerance — passes, unresolved rows counted as unattributed", () => {
  const windows = buildWeekWindows(NOW, 12);
  const result = buildAudienceVisitsSeries(
    {
      ok: true,
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE_1639,
      rows: [
        { date: "20260901", landingPage: "/", sessions: 200 },
        { date: "20260901", landingPage: "/recruit", sessions: 80 },
        { date: "20260901", landingPage: "/partners", sessions: 28 },
        { date: "20260901", landingPage: "(not set)", sessions: 13 },
        { date: "20260901", landingPage: "", sessions: 10 },
      ], // 331
      site_rows: [{ date: "20260901", sessions: 311 }],
    },
    windows,
  );
  assertEquals(result.homeowner.kind, "measured");
  assertEquals(result.homeowner.total, 200);
  assertEquals(result.unattributed.total, 23);
  assertEquals(result.homeowner.invariant.status, "passed");
  assertEquals(result.homeowner.invariant.bucket_sum_values[11], 331);
  assertEquals(result.homeowner.invariant.site_total_values[11], 311);
  assertEquals(result.homeowner.invariant.tolerance_values[11], 23); // max(23 unresolved, ceil(0.02*311)=7)
});

Deno.test("buildAudienceVisitsSeries NEGATIVE CONTROL: a gap LARGER than the unresolved rows and the 2% floor fails closed even when small in absolute terms", () => {
  const windows = buildWeekWindows(NOW, 12);
  const result = buildAudienceVisitsSeries(
    {
      ok: true,
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE_1639,
      rows: [
        { date: "20260901", landingPage: "/", sessions: 100 },
        { date: "20260901", landingPage: "(not set)", sessions: 2 },
      ], // 102 vs 90: gap 12 > max(2 unresolved, ceil(0.02*90)=2)
      site_rows: [{ date: "20260901", sessions: 90 }],
    },
    windows,
  );
  assertEquals(result.homeowner.kind, "not_run");
  assertEquals(result.homeowner.invariant.status, "failed");
  assertEquals(result.homeowner.invariant.tolerance_values[11], 2);
});

Deno.test("buildAudienceVisitsSeries: a window where the date-only read has sessions but the landingPage read has none fails closed (a short denominator is the conversion-inflating direction)", () => {
  const windows = buildWeekWindows(NOW, 12);
  const result = buildAudienceVisitsSeries(
    {
      ok: true,
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE_1639,
      rows: [{ date: "20260901", landingPage: "/", sessions: 100 }],
      site_rows: [
        { date: "20260901", sessions: 100 },
        { date: "20260701", sessions: 50 }, // an earlier window the buckets have nothing for
      ],
    },
    windows,
  );
  assertEquals(result.homeowner.kind, "not_run");
  assertEquals(result.homeowner.invariant.status, "failed");
  assertEquals(result.homeowner.invariant.mismatches.length, 1);
  assertEquals(result.homeowner.invariant.mismatches[0].includes("buckets sum to 0"), true);
});

Deno.test("buildAudienceVisitsSeries: a GA4 fetch failure carries invariant.status 'not_run' (the check never ran) — distinct from 'failed'", () => {
  const windows = buildWeekWindows(NOW, 12);
  const result = buildAudienceVisitsSeries(
    { ok: false, reason: "GA4 Data API returned HTTP 500 (site-total read)", property_id: "541423859", hosts: GA4_HOSTS_FIXTURE_1639 },
    windows,
  );
  assertEquals(result.contractor.invariant.status, "not_run");
  assertEquals(result.contractor.invariant.rule, GA4_INVARIANT_TOLERANCE_RULE);
});

Deno.test("buildAudienceVisitsSeries: an audience with zero rows this window is a real measured_zero, not not_run and not dropped", () => {
  const windows = buildWeekWindows(NOW, 12);
  const result = buildAudienceVisitsSeries(
    {
      ok: true,
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE_1639,
      rows: [{ date: "20260901", landingPage: "/get-started", sessions: 10 }], // homeowner only
      site_rows: additiveSiteRows([{ date: "20260901", landingPage: "/get-started", sessions: 10 }]),
    },
    windows,
  );
  assertEquals(result.contractor.kind, "measured_zero");
  assertEquals(result.contractor.total, 0);
  assertEquals(result.referral_partner.kind, "measured_zero");
  assertEquals(result.unattributed.kind, "measured_zero");
});

Deno.test("buildAudienceVisitsSeries: multiple landingPages in the same audience in the same week accumulate rather than overwrite", () => {
  const windows = buildWeekWindows(NOW, 12);
  const result = buildAudienceVisitsSeries(
    {
      ok: true,
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE_1639,
      rows: [
        { date: "20260901", landingPage: "/get-started", sessions: 100 },
        { date: "20260901", landingPage: "/claim", sessions: 20 }, // also homeowner
        { date: "20260901", landingPage: "/blog/roofing", sessions: 5 }, // also homeowner (prefix)
      ],
      site_rows: additiveSiteRows([
        { date: "20260901", landingPage: "/get-started", sessions: 100 },
        { date: "20260901", landingPage: "/claim", sessions: 20 }, // also homeowner
        { date: "20260901", landingPage: "/blog/roofing", sessions: 5 }, // also homeowner (prefix)
      ]),
    },
    windows,
  );
  assertEquals(result.homeowner.total, 125);
});

// gh-1639 fix (fresh-context refuter comment 5548057089, PR #1674): the raw
// GA4 landingPage (then pagePath) for the /guides and /blog section-index pages themselves
// (not a sub-page under them) is exactly "/guides/" / "/blog/" — with the
// trailing slash, since that IS the real page. Before this fix,
// normalizePagePath stripped that slash to "/guides"/"/blog" and
// bucketPagePath's slash-terminated prefix rule then failed to match,
// silently routing every such visit to unattributed instead of homeowner.
// This end-to-end (real GA4 rows -> buildAudienceVisitsSeries, not
// bucketPagePath called directly) mirrors the review's synthetic
// 40+25-session repro that found the defect.
Deno.test("buildAudienceVisitsSeries: /guides/ and /blog/ section-index visits (bare, trailing slash) count as homeowner, not unattributed", () => {
  const windows = buildWeekWindows(NOW, 12);
  const result = buildAudienceVisitsSeries(
    {
      ok: true,
      property_id: "541423859",
      hosts: GA4_HOSTS_FIXTURE_1639,
      rows: [
        { date: "20260901", landingPage: "/guides/", sessions: 40 },
        { date: "20260901", landingPage: "/blog/", sessions: 25 },
      ],
      site_rows: additiveSiteRows([
        { date: "20260901", landingPage: "/guides/", sessions: 40 },
        { date: "20260901", landingPage: "/blog/", sessions: 25 },
      ]),
    },
    windows,
  );
  assertEquals(result.homeowner.total, 65);
  assertEquals(result.unattributed.total, 0);
});
