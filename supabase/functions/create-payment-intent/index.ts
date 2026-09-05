/**
 * OtterQuote Edge Function: create-payment-intent
 * Creates a Stripe PaymentIntent for three use cases:
 *   - Measurement report purchases (server-side priced from platform_settings —
 *     gh-1537: the price is read live, never hardcoded here; see price-setting.ts)
 *   - Deductible escrow
 *   - Contractor platform fees (5% of job value)
 *
 * D-181 (Apr 23, 2026, ClickUp 86e117ty3): For hover_measurement charges the
 * amount is read server-side from platform_settings.hover_measurement_price.
 * Client-sent amount is ignored for that branch (Deploy Review Checklist #25 —
 * amount validated server-side). All other branches unchanged.
 *
 * Multi-payment-method support (platform_fee branch):
 *   - Default method first, then ACH, then cards
 *   - ACH charges: exact platform fee (no surcharge)
 *   - Card charges: 2.9% + $0.30 passthrough so we net the full fee
 *
 * Rate-limited via Supabase check_rate_limit() RPC.
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   STRIPE_SECRET_KEY
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import {
  describeGuardVerdict,
  evaluateLiveChargeGuard,
  GUARD_SELECT,
  REFUSAL_CODE,
} from "./live-charge-guard.ts";
import { PlatformSettingMissingError, resolveRequiredPriceCents } from "./price-setting.ts";
import {
  evaluateMeasurementUpgradeGate,
  UPGRADE_CHARGE_DESCRIPTION,
  VENDOR_CREDIT_EXPECTED_CENTS,
} from "./measurement-upgrade-gate.ts";

const FUNCTION_NAME = "create-payment-intent";
const STRIPE_API_BASE = "https://api.stripe.com/v1";

// CORS tightened Apr 15, 2026 (Session 181): payment intent creation is
// high-sensitivity — origin allowlisted instead of wildcard.
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
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

/**
 * charge_amount = (platform_fee + 0.30) / (1 - 0.029). All in cents.
 */
