/**
 * OtterQuote Edge Function: hand-off-after-fulfilment (gh-3861, P23 piece E, Q5 auto-send)
 *
 * After Dustin delivers a homeowner-paid measurement report ("Save & deliver" in admin-measurements.html),
 * open the claim to contractors: the server-side equivalent of the homeowner clicking Submit for Bids,
 * and then fire the EXISTING notify-contractors new_opportunity notification once.
 *
 * Why a server function: notify-contractors/user-gate.ts lets a signed-in user fire new_opportunity only
 * on a claim they own, so an admin session calling it directly gets 403 (and that gate stays as it is).
 * Submit also writes claims.status / ready_for_bids / {trade}_bid_released_at, which notify-contractors
 * alone does not. This function does both, behind an admin check, with the service key.
 *
 * Request (POST, Authorization: Bearer <admin JWT>):  { order_id }
 *
 * Order of work (each step stops everything after it):
 *   0. Flag MEASUREMENT_CHARGE_ENABLED (env) must be exactly "true"; else 200 {skipped, flag_off}, no I/O.
 *   1. Caller must pass requireAdmin() (public.is_admin_email(), the same admin set admin-measurements.html applies).
 *   2. Order must be 'completed' and homeowner-bought (plan.ts); else refused, nothing written.
 *   3. Idempotent per order, retry-safe. Two activity_log rows carry the state (no new table, no migration):
 *        measurement_handoff_release_pending  written right after the claim is opened, BEFORE notify-contractors
 *        measurement_handoff_to_contractors   written only after notify-contractors returned success
 *      done row present -> skipped (already_handed_off). Pending row and no done row, claim open -> the earlier notify
 *      failed (incl. a 429): the claim is NOT re-written and notify-contractors is called again, once.
 *   4. Claim opened exactly as submitForBids does (plan.ts). The gh-2559 DB trigger still applies to this
 *      write; its refusal (estimate not yet read) is passed back as 409 and nothing is sent.
 *   5. notify-contractors new_opportunity, once per success, with the service bearer and {claim_id} only (the wording is
 *      the existing approved template; this file writes no contractor-facing text).
 *   6. Done row. If notify-contractors failed (non-2xx, 429 or throw): 502, an alert in platform_alerts_log, the pending row
 *      stays, and the next re-save in the admin page calls notify-contractors again.
 *
 * Writes no migration. Sends no email or SMS itself. Merged is not deployed: deploy is Tier 3B (24 h notice).
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { type GateDeps, requireAdmin } from "../_shared/admin-gate.ts";
import { FLAG_ENV, flagIsOn, HANDOFF_EVENT, PENDING_EVENT, planHandOff } from "./plan.ts";

const FUNCTION_NAME = "hand-off-after-fulfilment";
const UNREAD_ESTIMATE_MARKER = "[gh2559-bid-open:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

type GetEnv = (name: string) => string | undefined;

// Exported so the test drives the REAL handler with injected env, a fake client and a fake admin gate.
export async function handler(
  req: Request,
  getEnv: GetEnv = (n) => Deno.env.get(n),
  makeClient: typeof createClient = createClient,
  gateDeps: GateDeps = {},
): Promise<Response> {
  const cors = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  // 0. Dark by default: with the flag off the function does nothing at all (no auth call, no DB, no fetch).
  if (!flagIsOn(getEnv(FLAG_ENV))) {
    return json({ success: true, skipped: true, reason: "flag_off" }, 200, cors);
  }

  try {
    // 1. Admin only.
    const gate = await requireAdmin(req, { getEnv, ...gateDeps });
    if (!gate.ok) return json({ error: gate.status === 401 ? "Unauthorized" : "Forbidden: admin role required" }, gate.status, cors);

    const supabaseUrl = getEnv("SUPABASE_URL") || "";
    const serviceKey = getEnv("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceKey) throw new Error("Missing required environment variables");

    const body = await req.json().catch(() => null);
    const orderId = body?.order_id;
    if (typeof orderId !== "string" || !UUID_RE.test(orderId)) {
      return json({ error: "Missing or invalid field: order_id" }, 400, cors);
    }

    // deno-lint-ignore no-explicit-any
    const sb: any = makeClient(supabaseUrl, serviceKey);

    const { data: order } = await sb
      .from("hover_orders")
      .select("id, claim_id, user_id, status, requested_by_role")
      .eq("id", orderId)
      .maybeSingle();
    const { data: claim } = order?.claim_id
      ? await sb
        .from("claims")
        .select("id, status, ready_for_bids, trades, is_test, roofing_bid_released_at, gutters_bid_released_at, siding_bid_released_at, windows_bid_released_at")
        .eq("id", order.claim_id)
        .maybeSingle()
      : { data: null };

    // Hand-off state for this order, from activity_log (see header, step 3).
    let markers = { pending: false, done: false };
    if (order?.id) {
      const { data: rows } = await sb
        .from("activity_log")
        .select("event_type")
        .in("event_type", [HANDOFF_EVENT, PENDING_EVENT])
        .contains("metadata", { order_id: order.id })
        .limit(10);
      const types = new Set((Array.isArray(rows) ? rows : []).map((r: { event_type?: string }) => r.event_type));
      markers = { pending: types.has(PENDING_EVENT), done: types.has(HANDOFF_EVENT) };
    }

    // 2. Refusals and the release plan.
    const plan = planHandOff(order ?? null, claim ?? null, new Date().toISOString(), markers);
    if (plan.action === "refuse") return json({ error: plan.reason }, plan.status, cors);
    if (plan.action === "already_open") return json({ success: true, skipped: true, reason: plan.reason }, 200, cors);

    const logMeta = (extra: Record<string, unknown> = {}) => ({
      order_id: order.id,
      claim_id: claim.id,
      released_by: gate.user.email,
      ...extra,
    });

    if (plan.action === "release") {
      // 4. Open the claim for bids (what Submit does).
      const { data: written, error: relErr } = await sb
        .from("claims")
        .update(plan.patch)
        .eq("id", claim.id)
        .select("id");
      if (relErr) {
        const msg = String(relErr.message ?? "");
        if (msg.includes(UNREAD_ESTIMATE_MARKER)) {
          console.warn(`[${FUNCTION_NAME}] claim ${claim.id} refused by the bid-open guard; nothing sent`);
          return json({ error: "bid_open_guard_refused" }, 409, cors);
        }
        console.error(`[${FUNCTION_NAME}] release failed for claim=${claim.id}:`, relErr);
        return json({ error: "release_failed" }, 500, cors);
      }
      if (!Array.isArray(written) || written.length === 0) {
        console.error(`[${FUNCTION_NAME}] zero_rows_updated: claims ${claim.id}`);
        return json({ error: "release_zero_rows" }, 409, cors);
      }
      // Pending marker: the claim is open and contractors are not yet told. If this insert fails we still try to notify
      // (below); only a failure of BOTH leaves nothing for a re-save to see, and that case alerts loudly.
      const { error: pendErr } = await sb.from("activity_log").insert({
        event_type: PENDING_EVENT,
        title: PENDING_EVENT,
        user_id: order.user_id,
        is_test: claim.is_test === true,
        metadata: logMeta({ released_trades: plan.releasedTrades }),
      });
      if (pendErr) console.error(`[${FUNCTION_NAME}] pending marker insert failed for order=${order.id}:`, pendErr);
    }
    const releasedTrades = plan.action === "release" ? plan.releasedTrades : [];
    const retried = plan.action === "renotify";

    // 5. The existing notification, once. Service bearer: passes notify-contractors' caller gate as a service call.
    let notifyOk = false;
    let notifyDetail: unknown = null;
    let notifyStatus: number | null = null;
    try {
      const res = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/functions/v1/notify-contractors`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
        body: JSON.stringify({ claim_id: claim.id }),
      });
      notifyOk = res.ok;
      notifyStatus = res.status;
      notifyDetail = await res.json().catch(() => null);
    } catch (e) {
      console.error(`[${FUNCTION_NAME}] notify-contractors call threw for claim=${claim.id}:`, e);
    }
    if (!notifyOk) {
      try {
        await sb.from("platform_alerts_log").insert({
          alert_type: "handoff_notify_contractors_failed",
          function_name: FUNCTION_NAME,
          message: `Claim ${claim.id} was opened for bids after order ${order.id} was fulfilled, but notify-contractors did not return success (status ${notifyStatus ?? "no response"}), so contractors have NOT been told. Re-save the order in admin-measurements.html to retry; the retry calls notify-contractors again.`,
          sent_at: new Date().toISOString(),
        });
      } catch {
        console.error(`[${FUNCTION_NAME}] alert insert failed`);
      }
      return json({ error: "notify_failed", released: true, notified: false, notify_status: notifyStatus }, 502, cors);
    }

    // 6. Record it: the done row is what stops any further notify for this order.
    const { error: logErr } = await sb.from("activity_log").insert({
      event_type: HANDOFF_EVENT,
      title: HANDOFF_EVENT,
      user_id: order.user_id,
      is_test: claim.is_test === true,
      metadata: logMeta({
        released_trades: releasedTrades,
        retried,
        notified_count: (notifyDetail as { notified_count?: number } | null)?.notified_count ?? null,
      }),
    });
    if (logErr) {
      // Contractors WERE told, but the record that says so was not written: a re-save would tell them again.
      console.error(`[${FUNCTION_NAME}] activity_log insert failed for order=${order.id}:`, logErr);
      try {
        await sb.from("platform_alerts_log").insert({
          alert_type: "handoff_done_marker_failed",
          function_name: FUNCTION_NAME,
          message: `Contractors were notified for claim ${claim.id} (order ${order.id}) but the hand-off record could not be written. Do NOT re-save the order: a re-save would notify contractors a second time.`,
          sent_at: new Date().toISOString(),
        });
      } catch {
        console.error(`[${FUNCTION_NAME}] alert insert failed`);
      }
      return json({ error: "handoff_record_failed", released: true, notified: true }, 502, cors);
    }

    return json({ success: true, released: true, notified: true, retried, released_trades: releasedTrades }, 200, cors);
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] error:`, err);
    return json({ error: "Internal server error" }, 500, cors);
  }
}

if (import.meta.main) {
  serve((req) => handler(req));
}
