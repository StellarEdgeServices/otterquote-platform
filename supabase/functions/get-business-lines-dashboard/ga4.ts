// get-business-lines-dashboard/ga4.ts
//
// gh-1574 (#1340 phase 5) — GA4 sessions-by-day client for the `visits`
// weekly series.
//
// The issue asked for this to move to `_shared/ga4.ts` ("one client, two
// callers", shared with ga4-report). `_shared/` imports do NOT resolve at
// Supabase Edge Function deploy time — see the ADMIN_EMAILS comment in this
// directory's index.ts and in ga4-report/index.ts ("deploy path does not
// resolve imports"), and the standing house pattern for source-split logic
// is a module CO-LOCATED in the calling function's own directory, imported
// via a same-directory relative path (confirmed working: approve-payout/
// w9-gate.ts, create-hover-order/price-setting.ts, docusign-webhook/
// price-verify.ts are all imported by their own directory's index.ts this
// way). So this file lives here instead, and index.ts imports it as
// "./ga4.ts". The token-minting path (service-account JWT -> Google OAuth ->
// GA4 Data API) mirrors ga4-report/index.ts's implementation exactly — same
// service account, same signing code — because that is the literal
// "one client" the issue means; a change to the auth path in one should be
// mirrored in the other until Supabase gives this repo a real shared-module
// mechanism.
//
// Unlike ga4-report (which requests one aggregate row over a single date
// range), this client requests the `date` dimension, so the response carries
// one row per calendar day — the raw material get-business-lines-dashboard's
// sumByWeek (index.ts) buckets into the 12 rolling weekly windows the rest of
// that EF's marketing series already use (buildWeekWindows).
//
// Fail-loud contract (house rule gh-1419 — UNMEASURED is never a quiet
// pass): every failure path here — missing/invalid service account config,
// a non-2xx from Google, an unparsable response, a network error — returns
// { ok: false, reason } and NEVER throws. The caller turns that into a
// `not_run` series carrying the reason, never a silent zero series.
//
// gh-1637 (#1340 phase 5a): this client's `sessions` read was unfiltered —
// every GA4 request now applies a `hostName` dimensionFilter restricting to
// the production hosts (GA4_PRODUCTION_HOSTS below). Without it the
// denominator is ~93% staging/branch-deploy/localhost traffic (production
// `gtag` fires everywhere until #1619 fixes the source), which inverts the
// conclusion a reader draws from every rate built on this series. The filter
// stays load-bearing for every window spanning #1619's eventual fix date —
// historical data cannot be retroactively cleaned. `www.otterquote.com` is
// included even though it reports zero sessions today, because it is a live
// host that can begin serving at any time.
//
// gh-1639 (#1340 phase 5c): the request now ALSO carries a `landingPage`
// dimension alongside `date`, INSIDE the same hostName filter above — a
// dimension, not a filter, so no row is excluded, only split further. Every
// returned landingPage is normalised (normalizePagePath below) before it is
// bucketed into one of four audiences (bucketPagePath below) by
// longest-matching prefix, per the CTO's ruling table (dispatch comment
// 2026-09-04T18:58:36Z) — that table is authoritative and is NOT extended
// here on inference; anything it does not name resolves to "unattributed".
//
// gh-1639 fix (CTO verification comment 5549189354, v13 defect): the first
// cut of 5c dimensioned by `pagePath`. GA4 `sessions` is NOT additive across
// pagePath — a session is counted once per page it viewed — so the split
// rows summed to 1,464 over 84 days against a site total of 827 on the same
// filter (1.77x, pages-per-session), and every per-audience denominator AND
// the site-wide total (which summed the same rows) were inflated by that
// factor. `landingPage` is session-scoped (one entry page per session), so
// its buckets are additive: measured 2026-09-05 over the same 84 days and
// filter, the [date, landingPage] rows summed EXACTLY to the [date]-only
// rows on every one of the 61 closed days; the only difference (+20
// sessions on the current, still-processing day) sat entirely on that
// day's 23 blank / "(not set)" landing rows, which GA4 has not yet resolved
// to an entry page. Those unresolved rows bucket to "unattributed" and are
// the declared tolerance of the sum invariant (index.ts
// buildAudienceVisitsSeries). The client therefore now issues TWO reports
// per call, same filter, same range: [date, landingPage] for the buckets and
// [date] only for the site total the buckets are checked against — so the
// invariant compares two independently-dimensioned reads, not one row set
// against itself.
//
// GitHub: #1574, #1340, #1331, #1637, #1639

