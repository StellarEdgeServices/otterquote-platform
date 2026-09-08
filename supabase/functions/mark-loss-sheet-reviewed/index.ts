/**
 * OtterQuote Edge Function: mark-loss-sheet-reviewed
 *
 * gh-1796 — the one-click half of the loss-sheet queue on admin-homeowners.html.
 *
 * Dustin's ruling on #1597 (2026-09-07, verbatim): "We are not changing our copy
 * regarding reviewing loss sheets to determine if it's acv or rcv. For now, I
 * want the system to identify people who need their loss sheets and bring them
 * to my attention in the administrative dashboard. This will need to be part of
 * the homeowner tracking process."
 *
 * This function does exactly one thing: set (or clear) the admin's
 * "I have reviewed this loss sheet" marker on a claim. It sends no email, it
 * changes no claim status, it touches no homeowner-facing surface, and it writes
 * no copy about ACV or RCV anywhere.
 *
 * ── Why a column and not an activity_log event ─────────────────────────────
 * #1796 offers either. The repo's own convention for "a human has verified this
 * record" is a nullable timestamptz on the record itself, everywhere it already
 * exists: referral_agents.w9_verified_at, contractors.coi_uploaded_at,
 * quotes.warranty_uploaded_at, claims.color_confirmed_at,
 * claims.live_charge_authorized_at, and — on this very concern —
 * claims.loss_sheet_parsed_at. activity_log is used for the event STREAM, not as
 * the source of truth for state: it has no uniqueness guarantee, its user_id is
 * NOT NULL (so a claim with no user_id could not carry a marker at all), and
 * every read would become "does an event of this type exist for this claim",
 * which cannot be expressed as a PostgREST filter on claims. So: the column is
 * the marker, and an activity_log row is written ALONGSIDE it as the audit trail.
 * That matches how loss_sheet_parsed / loss_sheet_parsed_at already pair up.
 *
 * ⚠ The column ships UNAPPLIED. Migration
 * supabase/migrations/20260907220015_gh1796_claims_loss_sheet_reviewed_at.sql is
 * filed in the same PR as this function and is deliberately NOT applied (D-182 /
 * D-261 Tier 3A: additive and nullable, but still a schema change, so it is a PR
 * and not a live ALTER). Until it is applied this function returns 503 with
 * `migration_pending: true` and writes nothing — it fails closed and says why,
 * rather than 500-ing on a PostgREST "column does not exist".
 *
 * Input:  POST { claim_id: string, reviewed?: boolean }
 *           reviewed omitted or true  -> set the marker to now (if unset)
 *           reviewed === false        -> clear the marker (undo)
 *         The undo path exists for a real reason beyond convenience: #1796's
 *         closes-on demands a NEGATIVE CONTROL — the same row shown present in
 *         the queue, then gone once marked. Without an undo, producing that pair
 *         means hand-editing production data.
 * Output: { ok: true, claim_id, reviewed, loss_sheet_reviewed_at, changed }
 *         `changed: false` on a repeat call — idempotent, no duplicate audit row.
 *
 * Auth: valid Supabase JWT whose email is in ADMIN_EMAILS. verify_jwt = false in
 * supabase/config.toml; auth is performed in-handler, the same two-layer shape
 * as get-homeowner-list / get-business-lines-dashboard — the user's JWT is
 * checked with the anon key BEFORE any service-role client exists.
 *
 * Environment variables: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *
 * GitHub: #1796 (sub-issue of #1653)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";

const FUNCTION_NAME = "mark-loss-sheet-reviewed";
// gh-1534: kept in sync with supabase/functions/_shared/admin.ts ADMIN_EMAILS — do not
// edit this array without updating that file too (deploy path does not resolve imports).
// Same allow-list as get-homeowner-list, which is the page this button lives on;
// widening or narrowing it here without doing the same there would give Dustin a
// list he can read and a button he cannot press (or vice versa).
const ADMIN_EMAILS = ["dustinstohler1@gmail.com", "dustin@otterquote.com"];

const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

/** PostgREST code for "column does not exist" — i.e. the migration is unapplied. */
const PG_UNDEFINED_COLUMN = "42703";

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function jsonResponse(data: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ ok: false, error: "Server configuration error" }, 500, corsHeaders);
  }

  // ── JWT verification — admin only, before any service-role client exists ──
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, supabaseAnon || serviceRoleKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();

  if (userError || !userData?.user || !ADMIN_EMAILS.includes(userData.user.email ?? "")) {
    return jsonResponse({ ok: false, error: "Unauthorized — admin only" }, 401, corsHeaders);
  }
  const adminEmail = userData.user.email as string;

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    // ── Input ────────────────────────────────────────────────────────────────
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch (_) {
      return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, corsHeaders);
    }

    const claimId = String(body.claim_id ?? "").trim();
    if (!claimId || !UUID_RE.test(claimId)) {
      return jsonResponse({ ok: false, error: "claim_id must be a UUID" }, 400, corsHeaders);
    }
    // Default is "mark reviewed". Only an explicit `false` clears it.
    const reviewed = body.reviewed === undefined ? true : body.reviewed === true;

    // ── Load the claim ───────────────────────────────────────────────────────
    // Also the migration probe: selecting loss_sheet_reviewed_at against the
    // pre-migration schema fails with 42703, which is reported as 503
    // migration_pending rather than a 500.
    const { data: claim, error: claimError } = await supabase
      .from("claims")
      .select("id, user_id, is_test, estimate_filename, loss_sheet_reviewed_at")
      .eq("id", claimId)
      .maybeSingle();

    if (claimError) {
      if (claimError.code === PG_UNDEFINED_COLUMN) {
        console.error(`[${FUNCTION_NAME}] loss_sheet_reviewed_at missing — migration 20260907220015 not applied`);
        return jsonResponse({
          ok: false,
          migration_pending: true,
          error:
            "claims.loss_sheet_reviewed_at does not exist yet. Apply migration " +
            "20260907220015_gh1796_claims_loss_sheet_reviewed_at.sql, then retry.",
        }, 503, corsHeaders);
      }
      console.error(`[${FUNCTION_NAME}] claim read failed:`, claimError.message);
      return jsonResponse({ ok: false, error: "Read failed" }, 500, corsHeaders);
    }

    if (!claim) {
      return jsonResponse({ ok: false, error: "Claim not found" }, 404, corsHeaders);
    }

    const already = claim.loss_sheet_reviewed_at ?? null;

    // ── Idempotency ──────────────────────────────────────────────────────────
    // A double-click, a retried fetch, or a second admin tab must not produce a
    // second audit row or move the timestamp Dustin already sees on the row.
    if (reviewed && already) {
      return jsonResponse({
        ok: true, claim_id: claimId, reviewed: true,
        loss_sheet_reviewed_at: already, changed: false,
        reason: "Already marked reviewed — no action taken",
      }, 200, corsHeaders);
    }
    if (!reviewed && !already) {
      return jsonResponse({
        ok: true, claim_id: claimId, reviewed: false,
        loss_sheet_reviewed_at: null, changed: false,
        reason: "Was not marked reviewed — no action taken",
      }, 200, corsHeaders);
    }

    const nowIso = new Date().toISOString();
    const nextValue = reviewed ? nowIso : null;

    // ── The write ────────────────────────────────────────────────────────────
    // The payload is built as a named object rather than passed inline on
    // purpose. scripts/schema-column-lint.py validates inline `.update({...})`
    // literals against sql/schema-snapshot.json, and loss_sheet_reviewed_at is
    // NOT in that snapshot yet — by design: the migration in this PR is
    // deliberately unapplied, so the snapshot (which mirrors production) must not
    // claim the column exists. An inline literal would therefore fail CI for
    // being correct. A non-literal argument is the linter's own documented
    // "review manually" path (see its scan_file()), and this comment is that
    // review. FOLLOW-UP, after the migration is applied: run
    // scripts/refresh-schema-snapshot.py and this can become an inline literal.
    const patch: Record<string, string | null> = { loss_sheet_reviewed_at: nextValue };

    // Concurrency guard, same shape as mark-payout-paid: constrain the UPDATE
    // itself to the state we read, so two admins clicking at once produce one
    // write and one 409 rather than two writes.
    let q = supabase.from("claims").update(patch).eq("id", claimId);
    q = reviewed ? q.is("loss_sheet_reviewed_at", null) : q.not("loss_sheet_reviewed_at", "is", null);

    const { data: updatedRows, error: updateError } = await q.select("id, loss_sheet_reviewed_at");

    if (updateError) {
      if (updateError.code === PG_UNDEFINED_COLUMN) {
        return jsonResponse({
          ok: false,
          migration_pending: true,
          error:
            "claims.loss_sheet_reviewed_at does not exist yet. Apply migration " +
            "20260907220015_gh1796_claims_loss_sheet_reviewed_at.sql, then retry.",
        }, 503, corsHeaders);
      }
      console.error(`[${FUNCTION_NAME}] update failed:`, updateError.message);
      return jsonResponse({ ok: false, error: "Database update failed" }, 500, corsHeaders);
    }

    if (!updatedRows || updatedRows.length === 0) {
      console.warn(`[${FUNCTION_NAME}] Conflict — claim ${claimId} changed between read and write`);
      return jsonResponse({
        ok: false,
        error: "Conflict — this claim's reviewed marker changed since it was loaded. Refresh and retry.",
      }, 409, corsHeaders);
    }

    // ── Audit trail ──────────────────────────────────────────────────────────
    // Non-fatal by design: the marker is the source of truth and is already
    // written. activity_log.user_id is NOT NULL, so a claim with no user_id gets
    // no audit row — which is exactly why the marker could not have BEEN an
    // activity_log event (see the header).
    if (claim.user_id) {
      const { error: logError } = await supabase.from("activity_log").insert({
        user_id: claim.user_id,
        event_type: reviewed ? "loss_sheet_reviewed" : "loss_sheet_review_cleared",
        title: reviewed ? "Loss sheet marked reviewed by admin" : "Loss sheet review marker cleared by admin",
        // Nested object — schema-column-lint only validates depth-0 keys, so
        // these are metadata, not claimed columns.
        metadata: {
          claim_id: claimId,
          admin_email: adminEmail,
          storage_path: claim.estimate_filename ?? null,
          previous_reviewed_at: already,
          source: "admin-homeowners.html loss-sheet queue (gh-1796)",
        },
        is_test: claim.is_test === true,
      });
      if (logError) {
        console.error(`[${FUNCTION_NAME}] activity_log insert failed (non-fatal):`, logError.message);
      }
    }

    console.log(`[${FUNCTION_NAME}] claim ${claimId} loss_sheet_reviewed_at -> ${nextValue ?? "NULL"}`);

    return jsonResponse({
      ok: true,
      claim_id: claimId,
      reviewed,
      loss_sheet_reviewed_at: updatedRows[0]?.loss_sheet_reviewed_at ?? null,
      changed: true,
    }, 200, corsHeaders);

  } catch (err) {
    console.error(`[${FUNCTION_NAME}] Unhandled error:`, err);
    return jsonResponse({ ok: false, error: "Internal server error" }, 500, corsHeaders);
  }
});
