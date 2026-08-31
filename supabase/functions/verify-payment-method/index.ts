/**
 * OtterQuote Edge Function: verify-payment-method
 *
 * gh-1387 — the authoritative, server-side confirmation that a contractor's
 * payment method is real, attached, and redeemable IN THE MODE THIS PLATFORM
 * ACTUALLY CHARGES IN.
 *
 * Why this exists
 * ---------------
 * Until now contractor-settings.html did every write itself, from the browser,
 * with the anon key:
 *
 *   1. insert into contractor_payment_methods
 *   2. update contractors.stripe_payment_method_id / _last4 / _brand
 *   3. ...and nothing, anywhere in the codebase, ever set
 *      contractors.has_payment_method. That column had no writer at all.
 *
 * Two separate things went wrong with that arrangement:
 *
 *   * stripe.retrievePaymentMethod(pm_id) is not a valid Stripe.js call. That
 *     method takes a *client secret*, not a PaymentMethod id, so it always
 *     threw, the catch swallowed the error, and the display placeholder
 *     "••••" was persisted into last_four instead of the real digits.
 *     Confirmed still happening on 2026-08-31 against a genuine live-mode card.
 *
 *   * A browser write can be skipped, replayed, or abandoned between steps, and
 *     a SetupIntent created against the Stripe sandbox writes a pm_/cus_ that a
 *     live-mode key can never redeem. Production contractors rows hold three
 *     such test-mode ids today.
 *
 * The gate that decides whether a homeowner may select a contractor
 * (get-contractor-info) must therefore not trust any client-written column.
 * This function re-reads the SetupIntent from Stripe using the server's own
 * secret key, refuses anything that is not "succeeded" and owned by this
 * contractor, and only then writes has_payment_method = true together with the
 * real card metadata, using the service role.
 *
 * The mode check is structural rather than a comparison: retrieving with the
 * key this platform charges with can only ever return an object that exists in
 * that key's mode. A test-mode SetupIntent presented to a live key 404s here
 * and earns a 409 — the flag stays false. A payment method that cannot be
 * retrieved with the charging key is not a payment method.
 *
 * Request body:
 *   contractor_id    (required)  UUID of the contractor
 *   setup_intent_id  (required)  seti_... returned by create-setup-intent
 *
 * Environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_ANON_KEY
 *   STRIPE_SECRET_KEY
 *   STRIPE_SECRET_KEY_TEST   (staging origins only)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FN_NAME = "verify-payment-method";
const STRIPE_API_BASE = "https://api.stripe.com/v1";

// Mirrors create-setup-intent's allowlist — this function is the second half of
// that flow and must accept exactly the same origins.
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

function json(body: unknown, status: number, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Digits-only guard. The DB check constraint enforces the same shape. */
function normalizeLast4(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return /^[0-9]{4}$/.test(raw) ? raw : null;
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  try {
    // ── Caller identity ──────────────────────────────────────────────────
    // The contractor may only verify their own payment method. Reading the
    // caller from the JWT (not from the request body) is what makes that
    // unforgeable.
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "Missing Authorization header" }, 401, corsHeaders);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    const callerId = userData?.user?.id;
    if (userErr || !callerId) {
      return json({ error: "Not authenticated" }, 401, corsHeaders);
    }

    const { contractor_id, setup_intent_id } = await req.json();
    if (!contractor_id || !setup_intent_id) {
      return json(
        { error: "Missing contractor_id or setup_intent_id" },
        400,
        corsHeaders,
      );
    }

    const sb = createClient(supabaseUrl, serviceKey);

    const { data: contractor, error: contractorErr } = await sb
      .from("contractors")
      .select("id, user_id, stripe_customer_id")
      .eq("id", contractor_id)
      .single();

    if (contractorErr || !contractor) {
      return json({ error: "Contractor not found" }, 404, corsHeaders);
    }
    if (contractor.user_id !== callerId) {
      return json({ error: "Forbidden" }, 403, corsHeaders);
    }

    // ── Stripe key selection ─────────────────────────────────────────────
    // Identical rule to create-setup-intent, so both halves of one card-add
    // always run against the same Stripe account and mode.
    const reqOrigin = req.headers.get("Origin") || "";
    const isStaging =
      reqOrigin.includes("staging--") || reqOrigin.includes("app-staging.");
    const stripeSecretKey = isStaging
      ? (Deno.env.get("STRIPE_SECRET_KEY_TEST") || Deno.env.get("STRIPE_SECRET_KEY"))
      : Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeSecretKey) {
      throw new Error("Stripe secret key not configured.");
    }
    const basicAuth = btoa(`${stripeSecretKey}:`);

    // ── Retrieve the SetupIntent with the charging key ───────────────────
    // expand[]=payment_method gets the card/bank details in the same round
    // trip, which is the whole reason the browser never needs to (and never
    // could correctly) look them up itself.
    const siResp = await fetch(
      `${STRIPE_API_BASE}/setup_intents/${encodeURIComponent(setup_intent_id)}` +
        `?expand[]=payment_method`,
      { headers: { Authorization: `Basic ${basicAuth}` } },
    );

    if (!siResp.ok) {
      const detail = await siResp.text();
      console.error(`[${FN_NAME}] SetupIntent ${setup_intent_id} not retrievable:`, detail);
      // 404 here is the test-mode-object-in-production case. Report it as a
      // conflict rather than a 404 so the page can say something true: the
      // card was not saved and must be re-entered.
      return json(
        {
          error: "payment_method_unverifiable",
          message:
            "This payment method could not be verified with our payment processor. " +
            "It was not saved. Please re-enter your card.",
        },
        409,
        corsHeaders,
      );
    }

    const si = await siResp.json();

    if (si.status !== "succeeded") {
      return json(
        {
          error: "setup_intent_not_succeeded",
          message: `Payment method setup is not complete (status: ${si.status}).`,
        },
        409,
        corsHeaders,
      );
    }

    // The SetupIntent must be the one this platform created for this
    // contractor. create-setup-intent stamps both metadata keys.
    if (si.metadata?.contractor_id !== contractor_id) {
      console.error(
        `[${FN_NAME}] SetupIntent ${setup_intent_id} metadata.contractor_id ` +
          `does not match requested contractor ${contractor_id}`,
      );
      return json({ error: "Forbidden" }, 403, corsHeaders);
    }

    const pm = si.payment_method;
    if (!pm || typeof pm !== "object" || !pm.id) {
      return json(
        {
          error: "payment_method_missing",
          message: "The setup completed without attaching a payment method.",
        },
        409,
        corsHeaders,
      );
    }

    // ── Real card metadata, from Stripe, never from the browser ──────────
    const paymentType: string = pm.type === "us_bank_account" ? "us_bank_account" : "card";
    const last4 = normalizeLast4(
      paymentType === "us_bank_account" ? pm.us_bank_account?.last4 : pm.card?.last4,
    );
    const brand =
      paymentType === "us_bank_account"
        ? (pm.us_bank_account?.bank_name || "Bank Account")
        : (pm.card?.brand ? String(pm.card.brand).toUpperCase() : "CARD");

    if (!last4) {
      // Stripe returned an object without usable digits. Refuse rather than
      // persist another placeholder — that is the exact defect this replaces.
      console.error(`[${FN_NAME}] No usable last4 on payment method ${pm.id}`);
      return json(
        {
          error: "payment_method_incomplete",
          message: "Your payment processor did not return card details. Please try again.",
        },
        409,
        corsHeaders,
      );
    }

    console.log(
      `[${FN_NAME}] Verified ${pm.id} (${paymentType}, livemode=${si.livemode}) ` +
        `for contractor ${contractor_id}`,
    );

    // ── Persist, service role ────────────────────────────────────────────
    // Upsert so a retry after a partial failure converges instead of
    // duplicating. idx_cpm_stripe_pm_id is UNIQUE on stripe_payment_method_id
    // alone, which is what makes the retry idempotent.
    const { data: existingRows } = await sb
      .from("contractor_payment_methods")
      .select("id")
      .eq("contractor_id", contractor_id);
    const isFirstMethod = !existingRows || existingRows.length === 0;

    const { error: upsertErr } = await sb
      .from("contractor_payment_methods")
      .upsert(
        {
          contractor_id: contractor_id,
          stripe_payment_method_id: pm.id,
          payment_type: paymentType,
          last_four: last4,
          brand: paymentType === "card" ? brand : null,
          bank_name: paymentType === "us_bank_account" ? brand : null,
          is_default: isFirstMethod,
        },
        { onConflict: "stripe_payment_method_id" },
      );

    if (upsertErr) {
      console.error(`[${FN_NAME}] contractor_payment_methods upsert failed:`, upsertErr);
      throw new Error(`Could not save payment method: ${upsertErr.message}`);
    }

    // has_payment_method is set HERE and nowhere else. It is the gate's single
    // source of truth and it means exactly one thing: "Stripe confirmed this
    // method with the key we charge with."
    if (isFirstMethod) {
      const { error: contractorUpdErr } = await sb
        .from("contractors")
        .update({
          has_payment_method: true,
          stripe_payment_method_id: pm.id,
          stripe_payment_method_last4: last4,
          stripe_payment_method_brand: brand,
          updated_at: new Date().toISOString(),
        })
        .eq("id", contractor_id);

      if (contractorUpdErr) {
        console.error(`[${FN_NAME}] contractors update failed:`, contractorUpdErr);
        throw new Error(`Could not update contractor: ${contractorUpdErr.message}`);
      }
    }

    return json(
      {
        ok: true,
        payment_method_id: pm.id,
        payment_type: paymentType,
        last_four: last4,
        brand,
        livemode: si.livemode === true,
        is_default: isFirstMethod,
      },
      200,
      corsHeaders,
    );
  } catch (error) {
    console.error(`[${FN_NAME}] error:`, error);
    return json({ error: (error as Error).message }, 500, corsHeaders);
  }
});