const DEFAULT_PROPERTY_ID = "541423859";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GA4_DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

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

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

// ---------------------------------------------------------------------------
// Mirrors ga4-report/index.ts's JWT-encoding primitives and service-account
// parsing exactly (see file header). Not re-exported/tested here beyond
// parseServiceAccountEnv (below) — ga4-report/index.test.ts already covers
// base64url/base64urlText/pemToDer byte-for-byte identically; duplicating
// those tests against a duplicated implementation would not catch anything
// the original doesn't already catch.
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlText(text: string): string {
  return base64url(new TextEncoder().encode(text));
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der.buffer;
}

/**
 * Pure parse of the two env-var strings into a usable service account, or
 * null on any config fault (empty, invalid JSON, missing fields). Unlike
 * ga4-report's parseServiceAccountEnv, this collapses every fault into a
 * single null rather than naming the gh-1331 Doppler-swap case specifically
 * — that diagnostic already exists in ga4-report's own error response, and
 * this caller's honesty contract only needs "configured" vs "not", surfaced
 * as a reason string one level up (see fetchGa4SessionsByDay).
 */
export function parseServiceAccountEnv(rawJson: string): ServiceAccount | null {
  const raw = rawJson.trim();
  if (!raw) return null;
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed.client_email || !parsed.private_key) return null;
  return parsed;
}

