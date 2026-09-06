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
  AUDIENCE_PREFIX_NOTE,
  buildDimensionFilter,
  buildRunReportRequestBody,
  buildSiteTotalRequestBody,
  bucketPagePath,
  GA4_PRODUCTION_HOSTS,
  isUnresolvedLandingPage,
  normalizePagePath,
  parseServiceAccountEnv,
  parseSessionsByDayResponse,
  parseSiteTotalResponse,
  GA4_DATACENTER_CITIES,
  GA4_EXCLUDED_SOURCE_SUBSTRINGS,
  GA4_EXCLUDED_SOURCES_EXACT,
  GA4_EXCLUSIONS,
} from "./ga4.ts";

// --- parseSessionsByDayResponse -------------------------------------------
//
// gh-1639: the request's dimensions are now [date, landingPage] (the gh-1639
// fix moved from pagePath — sessions are not additive across it), so every
// fixture below carries a second dimensionValues entry and the parsed rows
// carry a (normalised) `landingPage` field.

Deno.test("parseSessionsByDayResponse: extracts { date, landingPage, sessions } from a realistic stubbed GA4 runReport body", () => {
  // Shape matches what GA4 Data API's runReport actually returns for
  // dimensions: [{name:"date"},{name:"landingPage"}], metrics: [{name:"sessions"}]
  // — one row per (day, landingPage) pair, dimensionValues in request order.
  const fixture = {
    rows: [
      { dimensionValues: [{ value: "20260830" }, { value: "/get-started" }], metricValues: [{ value: "412" }] },
      { dimensionValues: [{ value: "20260831" }, { value: "/contractor-join" }], metricValues: [{ value: "398" }] },
      { dimensionValues: [{ value: "20260901" }, { value: "/ref" }], metricValues: [{ value: "421" }] },
    ],
    rowCount: 3,
  };
  const rows = parseSessionsByDayResponse(fixture);
  assertEquals(rows, [
    { date: "20260830", landingPage: "/get-started", sessions: 412 },
    { date: "20260831", landingPage: "/contractor-join", sessions: 398 },
    { date: "20260901", landingPage: "/ref", sessions: 421 },
  ]);
});

Deno.test("parseSessionsByDayResponse: the landingPage dimension value is normalised before it is attached to the row", () => {
  const fixture = {
    rows: [
      { dimensionValues: [{ value: "20260901" }, { value: "/get-started.html" }], metricValues: [{ value: "33" }] },
      { dimensionValues: [{ value: "20260901" }, { value: "/get-started" }], metricValues: [{ value: "557" }] },
    ],
  };
  const rows = parseSessionsByDayResponse(fixture);
  assertEquals(rows.map((r) => r.landingPage), ["/get-started", "/get-started"]);
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
      { dimensionValues: [{ value: "not-a-date" }, { value: "/get-started" }], metricValues: [{ value: "10" }] },
      { dimensionValues: [{ value: "2026090" }, { value: "/get-started" }], metricValues: [{ value: "10" }] }, // 7 digits
      { dimensionValues: [{}, { value: "/get-started" }], metricValues: [{ value: "10" }] }, // missing value
      { dimensionValues: [{ value: "20260901" }, { value: "/get-started" }], metricValues: [{ value: "5" }] }, // the one good row
    ],
  };
  const rows = parseSessionsByDayResponse(fixture);
  assertEquals(rows, [{ date: "20260901", landingPage: "/get-started", sessions: 5 }]);
});

Deno.test("parseSessionsByDayResponse: a missing landingPage dimension value normalises to empty, not root — never silently attributed to homeowner's exact '/' rule", () => {
  const fixture = { rows: [{ dimensionValues: [{ value: "20260901" }], metricValues: [{ value: "5" }] }] };
  const rows = parseSessionsByDayResponse(fixture);
  assertEquals(rows, [{ date: "20260901", landingPage: "", sessions: 5 }]);
  assertEquals(bucketPagePath(rows[0].landingPage), "unattributed");
});

Deno.test("parseSessionsByDayResponse: GA4's '(not set)' landingPage survives normalisation verbatim and buckets to unattributed (gh-1639 fix — the unresolved-entry-page sentinel, 23 rows/84 d live)", () => {
  const fixture = {
    rows: [
      { dimensionValues: [{ value: "20260904" }, { value: "(not set)" }], metricValues: [{ value: "23" }] },
      { dimensionValues: [{ value: "20260904" }, { value: "" }], metricValues: [{ value: "23" }] },
    ],
  };
  const rows = parseSessionsByDayResponse(fixture);
  assertEquals(rows.map((r) => r.landingPage), ["(not set)", ""]);
  for (const r of rows) {
    assertEquals(bucketPagePath(r.landingPage), "unattributed");
    assertEquals(isUnresolvedLandingPage(r.landingPage), true);
  }
});

