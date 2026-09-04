/**
 * OtterQuote Edge Function: get-homeowner-list
 *
 * gh-1653 — Homeowner tracking on the admin PWA. Dustin: "I need a way to
 * track homeowners. That's not there yet."
 *
 * admin-homeowners.html needs ONE ROW PER CLAIM with the homeowner's identity
 * (name or email as held), a plainly-worded status, created_at, and how long
 * the claim has sat at its current status. claims already carries an admin
 * SELECT policy (claims_admin_select, is_admin_email()) so the page could
 * read claims directly — but the homeowner's identity lives on profiles,
 * which has NO admin RLS read policy (verified live 2026-09-04: 0 of 5 real
 * claims carry claims.homeowner_name; every one has profiles.full_name +
 * email). Same reason get-payout-completion-status and
 * get-business-lines-dashboard exist: the join happens here with the service
 * role behind the admin allow-list, and only the joined, per-claim row
 * crosses the wire — never a raw profiles row.
 *
 * Dwell ("days at current status") is computed HERE, never client-side —
 * it is the product this list exists to show. Basis: claims.updated_at.
 * Neither a status-changed timestamp on claims nor a status-change
 * activity_log event exists (see rows.ts HomeownerRow.dwell_basis for the
 * verification and the lower-bound caveat); the response says so in
 * `dwell_basis` and the page labels the number "since last change".
 *
 * Read-only. No writes, no schema change, no other EF touched.
 *
 * Input:  POST {}  (body unused — reserved)
 * Output: { ok: true, generated_at, dwell_basis: "updated_at", rows: HomeownerRow[] }
 *         rows sorted longest-dwell first; is_test rows INCLUDED (the page
 *         hides them by default — a display filter, not a refetch).
 *
 * Auth: requires a valid Supabase JWT with email in the admin allow-list.
 * verify_jwt = false (see supabase/config.toml) — auth is performed
 * in-handler, same pattern as get-payout-completion-status /
 * get-business-lines-dashboard.
 *
 * GitHub: #1653
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { buildRows, type ClaimIn, type ProfileIn } from "./rows.ts";

const FUNCTION_NAME = "get-homeowner-list";
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

  // Service role for the cross-table read (profiles has no admin RLS).
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    const now = Date.now();

    // One query per table (no N+1). Column lists are the exact fields
    // rows.ts consumes — nothing else leaves the database.
    const [claimsRes, profilesRes] = await Promise.all([
      supabase.from("claims").select(
        "id, user_id, status, created_at, updated_at, trades, job_type, funding_type, is_test, homeowner_name"
      ),
      supabase.from("profiles").select("id, full_name, email"),
    ]);

    for (const [label, res] of [["claims", claimsRes], ["profiles", profilesRes]] as const) {
      if (res.error) {
        console.error(`[${FUNCTION_NAME}] ${label} read failed:`, res.error.message);
        return jsonResponse({ ok: false, error: `Read failed: ${label}` }, 500, corsHeaders);
      }
    }

    const rows = buildRows(
      (claimsRes.data ?? []) as ClaimIn[],
      (profilesRes.data ?? []) as ProfileIn[],
      now,
    );

    return jsonResponse({
      ok: true,
      generated_at: new Date(now).toISOString(),
      dwell_basis: "updated_at",
      rows,
    }, 200, corsHeaders);

  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Unhandled error:`, err);
    return jsonResponse({ ok: false, error: "Internal server error" }, 500, corsHeaders);
  }
});
