/**
 * OtterQuote Edge Function: get-business-lines-dashboard
 *
 * gh-1340 phase 1 — Business-lines dashboard, admin read model.
 *
 * admin-dashboard.html needs the top page (all SES business lines), the
 * Otter Quotes line page (high-level counts), and the three OQ audience CRM
 * tabs (Homeowner / Contractor / Referral Partner) — one row per member with
 * a stage checklist ticked from live evidence columns and a "days since last
 * movement" number. Four of those tables (profiles, quotes, referrals,
 * activity_log) carry no admin RLS read policy, so the anon client cannot
 * make these joins — the same reason get-payout-completion-status exists.
 * This EF performs every read with the service role behind the same admin
 * allow-list, and pre-aggregates the response so no raw profiles/quotes/
 * referrals/activity_log row crosses the wire unjoined.
 *
 * "Days since last movement" is computed HERE, never client-side (gh-1340
 * build order item 3) — it is the product this dashboard exists to show.
 *
 * Every count in the response is a real, live query result. Tiles that read
 * 0 are a MEASURED ZERO (a real, verified count) — this EF never fabricates
 * or omits a value; the UI is responsible for rendering 0 distinctly from
 * "not measured" (a data source that does not exist yet, e.g. GA4 visits —
 * out of scope for phase 1, which is entirely Supabase-backed).
 *
 * Phase 4 (gh-1340 scope item 4) adds ONE non-Supabase read: Revenue MTD via
 * the server-side Stripe read path (read-only GET, live key, no side
 * effects — Tier 3A). Its result carries its own honesty state: "measured" /
 * "measured_zero" (a real $0 Stripe actually answered) / "not_run" (key
 * missing, HTTP error, runaway pagination — with the query count and a
 * reason). It NEVER fabricates $0, and a Stripe failure never takes the
 * dashboard down: fetchRevenueMtd() cannot throw and sits outside the
 * all-tables error gate.
 *
 * Phase 2a (gh-1469) adds a 12-week weekly-bucketed marketing series to each
 * audience: homeowner (signups, claims, measurement orders, leads by
 * source), contractor (pre-approval → template → first-bid funnel),
 * referral_partner (partner signups by agent_type and by UTM source, plus
 * referral clicks). Every series is a real query result — the same
 * measured/measured_zero honesty contract as the rest of this EF, carried
 * per-series rather than per-scalar (buildWeeklySeries / buildGroupedWeekly
 * Series below). None of the six named series lack a live source as of this
 * phase, so "not_run" is reserved for a future series that genuinely has
 * none (e.g. GA4 visits, phase 5) — it is still part of the contract and
 * documented on WeeklySeries/GroupedWeeklySeries.
 *
 * The referral_clicks series carries the gh-1302 ~2x double-tracking caveat
 * IN THE PAYLOAD (a `caveat` string on the series itself), not only in a
 * future UI — gh-1302's fix (PR #1361, merged 2026-08-29T22:19:36Z) stops
 * new double-counted rows but does not backfill rows created before that
 * migration, and this series' 12-week trailing window spans that boundary.
 *
 * Phase 5 (gh-1574) adds ONE more series to all three audiences: `visits`, a
 * 12-week weekly GA4 `sessions` count via the live ga4-report (#1331) Data
 * API path — its token-minting/runReport client is mirrored (not shared;
 * `_shared/` does not resolve at deploy time) in this directory's ga4.ts.
 * All three audiences read the SAME site-wide GA4 property (541423859) until
 * per-audience GA4 dimensions exist — the series' `note` field says so, per
 * the issue. Same honesty contract as every other series: `kind: "measured"`
 * / `"measured_zero"` on a successful GA4 read, `kind: "not_run"` with a
 * `reason` on ANY GA4 failure (missing/invalid service account, non-2xx,
 * unparsable response) — never a fabricated zero (house rule gh-1419).
 * Carries a standing `caveat`: bot share within production traffic is still
 * unknown (#1464) — sessions ≈ totalUsers on a site with very few signups
 * smells like crawler traffic, so a rate built on this denominator without
 * the caveat would be a lie in the other direction.
 *
 * gh-1637 (#1340 phase 5a): the GA4 read this series was built from was
 * UNFILTERED — ~93% of the property's sessions are staging/branch-deploy/
 * localhost traffic (production `gtag` fires everywhere until #1619 fixes
 * the source), so the denominator was wrong by an order of magnitude. Every
 * GA4 request ga4.ts makes now applies a `hostName` dimensionFilter scoped
 * to the production hosts, and this payload declares that scope explicitly
 * (`visits.scope`, `visits.property_id`, `visits.hosts`) so #1638 (the page
 * half) and #1639 can render what was actually counted instead of assuming.
 *
 * Read-only. No writes, no schema change, no other EF touched.
 *
 * Input:  POST {}  (body currently unused — reserved for future filtering)
 * Output: { ok: true, generated_at, lines: [...], audiences: { homeowner, contractor, referral_partner } }
 *         lines[key=otterquotes] additionally carries revenue_mtd (phase 4).
 *         audiences.{homeowner,contractor,referral_partner} additionally
 *         carry `marketing` (phase 2a) — see buildWeeklySeries/
 *         buildGroupedWeeklySeries for the shared shape — and, as of phase 5
 *         (gh-1574), a `visits` series on that same `marketing` block.
 *
 * Auth: requires a valid Supabase JWT with email in the admin allow-list.
 * verify_jwt = false (see supabase/config.toml) — auth is performed
 * in-handler, same pattern as get-payout-completion-status / approve-payout.
 *
 * GitHub: #1340, #1469, #1574, #1637
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { fetchGa4SessionsByDay, type Ga4SessionsByDayResult } from "./ga4.ts";

const FUNCTION_NAME = "get-business-lines-dashboard";
// gh-1534: kept in sync with supabase/functions/_shared/admin.ts ADMIN_EMAILS — do not
// edit this array without updating that file too (deploy path does not resolve imports).
const ADMIN_EMAILS  = ["dustinstohler1@gmail.com", "dustin@otterquote.com"];

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function jsonResponse(
  data: unknown,
  status: number,
  corsHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Days-since-movement ──────────────────────────────────────────────────
// today - max(...every timestamp that counts as "this member did something").
// Returns { days, latest_iso, inputs } — inputs are the individual candidate
// timestamps that fed the max(), so the UI can show exactly what a "hand
// computed spot check" (gh-1340 closes-on) would have to reproduce.
interface MovementInput { label: string; iso: string | null }

function computeMovement(nowMs: number, inputs: MovementInput[]) {
  let latest: MovementInput | null = null;
  let latestMs = -Infinity;
  for (const inp of inputs) {
    if (!inp.iso) continue;
    const t = new Date(inp.iso).getTime();
    if (!isNaN(t) && t > latestMs) {
      latestMs = t;
      latest = inp;
    }
  }
  if (!latest) {
    return { days: null, latest_label: null, latest_iso: null, inputs, bucket: "unknown" as const };
  }
  const days = Math.floor((nowMs - latestMs) / 86400000);
  return { days, latest_label: latest.label, latest_iso: latest.iso, inputs, bucket: bucketFor(days) };
}

function bucketFor(days: number): "green" | "yellow" | "red" {
  if (days <= 7) return "green";
  if (days <= 13) return "yellow";
  return "red";
}

// A tile value that is always real — 0 is a MEASURED ZERO, never omitted.
function measured(value: number) {
  return { value, kind: value === 0 ? "measured_zero" : "measured" };
}

// ── gh-1469 phase 2a: 12-week marketing series ──────────────────────────
// Rolling 7-day windows ending NOW (not calendar Mon-Sun weeks) — window[11]
// (the last one) always ends at the moment the function ran, so "this week"
// is always a real, comparable 7-day slice no matter what day it is.
// window[0] is the oldest, window[11] the newest — chronological order.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MARKETING_WEEKS = 12;

interface WeekWindow { week_start: string; week_end: string }

function buildWeekWindows(nowMs: number, weeks: number): WeekWindow[] {
  const windows: WeekWindow[] = [];
  for (let i = weeks; i >= 1; i--) {
    const end = nowMs - (i - 1) * WEEK_MS;
    const start = end - WEEK_MS;
    windows.push({ week_start: new Date(start).toISOString(), week_end: new Date(end).toISOString() });
  }
  return windows;
}

// Every series carries its own honesty discriminant, same rule as measured()
// above but for a 12-value array instead of a scalar: "measured_zero" means
// the query ran and genuinely found nothing across all 12 weeks; "not_run"
// (reserved — see file header) means there was no query to run at all. A
// series is never a bare array standing in for either state.
type SeriesKind = "measured" | "measured_zero" | "not_run";

function kindForTotal(total: number): SeriesKind {
  return total === 0 ? "measured_zero" : "measured";
}

interface DatedRow { iso: string | null }

// Counts `rows` into the 12 windows by their `iso` timestamp. A row with no
// timestamp (or an unparsable one) is dropped from the weekly buckets — it
// cannot honestly be placed in a week it has no date for — but the caller is
// responsible for surfacing that exclusion (see excluded_no_timestamp on the
// pre-approval funnel series below) rather than letting the count silently
// disagree with a scalar total computed elsewhere in this same response.
function countByWeek(rows: DatedRow[], windows: WeekWindow[]): number[] {
  const starts = windows.map((w) => new Date(w.week_start).getTime());
  const ends = windows.map((w) => new Date(w.week_end).getTime());
  const values = new Array(windows.length).fill(0);
  for (const row of rows) {
    if (!row.iso) continue;
    const t = new Date(row.iso).getTime();
    if (isNaN(t)) continue;
    for (let w = 0; w < windows.length; w++) {
      if (t >= starts[w] && t < ends[w]) {
        values[w]++;
        break;
      }
    }
  }
  return values;
}

interface WeeklySeries {
  kind: SeriesKind;
  unit: string;
  windows: WeekWindow[];
  values: number[];
  total: number;
  reason?: string; // present only when kind === "not_run"
}

function buildWeeklySeries(unit: string, rows: DatedRow[], windows: WeekWindow[]): WeeklySeries {
  const values = countByWeek(rows, windows);
  const total = values.reduce((a, b) => a + b, 0);
  return { kind: kindForTotal(total), unit, windows, values, total };
}

// A series with no live data source at all — distinct from a series whose
// query ran and returned zero (buildWeeklySeries above always returns that
// as "measured_zero"). Introduced in phase 2a with no caller yet; phase 5's
// GA4 visits series (buildVisitsSeries below) is the first one to actually
// reach kind:"not_run" — on any GA4 fetch failure, never a fabricated zero.
function notRunSeries(unit: string, windows: WeekWindow[], reason: string): WeeklySeries {
  return { kind: "not_run", unit, windows, values: new Array(windows.length).fill(0), total: 0, reason };
}

// ── gh-1574 (#1340 phase 5): GA4 sessions ("visits") weekly series ──────
// GA4 returns one row per calendar day ("YYYYMMDD" in the property's
// reporting timezone) carrying an already-aggregated `sessions` total for
// that day — unlike the Supabase-backed series above, which count individual
// rows, this one SUMS each day's total into whichever of the 12 rolling
// windows (buildWeekWindows) contains it. Midnight UTC of the GA4 date
// string stands in for "when that day happened", the same day-level (not
// sub-day) precision buildWeeklySeries already accepts for every other
// series in this file.
function ga4DateToIso(ga4Date: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ga4Date);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`;
  return isNaN(new Date(iso).getTime()) ? null : iso;
}

interface WeightedDatedRow { iso: string | null; value: number }

// Same [start, end) windowing as countByWeek, but SUMS row.value into the
// matching window instead of counting occurrences — countByWeek itself
// cannot be reused as-is because each GA4 daily row already represents many
// sessions, not one event.
function sumByWeek(rows: WeightedDatedRow[], windows: WeekWindow[]): number[] {
  const starts = windows.map((w) => new Date(w.week_start).getTime());
  const ends = windows.map((w) => new Date(w.week_end).getTime());
  const values = new Array(windows.length).fill(0);
  for (const row of rows) {
    if (!row.iso) continue;
    const t = new Date(row.iso).getTime();
    if (isNaN(t)) continue;
    for (let w = 0; w < windows.length; w++) {
      if (t >= starts[w] && t < ends[w]) {
        values[w] += row.value;
        break;
      }
    }
  }
  return values;
}

// gh-1340 body / phase 5 build note: "sessions ≈ totalUsers on a site with
// 22 signups in 12 weeks smells like crawler traffic" — a conversion rate
// built on this denominator without saying so would be a lie in the other
// direction. Carried on the series itself (same pattern as referral_clicks'
// caveat above) so no consumer of this payload can drop the caveat by
// forgetting to look it up elsewhere.
//
// gh-1637: replaces the old "unfiltered" text, which became false the
// moment the hostName filter shipped — this string is now accurate about
// BOTH remaining caveats: bot share within production is still unknown
// (#1464), and the property itself stays polluted by non-production
// traffic for historical windows until #1619 lands (the filter only fixes
// what gets COUNTED, not what the raw property contains).
const GA4_VISITS_CAVEAT =
  "GA4 sessions on the production hosts only (property 541423859) — bot share within " +
  "production still unknown (see #1464); the property itself is polluted by staging and " +
  "localhost traffic (see #1619).";

// gh-1574: all three audiences source the SAME site-wide GA4 property until
// per-audience GA4 dimensions exist — the issue asks that this be said in
// the payload, not just in this comment.
const GA4_VISITS_NOTE =
  "Sourced from the site-wide GA4 property (541423859), not this audience specifically — " +
  "per-audience GA4 dimensions do not exist yet (gh-1574).";

// gh-1637: `scope` / `property_id` / `hosts` are a PINNED payload contract —
// #1638 (the page half) and #1639 are written against these exact key
// names and must not have to guess them. `property_id` and `hosts` come
// straight off `ga4Result` (both branches of Ga4SessionsByDayResult carry
// them as of gh-1637 — see ga4.ts) rather than being re-derived here, so
// there is exactly one place ("the same resolution the client already
// does") that decides what was actually requested.
interface VisitsSeries extends WeeklySeries {
  scope: string;
  property_id: string;
  hosts: string[];
  caveat: string;
  note: string;
}

// Turns a fetchGa4SessionsByDay result into the `visits` series honoring the
// fail-loud contract: any GA4 failure is kind:"not_run" with the reason
// attached (never zeros standing in for "unmeasured"). gh-1637: scope/
// property_id/hosts are populated on BOTH branches — a not_run result still
// says what it would have counted.
function buildVisitsSeries(ga4Result: Ga4SessionsByDayResult, windows: WeekWindow[]): VisitsSeries {
  const scope = "production";
  if (!ga4Result.ok) {
    return {
      ...notRunSeries("sessions", windows, ga4Result.reason),
      scope,
      property_id: ga4Result.property_id,
      hosts: ga4Result.hosts,
      caveat: GA4_VISITS_CAVEAT,
      note: GA4_VISITS_NOTE,
    };
  }
  const dated = ga4Result.rows.map((r) => ({ iso: ga4DateToIso(r.date), value: r.sessions }));
  const values = sumByWeek(dated, windows);
  const total = values.reduce((a, b) => a + b, 0);
  return {
    kind: kindForTotal(total),
    unit: "sessions",
    windows,
    values,
    total,
    scope,
    property_id: ga4Result.property_id,
    hosts: ga4Result.hosts,
    caveat: GA4_VISITS_CAVEAT,
    note: GA4_VISITS_NOTE,
  };
}

interface GroupedRow extends DatedRow { group: string | null }

interface WeeklySeriesGroup { key: string; values: number[]; total: number }

interface GroupedWeeklySeries {
  kind: SeriesKind;
  unit: string;
  windows: WeekWindow[];
  groups: WeeklySeriesGroup[];
  total: number;
}

// Same contract as buildWeeklySeries, split by an arbitrary string key
// (agent_type, utm_source, lead source, ...). A row whose group value is
// null/blank is bucketed under "(unspecified)" rather than dropped — an
// unlabeled lead is still a real lead.
const UNSPECIFIED_GROUP = "(unspecified)";

function buildGroupedWeeklySeries(unit: string, rows: GroupedRow[], windows: WeekWindow[]): GroupedWeeklySeries {
  const byGroup = new Map<string, DatedRow[]>();
  for (const row of rows) {
    const key = row.group && row.group.trim() ? row.group.trim() : UNSPECIFIED_GROUP;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push({ iso: row.iso });
  }
  const groups = Array.from(byGroup.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, groupRows]) => {
      const values = countByWeek(groupRows, windows);
      return { key, values, total: values.reduce((a, b) => a + b, 0) };
    });
  const total = groups.reduce((sum, g) => sum + g.total, 0);
  return { kind: kindForTotal(total), unit, windows, groups, total };
}

interface FirstEventRow { group: string; iso: string | null }
interface FirstEventResult { firsts: DatedRow[]; excludedNoTimestamp: number }

// First occurrence per group, by the earliest `iso` seen for that group key
// — used for funnel stages where the event that matters is "first bid ever
// submitted by this contractor", not every bid. Groups with no valid
// timestamp anywhere are omitted (never invented) and their count is
// returned separately so the caller can surface it rather than let a total
// silently disagree with a scalar computed elsewhere in this response.
function firstEventPerGroup(rows: FirstEventRow[]): FirstEventResult {
  const earliest = new Map<string, number>();
  const groupsSeen = new Set<string>();
  let excludedNoTimestamp = 0;
  for (const row of rows) {
    groupsSeen.add(row.group);
    if (!row.iso) continue;
    const t = new Date(row.iso).getTime();
    if (isNaN(t)) continue;
    const prev = earliest.get(row.group);
    if (prev === undefined || t < prev) earliest.set(row.group, t);
  }
  for (const g of groupsSeen) {
    if (!earliest.has(g)) excludedNoTimestamp++;
  }
  const firsts: DatedRow[] = Array.from(earliest.values()).map((t) => ({ iso: new Date(t).toISOString() }));
  return { firsts, excludedNoTimestamp };
}

// ── activity_log, read whole ────────────────────────────────────────────
// PostgREST caps rows server-side (db-max-rows) and a truncated read does NOT
// error — it returns a smaller, entirely plausible number of days on the one
// column this dashboard exists to produce. With no ORDER BY, which rows survive
// a truncation is arbitrary. So: page it, ordered, until a page comes back
// EMPTY, and REFUSE rather than silently return a partial set if the page count
// runs away. (gh-1340, CTO review.)
//
// ⛔ The cursor advances by rows.length, NOT by a fixed page size, and the stop
// test is rows.length === 0, NOT rows.length < ACTIVITY_PAGE. This is the whole
// point and it is easy to "simplify" back into a bug: if the server's cap were
// SMALLER than ACTIVITY_PAGE, a short-page test would fire on the very first
// page and return early — silently dropping every row past the cap, which is
// exactly the defect this function exists to remove, reintroduced inside its
// own fix. Advancing by what the server actually returned is correct for ANY
// cap, which is what "immune to the cap's value" has to mean.
// (Caught by an adversarial refuter on the first version of this fix.)
const ACTIVITY_PAGE = 1000;
const ACTIVITY_MAX_PAGES = 500;

interface ActivityRow {
  user_id: string | null;
  created_at: string;
  // gh-1580 review fix (PR #1601, comment 5532211463): needed so this reducer
  // can exclude system-generated absence nudges (metadata.system_generated)
  // from movement/first-activity — see the exclusion below.
  metadata: Record<string, unknown> | null;
}

async function fetchAllActivity(
  // deno-lint-ignore no-explicit-any
  db: any,
): Promise<{ data: ActivityRow[] | null; error: { message: string } | null }> {
  const all: ActivityRow[] = [];
  let from = 0;
  for (let page = 0; page < ACTIVITY_MAX_PAGES; page++) {
    const { data, error } = await db
      .from("activity_log")
      .select("user_id, created_at, metadata")
      .order("created_at", { ascending: false })
      .range(from, from + ACTIVITY_PAGE - 1);
    if (error) return { data: null, error };
    const rows = (data ?? []) as ActivityRow[];
    if (rows.length === 0) return { data: all, error: null };
    all.push(...rows);
    from += rows.length;
  }
  return {
    data: null,
    error: { message: `activity_log exceeded ${ACTIVITY_MAX_PAGES} pages — refusing a silently truncated read` },
  };
}

// ── Revenue MTD (gh-1340 phase 4) — server-side Stripe read path ─────────
// Read-only GET against the Stripe API (house pattern: raw fetch on
// api.stripe.com/v1, Basic auth, live STRIPE_SECRET_KEY — same base as
// create-payment-intent / stripe-webhook, but no writes and no test-key
// fallback: test-mode charges are not revenue).
//
// Revenue MTD = Σ(amount − amount_refunded) over charges with
// status === "succeeded", created at/after the UTC month start. USD only;
// any non-USD charge is counted separately, never silently mixed in.
//
// HONESTY CONTRACT (gh-1340 body, scope item 4): when the path is
// unavailable — key not configured, HTTP error, runaway pagination — the
// result is kind:"not_run" with the query count and a reason, NEVER a
// fabricated $0. Pagination advances by Stripe's cursor (starting_after)
// and refuses loudly past REVENUE_MAX_PAGES rather than returning a
// possibly-truncated sum — same discipline as fetchAllActivity above.
const STRIPE_API_BASE = "https://api.stripe.com/v1";
const REVENUE_PAGE_LIMIT = 100; // Stripe's max page size
const REVENUE_MAX_PAGES = 50;   // 5,000 charges MTD ≫ current volume; loud refusal past this

interface RevenueMtd {
  kind: "measured" | "measured_zero" | "not_run";
  value_cents?: number;
  currency?: string;
  charge_count?: number;
  non_usd_ignored?: number;
  queries: number;
  window_start_iso: string;
  reason?: string;
}

async function fetchRevenueMtd(nowMs: number): Promise<RevenueMtd> {
  const nowDate = new Date(nowMs);
  const windowStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1));
  const base = { queries: 0, window_start_iso: windowStart.toISOString() };

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    return { kind: "not_run", ...base, reason: "STRIPE_SECRET_KEY is not configured in this function's environment" };
  }

  const basicAuth = btoa(`${stripeKey}:`);
  const createdGte = Math.floor(windowStart.getTime() / 1000);

  let totalCents = 0;
  let chargeCount = 0;
  let nonUsdIgnored = 0;
  let startingAfter: string | null = null;

  try {
    for (let page = 0; page < REVENUE_MAX_PAGES; page++) {
      const params = new URLSearchParams({ limit: String(REVENUE_PAGE_LIMIT) });
      params.set("created[gte]", String(createdGte));
      if (startingAfter) params.set("starting_after", startingAfter);

      const res = await fetch(`${STRIPE_API_BASE}/charges?${params.toString()}`, {
        headers: { Authorization: `Basic ${basicAuth}` },
      });
      base.queries++;

      if (!res.ok) {
        // Status is enough to act on; never forward Stripe's error body.
        console.error(`[${FUNCTION_NAME}] Stripe /charges returned ${res.status}`);
        return { kind: "not_run", ...base, reason: `Stripe API returned HTTP ${res.status}` };
      }

      const body = await res.json();
      const charges = (body?.data ?? []) as {
        id: string; amount: number; amount_refunded: number; status: string; currency: string;
      }[];

      for (const ch of charges) {
        if (ch.status !== "succeeded") continue;
        if (ch.currency !== "usd") { nonUsdIgnored++; continue; }
        totalCents += (ch.amount || 0) - (ch.amount_refunded || 0);
        chargeCount++;
      }

      if (!body?.has_more) {
        const result: RevenueMtd = {
          kind: totalCents === 0 ? "measured_zero" : "measured",
          value_cents: totalCents,
          currency: "usd",
          charge_count: chargeCount,
          ...base,
        };
        if (nonUsdIgnored > 0) result.non_usd_ignored = nonUsdIgnored;
        return result;
      }
      if (charges.length === 0) {
        // has_more on an empty page should be impossible; refuse rather than spin.
        return { kind: "not_run", ...base, reason: "Stripe returned has_more with an empty page — refusing" };
      }
      startingAfter = charges[charges.length - 1].id;
    }
    return { kind: "not_run", ...base, reason: `charges exceeded ${REVENUE_MAX_PAGES} pages — refusing a possibly-truncated sum` };
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Stripe read failed:`, err);
    return { kind: "not_run", ...base, reason: "Stripe request failed before a sum could be computed" };
  }
}

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
  }

  const supabaseUrl    = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnon   = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, corsHeaders);
  }

  // ── JWT verification — admin only (same pattern as get-payout-completion-status) ──
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, supabaseAnon || serviceRoleKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();

  if (userError || !userData?.user || !ADMIN_EMAILS.includes(userData.user.email ?? "")) {
    return jsonResponse({ ok: false, error: "Unauthorized — admin only" }, 401, corsHeaders);
  }

  // Service role for the cross-table read (profiles/quotes/referrals/activity_log
  // have no admin RLS).
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const now = Date.now();

    // Phase 4: Stripe read runs concurrently with the DB reads. It never
    // throws (worst case: kind "not_run" with a reason) and is deliberately
    // NOT in the all-tables error gate — a Stripe outage must degrade one
    // tile, not 500 the dashboard.
    const revenueMtdPromise = fetchRevenueMtd(now);

    // Phase 5 (gh-1574): GA4 sessions-by-day, same concurrency/never-throws/
    // outside-the-error-gate treatment as revenueMtdPromise above — a GA4
    // outage must degrade one series (kind:"not_run"), not 500 the dashboard.
    // 90 days covers the 12-week (84-day) trailing window with margin, same
    // range verified live in the issue body.
    const ga4VisitsPromise = fetchGa4SessionsByDay("90daysAgo", "today");

    // ── One query per table (no N+1) ──────────────────────────────────────
    const [
      profilesRes,
      claimsRes,
      quotesRes,
      contractorsRes,
      contractorTemplatesRes,
      feeAcceptancesRes,
      referralAgentsRes,
      referralsRes,
      activityLogRes,
      hoverOrdersRes,
      leadsRes,
    ] = await Promise.all([
      // profiles.role holds 'homeowner' | 'contractor' (verified live, 2026-08-31) —
      // contractors and referral partners have their own dedicated tables with
      // their own checklists, so the Homeowner audience must filter to
      // role='homeowner' or it silently lists contractors as homeowners.
      supabase.from("profiles").select("id, full_name, email, created_at, updated_at, is_test, role"),
      supabase.from("claims").select(
        "id, user_id, created_at, updated_at, hover_order_id, hover_status, has_measurements, " +
        "ready_for_bids, bids_submitted_at, selected_contractor_id, contract_sent_at, " +
        "contract_signed_at, platform_fee_charged, completion_date, color_selected_at, " +
        "deductible_collected_at, is_test"
      ),
      supabase.from("quotes").select(
        "id, claim_id, contractor_id, status, payment_status, contractor_signed_at, " +
        "homeowner_signed_at, created_at, updated_at, is_test"
      ),
      supabase.from("contractors").select(
        "id, user_id, company_name, email, created_at, updated_at, approved_at, " +
        "legacy_pre_approval, status, is_test"
      ),
      supabase.from("contractor_templates").select(
        "id, contractor_id, status, created_at, updated_at"
      ),
      supabase.from("fee_acceptances").select(
        "id, contractor_id, claim_id, accepted_at, created_at"
      ),
      supabase.from("referral_agents").select(
        "id, user_id, first_name, last_name, company, email, created_at, onboarded_at, status, " +
        "partner_agreement_accepted_at, total_commission_earned, total_commission_paid, is_test"
      ),
      supabase.from("referrals").select(
        "id, referral_agent_id, claim_id, commission_amount, commission_paid_at, created_at, is_test"
      ),
      // Trimmed columns — only what feeds "days since movement". Read WHOLE via
      // fetchAllActivity's ordered pagination (see above): an unbounded
      // .select() here is capped server-side by PostgREST and truncates
      // silently. Reduced in-memory to a per-user max() rather than N+1.
      fetchAllActivity(supabase),
      // gh-1469: needs created_at to weekly-bucket "measurement orders", so
      // this is no longer a head:true count — hoverOrdersCount below is
      // derived from data.length instead (same real number, one query, not
      // two: the count and the weekly series come from the same read).
      // hover_orders has no is_test column (verified against
      // information_schema, 2026-09-01) — every row here is counted as-is.
      supabase.from("hover_orders").select("id, created_at"),
      // leads has no is_test column either (same verification) — a raw
      // top-of-funnel capture table, counted as-is.
      supabase.from("leads").select("id, source, created_at"),
    ]);

    for (const [label, res] of [
      ["profiles", profilesRes], ["claims", claimsRes], ["quotes", quotesRes],
      ["contractors", contractorsRes], ["contractor_templates", contractorTemplatesRes],
      ["fee_acceptances", feeAcceptancesRes], ["referral_agents", referralAgentsRes],
      ["referrals", referralsRes], ["activity_log", activityLogRes], ["hover_orders", hoverOrdersRes],
      ["leads", leadsRes],
    ] as const) {
      if (res.error) {
        console.error(`[${FUNCTION_NAME}] ${label} read failed:`, res.error.message);
        return jsonResponse({ ok: false, error: `Read failed: ${label}` }, 500, corsHeaders);
      }
    }

    const allProfiles = profilesRes.data ?? [];
    // Homeowner audience is role-scoped — see the read comment above.
    const profiles = (allProfiles as any[]).filter((p) => p.role === "homeowner");
    const claims = claimsRes.data ?? [];
    const quotes = quotesRes.data ?? [];
    const contractors = contractorsRes.data ?? [];
    const contractorTemplates = contractorTemplatesRes.data ?? [];
    const feeAcceptances = feeAcceptancesRes.data ?? [];
    const referralAgents = referralAgentsRes.data ?? [];
    const referrals = referralsRes.data ?? [];
    const activityLog = activityLogRes.data ?? [];
    const hoverOrders = hoverOrdersRes.data ?? [];
    const hoverOrdersCount = hoverOrders.length;
    const leads = leadsRes.data ?? [];

    // ── activity_log reduced to last-movement-per-user (no N+1 downstream) ──
    //
    // gh-1580 review fix (PR #1601, comment 5532211463): a system-generated
    // "we nagged you because nothing happened" row (metadata.system_generated
    // === true — see send-homeowner-next-steps' activity_log insert) must NOT
    // count as movement here, or the feature undoes itself: sending the day-0
    // nudge would stamp a fresh activity_log row, which would (a) make
    // computeMovement/bucketFor read the claim as "green" again — the exact
    // false-freshness bug gh-1580 exists to fix — and (b) flip
    // first_activity_at from null to non-null, silently dropping the claim
    // out of admin-dashboard.html's "NEW — no activity since signup" strip
    // right after the system acts on it.
    //
    // This is a metadata FLAG, not a deny-list of specific event_type
    // strings, deliberately: this repo's Edge Function deploy path does not
    // resolve `_shared/` imports (see send-home-profile-prompt's emailButton
    // comment), so a constant shared between this file and every future
    // nudge-sending function cannot be enforced by import — only a shared
    // naming CONVENTION can. A per-event-type deny-list would need this file
    // updated every time any other Edge Function adds a new "system nagged
    // about inactivity" event type, and nothing would catch a forgotten
    // update (fails open). Requiring every such writer to set
    // metadata.system_generated = true is exactly as opt-in, but the
    // reader-side check here never needs to change again for a new event
    // type — only the writer needs to remember the one flag, at the point
    // where they're already choosing the event's semantics. (A real
    // fail-safe — an `activity_log.system_generated` COLUMN the writer can't
    // omit — would be stronger still, but that is a schema change: Tier 3 /
    // D-182, its own migration, and a decision about every existing writer's
    // default, which is out of scope for this fix.)
    const lastActivityByUser = new Map<string, string>();
    // gh-1580: also reduced to first-movement-per-user, so the CRM render can
    // show "no activity since signup" (null = never) without re-deriving it
    // client-side from a raw activity_log scan.
    const firstActivityByUser = new Map<string, string>();
    for (const row of activityLog as ActivityRow[]) {
      if (!row.user_id) continue;
      if ((row.metadata as { system_generated?: boolean } | null)?.system_generated === true) continue;
      const prevLast = lastActivityByUser.get(row.user_id);
      if (!prevLast || new Date(row.created_at).getTime() > new Date(prevLast).getTime()) {
        lastActivityByUser.set(row.user_id, row.created_at);
      }
      const prevFirst = firstActivityByUser.get(row.user_id);
      if (!prevFirst || new Date(row.created_at).getTime() < new Date(prevFirst).getTime()) {
        firstActivityByUser.set(row.user_id, row.created_at);
      }
    }

    const claimsById = new Map(claims.map((c: any) => [c.id, c]));

    // ══════════════════════════════════════════════════════════════════════
    // HOMEOWNER audience — one row per profile; checklist from that
    // profile's most-recently-updated claim (a homeowner with multiple
    // claims is represented by their latest one — the common case is one).
    // ══════════════════════════════════════════════════════════════════════
    const quotesByClaimId = new Map<string, any[]>();
    for (const q of quotes as any[]) {
      if (!q.claim_id) continue;
      if (!quotesByClaimId.has(q.claim_id)) quotesByClaimId.set(q.claim_id, []);
      quotesByClaimId.get(q.claim_id)!.push(q);
    }

    const claimsByUserId = new Map<string, any[]>();
    for (const c of claims as any[]) {
      if (!c.user_id) continue;
      if (!claimsByUserId.has(c.user_id)) claimsByUserId.set(c.user_id, []);
      claimsByUserId.get(c.user_id)!.push(c);
    }

    // gh-1580 review (PR #1601, comment 5532245612): homeownerRows is, and
    // was before this PR, ONE ROW PER PROFILE — userClaims[0] below picks
    // only the most-recently-updated claim; checklist/movement have always
    // reflected that single claim, never a homeowner's full claim history.
    // This PR's created_at/first_activity_at additions inherit that same
    // per-profile granularity, but the EMAIL side (send-homeowner-next-
    // steps) is per-CLAIM. The mismatch: for a homeowner with 2+ claims, an
    // older claim's activity_log history makes first_activity_at non-null
    // for the PROFILE, so a genuinely-stalled newer claim would correctly
    // still receive the nudge email (claim-scoped) but would never earn the
    // "NEW — no activity since signup" badge on admin-dashboard.html
    // (profile-scoped) — the two halves of gh-1580 would disagree for that
    // homeowner. Confirmed via Supabase MCP against prod (yeszghaspzwwstvsrioa)
    // at review time: 0 real homeowners currently hold >1 claim, so this
    // does not invalidate the closes-on artifact test today. Deliberately
    // NOT fixed here: doing so means moving every homeownerRows field
    // (checklist, movement, bidsReceived, all of it) to per-claim
    // granularity — i.e. one CRM row per claim instead of per homeowner —
    // which is a materially larger change than gh-1580's day-0/day-2 nudge
    // + NEW strip, touches the meaning of every existing homeowner row, and
    // is a product decision (does Dustin want one row or many per repeat
    // homeowner?) that deserves its own issue rather than expanding this
    // one. Bites again the day a second real homeowner claim exists.
    const homeownerRows = (profiles as any[]).map((p) => {
      const userClaims = (claimsByUserId.get(p.id) || []).slice().sort(
        (a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime()
      );
      const claim = userClaims[0] || null;
      const claimQuotes = claim ? (quotesByClaimId.get(claim.id) || []) : [];
      const bidsReceived = claimQuotes.length;

      const checklist = [
        { key: "account", label: "Account created", done: true },
        { key: "claim_created", label: "Claim created", done: !!claim },
        { key: "measurement_ordered", label: "Measurement ordered", done: !!claim && (!!claim.hover_order_id || !!claim.hover_status) },
        { key: "measurements_on_file", label: "Measurements on file", done: !!claim && claim.has_measurements === true },
        { key: "ready_for_bids", label: "Ready for bids", done: !!claim && claim.ready_for_bids === true },
        { key: "bids_received", label: "Bids received", done: bidsReceived > 0, count: bidsReceived },
        { key: "bid_accepted", label: "Bid accepted", done: !!claim && !!claim.selected_contractor_id },
        { key: "contract_signed", label: "Contract signed", done: !!claim && !!claim.contract_signed_at },
        { key: "fee_charged", label: "Platform fee charged", done: !!claim && claim.platform_fee_charged === true },
        { key: "complete", label: "Complete", done: !!claim && !!claim.completion_date },
      ];

      const movement = computeMovement(now, [
        { label: "profile updated_at", iso: p.updated_at },
        ...(claim ? [
          { label: "claim updated_at", iso: claim.updated_at },
          { label: "claim bids_submitted_at", iso: claim.bids_submitted_at },
          { label: "claim contract_sent_at", iso: claim.contract_sent_at },
          { label: "claim contract_signed_at", iso: claim.contract_signed_at },
          { label: "claim color_selected_at", iso: claim.color_selected_at },
          { label: "claim deductible_collected_at", iso: claim.deductible_collected_at },
          { label: "claim completion_date", iso: claim.completion_date },
        ] : []),
        { label: "activity_log last event", iso: lastActivityByUser.get(p.id) || null },
      ]);

      const isComplete = checklist[checklist.length - 1].done;

      return {
        id: p.id,
        label: p.full_name || p.email || p.id,
        is_test: p.is_test === true,
        checklist,
        movement: { ...movement, bucket: isComplete ? "complete" : movement.bucket },
        // gh-1580: signup time — the CRM render needs this to compute "age in
        // hours" for the NEW strip without a second derived source of truth.
        created_at: p.created_at,
        // gh-1580: null = never had an activity_log row. Admin CRM "NEW — no
        // activity since signup" strip keys off this rather than re-deriving
        // it from movement.bucket, which a freshly-created row buckets green
        // (see p.updated_at as a movement input above) regardless of activity.
        first_activity_at: firstActivityByUser.get(p.id) || null,
      };
    });

    // ══════════════════════════════════════════════════════════════════════
    // CONTRACTOR audience — one row per contractor.
    // ══════════════════════════════════════════════════════════════════════
    const templatesByContractor = new Map<string, any[]>();
    for (const t of contractorTemplates as any[]) {
      if (!templatesByContractor.has(t.contractor_id)) templatesByContractor.set(t.contractor_id, []);
      templatesByContractor.get(t.contractor_id)!.push(t);
    }
    const quotesByContractor = new Map<string, any[]>();
    for (const q of quotes as any[]) {
      if (!q.contractor_id) continue;
      if (!quotesByContractor.has(q.contractor_id)) quotesByContractor.set(q.contractor_id, []);
      quotesByContractor.get(q.contractor_id)!.push(q);
    }
    const feesByContractor = new Map<string, any[]>();
    for (const f of feeAcceptances as any[]) {
      if (!feesByContractor.has(f.contractor_id)) feesByContractor.set(f.contractor_id, []);
      feesByContractor.get(f.contractor_id)!.push(f);
    }
    // claims.selected_contractor_id derives "first bid accepted" — bid_status
    // on quotes only ever holds 'active' in this data, so it cannot answer
    // this question (gh-1340 thread spec delta, verified 2026-08-31).
    const acceptedClaimsByContractor = new Map<string, any[]>();
    for (const c of claims as any[]) {
      if (!c.selected_contractor_id) continue;
      if (!acceptedClaimsByContractor.has(c.selected_contractor_id)) acceptedClaimsByContractor.set(c.selected_contractor_id, []);
      acceptedClaimsByContractor.get(c.selected_contractor_id)!.push(c);
    }

    const contractorRows = (contractors as any[]).map((k) => {
      const templates = templatesByContractor.get(k.id) || [];
      const cQuotes = quotesByContractor.get(k.id) || [];
      const fees = feesByContractor.get(k.id) || [];
      const acceptedClaims = acceptedClaimsByContractor.get(k.id) || [];
      // quotes.payment_status reads 'succeeded', not 'paid' (spec delta).
      const paidQuote = cQuotes.find((q) => q.payment_status === "succeeded");

      const checklist = [
        { key: "account", label: "Account created", done: true },
        { key: "pre_approved", label: "Pre-approved", done: !!k.approved_at || k.legacy_pre_approval === true },
        { key: "template_submitted", label: "Template submitted", done: templates.length > 0, count: templates.length },
        { key: "template_approved", label: "Template approved", done: templates.some((t) => t.status === "approved") },
        { key: "first_bid_submitted", label: "First bid submitted", done: cQuotes.length > 0, count: cQuotes.length },
        { key: "first_bid_accepted", label: "First bid accepted", done: acceptedClaims.length > 0 },
        { key: "contract_signed", label: "Contract signed", done: cQuotes.some((q) => !!q.contractor_signed_at) || acceptedClaims.some((c) => !!c.contract_signed_at) },
        { key: "fee_accepted", label: "Fee accepted", done: fees.length > 0 },
        { key: "payment_succeeded", label: "Payment succeeded", done: !!paidQuote },
      ];

      const movement = computeMovement(now, [
        { label: "contractor updated_at", iso: k.updated_at },
        ...cQuotes.map((q) => ({ label: "quote updated_at", iso: q.updated_at })),
        ...templates.map((t) => ({ label: "template updated_at", iso: t.updated_at })),
        ...fees.map((f) => ({ label: "fee accepted_at", iso: f.accepted_at || f.created_at })),
        { label: "activity_log last event", iso: lastActivityByUser.get(k.user_id) || null },
      ]);

      const isComplete = checklist[checklist.length - 1].done;

      return {
        id: k.id,
        label: k.company_name || k.email || k.id,
        is_test: k.is_test === true,
        checklist,
        movement: { ...movement, bucket: isComplete ? "complete" : movement.bucket },
      };
    });

    // ══════════════════════════════════════════════════════════════════════
    // REFERRAL PARTNER audience — one row per referral_agents row.
    // ══════════════════════════════════════════════════════════════════════
    const referralsByAgent = new Map<string, any[]>();
    for (const r of referrals as any[]) {
      if (!referralsByAgent.has(r.referral_agent_id)) referralsByAgent.set(r.referral_agent_id, []);
      referralsByAgent.get(r.referral_agent_id)!.push(r);
    }

    const referralPartnerRows = (referralAgents as any[]).map((a) => {
      const agentReferrals = referralsByAgent.get(a.id) || [];
      const linkedClaims = agentReferrals
        .map((r) => (r.claim_id ? claimsById.get(r.claim_id) : null))
        .filter(Boolean) as any[];
      const commissionEarned = (a.total_commission_earned || 0) > 0 ||
        agentReferrals.some((r) => (r.commission_amount || 0) > 0);
      const commissionPaid = (a.total_commission_paid || 0) > 0 ||
        agentReferrals.some((r) => !!r.commission_paid_at);

      const checklist = [
        { key: "account", label: "Account created", done: true },
        { key: "onboarded", label: "Onboarded", done: !!a.onboarded_at || a.status === "active" },
        { key: "agreement_accepted", label: "Partner agreement accepted", done: !!a.partner_agreement_accepted_at },
        { key: "first_referral_sent", label: "First referral sent", done: agentReferrals.length > 0, count: agentReferrals.length },
        { key: "referral_claim_linked", label: "Referral linked to a claim", done: agentReferrals.some((r) => !!r.claim_id) },
        { key: "referral_bid_accepted", label: "Referred bid accepted", done: linkedClaims.some((c) => !!c.selected_contractor_id) },
        { key: "contract_signed", label: "Contract signed", done: linkedClaims.some((c) => !!c.contract_signed_at) },
        { key: "commission_earned", label: "Commission earned", done: commissionEarned },
        { key: "commission_paid", label: "Commission paid", done: commissionPaid },
      ];

      const movement = computeMovement(now, [
        { label: "referral_agents created_at", iso: a.created_at },
        { label: "referral_agents onboarded_at", iso: a.onboarded_at },
        ...agentReferrals.map((r) => ({ label: "referral created_at", iso: r.created_at })),
        ...agentReferrals.map((r) => ({ label: "referral commission_paid_at", iso: r.commission_paid_at })),
        { label: "activity_log last event", iso: lastActivityByUser.get(a.user_id) || null },
      ]);

      const isComplete = checklist[checklist.length - 1].done;

      return {
        id: a.id,
        label: [a.first_name, a.last_name].filter(Boolean).join(" ") || a.company || a.email || a.id,
        is_test: a.is_test === true,
        checklist,
        movement: { ...movement, bucket: isComplete ? "complete" : movement.bucket },
      };
    });

    // ══════════════════════════════════════════════════════════════════════
    // gh-1469 phase 2a — 12-week marketing series, one block per audience.
    // Every series is real; none of the six named in the issue title lacks a
    // live source as of this phase (verified against information_schema,
    // 2026-09-01). Non-test rows only, mirroring this EF's existing default
    // (nonTest() below) — except leads and hover_orders, which have no
    // is_test column at all and are counted as-is (documented at their
    // query above).
    // ══════════════════════════════════════════════════════════════════════
    const weekWindows = buildWeekWindows(now, MARKETING_WEEKS);

    // gh-1574 phase 5 — resolve the concurrently-kicked-off GA4 fetch and
    // build the ONE `visits` series shared across all three audiences below
    // (same underlying site-wide property, per GA4_VISITS_NOTE above).
    const ga4VisitsResult = await ga4VisitsPromise;
    const visitsSeries = buildVisitsSeries(ga4VisitsResult, weekWindows);

    const nonTestRows = <T extends { is_test?: boolean }>(rows: T[]) => rows.filter((r) => r.is_test !== true);

    // ── Homeowner marketing ──────────────────────────────────────────────
    const homeownerMarketing = {
      signups: buildWeeklySeries(
        "profiles",
        nonTestRows(profiles as any[]).map((p) => ({ iso: p.created_at as string | null })),
        weekWindows,
      ),
      claims: buildWeeklySeries(
        "claims",
        nonTestRows(claims as any[]).map((c) => ({ iso: c.created_at as string | null })),
        weekWindows,
      ),
      measurement_orders: buildWeeklySeries(
        "hover_orders",
        (hoverOrders as any[]).map((h) => ({ iso: h.created_at as string | null })),
        weekWindows,
      ),
      leads_by_source: buildGroupedWeeklySeries(
        "leads",
        (leads as any[]).map((l) => ({ iso: l.created_at as string | null, group: l.source as string | null })),
        weekWindows,
      ),
      visits: visitsSeries,
    };

    // ── Contractor marketing — funnel: pre-approval → template → first bid ─
    // Each stage counts the FIRST time a contractor reached it, bucketed by
    // when that first event happened — a funnel over time, not a raw event
    // count (a contractor submitting 4 templates should not inflate
    // "template" 4x in one week).
    const nonTestContractors = nonTestRows(contractors as any[]);
    const nonTestContractorIds = new Set(nonTestContractors.map((k: any) => k.id));

    // Pre-approval's timestamp is approved_at; legacy_pre_approval-only
    // contractors (approved via the pre-#1340 flow, no approved_at) have no
    // date to bucket by — excluded from the weekly series and counted
    // separately rather than silently missing from the total (see
    // firstEventPerGroup's excludedNoTimestamp).
    const preApproval = firstEventPerGroup(
      nonTestContractors
        .filter((k: any) => !!k.approved_at || k.legacy_pre_approval === true)
        .map((k: any) => ({ group: k.id as string, iso: (k.approved_at as string | null) ?? null })),
    );
    const templateSubmitted = firstEventPerGroup(
      (contractorTemplates as any[])
        .filter((t: any) => nonTestContractorIds.has(t.contractor_id))
        .map((t: any) => ({ group: t.contractor_id as string, iso: t.created_at as string | null })),
    );
    const firstBid = firstEventPerGroup(
      (quotes as any[])
        .filter((q: any) => q.contractor_id && nonTestContractorIds.has(q.contractor_id) && q.is_test !== true)
        .map((q: any) => ({ group: q.contractor_id as string, iso: q.created_at as string | null })),
    );

    const contractorMarketing = {
      funnel: {
        pre_approval: {
          ...buildWeeklySeries("contractors", preApproval.firsts, weekWindows),
          excluded_no_timestamp: preApproval.excludedNoTimestamp,
        },
        template_submitted: {
          ...buildWeeklySeries("contractor_templates", templateSubmitted.firsts, weekWindows),
          excluded_no_timestamp: templateSubmitted.excludedNoTimestamp,
        },
        first_bid: {
          ...buildWeeklySeries("quotes", firstBid.firsts, weekWindows),
          excluded_no_timestamp: firstBid.excludedNoTimestamp,
        },
      },
      visits: visitsSeries,
    };

    // ── Referral partner marketing — signups by agent_type / UTM, clicks ──
    const nonTestReferralAgents = nonTestRows(referralAgents as any[]);
    const REFERRAL_CLICK_CAVEAT =
      "gh-1302: one click could write two `referrals` rows (ref.html and its " +
      "landing page both tracked the same click). Fixed 2026-08-29T22:19:36Z " +
      "(PR #1361, RPC-side 10s dedupe) — rows created before that timestamp " +
      "are NOT backfilled and may overcount clicks by roughly 2x. This " +
      "series' 12-week window spans that boundary.";

    const referralPartnerMarketing = {
      partner_signups_by_agent_type: buildGroupedWeeklySeries(
        "referral_agents",
        nonTestReferralAgents.map((a: any) => ({
          iso: a.created_at as string | null,
          group: a.agent_type as string | null,
        })),
        weekWindows,
      ),
      partner_signups_by_utm_source: buildGroupedWeeklySeries(
        "referral_agents",
        nonTestReferralAgents.map((a: any) => ({
          iso: a.created_at as string | null,
          group: a.utm_source as string | null,
        })),
        weekWindows,
      ),
      referral_clicks: {
        ...buildWeeklySeries(
          "referrals",
          nonTestRows(referrals as any[]).map((r: any) => ({ iso: r.created_at as string | null })),
          weekWindows,
        ),
        caveat: REFERRAL_CLICK_CAVEAT,
        caveat_ref: "https://github.com/StellarEdgeServices/otterquote-platform/issues/1302",
      },
      visits: visitsSeries,
    };

    // ══════════════════════════════════════════════════════════════════════
    // Top page — all SES business lines.
    // ══════════════════════════════════════════════════════════════════════
    const nonTest = (rows: any[]) => rows.filter((r) => !r.is_test);

    const revenueMtd = await revenueMtdPromise;

    const otterQuotesLine = {
      key: "otterquotes",
      label: "Otter Quotes",
      operational: true,
      // Phase 4 — its own honesty state (measured / measured_zero / not_run),
      // deliberately NOT inside stats: every stats value is a measured() DB
      // count, and this one can legitimately be "not_run".
      revenue_mtd: revenueMtd,
      stats: {
        homeowners_total: measured(profiles.length),
        homeowners_non_test: measured(nonTest(profiles as any[]).length),
        claims_total: measured(claims.length),
        claims_non_test: measured((claims as any[]).filter((c) => !c.is_test).length),
        contractors_total: measured(contractors.length),
        contractors_non_test: measured(nonTest(contractors as any[]).length),
        referral_partners_total: measured(referralAgents.length),
        referral_partners_non_test: measured(nonTest(referralAgents as any[]).length),
        measurement_orders: measured(hoverOrdersCount),
      },
    };

    // OQ CRM (separate Supabase project, phase 3), OQOM and Voice AI have no
    // aggregate read path yet — named explicitly as NOT OPERATIONAL rather
    // than silently omitted or rendered as a zero. This is a status, not a
    // measurement: distinct again from MEASURED ZERO and from NOT MEASURED.
    const notYetBuiltLine = (key: string, label: string, note: string) => ({
      key, label, operational: false, status_note: note,
      issues_url: "https://github.com/StellarEdgeServices/otterquote-platform/issues",
    });

    const lines = [
      otterQuotesLine,
      notYetBuiltLine("otter-crm", "Otter CRM", "Different Supabase project; no admin aggregate yet (gh-1340 phase 3)."),
      notYetBuiltLine("oqom", "OQOM", "No admin aggregate built yet."),
      notYetBuiltLine("voice-ai", "Voice AI", "No admin aggregate built yet."),
    ];

    return jsonResponse({
      ok: true,
      generated_at: new Date(now).toISOString(),
      lines,
      audiences: {
        homeowner: { rows: homeownerRows, marketing: homeownerMarketing },
        contractor: { rows: contractorRows, marketing: contractorMarketing },
        referral_partner: { rows: referralPartnerRows, marketing: referralPartnerMarketing },
      },
    }, 200, corsHeaders);

  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Unhandled error:`, err);
    return jsonResponse({ ok: false, error: "Internal server error" }, 500, corsHeaders);
  }
});