Deno.test("isUnresolvedLandingPage: only blank and '(not set)' — a real path, the root, and a table miss are all resolved entry pages", () => {
  assertEquals(isUnresolvedLandingPage(""), true);
  assertEquals(isUnresolvedLandingPage("(not set)"), true);
  assertEquals(isUnresolvedLandingPage("/"), false);
  assertEquals(isUnresolvedLandingPage("/login"), false);
  assertEquals(isUnresolvedLandingPage("/get-started"), false);
});

Deno.test("parseSessionsByDayResponse: a missing sessions value defaults to a real measured 0 for that day, not a dropped row", () => {
  const fixture = { rows: [{ dimensionValues: [{ value: "20260901" }, { value: "/get-started" }], metricValues: [{}] }] };
  const rows = parseSessionsByDayResponse(fixture);
  assertEquals(rows, [{ date: "20260901", landingPage: "/get-started", sessions: 0 }]);
});

// --- parseSiteTotalResponse (gh-1639 fix: the [date]-only reference read) --

Deno.test("parseSiteTotalResponse: extracts { date, sessions } from a [date]-only runReport body — no landingPage, no bucketing", () => {
  const fixture = {
    rows: [
      { dimensionValues: [{ value: "20260830" }], metricValues: [{ value: "63" }] },
      { dimensionValues: [{ value: "20260831" }], metricValues: [{ value: "72" }] },
    ],
  };
  assertEquals(parseSiteTotalResponse(fixture), [
    { date: "20260830", sessions: 63 },
    { date: "20260831", sessions: 72 },
  ]);
});