async function mintAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64urlText(
    JSON.stringify({ iss: sa.client_email, scope: GA4_SCOPE, aud: TOKEN_ENDPOINT, iat: now, exp: now + 3600 }),
  );
  const signingInput = `${header}.${claims}`;

  // The private_key arrives with literal \n when it has round-tripped
  // through an env var; normalise before parsing the PEM (same as
  // ga4-report).
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key.replace(/\\n/g, "\n")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
  );
  const assertion = `${signingInput}.${base64url(signature)}`;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Google token endpoint returned ${res.status}: ${body.slice(0, 400)}`);
  const token = JSON.parse(body).access_token;
  if (!token) throw new Error("Google token endpoint returned no access_token.");
  return token;
}

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/**
 * One calendar day's sessions for one normalised landingPage. `date` is
 * GA4's raw dimension value, "YYYYMMDD". `landingPage` (gh-1639) has already
 * been run through normalizePagePath below by the time it reaches this
 * shape — it is never the raw GA4 dimension value. GA4's own "(not set)"
 * sentinel and an empty value survive normalisation as-is (see
 * isUnresolvedLandingPage) and bucket to "unattributed".
 */
export interface Ga4DailyRow {
  date: string;
  landingPage: string;
  sessions: number;
}

/**
 * One calendar day's site-wide sessions from the [date]-only report — the
 * reference total the landingPage buckets are checked against (gh-1639
 * fix). Deliberately a separate shape from Ga4DailyRow so no caller can
 * confuse a bucketable row with the reference total.
 */
export interface Ga4SiteDailyRow {
  date: string;
  sessions: number;
}

/**
 * GA4 reports a session whose entry page it has not (yet) resolved with a
 * blank or "(not set)" landingPage. Measured 2026-09-05 (84 days, production
 * andGroup filter): 23 blank + 23 "(not set)" of 845 landing-dimensioned
 * sessions, and the [date, landingPage] rows exceeded the [date]-only rows
 * ONLY on the current, still-processing day, by no more than that day's
 * unresolved count. These rows bucket to "unattributed" (neither value is in
 * the ruling table) and bound the sum invariant's tolerance in index.ts.
 */
export function isUnresolvedLandingPage(normalizedLandingPage: string): boolean {
  return normalizedLandingPage === "" || normalizedLandingPage === "(not set)";
}

// ---------------------------------------------------------------------------
// gh-1639 (#1340 phase 5c): landingPage normalisation and audience bucketing.
// (The functions keep their pagePath-era names — they normalise and bucket a
// path string; what changed in the gh-1639 fix is WHICH GA4 dimension
// supplies that string: landingPage, which is one-per-session.)
// ---------------------------------------------------------------------------

/**
 * Normalises a raw GA4 `landingPage` dimension value before it is bucketed:
 * strips any query string and fragment, strips a trailing `/` (except the
 * bare root), and strips a trailing `.html` — repeating until neither
 * applies, since either can follow the other. This is not tidiness: Netlify
 * serves both spellings and GA4 records both as DISTINCT pagePath values.
 * Measured live on production over 84 days (issue body): `/get-started` 557
 * vs `/get-started.html` 33; `/recruit` 47 vs `/recruit.html` 122;
 * `/contractor-join` 12 vs `/contractor-join.html` 16. Skipping this step
 * silently splits one audience's traffic across two buckets and understates
 * it. An empty/missing value normalises to an empty string, NOT to the root
 * "/" — a missing dimension must never be silently attributed to
 * homeowner's exact "/" rule.
 */
export function normalizePagePath(raw: string): string {
  let p = String(raw ?? "");
  const hashIdx = p.indexOf("#");
  if (hashIdx !== -1) p = p.slice(0, hashIdx);
  const qIdx = p.indexOf("?");
  if (qIdx !== -1) p = p.slice(0, qIdx);
  let changed = true;
  while (changed) {
    changed = false;
    if (p.length > 1 && p.endsWith("/")) {
      p = p.slice(0, -1);
      changed = true;
    }
    if (p.length > ".html".length && p.toLowerCase().endsWith(".html")) {
      p = p.slice(0, -".html".length);
      changed = true;
    }
  }
  return p;
}

export type Audience = "homeowner" | "contractor" | "referral_partner" | "unattributed";

// gh-1639: THE prefix table, verbatim from the CTO's ruling (issue body +
// dispatch comment 2026-09-04T18:58:36Z: "The prefix table is a ruling, not
// a suggestion... Do not extend the table on inference; if a large
// unattributed share shows up, that is a finding to report"). Split into
// EXACT matches (checked first, unconditionally) and PREFIX matches
// (checked only after every exact rule misses, longest-prefix-wins) — this
// is what resolves both ordering hazards the issue names:
//   1. "/ref" (exact, referral_partner) must not be swallowed by any
//      prefix rule that happens to also start with "re" (e.g. "/recruit",
//      a contractor PREFIX) — exact rules are checked first, full stop.
//   2. "/contractor…" (prefix, contractor — e.g. production's own
//      "/contractor-join", 26 pageviews/12 sessions in 28 days) must not be
//      caught by a broadened form of "/contract-signing" (an EXACT
//      homeowner rule, never a prefix) — because "/contract-signing" is
//      exact-only, it can never expand to catch "/contractor-join".
const EXACT_AUDIENCE_PATHS: Record<string, Audience> = {
  "/": "homeowner",
  "/index": "homeowner",
  "/get-started": "homeowner",
  "/trade-selector": "homeowner",
  "/dashboard": "homeowner",
  "/bids": "homeowner",
  "/claim": "homeowner",
  "/contract-signing": "homeowner",
  "/faq": "homeowner",
  "/ref": "referral_partner",
  "/ref-re": "referral_partner",
};

// Longest-prefix-wins among these when more than one matches the same
// normalised path (none do today under the pinned table, but the tie-break
// is deterministic rather than "first array entry wins" so a future table
// edit cannot silently depend on array order).
//
// gh-1639 fix (fresh-context refuter comment 5548057089, PR #1674):
// `/guides/` and `/blog/` are written in the CTO's ruling WITH a trailing
// slash — a slash-terminated prefix — while `/contractor`, `/tools`,
// `/recruit`, `/partner` are bare prefixes (the ruling's own text: "matches
// by the ruling's own text '/contractor (prefix)'"). `normalizePagePath`
// strips a path's trailing slash (except bare root) before this table is
// consulted, so the raw GA4 value `/guides/` normalises to `/guides` before
// `.startsWith("/guides/")` ever runs — it can never match, and every visit
// to the guides/blog section-index page silently fell to `unattributed`.
// `slashTerminated: true` restores the ruling's intent post-normalisation
// without reintroducing the bug a bare `startsWith("/guides")` would cause
// (matching `/guidesfoo`, which is not in the table): match the bare root
// (`/guides`, `/blog` — what `/guides/` normalises to) OR any child path
// that still carries the slash in the middle (`/guides/foo` — untouched by
// trailing-slash stripping). Bare prefixes are unaffected: `startsWith`
// against the literal prefix, exactly as the ruling names them.
const PREFIX_AUDIENCE_PATHS: Array<{ prefix: string; audience: Audience; slashTerminated?: boolean }> = [
  { prefix: "/guides/", audience: "homeowner", slashTerminated: true },
  { prefix: "/blog/", audience: "homeowner", slashTerminated: true },
  { prefix: "/contractor", audience: "contractor" },
  { prefix: "/tools", audience: "contractor" }, // covers /tools-crm
  { prefix: "/recruit", audience: "contractor" },
  { prefix: "/partner", audience: "referral_partner" },
];

/**
 * Buckets an ALREADY-NORMALISED pagePath (see normalizePagePath) into one of
 * four audiences by the CTO's ruling table above. Anything not matched by
 * an exact or prefix rule is "unattributed" — never inferred onto the
 * nearest-looking bucket (issue item 3: "the table is the spec").
 */
export function bucketPagePath(normalizedPath: string): Audience {
  const exact = EXACT_AUDIENCE_PATHS[normalizedPath];
  if (exact) return exact;
  let best: { root: string; audience: Audience } | null = null;
  for (const rule of PREFIX_AUDIENCE_PATHS) {
    // Slash-terminated prefixes (/guides/, /blog/) match the bare root
    // post-normalisation (/guides, /blog) OR a child path that still has
    // the slash (/guides/foo) — never a bare startsWith, which would also
    // wrongly catch /guidesfoo or /blogger.
    const root = rule.slashTerminated ? rule.prefix.slice(0, -1) : rule.prefix;
    const matches = rule.slashTerminated
      ? normalizedPath === root || normalizedPath.startsWith(rule.prefix)
      : normalizedPath.startsWith(rule.prefix);
    if (matches) {
      if (!best || root.length > best.root.length) best = { root, audience: rule.audience };
    }
  }
  return best ? best.audience : "unattributed";
}

// gh-1639 item 7: the exact prefixes counted for each audience, exposed so
// index.ts's payload can put this verbatim into each per-audience series'
// `note` (and admin-dashboard.html can render it on the scope line) rather
// than a hand-summarised restatement of the table above that could drift
// from it.
export const AUDIENCE_PREFIX_NOTE: Record<Audience, string> = {
  homeowner:
    "Sessions bucketed by landingPage (the session's entry page, one per session — sessions are " +
    "not additive across pagePath): counts /, /index, /get-started, /trade-selector, /dashboard, " +
    "/bids, /claim, /contract-signing, /faq (exact) plus /guides/ and /blog/ (prefix) — see #1639.",
  contractor:
    "Sessions bucketed by landingPage (the session's entry page, one per session — sessions are " +
    "not additive across pagePath): counts /contractor, /tools, /recruit (prefix) — see #1639.",
  referral_partner:
    "Sessions bucketed by landingPage (the session's entry page, one per session — sessions are " +
    "not additive across pagePath): counts /partner (prefix) plus /ref, /ref-re (exact) — see #1639.",
  unattributed:
    "Sessions bucketed by landingPage (the session's entry page, one per session): every " +
    "landingPage not matched by the homeowner/contractor/referral_partner rules above (e.g. " +
    "/login, /auth-callback, /terms) plus sessions whose entry page GA4 has not resolved " +
    "(blank or \"(not set)\") — see #1639.",
};

// gh-1637: both branches carry property_id + hosts (not just the success
// branch) so a `not_run` result can still say what it WOULD have counted —
// the page (#1638) renders that even when GA4 itself is unreachable.
// gh-1639 fix: a successful result carries BOTH reads — `rows` from the
// [date, landingPage] report (bucketable) and `site_rows` from the [date]-only
// report (the reference total). Either report failing fails the whole result:
// buckets without a reference total cannot be checked, and a reference total
// without buckets is the pre-5c shared denominator this issue exists to end.
export type Ga4SessionsByDayResult =
  | {
    ok: true;
    property_id: string;
    hosts: string[];
    exclusions: Ga4Exclusions;
    rows: Ga4DailyRow[];
    site_rows: Ga4SiteDailyRow[];
  }
  | { ok: false; reason: string; property_id: string; hosts: string[]; exclusions: Ga4Exclusions };

/**
 * Resolves the GA4 property id from GA4_PROPERTY_ID (validated as all-digit)
 * or DEFAULT_PROPERTY_ID otherwise. Exported (gh-1637) so this is the single
 * resolution both the live request and every result branch — success or
 * not_run — report back, rather than a second ad hoc derivation drifting
 * from the one actually used on the wire.
 */
export function resolveGa4PropertyId(): string {
  const raw = (Deno.env.get("GA4_PROPERTY_ID") || "").trim();
  return /^\d+$/.test(raw) ? raw : DEFAULT_PROPERTY_ID;
}

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

/**
 * Pure construction of the GA4 :runReport request body for the per-audience
 * BUCKET read over a given date range, INCLUDING the gh-1637/gh-1649
 * dimensionFilter (buildDimensionFilter). Split out from
 * fetchGa4SessionsByDay (same "test the pure part" split
 * parseSessionsByDayResponse below already uses) so the filter can be
 * asserted against the actual object handed to fetch's body — not a
 * separately-checked constant a future refactor could silently drop without
 * failing a test.
 */
export function buildRunReportRequestBody(startDate: string, endDate: string): unknown {
  return {
    dateRanges: [{ startDate, endDate }],
    // gh-1639: landingPage is a DIMENSION added alongside date, inside the
    // unchanged filter below — it does not exclude any row, it only splits
    // each day's sessions further so the caller can bucket them by audience
    // (see buildAudienceVisitsSeries in index.ts). Per the issue: "a
    // dimension is not a filter — do not filter paths out; bucket them."
    // gh-1639 fix: landingPage, NOT pagePath — sessions are additive across
    // the former (one entry page per session) and not the latter (one count
    // per page viewed; measured 1.77x inflation, see file header).
    dimensions: [{ name: "date" }, { name: "landingPage" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: buildDimensionFilter(),
  };
}

/**
 * Pure construction of the SITE-TOTAL read: the same range, the same
 * filter, `date` as the only dimension — what v12 summed, and the reference
 * total the landingPage buckets are checked against (gh-1639 fix). Kept as a
 * separate builder rather than a flag so a test can assert the two bodies
 * differ in `dimensions` and NOTHING else.
 */
export function buildSiteTotalRequestBody(startDate: string, endDate: string): unknown {
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: buildDimensionFilter(),
  };
}

/**
 * Pure extraction of { date, landingPage, sessions } rows from a GA4
 * runReport response body (already-parsed JSON). Split out from fetchGa4SessionsByDay so the
 * new bucketing/parsing logic this issue adds is testable against a stubbed
 * GA4 response fixture without live credentials or network access — the
 * same "test the pure part, not the network part" split ga4-report/
 * index.test.ts already uses for its own primitives.
 *
 * Rows whose date dimension is not exactly 8 digits are dropped rather than
 * mis-bucketed downstream — same "drop, don't guess" discipline as
 * countByWeek in index.ts.
 *
 * gh-1639: the request's dimensions are now [date, landingPage] (see
 * buildRunReportRequestBody), so dimensionValues[1] is the landingPage — run
 * through normalizePagePath before it is ever attached to the row, so every
 * downstream consumer (bucketPagePath included) sees an already-normalised
 * value and cannot forget the step.
 */
export function parseSessionsByDayResponse(report: unknown): Ga4DailyRow[] {
  const rawRows = (report as { rows?: unknown[] } | null | undefined)?.rows ?? [];
  const out: Ga4DailyRow[] = [];
  for (const r of rawRows as Array<{
    dimensionValues?: { value?: string }[];
    metricValues?: { value?: string }[];
  }>) {
    const date = String(r?.dimensionValues?.[0]?.value ?? "");
    if (!/^\d{8}$/.test(date)) continue;
    const landingPage = normalizePagePath(String(r?.dimensionValues?.[1]?.value ?? ""));
    out.push({ date, landingPage, sessions: Number(r?.metricValues?.[0]?.value ?? 0) });
  }
  return out;
}

/**
 * Pure extraction of { date, sessions } rows from the [date]-only site-total
 * report (buildSiteTotalRequestBody). Same "drop, don't guess" date
 * discipline as parseSessionsByDayResponse; a second dimension value, if one
 * were ever present, is ignored rather than trusted.
 */
export function parseSiteTotalResponse(report: unknown): Ga4SiteDailyRow[] {
  const rawRows = (report as { rows?: unknown[] } | null | undefined)?.rows ?? [];
  const out: Ga4SiteDailyRow[] = [];
  for (const r of rawRows as Array<{
    dimensionValues?: { value?: string }[];
    metricValues?: { value?: string }[];
  }>) {
    const date = String(r?.dimensionValues?.[0]?.value ?? "");
    if (!/^\d{8}$/.test(date)) continue;
    out.push({ date, sessions: Number(r?.metricValues?.[0]?.value ?? 0) });
  }
  return out;
}

/**
 * One :runReport round-trip. Never throws — every failure path returns
 * { ok: false, reason } so fetchGa4SessionsByDay can attach property/hosts/
 * exclusions and hand it up unchanged. `label` names which of the two reads
 * failed in the reason string (gh-1639 fix issues two per call).
 */
async function runReport(
  propertyId: string,
  accessToken: string,
  body: unknown,
  label: string,
): Promise<{ ok: true; report: unknown } | { ok: false; reason: string }> {
  let reportRes: Response;
  let reportText: string;
  try {
    reportRes = await fetch(`${GA4_DATA_API}/properties/${propertyId}:runReport`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    reportText = await reportRes.text();
  } catch (err) {
    return {
      ok: false,
      reason: `GA4 ${label} request failed before a response was received: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400),
    };
  }

  if (!reportRes.ok) {
    // Log the upstream body for the operator; never return it (same
    // information-exposure discipline as ga4-report's catch).
    console.error(`[get-business-lines-dashboard/ga4] GA4 ${label} ${reportRes.status}:`, reportText.slice(0, 600));
  }

  if (reportRes.status === 403) {
    // gh-1331's predicted failure mode: the service account is authenticated
    // but not authorized on this property (Viewer grant missing/misplaced).
    return {
      ok: false,
      reason:
        `GA4 Data API returned 403 for property ${propertyId} (${label} read) — the service account ` +
        "otterquote-ga4-reader@otterquote-analytics.iam.gserviceaccount.com is likely not " +
        "granted Viewer on this property yet (same failure mode ga4-report documents for gh-1331).",
    };
  }
  if (!reportRes.ok) {
    return { ok: false, reason: `GA4 Data API returned HTTP ${reportRes.status} (${label} read)` };
  }

  try {
    return { ok: true, report: JSON.parse(reportText) };
  } catch {
    return { ok: false, reason: `GA4 Data API returned a ${label} response that could not be parsed as JSON.` };
  }
}

