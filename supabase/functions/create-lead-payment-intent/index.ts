/**
 * OtterQuote Edge Function: create-lead-payment-intent
 *
 * gh-2121 (HO-3, #2121 row 3.2). Creates the $15 Stripe PaymentIntent for a
 * lead that has no account yet, resolved server-side from an unguessable
 * lead_token (Ben's Ruling 3) -- see ./handler.ts for the full contract and
 * ./handler.test.ts for the unit tests (including the negative controls: a
 * bad/expired token is rejected and no Stripe call is attempted without a
 * valid lead).
 *
 * verify_jwt is pinned to false in supabase/config.toml: the caller is an
 * anonymous lead with no session. Authorization is entirely the lead_token
 * (resolved server-side via resolve_lead_by_token(), never a client-supplied
 * lead_id) plus the per-IP rate limit.
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   STRIPE_SECRET_KEY (+ STRIPE_SECRET_KEY_TEST for staging origins)
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { fetchStripeWithTimeout } from "../create-payment-intent/stripe-fetch.ts";
import { handleRequest, type ResolvedLead } from "./handler.ts";

const FUNCTION_NAME = "create-lead-payment-intent";
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
      const row = rows[0] as { lead_id?: string; email?: string; is_synthetic?: boolean } | undefined;
      if (!row?.lead_id) return null;
      const resolved: ResolvedLead = {
        leadId: row.lead_id,
        email: row.email && row.email.length > 0 ? row.email : null,
        isSynthetic: row.is_synthetic === true,
      };
      return resolved;
    },
    readPriceCents: async () => {
      const { data, error } = await sb
        .from("platform_settings")
        .select("value")
        .eq("key", "hover_measurement_price")
        .maybeSingle();
      return { row: data ?? null, error: error ? { message: error.message } : null };
    },
    checkRateLimit: async (bucketUserId) => {
      const { data, error } = await sb.rpc("check_rate_limit", {
        p_function_name: FUNCTION_NAME,
        p_user_id: bucketUserId,
      });
      if (error) {
        console.error(`[${FUNCTION_NAME}] rate limit check failed:`, error);
        // Fail CLOSED here (unlike record-lead-details): this is a money
        // path, not a consent write, so an infra hiccup refuses rather than
        // risks an unbounded Stripe create loop.
        return { allowed: false, reason: "rate_limit_check_failed" };
      }
      const parsed = data as { allowed?: boolean; reason?: string; counts?: unknown } | null;
      return { allowed: parsed?.allowed === true, reason: parsed?.reason, counts: parsed?.counts };
    },
    createPaymentIntent: async (form, idempotencyKey) => {
      if (!stripeSecretKey) {
        console.error(`[${FUNCTION_NAME}] Stripe secret key not configured.`);
        return { ok: false, status: 0, body: {} };
      }
      const basicAuth = btoa(`${stripeSecretKey}:`);
      try {
        // Ben's Ruling 2: fetchStripeWithTimeout + an Idempotency-Key, exactly
        // like create-payment-intent's own standard-flow create.
        const r = await fetchStripeWithTimeout(fetch, `${STRIPE_API_BASE}/payment_intents`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${basicAuth}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Idempotency-Key": idempotencyKey,
          },
          body: form.toString(),
        });
        const body = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, body };
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] Stripe create threw:`, e instanceof Error ? e.message : e);
        return { ok: false, status: 0, body: {} };
      }
    },
    logPlatformAlert: async (message) => {
      try {
        await sb.from("platform_alerts_log").insert({
          alert_type: "platform_setting_missing",
          function_name: FUNCTION_NAME,
          message,
          sent_at: new Date().toISOString(),
        });
      } catch (e) {
        console.error("platform_alerts_log insert failed:", e);
      }
    },
  });
});