Deno.test("parseSiteTotalResponse: malformed dates are dropped, missing sessions is 0, null/empty input is no rows", () => {
  const fixture = {
    rows: [
      { dimensionValues: [{ value: "nope" }], metricValues: [{ value: "9" }] },
      { dimensionValues: [{ value: "20260901" }], metricValues: [{}] },
    ],
  };
  assertEquals(parseSiteTotalResponse(fixture), [{ date: "20260901", sessions: 0 }]);
  assertEquals(parseSiteTotalResponse(null), []);
  assertEquals(parseSiteTotalResponse({ rowCount: 0 }), []);
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

Deno.test("buildRunReportRequestBody: the body handed to fetch carries a hostName dimensionFilter for all three production hosts (gh-1637) AND a landingPage dimension alongside date (gh-1639 fix)", () => {
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
    dimensions: [{ name: "date" }, { name: "landingPage" }],
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
  dimensions: Array<{ name: string }>;
  dimensionFilter: {
    andGroup: {
      expressions: Array<{
        filter?: { fieldName: string; inListFilter?: { values: string[] } };
        notExpression?: { filter: { fieldName: string; inListFilter?: { values: string[] }; stringFilter?: { value: string } } };
      }>;
    };
  };
};

Deno.test("buildRunReportRequestBody: landingPage is a DIMENSION only, not folded into the andGroup filter (gh-1639 — 'do not filter paths out; bucket them' — survives gh-1649's andGroup rewrite)", () => {
  const body = buildRunReportRequestBody("84daysAgo", "today") as AndGroupBody;
  assertEquals(body.dimensions, [{ name: "date" }, { name: "landingPage" }]);
  const fieldNames = body.dimensionFilter.andGroup.expressions.map(
    (e) => e.filter?.fieldName ?? e.notExpression?.filter.fieldName,
  );
  assertEquals(fieldNames.includes("landingPage"), false);
  assertEquals(fieldNames.includes("pagePath"), false);
});

// gh-1639 fix: the bucket read must NEVER be dimensioned by pagePath again —
// GA4 `sessions` is counted once per page viewed under that dimension
// (measured 1,464 vs 827 site-wide over 84 days, v13). Pinned by name so a
// "helpful" revert shows up as a red test, not a +77% denominator.
Deno.test("buildRunReportRequestBody: the bucket dimension is landingPage, never pagePath (gh-1639 fix — sessions are non-additive across pagePath, 1.77x measured)", () => {
  const body = buildRunReportRequestBody("84daysAgo", "today") as AndGroupBody;
  assertEquals(body.dimensions.map((d) => d.name).includes("pagePath"), false);
  assertEquals(body.dimensions.map((d) => d.name), ["date", "landingPage"]);
});

// gh-1639 fix: the site-total read the sum invariant compares against.
Deno.test("buildSiteTotalRequestBody: [date] as the ONLY dimension, same metric, same range — the reference total the landingPage buckets are checked against", () => {
  const body = buildSiteTotalRequestBody("90daysAgo", "today") as AndGroupBody & { dateRanges: unknown; metrics: unknown };
  assertEquals(body.dimensions, [{ name: "date" }]);
  assertEquals(body.dateRanges, [{ startDate: "90daysAgo", endDate: "today" }]);
  assertEquals(body.metrics, [{ name: "sessions" }]);
});

Deno.test("buildSiteTotalRequestBody and buildRunReportRequestBody: identical serialised dimensionFilter (the #1666 andGroup, byte-for-byte on the wire) — the two reads differ in `dimensions` and nothing else", () => {
  const bucket = JSON.parse(JSON.stringify(buildRunReportRequestBody("84daysAgo", "today")));
  const site = JSON.parse(JSON.stringify(buildSiteTotalRequestBody("84daysAgo", "today")));
  assertEquals(JSON.stringify(bucket.dimensionFilter), JSON.stringify(site.dimensionFilter));
  assertEquals(JSON.stringify(bucket.dimensionFilter), JSON.stringify(JSON.parse(JSON.stringify(buildDimensionFilter()))));
  const { dimensions: _bd, ...bucketRest } = bucket;
  const { dimensions: _sd, ...siteRest } = site;
  assertEquals(bucketRest, siteRest);
  assertEquals(bucket.dimensionFilter.andGroup.expressions.length, 4);
});

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

// --- gh-1639 (#1340 phase 5c): normalizePagePath ---------------------------

Deno.test("normalizePagePath: strips a trailing .html — /get-started.html and /get-started must bucket identically (production over 84 days: 557 vs 33 unnormalised)", () => {
  assertEquals(normalizePagePath("/get-started.html"), "/get-started");
  assertEquals(normalizePagePath("/get-started"), "/get-started");
});

Deno.test("normalizePagePath: strips a trailing slash, except the bare root", () => {
  assertEquals(normalizePagePath("/get-started/"), "/get-started");
  assertEquals(normalizePagePath("/"), "/");
});

Deno.test("normalizePagePath: strips a query string and a fragment, together or separately", () => {
  assertEquals(normalizePagePath("/get-started?utm_source=x"), "/get-started");
  assertEquals(normalizePagePath("/get-started#pricing"), "/get-started");
  assertEquals(normalizePagePath("/get-started.html?utm_source=x#pricing"), "/get-started");
});

Deno.test("normalizePagePath: /recruit and /recruit.html normalise to the same key (production over 84 days: 47 vs 122 unnormalised)", () => {
  assertEquals(normalizePagePath("/recruit"), normalizePagePath("/recruit.html"));
  assertEquals(normalizePagePath("/recruit.html"), "/recruit");
});

Deno.test("normalizePagePath: /contractor-join and /contractor-join.html normalise to the same key (production over 84 days: 12 vs 16 unnormalised)", () => {
  assertEquals(normalizePagePath("/contractor-join"), normalizePagePath("/contractor-join.html"));
  assertEquals(normalizePagePath("/contractor-join.html"), "/contractor-join");
});

Deno.test("normalizePagePath: a trailing slash AFTER .html is stripped too (repeats until stable)", () => {
  assertEquals(normalizePagePath("/get-started.html/"), "/get-started");
});

Deno.test("normalizePagePath: an empty/missing value normalises to empty, not root", () => {
  assertEquals(normalizePagePath(""), "");
});

// --- gh-1639: bucketPagePath — the CTO's prefix table (a ruling, not an
// inference target: do not extend it) ---------------------------------------

Deno.test("bucketPagePath: homeowner's exact-match paths", () => {
  for (
    const p of [
      "/",
      "/index",
      "/get-started",
      "/trade-selector",
      "/dashboard",
      "/bids",
      "/claim",
      "/contract-signing",
      "/faq",
    ]
  ) {
    assertEquals(bucketPagePath(p), "homeowner", `expected ${p} -> homeowner`);
  }
});

Deno.test("bucketPagePath: homeowner's prefix paths (/guides/, /blog/)", () => {
  assertEquals(bucketPagePath("/guides/roofing-101"), "homeowner");
  assertEquals(bucketPagePath("/blog/2026-08-launch"), "homeowner");
});

// gh-1639 fix (fresh-context refuter comment 5548057089, PR #1674):
// /guides/ and /blog/ are section-index pages that GA4 records with a
// trailing slash — normalizePagePath strips that slash before
// bucketPagePath ever sees the value, so composing the two functions (the
// real production pipeline, not calling bucketPagePath directly with a
// sub-path already present) is the only way this regression is caught.
Deno.test("bucketPagePath(normalizePagePath(...)): /guides and /blog section-index paths bucket to homeowner after trailing-slash normalisation", () => {
  assertEquals(bucketPagePath(normalizePagePath("/guides/")), "homeowner");
  assertEquals(bucketPagePath(normalizePagePath("/guides")), "homeowner");
  assertEquals(bucketPagePath(normalizePagePath("/guides/foo.html")), "homeowner");
  assertEquals(bucketPagePath(normalizePagePath("/blog/")), "homeowner");
  assertEquals(bucketPagePath(normalizePagePath("/blog/post")), "homeowner");
});

Deno.test("bucketPagePath: /guidesfoo and /blogger are NOT caught by the /guides//blog/ slash-terminated prefixes (negative — a bare startsWith would wrongly match these)", () => {
  assertEquals(bucketPagePath(normalizePagePath("/guidesfoo")), "unattributed");
  assertEquals(bucketPagePath(normalizePagePath("/blogger")), "unattributed");
});

Deno.test("bucketPagePath: contractor's prefix paths (/contractor, /tools incl. /tools-crm, /recruit)", () => {
  assertEquals(bucketPagePath("/contractor"), "contractor");
  assertEquals(bucketPagePath("/contractor-join"), "contractor");
  assertEquals(bucketPagePath("/tools"), "contractor");
  assertEquals(bucketPagePath("/tools-crm"), "contractor");
  assertEquals(bucketPagePath("/recruit"), "contractor");
});

Deno.test("bucketPagePath: referral_partner — /partner prefix, /ref and /ref-re exact", () => {
  assertEquals(bucketPagePath("/partner"), "referral_partner");
  assertEquals(bucketPagePath("/partner-dashboard"), "referral_partner");
  assertEquals(bucketPagePath("/ref"), "referral_partner");
  assertEquals(bucketPagePath("/ref-re"), "referral_partner");
});

Deno.test("bucketPagePath: anything not in the table is unattributed, never inferred onto the nearest-looking bucket", () => {
  for (const p of ["/login", "/auth-callback", "/terms", "/some-future-page-not-in-the-table"]) {
    assertEquals(bucketPagePath(p), "unattributed", `expected ${p} -> unattributed`);
  }
});

// --- gh-1639 ordering hazard 1 (issue item 3): "/ref" as an EXACT match
// must be tested before any prefix rule, or it will be swallowed by a
// /re*-shaped prefix (the closest real one is /recruit, a contractor
// PREFIX rule) ----------------------------------------------------------

Deno.test("bucketPagePath ordering hazard 1: /ref (exact, referral_partner) is not swallowed by /recruit (prefix, contractor) despite sharing the 're' start", () => {
  assertEquals(bucketPagePath("/ref"), "referral_partner");
  assertEquals(bucketPagePath("/recruit"), "contractor");
  assertEquals(bucketPagePath("/ref-re"), "referral_partner");
});

// --- gh-1639 ordering hazard 2 (issue item 3): "/contractor…" must be
// tested before "/contract-signing" is (mis)treated as a broadened prefix —
// this is production's own motivating example (26 pageviews/12 sessions in
// 28 days on /contractor-join.html) ---------------------------------------

Deno.test("bucketPagePath ordering hazard 2: /contractor-join resolves via the /contractor PREFIX rule and is never caught by a broadened /contract-signing-shaped rule", () => {
  assertEquals(bucketPagePath("/contractor-join"), "contractor");
  assertEquals(bucketPagePath(normalizePagePath("/contractor-join.html")), "contractor");
  assertEquals(bucketPagePath("/contract-signing"), "homeowner");
});

// --- gh-1639 item 7: AUDIENCE_PREFIX_NOTE is the single source for the
// per-audience payload `note` and the page's scope-line text ---------------

Deno.test("AUDIENCE_PREFIX_NOTE: every note declares the denominator as landingPage-bucketed, never pagePath-bucketed (gh-1639 fix, brief item 5)", () => {
  for (const aud of ["homeowner", "contractor", "referral_partner", "unattributed"] as const) {
    assertEquals(AUDIENCE_PREFIX_NOTE[aud].includes("bucketed by landingPage"), true);
    assertEquals(AUDIENCE_PREFIX_NOTE[aud].includes("Counts pagePath"), false);
  }
  assertEquals(AUDIENCE_PREFIX_NOTE.unattributed.includes("(not set)"), true);
});

Deno.test("AUDIENCE_PREFIX_NOTE: every audience (including unattributed) has a non-empty note naming what it counts", () => {
  for (const aud of ["homeowner", "contractor", "referral_partner", "unattributed"] as const) {
    const note = AUDIENCE_PREFIX_NOTE[aud];
    assertEquals(typeof note, "string");
    assertEquals(note.length > 0, true);
  }
});
