/**
 * OtterQuote Edge Function: create-measurement-order
 *
 * Records a PAID, HUMAN-FULFILLED measurement order. It contacts no
 * measurement vendor. It verifies that the buyer's Stripe PaymentIntent
 * actually succeeded for the right amount, on the right claim, then writes a
 * row in status 'awaiting_fulfillment' for an admin to work in
 * admin-measurements.html.
 *
 * WHY THIS EXISTS (Dustin, 2026-08-24): "Make sure we are able to purchase
 * measurements from [our vendor]. We have measurements mailed to us and
 * entered manually for the first few runs." The pre-existing
 * create-hover-order function calls a vendor API synchronously and has no
 * way to express "paid, a human will order it." This does, and it is
 * deliberately vendor-agnostic — swapping vendors, or automating fulfillment
 * later, changes the admin tool, not this function or the money path.
 *
 * PRICING (Dustin's 2026-08-24 ruling): the homeowner pays for the condensed
 * roof report only — "It should be enough to bid on for most jobs. If
 * contractors need the full measurement, they can pay for it." SKUs, prices
 * and expected vendor costs live in platform_settings.measurement_products
 * so an operator can reprice without a deploy. This function NEVER trusts a
 * price from the client; it reads the catalog and requires the PaymentIntent
 * to match it exactly.
 *
 * Contractor-buyer SKUs (homeowner_price_cents = null) are NOT purchasable
 * through this function. A contractor asking for a full report is a money
 * flow Dustin has not priced; those arrive as unpriced requests instead
 * (buyer_role='contractor', status='awaiting_quote') and an admin prices
 * them by hand. Rejecting rather than guessing is the point.
 *
 * [gh-1411, 2026-09-03] EXCEPTION to the paragraph above: product_code
 * 'roof_upgrade_detailed' (D-317 cl. 4/5, the contractor detailed-measurement
 * upgrade) IS a priced, chargeable contractor purchase — $25/$55 by SQ tier,
 * computed and enforced server-side by create-payment-intent's own gate, not
 * by this file's catalog-driven price. It is handled by a dedicated branch
 * near the top of the handler, before the generic catalog flow, because it
 * is not (and by design cannot be) a flat-priced platform_settings SKU. See
 * measurement-upgrade-order.ts.
 *
 * Environment variables:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
 *   STRIPE_SECRET_KEY (+ STRIPE_SECRET_KEY_TEST for staging origins)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.114.0";
import { logNotificationFailure } from "./notification-failure.ts";
import {
  buildUpgradeOrderInsert,
  UPGRADE_PRODUCT_CODE,
} from "./measurement-upgrade-order.ts";

const FUNCTION_NAME = "create-measurement-order";
const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** PaymentIntent metadata.type this function will accept. */
const PI_TYPE = "measurement_order";
/** Legacy value still emitted by the older frontend payment path. */
const PI_TYPE_LEGACY = "hover_measurement";

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

