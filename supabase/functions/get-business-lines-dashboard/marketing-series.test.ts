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

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

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
  ga4DateToIso,
  sumByWeek,
  buildVisitsSeries,
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
      rows: [{ date: dayInLastWindow, sessions: 421 }],
    },
    windows,
  );
  assertEquals(series.kind, "measured");
  assertEquals(series.unit, "sessions");
  assertEquals(series.total, 421);
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
      exclusions: GA4_EXCLUSIONS_FIXTURE, rows: [] },
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
      rows: [
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
      exclusions: GA4_EXCLUSIONS_FIXTURE, rows: [{ date: "20260901", sessions: 10 }] },
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
