// get-business-lines-dashboard/ga4.test.ts
//
// gh-1574 (#1340 phase 5) — pure-unit tests for ga4.ts.
//
// Unlike index.ts (a single-file EF with no exports, hence marketing-series
// .test.ts's source-extraction trick), ga4.ts is a real module with real
// exports, so it's imported directly here — no data: URL indirection needed.
//
// Deliberately does NOT exercise fetchGa4SessionsByDay's network path
// (mintAccessToken, the runReport fetch) — same "pure part only, no live
// credentials or network" boundary ga4-report/index.test.ts already draws
// for its (near-identical) mirrored implementation. What IS covered: the
// response-parsing logic new to this issue (parseSessionsByDayResponse,
// exercised against a stubbed GA4 runReport response fixture, per the work
// order) and the service-account config check (parseServiceAccountEnv).
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildRunReportRequestBody,
  GA4_PRODUCTION_HOSTS,
  parseServiceAccountEnv,
  parseSessionsByDayResponse,
  GA4_DATACENTER_CITIES,
  GA4_EXCLUDED_SOURCE_SUBSTRINGS,
  GA4_EXCLUDED_SOURCES_EXACT,
  GA4_EXCLUSIONS,
} from "./ga4.ts";

// --- parseSessionsByDayResponse -------------------------------------------

Deno.test("parseSessionsByDayResponse: extracts { date, sessions } from a realistic stubbed GA4 runReport body", () => {
  // Shape matches what GA4 Data API's runReport actually returns for
  // dimensions: [{name:"date"}], metrics: [{name:"sessions"}] — one row per
  // day, dimensionValues[0] and metricValues[0] in request order.
  const fixture = {
    rows: [
      { dimensionValues: [{ value: "20260830" }], metricValues: [{ value: "412" }] },
      { dimensionValues: [{ value: "20260831" }], metricValues: [{ value: "398" }] },
      { dimensionValues: [{ value: "20260901" }], metricValues: [{ value: "421" }] },
    ],
    rowCount: 3,
  };
  const rows = parseSessionsByDayResponse(fixture);
  assertEquals(rows, [
    { date: "20260830", sessions: 412 },
    { date: "20260831", sessions: 398 },
    { date: "20260901", sessions: 421 },
  ]);
});

Deno.test("parseSessionsByDayResponse: a property with zero traffic in range returns an empty array, not an error", () => {
  // GA4 omits `rows` entirely (not an empty array) when nothing matched —
  // same "no rows key" shape ga4-report's own rows_returned handling
  // (report?.rows?.length ?? 0) already accounts for.
  const rows = parseSessionsByDayResponse({ rowCount: 0 });
  assertEquals(rows, []);
});

Deno.test("parseSessionsByDayResponse: rows with a malformed date dimension are dropped, not mis-bucketed", () => {
  const fixture = {
    rows: [
      { dimensionValues: [{ value: "not-a-date" }], metricValues: [{ value: "10" }] },
      { dimensionValues: [{ value: "2026090" }], metricValues: [{ value: "10" }] }, // 7 digits
      { dimensionValues: [{}], metricValues: [{ value: "10" }] }, // missing value
      { dimensionValues: [{ value: "20260901" }], metricValues: [{ value: "5" }] }, // the one good row
    ],
  };
  const rows = parseSessionsByDayResponse(fixture);
  assertEquals(rows, [{ date: "20260901", sessions: 5 }]);
});

Deno.test("parseSessionsByDayResponse: a missing sessions value defaults to a real measured 0 for that day, not a dropped row", () => {
  const fixture = { rows: [{ dimensionValues: [{ value: "20260901" }], metricValues: [{}] }] };
  const rows = parseSessionsByDayResponse(fixture);
  assertEquals(rows, [{ date: "20260901", sessions: 0 }]);
});

Deno.test("parseSessionsByDayResponse: null/undefined input is treated as no rows, not a throw", () => {
  assertEquals(parseSessionsByDayResponse(null), []);
  assertEquals(parseSessionsByDayResponse(undefined), []);
  assertEquals(parseSessionsByDayResponse({}), []);
});

// --- parseServiceAccountEnv ------------------------------------------------

Deno.test("parseServiceAccountEnv: empty string is unconfigured (null), the fail-loud trigger for not_run", () => {
  assertEquals(parseServiceAccountEnv(""), null);
  assertEquals(parseServiceAccountEnv("   "), null);
});

Deno.test("parseServiceAccountEnv: invalid JSON is unconfigured (null), not a thrown parse error", () => {
  assertEquals(parseServiceAccountEnv("{not valid json"), null);
});

Deno.test("parseServiceAccountEnv: JSON missing client_email or private_key is unconfigured (null)", () => {
  assertEquals(parseServiceAccountEnv('{"client_email":"x@y.iam.gserviceaccount.com"}'), null);
  assertEquals(parseServiceAccountEnv('{"private_key":"NOT-A-REAL-KEY"}'), null);
});

Deno.test("parseServiceAccountEnv: a complete service account parses cleanly (synthetic key material only)", () => {
  const sa = parseServiceAccountEnv(
    '{"client_email":"otterquote-ga4-reader@otterquote-analytics.iam.gserviceaccount.com","private_key":"NOT-A-REAL-KEY"}',
  );
  assertEquals(sa?.client_email, "otterquote-ga4-reader@otterquote-analytics.iam.gserviceaccount.com");
  assertEquals(sa?.private_key, "NOT-A-REAL-KEY");
});