/**
 * Fetches daily `sessions` for the configured GA4 property over
 * [startDate, endDate] (same date-string grammar ga4-report accepts:
 * YYYY-MM-DD, "today", "yesterday", "NdaysAgo"). Never throws — every
 * failure path returns { ok: false, reason }.
 *
 * gh-1639 fix: two reports per call, one access token, same filter and
 * range — [date, landingPage] (`rows`, bucketable) and [date] only
 * (`site_rows`, the reference total). Issued concurrently; either failing
 * fails the result.
 */
export async function fetchGa4SessionsByDay(
  startDate: string,
  endDate: string,
): Promise<Ga4SessionsByDayResult> {
  // gh-1637: resolved up front (pure env read, no side effects) so EVERY
  // return path below — not_run included — can report the property/hosts a
  // caller would have counted, per the work order's "not_run still carries
  // property_id/hosts" requirement.
  const propertyId = resolveGa4PropertyId();
  const hosts = GA4_PRODUCTION_HOSTS;
  const exclusions = GA4_EXCLUSIONS;

  const sa = parseServiceAccountEnv(Deno.env.get("GA4_SERVICE_ACCOUNT_JSON") || "");
  if (!sa) {
    return {
      ok: false,
      reason:
        "GA4_SERVICE_ACCOUNT_JSON is not set or is not a complete service account " +
        "(see ga4-report's gh-1331 config-error handling for the full diagnostic).",
      property_id: propertyId,
      hosts,
      exclusions,
    };
  }

  let accessToken: string;
  try {
    accessToken = await mintAccessToken(sa);
  } catch (err) {
    return {
      ok: false,
      reason: `GA4 auth failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400),
      property_id: propertyId,
      hosts,
      exclusions,
    };
  }

  const [bucketRead, siteRead] = await Promise.all([
    runReport(propertyId, accessToken, buildRunReportRequestBody(startDate, endDate), "landingPage"),
    runReport(propertyId, accessToken, buildSiteTotalRequestBody(startDate, endDate), "site-total"),
  ]);
  if (!bucketRead.ok) return { ok: false, reason: bucketRead.reason, property_id: propertyId, hosts, exclusions };
  if (!siteRead.ok) return { ok: false, reason: siteRead.reason, property_id: propertyId, hosts, exclusions };

  return {
    ok: true,
    property_id: propertyId,
    hosts,
    exclusions,
    rows: parseSessionsByDayResponse(bucketRead.report),
    site_rows: parseSiteTotalResponse(siteRead.report),
  };
}
