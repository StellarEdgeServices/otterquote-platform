/**
 * OtterQuote Edge Function: create-lead-measurement-order
 *
 * gh-2121 (HO-3, #2121 row 3.2). Records a paid, human-fulfilled $15
 * measurement report ordered by a lead with no account -- see ./handler.ts
 * for the full contract and ./handler.test.ts for the unit tests (including
 * the negative controls).
 *
 * verify_jwt is pinned to false in supabase/config.toml: authorization is the
 * lead_token (resolved server-side, Ruling 3) plus Stripe's own confirmation
 * that the PaymentIntent succeeded (fetched from Stripe, never trusted from
 * the client, per create-measurement-order's existing discipline).
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   STRIPE_SECRET_KEY (+ STRIPE_SECRET_KEY_TEST for staging origins)
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { handleRequest } from "./handler.ts";

const FUNCTION_NAME = "create-lead-measurement-order";
const STRIPE_API_BASE = "https://api.stripe.com/v1";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const sb = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");

function stripeKeyForOrigin(origin: string): string | undefined {
  const isStaging = origin === "https://jade-alpaca-b82b5e.netlify.app" ||
    origin === "https://staging--jade-alpaca-b82b5e.netlify.app";
  return isStaging
    ? (Deno.env.get("STRIPE_SECRET_KEY_TEST") || Deno.env.get("STRIPE_SECRET_KEY"))
    : Deno.env.get("STRIPE_SECRET_KEY");
}

serve((req: Request) => {
  const origin = req.headers.get("Origin") || "";
  const stripeSecretKey = stripeKeyForOrigin(origin);

  return handleRequest(req, {
    resolveLead: async (leadToken) => {
      const { data, error } = await sb.rpc("resolve_lead_by_token", { p_token: leadToken });
      if (error) {
        console.error(`[${FUNCTION_NAME}] resolve_lead_by_token rpc failed`);
        return null;
      }
      const rows = Array.isArray(data) ? data : [];
      const row = rows[0] as { lead_id?: string } | undefined;
      return row?.lead_id ? { leadId: row.lead_id } : null;
    },
    readPriceCents: async () => {
      const { data, error } = await sb
        .from("platform_settings")
        .select("value")
        .eq("key", "hover_measurement_price")
        .maybeSingle();
      return { row: data ?? null, error: error ? { message: error.message } : null };
    },
    findExistingOrder: async (paymentIntentId) => {
      const { data } = await sb
        .from("lead_measurement_orders")
        .select("id, status")
        .eq("stripe_payment_intent_id", paymentIntentId)
        .maybeSingle();
      return data ?? null;
    },
    fetchPaymentIntent: async (paymentIntentId) => {
      if (!stripeSecretKey) {
        console.error(`[${FUNCTION_NAME}] Stripe secret key not configured.`);
        return null;
      }
      const basicAuth = btoa(`${stripeSecretKey}:`);
      try {
        const piRes = await fetch(`${STRIPE_API_BASE}/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
          headers: { Authorization: `Basic ${basicAuth}` },
        });
        if (!piRes.ok) {
          console.error(`[${FUNCTION_NAME}] Stripe PI retrieve failed:`, piRes.status);
          return null;
        }
        return await piRes.json();
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] Stripe PI retrieve threw:`, e instanceof Error ? e.message : e);
        return null;
      }
    },
    insertOrder: async ({ leadId, paymentIntentId, amountCents, stripeChargeId }) => {
      const { data, error } = await sb
        .from("lead_measurement_orders")
        .insert({
          lead_id: leadId,
          status: "awaiting_fulfillment",
          product_code: "roof_basic",
          stripe_payment_intent_id: paymentIntentId,
          homeowner_charge_amount: amountCents,
          stripe_charge_id: stripeChargeId,
          rebate_due: true,
        })
        .select("id, status")
        .single();
      if (error || !data) {
        console.error(`[${FUNCTION_NAME}] order insert failed:`, error);
        return { error: error?.message ?? "insert failed" };
      }
      return data;
    },
    checkRateLimit: async (bucketKey) => {
      const bucketUuid = await ipToUuidFallback(bucketKey);
      const { data, error } = await sb.rpc("check_rate_limit", {
        p_function_name: FUNCTION_NAME,
        p_user_id: bucketUuid,
      });
      if (error) {
        console.error(`[${FUNCTION_NAME}] rate limit check failed:`, error);
        return { allowed: false, reason: "rate_limit_check_failed" };
      }
      const parsed = data as { allowed?: boolean; reason?: string } | null;
      return { allowed: parsed?.allowed === true, reason: parsed?.reason };
    },
    notifyOrderCreated: async ({ id, leadId }) => {
      try {
        const { error: logErr } = await sb.from("activity_log").insert({
          event_type: "lead_measurement_order_created",
          title: "lead_measurement_order_created",
          user_id: null,
          is_test: false,
          metadata: { order_id: id, lead_id: leadId, product_code: "roof_basic" },
        });
        if (logErr) console.error(`[${FUNCTION_NAME}] activity_log insert failed:`, logErr);
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] activity_log write threw:`, e);
      }
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/notify-measurement-order`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ order_id: id, lead_order: true }),
        });
        if (!res.ok) console.error(`[${FUNCTION_NAME}] notify-measurement-order returned ${res.status}`);
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] notify-measurement-order invoke failed:`, e);
      }
    },
  });
});

/** Same construction as the other new EFs' ipToUuid, kept local so this file has no cross-directory import for it. */
async function ipToUuidFallback(seed: string): Promise<string> {
  const data = new TextEncoder().encode(`${FUNCTION_NAME}:${seed}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
