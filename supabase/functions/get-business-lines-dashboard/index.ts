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
 * Read-only. No writes, no schema change, no other EF touched.
 *
 * Input:  POST {}  (body currently unused — reserved for future filtering)
 * Output: { ok: true, generated_at, lines: [...], audiences: { homeowner, contractor, referral_partner } }
 *
 * Auth: requires a valid Supabase JWT with email in the admin allow-list.
 * verify_jwt = false (see supabase/config.toml) — auth is performed
 * in-handler, same pattern as get-payout-completion-status / approve-payout.
 *
 * GitHub: #1340
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FUNCTION_NAME = "get-business-lines-dashboard";
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

interface ActivityRow { user_id: string | null; created_at: string }

async function fetchAllActivity(
  // deno-lint-ignore no-explicit-any
  db: any,
): Promise<{ data: ActivityRow[] | null; error: { message: string } | null }> {
  const all: ActivityRow[] = [];
  let from = 0;
  for (let page = 0; page < ACTIVITY_MAX_PAGES; page++) {
    const { data, error } = await db
      .from("activity_log")
      .select("user_id, created_at")
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
      supabase.from("hover_orders").select("id", { count: "exact", head: true }),
    ]);

    for (const [label, res] of [
      ["profiles", profilesRes], ["claims", claimsRes], ["quotes", quotesRes],
      ["contractors", contractorsRes], ["contractor_templates", contractorTemplatesRes],
      ["fee_acceptances", feeAcceptancesRes], ["referral_agents", referralAgentsRes],
      ["referrals", referralsRes], ["activity_log", activityLogRes], ["hover_orders", hoverOrdersRes],
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
    const hoverOrdersCount = hoverOrdersRes.count ?? 0;

    // ── activity_log reduced to last-movement-per-user (no N+1 downstream) ──
    const lastActivityByUser = new Map<string, string>();
    for (const row of activityLog as { user_id: string | null; created_at: string }[]) {
      if (!row.user_id) continue;
      const prev = lastActivityByUser.get(row.user_id);
      if (!prev || new Date(row.created_at).getTime() > new Date(prev).getTime()) {
        lastActivityByUser.set(row.user_id, row.created_at);
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
    // Top page — all SES business lines.
    // ══════════════════════════════════════════════════════════════════════
    const nonTest = (rows: any[]) => rows.filter((r) => !r.is_test);

    const otterQuotesLine = {
      key: "otterquotes",
      label: "Otter Quotes",
      operational: true,
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
        homeowner: { rows: homeownerRows },
        contractor: { rows: contractorRows },
        referral_partner: { rows: referralPartnerRows },
      },
    }, 200, corsHeaders);

  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Unhandled error:`, err);
    return jsonResponse({ ok: false, error: "Internal server error" }, 500, corsHeaders);
  }
});
