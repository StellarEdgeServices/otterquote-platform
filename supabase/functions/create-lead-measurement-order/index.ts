/**
 * OtterQuote Edge Function: create-lead-measurement-order
 *
 * gh-2121 (HO-3, #2121 row 3.2). Browser-side recording of a paid,
 * human-fulfilled measurement report for a lead with no account -- see
 * ./handler.ts for the contract (stripe-webhook records the same order
 * independently; exactly one row per PaymentIntent) and ./handler.test.ts.
 *
 * verify_jwt is pinned to false in supabase/config.toml: authorization is the
 * lead_token (resolved server-side, Ruling 3) plus Stripe's own confirmation
 * of the PaymentIntent, fetched server-side.
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   STRIPE_MODE (see create-lead-payment-intent/index.ts), STRIPE_SECRET_KEY / STRIPE_SECRET_KEY_TEST
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { fetchStripeWithTimeout } from "../_shared/stripe-fetch-timeout.ts";
import {
  HOVER_PRICE_SETTING_KEY,
  recordLeadOrder,
  resolveStripeMode,
  stripeSecretKeyForMode,
} from "../_shared/lead-measurement-order.ts";
import { FUNCTION_NAME, handleRequest } from "./handler.ts";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const sb = createClient(supabaseUrl, serviceRoleKey);
const stripeMode = resolveStripeMode(Deno.env.get("STRIPE_MODE"), supabaseUrl);
const stripeSecretKey = stripeSecretKeyForMode(stripeMode, (k) => Deno.env.get(k));

async function ipToUuid(seed: string): Promise<string> {
  const data = new TextEncoder().encode(`${FUNCTION_NAME}:${seed}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

serve((req: Request) =>
  handleRequest(req, {
    stripeMode,
    resolveLead: async (leadToken) => {
      const { data, error } = await sb.rpc("resolve_lead_by_token", { p_token: leadToken });
      if (error) {
        console.error(`[${FUNCTION_NAME}] resolve_lead_by_token rpc failed`);
        return null;
      }
      const rows = Array.isArray(data) ? data : [];
      const row = rows[0] as { lead_id?: string; is_synthetic?: boolean } | undefined;
      return row?.lead_id ? { leadId: row.lead_id, isSynthetic: row.is_synthetic === true } : null;
    },
    readPriceCents: async () => {
      const { data, error } = await sb
        .from("platform_settings")
        .select("value")
        .eq("key", HOVER_PRICE_SETTING_KEY)
        .maybeSingle();
      return { row: data ?? null, error: error ? { message: error.message } : null };
    },
    findExistingOrder: async (paymentIntentId) => {
      const { data } = await sb
        .from("lead_measurement_orders")
        .select("id, status, lead_id")
        .eq("stripe_payment_intent_id", paymentIntentId)
        .maybeSingle();
      return data ?? null;
    },
    fetchPaymentIntent: async (paymentIntentId) => {
      if (!stripeSecretKey) {
        console.error(`[${FUNCTION_NAME}] Stripe secret key not configured for mode ${stripeMode}.`);
        return null;
      }
      try {
        // D14: bounded by fetchStripeWithTimeout, like every other Stripe call on this path.
        const piRes = await fetchStripeWithTimeout(
          fetch,
          `${STRIPE_API_BASE}/payment_intents/${encodeURIComponent(paymentIntentId)}`,
          { headers: { Authorization: `Basic ${btoa(`${stripeSecretKey}:`)}` } },
        );
        if (!piRes.ok) {
          console.error(`[${FUNCTION_NAME}] Stripe PI retrieve failed: HTTP ${piRes.status}`);
          return null;
        }
        return await piRes.json();
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] Stripe PI retrieve threw:`, e instanceof Error ? e.name : "non-error");
        return null;
      }
    },
    recordOrder: (input) =>
      recordLeadOrder(input, {
        insertIgnoringDuplicate: async (row) => {
          const { data, error } = await sb
            .from("lead_measurement_orders")
            .upsert(row, { onConflict: "stripe_payment_intent_id", ignoreDuplicates: true })
            .select("id, status");
          const first = Array.isArray(data) && data.length > 0 ? (data[0] as { id: string; status: string }) : null;
          return { row: first, error: error ? { code: error.code, message: error.message } : null };
        },
        findByPaymentIntent: async (paymentIntentId) => {
          const { data } = await sb
            .from("lead_measurement_orders")
            .select("id, status, lead_id")
            .eq("stripe_payment_intent_id", paymentIntentId)
            .maybeSingle();
          return data ?? null;
        },
        alert: async (alertType, message) => {
          console.error(`[${FUNCTION_NAME}] ${message}`);
          try {
            await sb.from("platform_alerts_log").insert({
              alert_type: alertType,
              function_name: FUNCTION_NAME,
              message,
              sent_at: new Date().toISOString(),
            });
          } catch {
            console.error(`[${FUNCTION_NAME}] platform_alerts_log insert failed`);
          }
        },
      }),
    checkRateLimit: async (bucketKey) => {
      const { data, error } = await sb.rpc("check_rate_limit", {
        p_function_name: FUNCTION_NAME,
        p_user_id: await ipToUuid(bucketKey),
      });
      if (error) {
        console.error(`[${FUNCTION_NAME}] rate limit check failed; failing closed`);
        return { allowed: false, reason: "rate_limit_check_failed" };
      }
      const parsed = data as { allowed?: boolean; reason?: string } | null;
      return { allowed: parsed?.allowed === true, reason: parsed?.reason };
    },
    notifyOrderCreated: async ({ id }) => {
      // activity_log is NOT written: activity_log.user_id is NOT NULL with a FK
      // to auth.users, and a lead has no account (the first draft's user_id:null
      // insert could never succeed). The admin email + the order row's is_test
      // are this feature's record.
      const res = await fetch(`${supabaseUrl}/functions/v1/notify-measurement-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
        body: JSON.stringify({ order_id: id, lead_order: true }),
      });
      if (!res.ok) console.error(`[${FUNCTION_NAME}] notify-measurement-order returned ${res.status}`);
    },
  })
);