function calculateCardChargeAmount(platformFeeCents: number): number {
  return Math.ceil((platformFeeCents + 30) / (1 - 0.029));
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Health check ping — used by platform-health-check every 15 minutes.
  try {
    const bodyPeek = await req.clone().json().catch(() => ({}));
    if (bodyPeek?.health_check === true) {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200,
      });
    }
  } catch { /* no-op */ }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // ===== AUTH (86e1v6nnh) =====
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const jwtToken = authHeader.slice(7);
  const isServiceRole = jwtToken === supabaseKey;
  let callerId: string | null = null;
  if (!isServiceRole) {
    const { data: { user: caller }, error: authErr } = await supabase.auth.getUser(jwtToken);
    if (authErr || !caller) {
      return new Response(JSON.stringify({ error: "Unauthorized: invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    callerId = caller.id;
  }

  try {
    const { amount: clientAmount, currency, description, metadata, contractor_id, off_session } = await req.json();

    // D-181: server-side price enforcement for hover_measurement.
    let amount: number = clientAmount;
    if (metadata?.type === "hover_measurement") {
      const { data: priceRow, error: priceErr } = await supabase
        .from("platform_settings")
        .select("value")
        .eq("key", "hover_measurement_price")
        .maybeSingle();
      // gh-1537: no defensive numeric default. The prior fallback (7900,
      // "$79") was three price changes stale against the live price at audit
      // time — a defensive default is a silent overcharge risk one deleted
      // row away. Missing/invalid setting must fail closed, never guess.
      let resolvedPrice: number;
      try {
        resolvedPrice = resolveRequiredPriceCents("hover_measurement_price", priceRow, priceErr);
      } catch (err) {
        const message = err instanceof PlatformSettingMissingError ? err.message : "platform_setting_missing: hover_measurement_price";
        console.error(`[${FUNCTION_NAME}] ${message}`, priceErr ?? "");
        try {
          await supabase.from("platform_alerts_log").insert({
            alert_type: "platform_setting_missing",
            function_name: FUNCTION_NAME,
            message,
            sent_at: new Date().toISOString(),
          });
        } catch (alertErr) {
          console.error("platform_alerts_log insert failed:", alertErr);
        }
        return new Response(JSON.stringify({ error: message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      amount = resolvedPrice;
      console.log("[hover_measurement] Server-side price enforced:", amount, "(client sent:", clientAmount, ")");
    }

    // measurement_upgrade's amount is entirely server-derived from the SQ
    // tier gate below (never trusted from the client — same reasoning as
    // D-181's hover_measurement price), so it is not known yet at this point
    // and is exempted from this pre-authorization check rather than made to
    // pass with a meaningless placeholder.
    if (
      metadata?.type !== "measurement_upgrade" &&
      (!amount || typeof amount !== "number" || amount <= 0 || !Number.isInteger(amount))
    ) {
      return new Response(JSON.stringify({ error: "Invalid amount. Must be a positive integer (in cents)." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!currency || typeof currency !== "string") {
      return new Response(JSON.stringify({ error: "Invalid currency. Must be a string (e.g., 'usd')." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!metadata || !metadata.claim_id || !metadata.type) {
      return new Response(JSON.stringify({
        error: "Missing required metadata fields: claim_id and type (hover_measurement, deductible_escrow, or platform_fee).",
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const validTypes = ["hover_measurement", "deductible_escrow", "platform_fee", "measurement_upgrade"];
    if (!validTypes.includes(metadata.type)) {
      return new Response(JSON.stringify({ error: `Invalid metadata.type. Must be one of: ${validTypes.join(", ")}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (metadata.type === "platform_fee" && off_session && !contractor_id) {
      return new Response(JSON.stringify({ error: "Missing contractor_id for off-session platform fee charge." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ===== CALLER AUTHORIZATION + SERVER-SIDE AMOUNT DERIVATION (86e1v6nnh) =====
    if (metadata.type === "platform_fee") {
      // Only internal service-role calls may trigger contractor platform-fee charges.
      if (!isServiceRole) {
        return new Response(JSON.stringify({ error: "Forbidden: platform_fee requires service authorization" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // ── #1467 GATE 2: live-charge authorization, independent of the caller ──
      // Deliberately redundant with docusign-webhook's own gate. One gate is a
      // code path; two gates is a property — and this one also covers every
      // FUTURE caller of the platform_fee branch, which the upstream gate
      // cannot. Fails CLOSED: if the claim row cannot be read, the charge is
      // refused rather than attempted. See live-charge-guard.ts.
      const { data: guardClaim } = await supabase
        .from("claims")
        .select(GUARD_SELECT)
        .eq("id", metadata.claim_id)
        .maybeSingle();
      const chargeGuard = evaluateLiveChargeGuard(guardClaim);
      if (!chargeGuard.allow) {
        const guardMessage = describeGuardVerdict(
          chargeGuard,
          metadata.claim_id,
          typeof amount === "number" ? amount : null
        );
        console.error(`[${FUNCTION_NAME}] ${guardMessage}`);
        try {
          await supabase.from("platform_alerts_log").insert({
            alert_type: "platform_fee_refused_unauthorized_test",
            function_name: FUNCTION_NAME,
            message: guardMessage,
            sent_at: new Date().toISOString(),
          });
        } catch (alertErr) {
          console.error("platform_alerts_log insert failed:", alertErr);
        }
        // 422, not 400/403: distinguishable from every existing refusal in this
        // function, so the caller's log says WHICH gate stopped the charge.
        return new Response(
          JSON.stringify({
            error: guardMessage,
            code: REFUSAL_CODE,
            reason: chargeGuard.reason,
          }),
          {
            status: 422,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Re-derive fee amount from DB to prevent a compromised upstream EF from fabricating the charge.
      if (off_session && contractor_id) {
        const { data: quote, error: quoteErr } = await supabase
          .from("quotes")
          .select("total_price, platform_fee_pct")
          .eq("claim_id", metadata.claim_id)
          .eq("contractor_id", contractor_id)
          .eq("status", "selected")
          .limit(1)
          .single();
        if (quoteErr || !quote) {
          return new Response(JSON.stringify({ error: "No matching quote found for platform_fee charge" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const { data: settings } = await supabase
          .from("platform_settings")
          .select("value")
          .eq("key", "platform_fee_percentage")
          .single();
        const feePct = quote.platform_fee_pct ?? settings?.value;
        if (feePct == null) {
          return new Response(JSON.stringify({ error: "Cannot determine platform fee percentage" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        amount = Math.round(Number(quote.total_price) * (Number(feePct) / 100) * 100);
        if (!Number.isFinite(amount) || amount <= 0) {
          return new Response(JSON.stringify({ error: "Computed platform fee amount is invalid" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    } else if (metadata.type === "measurement_upgrade") {
      // ===== gh-1411 / D-317 cl. 4-5: contractor detailed-measurement upgrade =====
      // Contractor-initiated, so ownership is "does this contractor belong to
      // this caller," not "does this caller own the claim" (the branch below).
      if (!callerId) {
        return new Response(JSON.stringify({ error: "Forbidden: this operation requires user authentication" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!contractor_id || typeof contractor_id !== "string") {
        return new Response(JSON.stringify({ error: "Missing contractor_id." }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: contractorRow, error: contractorErr } = await supabase
        .from("contractors")
        .select("id, user_id")
        .eq("id", contractor_id)
        .maybeSingle();
      if (contractorErr || !contractorRow || contractorRow.user_id !== callerId) {
        return new Response(JSON.stringify({ error: "Forbidden: caller does not own this contractor account." }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // select('*'): per #1410 (js/measurement-shape.js), claims.measurement_shape
      // may not exist in the live schema yet, and an explicit column list
      // naming it is a 42703 error against today's schema. hover_measurements
      // (for squares) and the #1467 guard columns all ride along on '*'.
      const { data: upgradeClaimRow, error: upgradeClaimErr } = await supabase
        .from("claims")
        .select("*")
        .eq("id", metadata.claim_id)
        .maybeSingle();
      if (upgradeClaimErr) {
        console.error(`[${FUNCTION_NAME}] measurement_upgrade claim lookup failed:`, upgradeClaimErr);
      }

      const { data: basicOrderRow } = await supabase
        .from("hover_orders")
        .select("status")
        .eq("claim_id", metadata.claim_id)
        .eq("product_code", "roof_basic")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const gate = evaluateMeasurementUpgradeGate(upgradeClaimRow, basicOrderRow?.status ?? null);
      if (!gate.allow) {
        if (gate.code === "TEST_CLAIM_CHARGE_REFUSED") {
          const guardMessage = describeGuardVerdict(
            evaluateLiveChargeGuard(upgradeClaimRow),
            metadata.claim_id,
            null,
          );
          console.error(`[${FUNCTION_NAME}] ${guardMessage}`);
          try {
            await supabase.from("platform_alerts_log").insert({
              alert_type: "measurement_upgrade_refused_unauthorized_test",
              function_name: FUNCTION_NAME,
              message: guardMessage,
              sent_at: new Date().toISOString(),
            });
          } catch (alertErr) {
            console.error("platform_alerts_log insert failed:", alertErr);
          }
        }
        return new Response(
          JSON.stringify({ error: gate.error, code: gate.code }),
          { status: gate.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Server-side price, from the tier gate — never trusted from the client.
      amount = gate.amountCents;
    } else {
      // hover_measurement / deductible_escrow: must be an authenticated user who owns the claim.
      if (!callerId) {
        return new Response(JSON.stringify({ error: "Forbidden: this operation requires user authentication" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const { data: claimRow, error: claimErr } = await supabase
        .from("claims")
        .select("user_id, deductible_amount")
        .eq("id", metadata.claim_id)
        .single();
      if (claimErr || !claimRow || claimRow.user_id !== callerId) {
        return new Response(JSON.stringify({ error: "Forbidden: caller does not own this claim" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (metadata.type === "deductible_escrow") {
        if (claimRow.deductible_amount == null) {
          return new Response(JSON.stringify({ error: "Deductible amount not recorded on this claim" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // deductible_amount is stored in dollars (NUMERIC(10,2)); Stripe needs cents.
        amount = Math.round(Number(claimRow.deductible_amount) * 100);
        if (!Number.isFinite(amount) || amount <= 0) {
          return new Response(JSON.stringify({ error: "Invalid deductible_amount on claim" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      // hover_measurement amount is already enforced server-side by D-181 above.
    }

    // ===== RATE LIMIT =====
    const { data: rateLimitResult, error: rlError } = await supabase.rpc("check_rate_limit", {
      p_function_name: FUNCTION_NAME,
      p_user_id: callerId ?? null,
    });
    if (rlError) {
      console.error("Rate limit check failed:", rlError);
      return new Response(JSON.stringify({
        error: "Rate limit check failed. Refusing to create payment intent for safety.",
        detail: rlError.message,
      }), { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (!rateLimitResult?.allowed) {
      console.warn(`RATE LIMITED [${FUNCTION_NAME}]: ${rateLimitResult?.reason}`);
      return new Response(JSON.stringify({
        error: "Rate limit exceeded",
        reason: rateLimitResult?.reason,
        counts: rateLimitResult?.counts,
      }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Staging detection — use test-mode key when origin is staging (fix #86e19wk6z).
    // gh-1536: exact-match, not substring — "app-staging." falsely matched
    // app-staging.otterquote.com, a Netlify DOMAIN ALIAS on the PRODUCTION app
    // site (not staging), which selected Stripe TEST-mode keys against real
    // production data. This must never match a production hostname.
    const _reqOrigin = req.headers.get("Origin") || "";
    const isStaging = _reqOrigin === "https://jade-alpaca-b82b5e.netlify.app" ||
      _reqOrigin === "https://staging--jade-alpaca-b82b5e.netlify.app";
    const stripeSecretKey = isStaging
      ? (Deno.env.get("STRIPE_SECRET_KEY_TEST") || Deno.env.get("STRIPE_SECRET_KEY"))
      : Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) throw new Error("Stripe secret key not configured.");
    const basicAuth = btoa(`${stripeSecretKey}:`);

    let paymentIntentData: any;

    // ===== OFF-SESSION contractor platform fee =====
    if (metadata.type === "platform_fee" && off_session && contractor_id) {
      const { data: contractorData, error: contractorError } = await supabase
        .from("contractors")
        .select("stripe_customer_id, stripe_payment_method_id")
        .eq("id", contractor_id)
        .single();
      if (contractorError || !contractorData) {
        throw new Error(`Failed to look up contractor: ${contractorError?.message || "contractor not found"}`);
      }
      if (!contractorData.stripe_customer_id) {
        throw new Error("Contractor does not have a Stripe customer on file. Charge cannot proceed.");
      }

      const { data: paymentMethods } = await supabase
        .from("contractor_payment_methods")
        .select("*")
        .eq("contractor_id", contractor_id)
        .order("is_default", { ascending: false })
        .order("payment_type", { ascending: true });

      interface PaymentMethodAttempt { stripe_payment_method_id: string; payment_type: string; id: string | null; }
      const methodsToTry: PaymentMethodAttempt[] = [];
      if (paymentMethods && paymentMethods.length > 0) {
        const defaultMethod = paymentMethods.find((m: any) => m.is_default);
        const nonDefault = paymentMethods.filter((m: any) => !m.is_default);
        const achMethods = nonDefault.filter((m: any) => m.payment_type === "us_bank_account");
        const cardMethods = nonDefault.filter((m: any) => m.payment_type === "card");
        if (defaultMethod) {
          methodsToTry.push({
            stripe_payment_method_id: defaultMethod.stripe_payment_method_id,
            payment_type: defaultMethod.payment_type,
            id: defaultMethod.id,
          });
        }
        for (const m of achMethods) {
          if (!defaultMethod || m.id !== defaultMethod.id) {
            methodsToTry.push({ stripe_payment_method_id: m.stripe_payment_method_id, payment_type: m.payment_type, id: m.id });
          }
        }
        for (const m of cardMethods) {
          if (!defaultMethod || m.id !== defaultMethod.id) {
            methodsToTry.push({ stripe_payment_method_id: m.stripe_payment_method_id, payment_type: m.payment_type, id: m.id });
          }
        }
      } else if (contractorData.stripe_payment_method_id) {
        methodsToTry.push({ stripe_payment_method_id: contractorData.stripe_payment_method_id, payment_type: "card", id: null });
      }
      if (methodsToTry.length === 0) {
        throw new Error("Contractor does not have any payment methods on file. Charge cannot proceed.");
      }

      let lastError = "";
      let usedMethod: PaymentMethodAttempt | null = null;
      let chargedAmount = amount;
      let cardFeeCents = 0;
      for (const method of methodsToTry) {
        let thisChargeAmount = amount;
        let thisCardFee = 0;
        if (method.payment_type === "card") {
          thisChargeAmount = calculateCardChargeAmount(amount);
          thisCardFee = thisChargeAmount - amount;
        }
        const form = new URLSearchParams();
        form.append("amount", String(thisChargeAmount));
        form.append("currency", currency);
        form.append("customer", contractorData.stripe_customer_id);
        form.append("payment_method", method.stripe_payment_method_id);
        form.append("off_session", "true");
        form.append("confirm", "true");
        form.append("description", description || "");
        form.append("metadata[claim_id]", metadata.claim_id);
        form.append("metadata[type]", metadata.type);
        form.append("metadata[contractor_id]", contractor_id);
        form.append("metadata[payment_type]", method.payment_type);
        form.append("metadata[platform_fee_cents]", String(amount));
        if (thisCardFee > 0) form.append("metadata[card_fee_cents]", String(thisCardFee));
        form.append("payment_method_types[]", method.payment_type === "us_bank_account" ? "us_bank_account" : "card");
        try {
          const offSessionKey = `plat-fee-${metadata.claim_id}-${contractor_id}-${method.stripe_payment_method_id}`;
          const r = await fetch(`${STRIPE_API_BASE}/payment_intents`, {
            method: "POST",
            headers: {
              Authorization: `Basic ${basicAuth}`,
              "Content-Type": "application/x-www-form-urlencoded",
              "Idempotency-Key": offSessionKey,
            },
            body: form.toString(),
          });
          const rd = await r.json();
          if (!r.ok) { lastError = rd?.error?.message || `HTTP ${r.status}`; continue; }
          if (rd.status === "requires_action" || rd.status === "requires_payment_method") {
            lastError = `Payment ${rd.status} for method ${method.stripe_payment_method_id}`;
            try {
              await fetch(`${STRIPE_API_BASE}/payment_intents/${rd.id}/cancel`, {
                method: "POST",
                headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
              });
            } catch {}
            continue;
          }
          paymentIntentData = rd;
          usedMethod = method;
          chargedAmount = thisChargeAmount;
          cardFeeCents = thisCardFee;
          break;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          continue;
        }
      }
      if (!paymentIntentData) {
        throw new Error(`All ${methodsToTry.length} payment methods failed. Last error: ${lastError}`);
      }
      if (metadata.quote_id) {
        // gh-948: 'processing' (ACH in flight) is NOT success. Map it to the
        // existing 'pending' quotes.payment_status value (allowed by
        // quotes_payment_status_check) instead of fabricating a premature
        // 'succeeded'. Any other non-succeeded status is treated as failed —
        // by the time we reach here requires_action/requires_payment_method
        // have already been filtered out of methodsToTry above.
        const dbPaymentStatus =
          paymentIntentData.status === "succeeded"
            ? "succeeded"
            : paymentIntentData.status === "processing"
            ? "pending"
            : "failed";
        const quoteUpdate: Record<string, any> = {
          payment_method_type: usedMethod!.payment_type,
          payment_status: dbPaymentStatus,
          payment_intent_id: paymentIntentData.id,
        };
        if (usedMethod!.id) quoteUpdate.payment_method_id = usedMethod!.id;
        if (cardFeeCents > 0) quoteUpdate.card_fee_cents = cardFeeCents;
        await supabase.from("quotes").update(quoteUpdate).eq("id", metadata.quote_id);
      }
    } else {
      // ===== Standard flow (hover_measurement, deductible_escrow, measurement_upgrade) =====
      const form = new URLSearchParams();
      form.append("amount", String(amount));
      form.append("currency", currency);
      // measurement_upgrade: description is server-enforced, never the
      // client-sent value — D-312/#1414 scrubbed vendor names from every
      // customer-facing string and this must never regress that.
      const chargeDescription = metadata.type === "measurement_upgrade"
        ? UPGRADE_CHARGE_DESCRIPTION
        : (description || "");
      form.append("description", chargeDescription);
      form.append("metadata[claim_id]", metadata.claim_id);
      form.append("metadata[type]", metadata.type);
      if (metadata.type === "measurement_upgrade") {
        form.append("metadata[contractor_id]", contractor_id);
        // Bookkeeping only (Marty, #1411 cto-2026-09-02T13:45:25Z: "does not
        // net it against the charge") — the contractor is still charged the
        // full tier amount above.
        form.append("metadata[vendor_credit_expected_cents]", String(VENDOR_CREDIT_EXPECTED_CENTS));
      }
      form.append("automatic_payment_methods[enabled]", "true");
      const idempotencyKey = `${metadata.type}-${metadata.claim_id}`;
      const r = await fetch(`${STRIPE_API_BASE}/payment_intents`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Idempotency-Key": idempotencyKey,
        },
        body: form.toString(),
      });
      if (!r.ok) {
        const err = await r.text();
        throw new Error(`Stripe API error (HTTP ${r.status}): ${err}`);
      }
      paymentIntentData = await r.json();
    }

    // gh-948: 'processing' (ACH in flight) must NOT be reported as `succeeded` —
    // callers (docusign-webhook, process-dunning) previously conflated the two and
    // ran fulfillment logic (fee-charged flag, contractor notification) on a charge
    // that had not actually settled. `pending` lets callers withhold fulfillment and
    // wait for the stripe-webhook payment_intent.succeeded / payment_intent.payment_failed
    // listeners to finalize the outcome.
    const succeeded = paymentIntentData.status === "succeeded";
    const pending = paymentIntentData.status === "processing";
    return new Response(JSON.stringify({
      client_secret: paymentIntentData.client_secret || null,
      payment_intent_id: paymentIntentData.id,
      status: paymentIntentData.status,
      succeeded,
      pending,
      amount: paymentIntentData.amount,
      currency: paymentIntentData.currency,
      rate_limit_counts: rateLimitResult?.counts,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error: any) {
    console.error("create-payment-intent error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
