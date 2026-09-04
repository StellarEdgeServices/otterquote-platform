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
// GitHub: #1574, #1340, #1331, #1637

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

/** One calendar day's sessions. `date` is GA4's raw dimension value, "YYYYMMDD". */
export interface Ga4DailyRow {
  date: string;
  sessions: number;
}

// gh-1637: both branches carry property_id + hosts (not just the success
// branch) so a `not_run` result can still say what it WOULD have counted —
// the page (#1638) renders that even when GA4 itself is unreachable.
export type Ga4SessionsByDayResult =
  | { ok: true; property_id: string; hosts: string[]; exclusions: Ga4Exclusions; rows: Ga4DailyRow[] }
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
 * Pure construction of the GA4 :runReport request body for a given date
 * range, INCLUDING the gh-1637 hostName dimensionFilter. Split out from
 * fetchGa4SessionsByDay (same "test the pure part" split
 * parseSessionsByDayResponse above already uses) so the filter can be
 * asserted against the actual object handed to fetch's body — not a
 * separately-checked constant a future refactor could silently drop without
 * failing a test.
 */
export function buildRunReportRequestBody(startDate: string, endDate: string): unknown {
  // gh-1649: the host allow-list AND the three exclusion rules, as one
  // andGroup, so the denominator every consumer receives is the same one.
  return {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: {
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
    },
  };
}

/**
 * Pure extraction of { date, sessions } rows from a GA4 runReport response
 * body (already-parsed JSON). Split out from fetchGa4SessionsByDay so the
 * new bucketing/parsing logic this issue adds is testable against a stubbed
 * GA4 response fixture without live credentials or network access — the
 * same "test the pure part, not the network part" split ga4-report/
 * index.test.ts already uses for its own primitives.
 *
 * Rows whose date dimension is not exactly 8 digits are dropped rather than
 * mis-bucketed downstream — same "drop, don't guess" discipline as
 * countByWeek in index.ts.
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
    out.push({ date, sessions: Number(r?.metricValues?.[0]?.value ?? 0) });
  }
  return out;
}

/**
 * Fetches daily `sessions` for the configured GA4 property over
 * [startDate, endDate] (same date-string grammar ga4-report accepts:
 * YYYY-MM-DD, "today", "yesterday", "NdaysAgo"). Never throws — every
 * failure path returns { ok: false, reason }.
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

  let reportRes: Response;
  let reportText: string;
  try {
    reportRes = await fetch(`${GA4_DATA_API}/properties/${propertyId}:runReport`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildRunReportRequestBody(startDate, endDate)),
    });
    reportText = await reportRes.text();
  } catch (err) {
    return {
      ok: false,
      reason: `GA4 request failed before a response was received: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400),
      property_id: propertyId,
      hosts,
      exclusions,
    };
  }

  if (!reportRes.ok) {
    // Log the upstream body for the operator; never return it (same
    // information-exposure discipline as ga4-report's catch).
    console.error(`[get-business-lines-dashboard/ga4] GA4 ${reportRes.status}:`, reportText.slice(0, 600));
  }

  if (reportRes.status === 403) {
    // gh-1331's predicted failure mode: the service account is authenticated
    // but not authorized on this property (Viewer grant missing/misplaced).
    return {
      ok: false,
      reason:
        `GA4 Data API returned 403 for property ${propertyId} — the service account ` +
        "otterquote-ga4-reader@otterquote-analytics.iam.gserviceaccount.com is likely not " +
        "granted Viewer on this property yet (same failure mode ga4-report documents for gh-1331).",
      property_id: propertyId,
      hosts,
      exclusions,
    };
  }
  if (!reportRes.ok) {
    return { ok: false, reason: `GA4 Data API returned HTTP ${reportRes.status}`, property_id: propertyId, hosts, exclusions };
  }

  let report: unknown;
  try {
    report = JSON.parse(reportText);
  } catch {
    return {
      ok: false,
      reason: "GA4 Data API returned a response that could not be parsed as JSON.",
      property_id: propertyId,
      hosts,
      exclusions,
    };
  }

  return { ok: true, property_id: propertyId, hosts, exclusions, rows: parseSessionsByDayResponse(report) };
}