// --- gh-1637: hostName dimensionFilter -------------------------------------
//
// fetchGa4SessionsByDay's network path (mintAccessToken, the runReport
// fetch) is deliberately not exercised here — same boundary as the rest of
// this file. buildRunReportRequestBody is the pure function
// fetchGa4SessionsByDay actually calls to build the object it JSON.stringifies
// into fetch's `body`, so asserting on ITS return value is asserting on the
// real serialised request body, not a separately-checked constant a future
// refactor could drop without failing this test (work order clause 7).

Deno.test("buildRunReportRequestBody: the body handed to fetch carries a hostName dimensionFilter for all three production hosts (gh-1637)", () => {
  const body = buildRunReportRequestBody("84daysAgo", "today");
  // Round-trip through JSON exactly like fetch's `body: JSON.stringify(...)`
  // does, so this asserts on the actual serialised shape sent over the wire.
  const serialised = JSON.parse(JSON.stringify(body));
  // gh-1649: the host allow-list is now the FIRST expression of an andGroup
  // that also carries the three bot-exclusion rules. The exact wire shape is
  // pinned here because a future "simplification" back to a bare filter
  // would silently re-admit ~60% robots to every rate on the dashboard.
  assertEquals(serialised, {
    dateRanges: [{ startDate: "84daysAgo", endDate: "today" }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: {
      andGroup: {
        expressions: [
          {
            filter: {
              fieldName: "hostName",
              inListFilter: {
                values: ["otterquote.com", "www.otterquote.com", "app.otterquote.com"],
              },
            },
          },
          {
            notExpression: {
              filter: {
                fieldName: "sessionSource",
                stringFilter: { matchType: "CONTAINS", value: "netlify.app", caseSensitive: false },
              },
            },
          },
          {
            notExpression: {
              filter: {
                fieldName: "sessionSource",
                stringFilter: { matchType: "EXACT", value: "accounts.google.com" },
              },
            },
          },
          {
            notExpression: {
              filter: {
                fieldName: "city",
                inListFilter: {
                  values: [
                    "Glenview",
                    "Council Bluffs",
                    "Boardman",
                    "Flint Hill",
                    "San Jose",
                    "Des Moines",
                    "Phoenix",
                    "Moses Lake",
                    "Cheyenne",
                    "Boydton",
                    "Prague",
                  ],
                },
              },
            },
          },
        ],
      },
    },
  });
});

type AndGroupBody = {
  dimensionFilter: {
    andGroup: {
      expressions: Array<{
        filter?: { fieldName: string; inListFilter?: { values: string[] } };
        notExpression?: { filter: { fieldName: string; inListFilter?: { values: string[] }; stringFilter?: { value: string } } };
      }>;
    };
  };
};

Deno.test("buildRunReportRequestBody: the filter's host list is GA4_PRODUCTION_HOSTS itself, not a hand-copied duplicate", () => {
  const body = buildRunReportRequestBody("90daysAgo", "today") as AndGroupBody;
  assertEquals(body.dimensionFilter.andGroup.expressions[0].filter?.inListFilter?.values, GA4_PRODUCTION_HOSTS);
});

// --- gh-1649: bot exclusion rules ----------------------------------------

Deno.test("buildRunReportRequestBody: the city exclusion is GA4_DATACENTER_CITIES itself and every source exclusion is a notExpression on sessionSource (gh-1649)", () => {
  const body = buildRunReportRequestBody("28daysAgo", "yesterday") as AndGroupBody;
  const nots = body.dimensionFilter.andGroup.expressions.filter((e) => e.notExpression);
  const cityRule = nots.find((e) => e.notExpression?.filter.fieldName === "city");
  assertEquals(cityRule?.notExpression?.filter.inListFilter?.values, GA4_DATACENTER_CITIES);
  const sourceValues = nots
    .filter((e) => e.notExpression?.filter.fieldName === "sessionSource")
    .map((e) => e.notExpression?.filter.stringFilter?.value);
  assertEquals(sourceValues, [...GA4_EXCLUDED_SOURCE_SUBSTRINGS, ...GA4_EXCLUDED_SOURCES_EXACT]);
});

Deno.test("GA4_EXCLUSIONS: the payload-facing declaration is built from the same constants the wire filter uses, and names its residual (gh-1649)", () => {
  assertEquals(GA4_EXCLUSIONS.source_substrings, GA4_EXCLUDED_SOURCE_SUBSTRINGS);
  assertEquals(GA4_EXCLUSIONS.sources_exact, GA4_EXCLUDED_SOURCES_EXACT);
  assertEquals(GA4_EXCLUSIONS.cities, GA4_DATACENTER_CITIES);
  assertEquals(GA4_EXCLUSIONS.residual.includes("heuristic"), true);
  assertEquals(GA4_EXCLUSIONS.residual.includes("(not set)"), true);
});

Deno.test("GA4_PRODUCTION_HOSTS: is exactly the three production hosts named in the issue, www included though it reports zero sessions today", () => {
  assertEquals(GA4_PRODUCTION_HOSTS, ["otterquote.com", "www.otterquote.com", "app.otterquote.com"]);
});

// resolveGa4PropertyId() itself is NOT unit-tested here: it reads
// Deno.env.get, and this repo's CI runs `deno test` with ZERO permission
// flags beyond --allow-read (see e2e-tests.yml's "gh-422" comment) so that
// any test needing a secret or env access fails loudly instead of silently
// widening the CI grant. resolveGa4PropertyId is exercised indirectly via
// fetchGa4SessionsByDay in production; its "same resolution" contract with
// the payload's visits.property_id is what buildVisitsSeries's tests in
// marketing-series.test.ts (gh-1637) actually cover.