function json(body: unknown, status: number, corsHeaders: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Verify the incoming JWT with Supabase Auth. The gateway check is disabled
 * (--no-verify-jwt) across this project because of an ES256/HS256 mismatch,
 * so this handler-level check is the only thing standing between an
 * anonymous caller and a write. Same pattern as create-hover-order.
 */
async function verifyJwt(
  req: Request,
  supabaseUrl: string,
  supabaseAnonKey: string,
  corsHeaders: Record<string, string>,
): Promise<{ user: any } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return json({ error: "Unauthorized. A valid user session is required." }, 401, corsHeaders);
  }
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${authHeader.slice(7)}` } },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) {
    return json({ error: "Unauthorized. Session invalid or expired." }, 401, corsHeaders);
  }
  return { user };
}

interface Product {
  label?: string;
  buyer?: string;
  scope?: string;
  homeowner_price_cents?: number | null;
  expected_vendor_cost_cents?: number | null;
  rebate_on_close?: boolean;
  active?: boolean;
}

/** Read one SKU from the operator-editable catalog. */
async function loadProduct(supabase: any, productCode: string): Promise<Product | null> {
  const { data } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", "measurement_products")
    .maybeSingle();
  const catalog = (data?.value ?? {}) as Record<string, Product>;
  const product = catalog[productCode];
  if (!product || product.active === false) return null;
  return product;
}

/**
 * Guard against a two-source price split.
 *
 * create-payment-intent prices the charge from
 * platform_settings.hover_measurement_price (D-181). This function prices the
 * ORDER from platform_settings.measurement_products. Today both say 1500. If
 * an operator edits one and not the other, every purchase would fail with the
 * generic "amount does not match" 402 and nobody would know why.
 *
 * So: when the legacy key exists and disagrees with the catalog for the SKU
 * the legacy key actually governs, refuse with a message that names the
 * problem. A loud, specific failure is the point — silently preferring one
 * source would let the two drift apart unnoticed, which is the failure this
 * check exists to prevent.
 *
 * The follow-up that removes this guard is repointing create-payment-intent
 * at the catalog. Until that ships, this is the seam.
 */
const LEGACY_PRICED_SKU = "roof_basic";

async function detectPriceDrift(
  supabase: any,
  productCode: string,
  catalogPrice: number,
): Promise<string | null> {
  if (productCode !== LEGACY_PRICED_SKU) return null;
  const { data } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", "hover_measurement_price")
    .maybeSingle();
  if (data?.value === null || data?.value === undefined) return null;
  const legacy = Number(data.value);
  if (!Number.isFinite(legacy) || legacy === catalogPrice) return null;
  console.error(`[${FUNCTION_NAME}] PRICE DRIFT`, {
    product_code: productCode,
    measurement_products_cents: catalogPrice,
    hover_measurement_price_cents: legacy,
  });
  return "This report is temporarily unavailable — its price is misconfigured. Nothing has been charged. Please contact support.";
}

/**
 * Confirm the buyer really paid, for this SKU, on this claim.
 *
 * Every check here is a "must be true," not a "should be": the expected
 * amount comes from the catalog rather than the request body, so a client
 * that lies about the price fails; the claim_id and type must match the
 * PaymentIntent's own metadata, so a PaymentIntent from a different claim or
 * a different kind of charge cannot be replayed into a free report.
 */
async function verifyPayment(
  paymentIntentId: string,
  expectedAmount: number,
  claimId: string | null,
  requestOrigin: string,
): Promise<{ ok: true; amount: number; stripeChargeId: string | null } | { ok: false; status: number; error: string }> {
  // gh-1536: exact-match, not substring — "app-staging." falsely matched
  // app-staging.otterquote.com, a Netlify DOMAIN ALIAS on the PRODUCTION app
  // site (not staging), which selected Stripe TEST-mode keys against real
  // production data. This must never match a production hostname.
  const isStaging = requestOrigin === "https://jade-alpaca-b82b5e.netlify.app" ||
    requestOrigin === "https://staging--jade-alpaca-b82b5e.netlify.app";
  const stripeSecretKey = isStaging
    ? (Deno.env.get("STRIPE_SECRET_KEY_TEST") || Deno.env.get("STRIPE_SECRET_KEY"))
    : Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) {
    return { ok: false, status: 500, error: "Payment processing is not configured." };
  }

  const basicAuth = btoa(`${stripeSecretKey}:`);
  const piRes = await fetch(
    `${STRIPE_API_BASE}/payment_intents/${encodeURIComponent(paymentIntentId)}`,
    { headers: { Authorization: `Basic ${basicAuth}` } },
  );
  if (!piRes.ok) {
    console.error(`[${FUNCTION_NAME}] Stripe PI retrieve failed:`, piRes.status, await piRes.text());
    return {
      ok: false,
      status: 402,
      error: "We could not verify your payment. Please try again or contact support.",
    };
  }
  const pi = await piRes.json();

  if (pi.status !== "succeeded") {
    return {
      ok: false,
      status: 402,
      error: `Payment must complete before we can order your report. Current payment status: ${pi.status}.`,
    };
  }
  if (pi.amount !== expectedAmount) {
    console.error(`[${FUNCTION_NAME}] PI amount mismatch:`, { got: pi.amount, expected: expectedAmount, pi: pi.id });
    return { ok: false, status: 402, error: "Payment amount does not match the report price. Please contact support." };
  }
  if (claimId && pi.metadata?.claim_id && pi.metadata.claim_id !== claimId) {
    console.error(`[${FUNCTION_NAME}] PI claim mismatch:`, { pi_claim: pi.metadata.claim_id, supplied: claimId });
    return { ok: false, status: 402, error: "Payment does not belong to this project. Please contact support." };
  }
  if (pi.metadata?.type && pi.metadata.type !== PI_TYPE && pi.metadata.type !== PI_TYPE_LEGACY) {
    console.error(`[${FUNCTION_NAME}] PI type mismatch:`, { pi_type: pi.metadata.type });
    return { ok: false, status: 402, error: "Payment is not a measurement charge. Please contact support." };
  }

  return { ok: true, amount: pi.amount, stripeChargeId: pi.latest_charge ?? null };
}

/**
 * [gh-1411] verifyPayment's counterpart for the measurement_upgrade type.
 * Deliberately separate rather than widening verifyPayment's signature: this
 * SKU has no single catalog `expectedAmount` (it is SQ-tier priced — see
 * measurement-upgrade-order.ts), so the exact-amount check is a membership
 * test against the two known tier prices instead, performed by the caller
 * via buildUpgradeOrderInsert. This function only confirms Stripe actually
 * settled the charge, for the right claim, as the right charge type.
 */
async function verifyUpgradePayment(
  paymentIntentId: string,
  claimId: string,
  requestOrigin: string,
): Promise<{ ok: true; amount: number; stripeChargeId: string | null } | { ok: false; status: number; error: string }> {
  const isStaging = requestOrigin === "https://jade-alpaca-b82b5e.netlify.app" ||
    requestOrigin === "https://staging--jade-alpaca-b82b5e.netlify.app";
  const stripeSecretKey = isStaging
    ? (Deno.env.get("STRIPE_SECRET_KEY_TEST") || Deno.env.get("STRIPE_SECRET_KEY"))
    : Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeSecretKey) {
    return { ok: false, status: 500, error: "Payment processing is not configured." };
  }

  const basicAuth = btoa(`${stripeSecretKey}:`);
  const piRes = await fetch(
    `${STRIPE_API_BASE}/payment_intents/${encodeURIComponent(paymentIntentId)}`,
    { headers: { Authorization: `Basic ${basicAuth}` } },
  );
  if (!piRes.ok) {
    console.error(`[${FUNCTION_NAME}] Stripe PI retrieve failed (upgrade):`, piRes.status, await piRes.text());
    return {
      ok: false,
      status: 402,
      error: "We could not verify your payment. Please try again or contact support.",
    };
  }
  const pi = await piRes.json();

  if (pi.status !== "succeeded") {
    return {
      ok: false,
      status: 402,
      error: `Payment must complete before we can order your report. Current payment status: ${pi.status}.`,
    };
  }
  if (pi.metadata?.claim_id && pi.metadata.claim_id !== claimId) {
    console.error(`[${FUNCTION_NAME}] upgrade PI claim mismatch:`, { pi_claim: pi.metadata.claim_id, supplied: claimId });
    return { ok: false, status: 402, error: "Payment does not belong to this project. Please contact support." };
  }
  if (pi.metadata?.type !== "measurement_upgrade") {
    console.error(`[${FUNCTION_NAME}] upgrade PI type mismatch:`, { pi_type: pi.metadata?.type });
    return { ok: false, status: 402, error: "Payment is not a measurement-upgrade charge. Please contact support." };
  }

  return { ok: true, amount: pi.amount, stripeChargeId: pi.latest_charge ?? null };
}

/**
 * gh-1412: make the order visible the moment it exists.
 *
 * Two artifacts, neither of which may break the money path:
 *   1. An activity_log row — the CTO's #1412 ruling put this first: "the log
 *      row is the record that makes the order findable, auditable, and
 *      reportable." Before this, a paid order's only trace anywhere was the
 *      hover_orders row itself (measured live: the first real-looking order
 *      sat 6h44m in awaiting_fulfillment with zero activity rows).
 *   2. An invoke of notify-measurement-order (service-role bearer, same
 *      machine-to-machine model as notify-admin-new-contractor), which sends
 *      the admin the "Buy basic report — [address]" / "Buy detailed report —
 *      [address]" purchase email per #1339's spec copy.
 *
 * Failures here are logged and swallowed: the buyer's order (and possibly
 * their money) is already recorded, and a notification failure must never
 * turn a recorded order into a 500.
 */
async function recordOrderCreated(
  supabase: any,
  supabaseUrl: string,
  order: { id: string; status: string },
  claimId: string,
  productCode: string,
  buyerRole: string,
  buyerUserId: string,
  amountCents: number | null,
): Promise<void> {
  // gh-1538: this lookup must never throw out of recordOrderCreated — a
  // failure here must not turn an already-recorded (and possibly paid)
  // order into a client-facing 500. Defaults is_test to false (fail toward
  // "treat as real," matching this function's existing swallow-everything
  // posture) rather than let the exception propagate.
  let isTest = false;
  try {
    const { data: claim } = await supabase
      .from("claims")
      .select("is_test")
      .eq("id", claimId)
      .maybeSingle();
    isTest = claim?.is_test === true;
  } catch (e) {
    console.error(`[${FUNCTION_NAME}] claim is_test lookup failed:`, e);
  }

  try {
    const { error: logErr } = await supabase.from("activity_log").insert({
      event_type: "measurement_order_created",
      title: "measurement_order_created",
      user_id: buyerUserId,
      is_test: isTest,
      metadata: {
        order_id: order.id,
        claim_id: claimId,
        product_code: productCode,
        status: order.status,
        requested_by_role: buyerRole,
        amount_cents: amountCents,
      },
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
      body: JSON.stringify({ order_id: order.id }),
    });
    if (!res.ok) {
      const bodyText = await res.text();
      throw new Error(`notify-measurement-order returned ${res.status}: ${bodyText}`);
    }
  } catch (e) {
    // gh-1538: this was console.error-only, with no durable trace anywhere
    // (no activity_log row, no Sentry, no notifications row). Never turn a
    // notification failure into a client-facing throw here — the order is
    // already recorded, and possibly paid for; log it instead.
    console.error(`[${FUNCTION_NAME}] notify-measurement-order invoke failed:`, e);
    await logNotificationFailure(
      (row) => supabase.from("activity_log").insert(row),
      e,
      {
        functionName: FUNCTION_NAME,
        recipientRole: buyerRole,
        isTest,
        userId: buyerUserId,
        extra: { order_id: order.id, claim_id: claimId },
      },
    );
  }
}

serve(async (req) => {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, corsHeaders);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const jwtResult = await verifyJwt(req, supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, corsHeaders);
  if (jwtResult instanceof Response) return jwtResult;
  const authedUser = jwtResult.user;

  try {
    const body = await req.json();
    const claimId: string | null = body.claim_id ?? null;
    const productCode: string = body.product_code ?? "";
    const paymentIntentId: string | undefined = body.payment_intent_id;
    const buyerRole: string = body.buyer_role === "contractor" ? "contractor" : "homeowner";
    const contractorId: string | null = body.contractor_id ?? null;
    const note: string | null = typeof body.note === "string" ? body.note.slice(0, 2000) : null;

    if (!claimId) return json({ error: "Missing claim_id." }, 400, corsHeaders);
    if (!productCode) return json({ error: "Missing product_code." }, 400, corsHeaders);

    // ── gh-1411 / D-317 cl. 4-5: contractor detailed-measurement upgrade ──
    // Not a catalog SKU (see the file header note) — handled entirely here,
    // before the generic loadProduct() flow below.
    if (productCode === UPGRADE_PRODUCT_CODE) {
      if (buyerRole !== "contractor" || !contractorId) {
        return json({ error: "The detailed-measurement upgrade may only be purchased by a contractor." }, 400, corsHeaders);
      }
      if (!paymentIntentId || typeof paymentIntentId !== "string") {
        return json(
          { error: "Missing payment_intent_id. A completed payment is required before we can record your upgrade." },
          400,
          corsHeaders,
        );
      }

      // Idempotency FIRST, before touching Stripe — same discipline as the
      // generic paid path below: a retried request for a PaymentIntent we
      // already recorded returns the existing order rather than a duplicate.
      const { data: existingUpgrade } = await supabase
        .from("hover_orders")
        .select("id, status")
        .eq("homeowner_stripe_payment_intent_id", paymentIntentId)
        .maybeSingle();
      if (existingUpgrade) {
        return json({ order_id: existingUpgrade.id, status: existingUpgrade.status, idempotent: true }, 200, corsHeaders);
      }

      // First buyer? Only the first upgrade order on a claim carries the
      // D-317 cl. 4 vendor-credit bookkeeping (see measurement-upgrade-order.ts).
      const { data: priorUpgrade } = await supabase
        .from("hover_orders")
        .select("id")
        .eq("claim_id", claimId)
        .eq("product_code", UPGRADE_PRODUCT_CODE)
        .limit(1)
        .maybeSingle();
      const isFirstBuyer = !priorUpgrade;

      const paidUpgrade = await verifyUpgradePayment(paymentIntentId, claimId, req.headers.get("Origin") || "");
      if (!paidUpgrade.ok) return json({ error: paidUpgrade.error }, paidUpgrade.status, corsHeaders);

      const decision = buildUpgradeOrderInsert(
        paidUpgrade,
        claimId,
        authedUser.id,
        contractorId,
        paymentIntentId,
        isFirstBuyer,
        note,
      );
      if (!decision.ok) {
        console.error(`[${FUNCTION_NAME}] upgrade order rejected AFTER successful payment:`, {
          payment_intent_id: paymentIntentId,
          claim_id: claimId,
          error: decision.error,
        });
        return json({ error: decision.error, payment_captured: true }, decision.status, corsHeaders);
      }

      let { data: upgradeOrder, error: upgradeInsErr } = await supabase
        .from("hover_orders")
        .insert(decision.insertPayload)
        .select("id, status")
        .single();

      // [gh-1411] vendor_credit_expected_cents ships in this PR's migration
      // (Tier 3A additive, D-182 approval pending) but may not be applied to
      // every environment yet. Same tolerance the #1410 shape column already
      // requires of readers (js/measurement-shape.js) — degrade gracefully
      // rather than turn an already-captured payment into a 500. The order
      // itself, and its PaymentIntent id, are never dropped by this retry.
      if (upgradeInsErr?.code === "42703") {
        console.error(
          `[${FUNCTION_NAME}] hover_orders.vendor_credit_expected_cents missing (migration not yet applied) — retrying without it:`,
          upgradeInsErr,
        );
        const { vendor_credit_expected_cents: _omit, ...payloadWithoutVendorCredit } = decision.insertPayload;
        const retry = await supabase
          .from("hover_orders")
          .insert(payloadWithoutVendorCredit)
          .select("id, status")
          .single();
        upgradeOrder = retry.data;
        upgradeInsErr = retry.error;
      }

      if (upgradeInsErr || !upgradeOrder) {
        // The buyer's money has already moved. Never tell them the order
        // failed in a way that invites a second payment — this is a support case.
        console.error(`[${FUNCTION_NAME}] upgrade order insert failed AFTER successful payment:`, {
          payment_intent_id: paymentIntentId,
          claim_id: claimId,
          error: upgradeInsErr,
        });
        return json({
          error: "Your payment went through, but we could not record the order. Do not pay again — contact support and we will finish it by hand.",
          payment_captured: true,
        }, 500, corsHeaders);
      }

      console.log(`[${FUNCTION_NAME}] upgrade order queued for manual fulfillment:`, {
        order_id: upgradeOrder.id,
        claim_id: claimId,
        contractor_id: contractorId,
        amount: paidUpgrade.amount,
        first_buyer: isFirstBuyer,
      });

      // gh-1412: same log + admin email path every other paid order uses.
      await recordOrderCreated(
        supabase,
        supabaseUrl,
        upgradeOrder,
        claimId,
        UPGRADE_PRODUCT_CODE,
        "contractor",
        authedUser.id,
        paidUpgrade.amount,
      );

      return json({
        order_id: upgradeOrder.id,
        status: upgradeOrder.status,
        product_code: UPGRADE_PRODUCT_CODE,
        amount: paidUpgrade.amount,
      }, 200, corsHeaders);
    }

    const product = await loadProduct(supabase, productCode);
    if (!product) {
      return json({ error: "That report is not available." }, 400, corsHeaders);
    }

    // ── Contractor-requested reports are quoted by a human, never charged here ──
    // The catalog marks these with homeowner_price_cents = null. Charging a
    // contractor is a money flow that has not been priced; this function
    // refuses to invent one and files an unpriced request instead.
    const price = product.homeowner_price_cents;
    const isQuoteOnly = price === null || price === undefined;

    if (isQuoteOnly) {
      if (buyerRole !== "contractor") {
        return json({ error: "That report is not available for purchase." }, 400, corsHeaders);
      }
      // Idempotent on (claim, product, contractor) so a double-click files one request.
      const { data: dupe } = await supabase
        .from("hover_orders")
        .select("id, status")
        .eq("claim_id", claimId)
        .eq("product_code", productCode)
        .in("status", ["awaiting_quote", "awaiting_fulfillment"])
        .maybeSingle();
      if (dupe) {
        return json({ order_id: dupe.id, status: dupe.status, idempotent: true }, 200, corsHeaders);
      }

      const { data: requested, error: reqErr } = await supabase
        .from("hover_orders")
        .insert({
          claim_id: claimId,
          user_id: authedUser.id,
          status: "awaiting_quote",
          product_code: productCode,
          fulfillment_mode: "manual",
          requested_by_role: "contractor",
          requested_by_contractor_id: contractorId,
          admin_notes: note,
        })
        .select("id, status")
        .single();
      if (reqErr) {
        console.error(`[${FUNCTION_NAME}] request insert failed:`, reqErr);
        return json({ error: "Could not file your request. Please try again." }, 500, corsHeaders);
      }
      // gh-1412: log + admin email ("Buy detailed report — [address]").
      await recordOrderCreated(supabase, supabaseUrl, requested, claimId, productCode, "contractor", authedUser.id, null);
      return json({ order_id: requested.id, status: requested.status, quote_required: true }, 200, corsHeaders);
    }

    // ── Paid path ──
    if (!paymentIntentId || typeof paymentIntentId !== "string") {
      return json(
        { error: "Missing payment_intent_id. A completed payment is required before we order your report." },
        400,
        corsHeaders,
      );
    }

    // Idempotency FIRST, before touching Stripe: a retried request for a
    // PaymentIntent we have already recorded returns the existing order
    // rather than creating a second one the admin would fulfil twice.
    const { data: existing } = await supabase
      .from("hover_orders")
      .select("id, status, product_code")
      .eq("homeowner_stripe_payment_intent_id", paymentIntentId)
      .maybeSingle();
    if (existing) {
      return json({ order_id: existing.id, status: existing.status, idempotent: true }, 200, corsHeaders);
    }

    const drift = await detectPriceDrift(supabase, productCode, price!);
    if (drift) return json({ error: drift }, 409, corsHeaders);

    const paid = await verifyPayment(paymentIntentId, price!, claimId, req.headers.get("Origin") || "");
    if (!paid.ok) return json({ error: paid.error }, paid.status, corsHeaders);

    const { data: order, error: insErr } = await supabase
      .from("hover_orders")
      .insert({
        claim_id: claimId,
        user_id: authedUser.id,
        status: "awaiting_fulfillment",
        product_code: productCode,
        fulfillment_mode: "manual",
        requested_by_role: buyerRole,
        requested_by_contractor_id: buyerRole === "contractor" ? contractorId : null,
        homeowner_stripe_payment_intent_id: paymentIntentId,
        homeowner_charge_amount: paid.amount,
        amount_charged: paid.amount / 100,
        stripe_payment_id: paid.stripeChargeId,
        rebate_due: product.rebate_on_close === true,
        admin_notes: note,
      })
      .select("id, status")
      .single();

    if (insErr) {
      // The buyer's money has already moved. Never tell them the order failed
      // in a way that invites a second payment — this is a support case.
      console.error(`[${FUNCTION_NAME}] order insert failed AFTER successful payment:`, {
        payment_intent_id: paymentIntentId,
        claim_id: claimId,
        error: insErr,
      });
      return json({
        error: "Your payment went through, but we could not record the order. Do not pay again — contact support and we will finish it by hand.",
        payment_captured: true,
      }, 500, corsHeaders);
    }

    console.log(`[${FUNCTION_NAME}] order queued for manual fulfillment:`, {
      order_id: order.id,
      claim_id: claimId,
      product_code: productCode,
      amount: paid.amount,
    });

    // gh-1412: log + admin email ("Buy basic report — [address]").
    await recordOrderCreated(supabase, supabaseUrl, order, claimId, productCode, buyerRole, authedUser.id, paid.amount);

    return json({
      order_id: order.id,
      status: order.status,
      product_code: productCode,
      rebate_due: product.rebate_on_close === true,
    }, 200, corsHeaders);
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] unhandled:`, err);
    return json({ error: "Something went wrong recording your order." }, 500, corsHeaders);
  }
});
