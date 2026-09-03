/**
 * OtterQuote Edge Function: get-payout-completion-status
 *
 * D-139 / #567 — Admin read: job-completion status for payout rows
 *
 * admin-payouts.html needs a "Job complete / In progress" badge per payout row
 * (payout → referral → claim → completion_date), but claims and referrals
 * carry no admin RLS read policy, so the page cannot make that join with the
 * anon client. This EF performs the join with the service role behind the same
 * admin allow-list as approve-payout. Read-only — no writes.
 *
 * Input:  POST { payout_approval_ids: string[] }   (max 500 per call)
 * Output: { ok: true, statuses: { [payout_approval_id]: boolean } }
 *   true  = the linked claim has completion_date set
 *   false = no referral / no claim / completion_date NULL / id not found
 *
 * Auth: requires a valid Supabase JWT with email in the admin allow-list.
 * verify_jwt = false (see supabase/config.toml) — auth is performed in-handler,
 * same pattern as approve-payout / reject-payout.
 *
 * GitHub: #567
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

const FUNCTION_NAME = "get-payout-completion-status";
// gh-1534: kept in sync with supabase/functions/_shared/admin.ts ADMIN_EMAILS — do not
// edit this array without updating that file too (deploy path does not resolve imports).
const ADMIN_EMAILS  = ["dustinstohler1@gmail.com", "dustin@otterquote.com"];
const MAX_IDS       = 500;

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

  // ── JWT verification — admin only (same pattern as approve-payout) ─────────
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, supabaseAnon || serviceRoleKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();

  if (userError || !userData?.user || !ADMIN_EMAILS.includes(userData.user.email ?? "")) {
    return jsonResponse({ ok: false, error: "Unauthorized — admin only" }, 401, corsHeaders);
  }

  // Service role for the cross-table read (claims/referrals have no admin RLS).
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch (_) {
      return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, corsHeaders);
    }

    const rawIds = body.payout_approval_ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      return jsonResponse({ ok: false, error: "payout_approval_ids (non-empty array) is required" }, 400, corsHeaders);
    }
    if (rawIds.length > MAX_IDS) {
      return jsonResponse({ ok: false, error: `Too many ids — max ${MAX_IDS} per call` }, 400, corsHeaders);
    }
    const ids = rawIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);

    // Every requested id defaults to false (incomplete / unknown) — fail-safe,
    // matching the payout-release gates.
    const statuses: Record<string, boolean> = {};
    for (const id of ids) statuses[id] = false;

    // payout_approvals → referral_id
    const { data: approvals, error: apprErr } = await supabase
      .from("payout_approvals")
      .select("id, referral_id")
      .in("id", ids);
    if (apprErr) {
      console.error(`[${FUNCTION_NAME}] payout_approvals lookup failed:`, apprErr.message);
      return jsonResponse({ ok: false, error: "Lookup failed" }, 500, corsHeaders);
    }

    const referralIds = [...new Set((approvals ?? []).map(a => a.referral_id).filter(Boolean))] as string[];
    if (referralIds.length === 0) {
      return jsonResponse({ ok: true, statuses }, 200, corsHeaders);
    }

    // referrals → claim_id
    const { data: referrals, error: refErr } = await supabase
      .from("referrals")
      .select("id, claim_id")
      .in("id", referralIds);
    if (refErr) {
      console.error(`[${FUNCTION_NAME}] referrals lookup failed:`, refErr.message);
      return jsonResponse({ ok: false, error: "Lookup failed" }, 500, corsHeaders);
    }
    const claimByReferral: Record<string, string> = {};
    for (const r of referrals ?? []) {
      if (r.claim_id) claimByReferral[r.id as string] = r.claim_id as string;
    }

    const claimIds = [...new Set(Object.values(claimByReferral))];
    const completeClaims = new Set<string>();
    if (claimIds.length > 0) {
      // claims → completion_date
      const { data: claims, error: claimErr } = await supabase
        .from("claims")
        .select("id, completion_date")
        .in("id", claimIds);
      if (claimErr) {
        console.error(`[${FUNCTION_NAME}] claims lookup failed:`, claimErr.message);
        return jsonResponse({ ok: false, error: "Lookup failed" }, 500, corsHeaders);
      }
      for (const c of claims ?? []) {
        if (c.completion_date != null) completeClaims.add(c.id as string);
      }
    }

    for (const a of approvals ?? []) {
      const claimId = a.referral_id ? claimByReferral[a.referral_id as string] : undefined;
      statuses[a.id as string] = claimId != null && completeClaims.has(claimId);
    }

    return jsonResponse({ ok: true, statuses }, 200, corsHeaders);

  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Unhandled error:`, err);
    return jsonResponse({ ok: false, error: "Internal server error" }, 500, corsHeaders);
  }
});
