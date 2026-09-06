// ga4-report/ga4-filter.ts
//
// gh-1649 (REFUTED-REOPENED, refuter comment 5549725214): the closing clause
// names TWO functions — "`ga4-report` / `get-business-lines-dashboard` carry a
// `notExpression` on the datacenter city set alongside the `hostName` filter"
// — and ga4-report was still sending a bare { dateRanges, metrics } body: no
// hostName filter (#1637), no bot/datacenter exclusions (#1666). Measured
// 2026-09-05 over the function's own 84-day span: 29,113 unfiltered sessions
// vs 831 with the deployed andGroup — a 35x denominator on the funnel path.
//
// WHY A COPY AND NOT AN IMPORT: `_shared/` (and any other cross-directory)
// imports do NOT resolve at Supabase Edge Function deploy time — see the
// ADMIN_EMAILS comment in index.ts and the file header of
// get-business-lines-dashboard/ga4.ts. The house pattern is a module
// CO-LOCATED in the calling function's directory, imported by a
// same-directory relative path. So the constants and buildDimensionFilter()
// below are copied VERBATIM from get-business-lines-dashboard/ga4.ts, and
// ga4-filter.test.ts asserts that (a) the serialised filter both modules
// produce is byte-equal and (b) the `export function buildDimensionFilter`
// source text is byte-equal — so the two cannot drift without a red test.
// Edit the dashboard's ga4.ts first, then mirror the change here.
//
// GitHub: #1649, #1637, #1666, #1331

// gh-1637: the production host allow-list for the `hostName` dimensionFilter
// on every GA4 request this client makes. Exported so index.ts's payload can
// declare exactly what it counted (visits.hosts) rather than restating this
// list by hand — see the work order's pinned payload-key contract.
export const GA4_PRODUCTION_HOSTS: string[] = [
  "otterquote.com",
  "www.otterquote.com",
  "app.otterquote.com",
];

// gh-1649: hostname filtering is not bot filtering. Measured 2026-09-04 on
// the production hosts, 28 days, property 541423859 (CRO, device shell,
// Data API): 1,255 sessions survived the hostName filter and roughly 60% of
// them were our own robots or datacenter one-hit traffic. Three exclusion
// rules, in order of certainty, all applied on the wire alongside the host
// allow-list so EVERY consumer of this client gets the same denominator:
//
//  1. sessionSource CONTAINS "netlify.app" — a session whose referrer is our
//     own staging/branch-deploy host is our own E2E/CI robot stepping from
//     staging onto production (259 sessions / 28 d, 0 engaged, 0.02 s
//     average, one session per user). Deterministic; #1619 does NOT remove
//     these because the session is measured on the production host.
//  2. sessionSource EXACT "accounts.google.com" — an OAuth round-trip is a
//     login redirect, never an arrival (73 sessions from 4 users / 28 d).
//     Deterministic.
//  3. city NOT IN GA4_DATACENTER_CITIES — HEURISTIC. Every city below showed
//     the datacenter signature on 2026-09-04: sessions == totalUsers, average
//     session duration under 10 s, at least 10 sessions / 28 d. Glenview is
//     96% of "bing / organic" landing on noindexed /recruit.html; Council
//     Bluffs is GCP us-central1; Boardman is AWS us-west-2; the rest are
//     Azure regions (GitHub Actions runners). A real person in one of these
//     cities is excluded too — that is the accepted cost, and it is declared
//     in the payload (visits.exclusions) so no reader mistakes the heuristic
//     for a truth.
//
// What is NOT excluded, and is declared as the residual: the `(not set)` city
// bucket (~170 sessions / 28 d, one session per user, ~7 s average) cannot be
// classified either way and stays in. Dustin's own Zionsville/Indianapolis
// sessions are a GA4 admin internal-traffic filter (his action), not code.
//
// Effect of the three rules on 2026-09-04, same window: 1,255 -> 474 sessions.
//
// GitHub: #1649, #1619, #1637, #1638
export const GA4_EXCLUDED_SOURCE_SUBSTRINGS: string[] = ["netlify.app"];
export const GA4_EXCLUDED_SOURCES_EXACT: string[] = ["accounts.google.com"];
export const GA4_DATACENTER_CITIES: string[] = [
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
];

// gh-1649: what the wire filter excludes, in the shape index.ts publishes as
// `visits.exclusions` so #1638's page can render it instead of restating it.
export interface Ga4Exclusions {
  source_substrings: string[];
  sources_exact: string[];
  cities: string[];
  residual: string;
}

export const GA4_EXCLUSIONS: Ga4Exclusions = {
  source_substrings: GA4_EXCLUDED_SOURCE_SUBSTRINGS,
  sources_exact: GA4_EXCLUDED_SOURCES_EXACT,
  cities: GA4_DATACENTER_CITIES,
  residual:
    "City exclusion is a heuristic (sessions = users, <10 s average, >=10 sessions/28 d, measured " +
    "2026-09-04). The `(not set)` city bucket cannot be classified and stays in; the owner's own " +
    "sessions are a GA4 internal-traffic filter, not code.",
};

/**
 * The ONE dimensionFilter every report this client issues carries — the
 * gh-1637 host allow-list AND gh-1649's three exclusion rules, as one
 * andGroup, so the denominator every consumer receives is the same one.
 * gh-1639 fix: shared verbatim by BOTH request builders below (buckets and
 * site total) so the two reads the sum invariant compares can never drift
 * onto different filters — the invariant would then be measuring the
 * filter difference, not additivity.
 */
export function buildDimensionFilter(): unknown {
  return {
    andGroup: {
      expressions: [
        {
          filter: {
            fieldName: "hostName",
            inListFilter: { values: GA4_PRODUCTION_HOSTS },
          },
        },
        ...GA4_EXCLUDED_SOURCE_SUBSTRINGS.map((value) => ({
          notExpression: {
            filter: {
              fieldName: "sessionSource",
              stringFilter: { matchType: "CONTAINS", value, caseSensitive: false },
            },
          },
        })),
        ...GA4_EXCLUDED_SOURCES_EXACT.map((value) => ({
          notExpression: {
            filter: {
              fieldName: "sessionSource",
              stringFilter: { matchType: "EXACT", value },
            },
          },
        })),
        {
          notExpression: {
            filter: {
              fieldName: "city",
              inListFilter: { values: GA4_DATACENTER_CITIES },
            },
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/**
 * Pure construction of the GA4 :runReport body this function sends — one
 * aggregate row (no dimensions) over a single range, for the caller's
 * metrics, INSIDE the gh-1637/gh-1649 dimensionFilter (buildDimensionFilter).
 * Lives here rather than in index.ts (same pattern as
 * get-business-lines-dashboard/ga4.ts) so a test can import it without
 * importing index.ts, whose top-level serve() needs --allow-net; the test
 * then asserts the filter on the object actually handed to fetch, not on a
 * constant a refactor could drop without failing anything.
 */
export function buildGa4ReportRequestBody(startDate: string, endDate: string, metrics: string[]): unknown {
  return {
    dateRanges: [{ startDate, endDate }],
    metrics: metrics.map((name) => ({ name })),
    dimensionFilter: buildDimensionFilter(),
  };
}
