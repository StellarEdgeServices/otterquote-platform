/**
 * OtterQuote Edge Function: create-lead-payment-intent
 *
 * gh-2121 (HO-3, #2121 row 3.2). Price preview + Stripe PaymentIntent for a
 * lead with no account, resolved server-side from an unguessable lead_token
 * (Ben's Ruling 3). See ./handler.ts for the contract and ./handler.test.ts
 * for the tests (negative controls included).
 *
 * verify_jwt is pinned to false in supabase/config.toml: the caller is an
 * anonymous lead. Authorization is the lead_token plus the per-IP rate limit.
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   STRIPE_MODE          -- ignored on the production project (yeszghaspzwwstvsrioa),
 *                           which is always live; "test" elsewhere, anything else
 *                           (or unset) means live. Never derived from the request
 *                           (PR #2226 REVIEW D7, N1).
 *   STRIPE_SECRET_KEY    -- live mode
 *   STRIPE_SECRET_KEY_TEST -- test mode only
 */
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { fetchStripeWithTimeout } from "../_shared/stripe-fetch-timeout.ts";
import { resolveStripeMode, stripeSecretKeyForMode, HOVER_PRICE_SETTING_KEY } from "../_shared/lead-measurement-order.ts";
import { FUNCTION_NAME, handleRequest, type ResolvedLead } from "./handler.ts";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

const sb = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
const stripeMode = resolveStripeMode(Deno.env.get("STRIPE_MODE"), Deno.env.get("SUPABASE_URL"));
const stripeSecretKey = stripeSecretKeyForMode(stripeMode, (k) => Deno.env.get(k));

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
        .eq("key", HOVER_PRICE_SETTING_KEY)
        .maybeSingle();
      return { row: data ?? null, error: error ? { message: error.message } : null };
    },
    findLeadOrderStatuses: async (leadId) => {
      const { data, error } = await sb
        .from("lead_measurement_orders")
        .select("status")
        .eq("lead_id", leadId);
      if (error) {
        console.error(`[${FUNCTION_NAME}] lead order lookup failed`);
        return { statuses: [], error: true };
      }
      return { statuses: (data ?? []).map((r: { status: string }) => r.status), error: false };
    },
    checkRateLimit: async (bucketUserId) => {
      const { data, error } = await sb.rpc("check_rate_limit", {
        p_function_name: FUNCTION_NAME,
        p_user_id: bucketUserId,
      });
      if (error) {
        // Fail CLOSED: a money path refuses rather than risks an unbounded create loop.
        console.error(`[${FUNCTION_NAME}] rate limit check failed; failing closed`);
        return { allowed: false, reason: "rate_limit_check_failed" };
      }
      const parsed = data as { allowed?: boolean; reason?: string } | null;
      return { allowed: parsed?.allowed === true, reason: parsed?.reason };
    },
    recordConsent: async (c) => {
      const userAgent = (c.userAgent ?? "").slice(0, 500) || null;
      const { error } = await sb.from("lead_consents").upsert(
        {
          lead_id: c.leadId,
          consent_key: c.consentKey,
          consent_given: true,
          consent_text: c.consentText,
          page_url: c.pageUrl,
          user_agent: userAgent,
          ip: c.ip,
          payload: c.payload,
        },
        { onConflict: "lead_id,consent_key", ignoreDuplicates: true },
      );
      if (error) console.error(`[${FUNCTION_NAME}] lead_consents insert failed (code ${error.code ?? "unknown"})`);
      return { ok: !error };
    },
    createPaymentIntent: async (form, idempotencyKey) => {
      if (!stripeSecretKey) {
        console.error(`[${FUNCTION_NAME}] Stripe secret key not configured for mode ${stripeMode}.`);
        return { ok: false, status: 0, body: {} };
      }
      try {
        const r = await fetchStripeWithTimeout(fetch, `${STRIPE_API_BASE}/payment_intents`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${btoa(`${stripeSecretKey}:`)}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Idempotency-Key": idempotencyKey,
          },
          body: form.toString(),
        });
        const body = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, body };
      } catch (e) {
        console.error(`[${FUNCTION_NAME}] Stripe create threw:`, e instanceof Error ? e.name : "non-error");
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
      } catch {
        console.error(`[${FUNCTION_NAME}] platform_alerts_log insert failed`);
      }
    },
  })
);
