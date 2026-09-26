/**
 * [gh-2121 / HO-3] stripe-webhook's handling of the no-account, lead-keyed
 * measurement purchase (PaymentIntent metadata.type = lead_measurement_order).
 *
 * Two independent jobs, both run from ONE call site in index.ts
 * (handleLeadMeasurementPurchase), each fully caught so neither can fail the
 * webhook or block the other:
 *
 *   1. RECORD THE ORDER (PR #2226 REVIEW D5). The browser's
 *      create-lead-measurement-order call is UX only; a closed tab or a dropped
 *      network used to leave a charge with no order row. Here the order is
 *      upserted from the signature-verified PaymentIntent through the SAME
 *      shared recordLeadOrder()/checkLeadPaymentIntent() the browser path uses
 *      (INSERT ... ON CONFLICT (stripe_payment_intent_id) DO NOTHING), then the
 *      admin email is sent for a newly inserted row. Every failure writes
 *      platform_alerts_log (lead_order_payment_captured_unrecorded).
 *
 *   2. META CAPI PURCHASE. Same safety discipline as the claim-keyed
 *      handleMeasurementOrderCapiPurchase in index.ts: GPC metadata checked
 *      first, the USD/$15 pin, fail-closed person resolution, the test-traffic
 *      gate (leads.is_synthetic stands in for claims.is_test -- Ruling 4), the
 *      hashed-email suppression list, and the PaymentIntent-scoped claim
 *      dedupe (sendCapiPurchaseOnce). It lives in this module, not in
 *      index.ts, so index.ts's claim-keyed handler -- and the structural tests
 *      that pin it (meta-capi-*.test.ts) -- are byte-for-byte unchanged
 *      (REVIEW D8). lead-capi.test.ts pins the same ordering rules on THIS
 *      handler.
 *
 * Pure decision helpers are exported for unit tests.
 */

import {
  buildCapiEventId,
  buildCapiPurchasePayload,
  CAPI_CLAIM_EVENT_TYPE,
  capiClaimKey,
  capiPurchaseValueUsd,
  hashEmailSha256,
  MEASUREMENT_PURCHASE_VALUE_USD,
  META_CAPI_API_VERSION,
  META_CAPI_PIXEL_ID,
  safeMetaErrorSummary,
  sanitizeCapiVariant,
  sendCapiPurchaseOnce,
  shouldSendCapiEvent,
  shouldSkipForGpcMetadata,
  shouldSkipForNonUsdMeasurement,
  shouldSkipForSuppression,
} from "./meta-capi.ts";
import {
  checkLeadPaymentIntent,
  HOVER_PRICE_SETTING_KEY,
  LEAD_MEASUREMENT_PI_TYPE,
  LEAD_ORDER_UNRECORDED_ALERT,
  recordLeadOrder,
  resolveRequiredPriceCents,
  resolveStripeMode,
  unrecordedAlertMessage,
} from "../_shared/lead-measurement-order.ts";

export { LEAD_MEASUREMENT_PI_TYPE };

const FN_NAME = "stripe-webhook";
const META_CAPI_TIMEOUT_MS = 3000;

// deno-lint-ignore no-explicit-any
type PaymentIntentLike = any;
// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/** Only a PI whose metadata.type is exactly this feature's own value is ever considered here -- never touches the claim-keyed types. */
export function isLeadMeasurementPurchase(pi: PaymentIntentLike): boolean {
  return pi?.metadata?.type === LEAD_MEASUREMENT_PI_TYPE;
}

/**
 * The lead-keyed counterpart to meta-capi.ts's decideCapiPerson. A lead IS
 * the person, so skip only when the lead itself could not be resolved. An
 * empty email (phone-only leads store '') is not a skip reason.
 */
export function decideLeadCapiPerson(input: {
  leadId: string | null | undefined;
  leadLookupFailed: boolean;
  leadFound?: boolean;
}): { skip: boolean; reason: "lead_lookup_failed" | "no_lead_id" | "lead_not_found" | null } {
  if (input.leadLookupFailed) return { skip: true, reason: "lead_lookup_failed" };
  if (!input.leadId) return { skip: true, reason: "no_lead_id" };
  if (input.leadFound === false) return { skip: true, reason: "lead_not_found" };
  return { skip: false, reason: null };
}

export interface LeadRow {
  id: string;
  email: string | null;
  is_synthetic: boolean | null;
  property_address?: string | null;
}

/** Resolves the fields this handler needs from a `leads` row lookup. */
export function resolveLeadForCapi(lead: LeadRow | null): { email: string | null; isSynthetic: boolean } {
  return {
    email: lead?.email && lead.email.length > 0 ? lead.email : null,
    isSynthetic: lead?.is_synthetic === true,
  };
}

export interface LeadPurchaseEnv {
  get: (name: string) => string | undefined;
  fetch: typeof fetch;
}

const defaultEnv: LeadPurchaseEnv = {
  get: (name) => Deno.env.get(name),
  fetch: (input, init) => fetch(input, init),
};

async function alertLog(supabase: SupabaseLike, alertType: string, message: string): Promise<void> {
  console.error(`[${FN_NAME}] ${message}`);
  try {
    await supabase.from("platform_alerts_log").insert({
      alert_type: alertType,
      function_name: FN_NAME,
      message,
      sent_at: new Date().toISOString(),
    });
  } catch {
    console.error(`[${FN_NAME}] platform_alerts_log insert failed`);
  }
}

/**
 * Job 1 (D5): record the order from the webhook. Never throws. Returns the
 * outcome for tests/logging.
 */
export async function recordLeadOrderFromWebhook(
  paymentIntent: PaymentIntentLike,
  supabase: SupabaseLike,
  env: LeadPurchaseEnv = defaultEnv,
): Promise<"inserted" | "existing" | "rejected" | "failed"> {
  const piId = typeof paymentIntent?.id === "string" ? paymentIntent.id : "unknown";
  try {
    const { data: priceRow, error: priceErr } = await supabase
      .from("platform_settings")
      .select("value")
      .eq("key", HOVER_PRICE_SETTING_KEY)
      .maybeSingle();
    let expectedAmount: number;
    try {
      expectedAmount = resolveRequiredPriceCents(HOVER_PRICE_SETTING_KEY, priceRow, priceErr);
    } catch {
      await alertLog(supabase, LEAD_ORDER_UNRECORDED_ALERT, unrecordedAlertMessage(piId, "webhook", "price_unreadable"));
      return "failed";
    }

    const check = checkLeadPaymentIntent(paymentIntent, {
      expectedAmount,
      leadId: null,
      stripeMode: resolveStripeMode(env.get("STRIPE_MODE"), env.get("SUPABASE_URL")),
    });
    if (!check.ok) {
      // A succeeded charge of our type that fails verification (wrong mode,
      // amount, currency) is not recorded as an order -- and a human is told.
      await alertLog(supabase, "lead_order_payment_rejected", `HO-3 lead PaymentIntent ${piId} not recorded as an order (${check.reason}). Review and refund if needed.`);
      return "rejected";
    }

    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .select("id, is_synthetic")
      .eq("id", check.leadId)
      .maybeSingle();
    if (leadErr || !lead) {
      await alertLog(supabase, LEAD_ORDER_UNRECORDED_ALERT, unrecordedAlertMessage(piId, "webhook", leadErr ? "lead_lookup_failed" : "lead_not_found"));
      return "failed";
    }

    const outcome = await recordLeadOrder(
      {
        leadId: check.leadId,
        paymentIntentId: piId,
        amountCents: check.amount,
        stripeChargeId: check.stripeChargeId,
        isTest: (lead as { is_synthetic: boolean | null }).is_synthetic === true || check.isSyntheticMeta,
        recordedBy: "webhook",
      },
      {
        insertIgnoringDuplicate: async (row) => {
          const { data, error } = await supabase
            .from("lead_measurement_orders")
            .upsert(row, { onConflict: "stripe_payment_intent_id", ignoreDuplicates: true })
            .select("id, status");
          const first = Array.isArray(data) && data.length > 0 ? (data[0] as { id: string; status: string }) : null;
          return { row: first, error: error ? { code: error.code, message: error.message } : null };
        },
        findByPaymentIntent: async (id) => {
          const { data } = await supabase
            .from("lead_measurement_orders")
            .select("id, status, lead_id")
            .eq("stripe_payment_intent_id", id)
            .maybeSingle();
          return data ?? null;
        },
        alert: (alertType, message) => alertLog(supabase, alertType, message),
      },
    );

    if (outcome.outcome === "inserted") {
      console.log(`[${FN_NAME}] gh-2121: lead order recorded from webhook for PI ${piId}`);
      try {
        const res = await env.fetch(`${env.get("SUPABASE_URL")}/functions/v1/notify-measurement-order`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
          body: JSON.stringify({ order_id: outcome.order.id, lead_order: true }),
        });
        if (!res.ok) console.error(`[${FN_NAME}] gh-2121: notify-measurement-order returned ${res.status} for PI ${piId}`);
      } catch {
        console.error(`[${FN_NAME}] gh-2121: notify-measurement-order call threw for PI ${piId}`);
      }
      return "inserted";
    }
    return outcome.outcome;
  } catch (err) {
    await alertLog(supabase, LEAD_ORDER_UNRECORDED_ALERT, unrecordedAlertMessage(piId, "webhook", `threw_${err instanceof Error ? err.name : "non-error"}`));
    return "failed";
  }
}

/**
 * Job 2: Meta CAPI Purchase for a lead-keyed measurement purchase. Never throws.
 */
export async function handleLeadMeasurementCapiPurchase(
  paymentIntent: PaymentIntentLike,
  supabase: SupabaseLike,
  env: LeadPurchaseEnv = defaultEnv,
): Promise<void> {
  const gpcMeta = shouldSkipForGpcMetadata(paymentIntent.metadata);
  if (gpcMeta.skip) {
    console.log(`[${FN_NAME}] gh-2121: lead CAPI Purchase skipped for PI ${paymentIntent.id} (${gpcMeta.reason})`);
    return;
  }

  try {
    const nonUsd = shouldSkipForNonUsdMeasurement(paymentIntent);
    if (nonUsd.skip) {
      console.log(`[${FN_NAME}] gh-2121: lead CAPI Purchase skipped for PI ${paymentIntent.id} (${nonUsd.reason})`);
      return;
    }

    const capiToken = env.get("META_CAPI_ACCESS_TOKEN");
    if (!capiToken) {
      console.log(`[${FN_NAME}] gh-2121: META_CAPI_ACCESS_TOKEN not set -- lead CAPI Purchase skipped (safe no-op) for PI ${paymentIntent.id}`);
      return;
    }

    const leadId: string | null = paymentIntent.metadata?.lead_id ?? null;
    let leadLookupFailed = false;
    let leadFound = false;
    let leadEmail: string | null = null;
    let leadIsSynthetic = false;

    if (leadId) {
      const { data: lead, error: leadErr } = await supabase
        .from("leads")
        .select("id, email, is_synthetic")
        .eq("id", leadId)
        .maybeSingle();
      if (leadErr) {
        leadLookupFailed = true;
        console.error(`[${FN_NAME}] gh-2121: lead lookup failed for PI ${paymentIntent.id}`);
      } else {
        leadFound = !!lead;
        const resolved = resolveLeadForCapi(lead as LeadRow | null);
        leadEmail = resolved.email;
        leadIsSynthetic = resolved.isSynthetic;
      }
    }
    // D11: the PaymentIntent's own is_synthetic stamp also marks test traffic.
    if (paymentIntent.metadata?.is_synthetic === "1") leadIsSynthetic = true;

    const person = decideLeadCapiPerson({ leadId, leadLookupFailed, leadFound });
    if (person.skip) {
      console.log(`[${FN_NAME}] gh-2121: lead CAPI Purchase skipped for PI ${paymentIntent.id} (${person.reason})`);
      return;
    }

    const testEventCode = env.get("META_CAPI_TEST_EVENT_CODE") ?? null;
    if (!shouldSendCapiEvent({ livemode: paymentIntent.livemode, claimIsTest: leadIsSynthetic, testEventCode })) {
      console.log(
        `[${FN_NAME}] gh-2121: test-mode/synthetic lead purchase with no META_CAPI_TEST_EVENT_CODE configured -- ` +
          `lead CAPI Purchase skipped (PI ${paymentIntent.id}, livemode=${paymentIntent.livemode}, isSynthetic=${leadIsSynthetic})`,
      );
      return;
    }
    const isTestTraffic = !paymentIntent.livemode || leadIsSynthetic;

    let hashedEmail: string | null = null;
    if (leadEmail) hashedEmail = await hashEmailSha256(leadEmail);
    if (hashedEmail) {
      const { data: suppressedRow, error: suppErr } = await supabase
        .from("ad_sharing_suppressions")
        .select("email_sha256")
        .eq("email_sha256", hashedEmail)
        .maybeSingle();
      const suppression = shouldSkipForSuppression(!!suppressedRow, !!suppErr);
      if (suppression.skip) {
        console.log(`[${FN_NAME}] gh-2121: lead CAPI Purchase skipped for PI ${paymentIntent.id} (${suppression.reason})`);
        return;
      }
    } else {
      console.warn(`[${FN_NAME}] gh-2121: no email for the lead on PI ${paymentIntent.id} -- sending lead CAPI Purchase with no user_data`);
    }

    const payload = buildCapiPurchasePayload({
      paymentIntentId: paymentIntent.id,
      eventTimeSeconds: Math.floor(Date.now() / 1000),
      valueUsd: capiPurchaseValueUsd(paymentIntent.amount_received ?? paymentIntent.amount, MEASUREMENT_PURCHASE_VALUE_USD),
      variant: sanitizeCapiVariant(paymentIntent.metadata?.variant),
      hashedEmail,
      testEventCode: isTestTraffic ? testEventCode : null,
    });

    const outcome = await sendCapiPurchaseOnce({
      claim: async () => {
        const { error } = await supabase
          .from("stripe_webhook_events")
          .insert({ event_id: capiClaimKey(paymentIntent.id), event_type: CAPI_CLAIM_EVENT_TYPE });
        return error ? { code: (error as { code?: string }).code } : null;
      },
      send: async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), META_CAPI_TIMEOUT_MS);
        try {
          const res = await env.fetch(
            `https://graph.facebook.com/${META_CAPI_API_VERSION}/${META_CAPI_PIXEL_ID}/events`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...payload, access_token: capiToken }),
              signal: controller.signal,
            },
          );
          const resBody = await res.text();
          if (!res.ok) {
            const metaError = safeMetaErrorSummary(resBody);
            await alertLog(supabase, "meta_capi_purchase_failed", `Meta CAPI Purchase (lead) send failed (HTTP ${res.status}, ${metaError}) for payment_intent ${paymentIntent.id}`);
            return false;
          }
          console.log(
            `[${FN_NAME}] gh-2121: Meta CAPI Purchase (lead) sent for PI ${paymentIntent.id} (event_id=${buildCapiEventId(paymentIntent.id)}, test_event_code=${isTestTraffic ? testEventCode : "none"})`,
          );
          return true;
        } finally {
          clearTimeout(timer);
        }
      },
      release: async () => {
        const { error } = await supabase
          .from("stripe_webhook_events")
          .delete()
          .eq("event_id", capiClaimKey(paymentIntent.id));
        return !error;
      },
      log: (m) => console.error(`[${FN_NAME}] ${m}`),
    });
    if (outcome === "already_sent" || outcome === "claim_failed") {
      console.log(`[${FN_NAME}] gh-2121: lead CAPI Purchase skipped for PI ${paymentIntent.id} (${outcome})`);
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    console.error(
      `[${FN_NAME}] gh-2121: Meta CAPI Purchase (lead) ${isAbort ? "timed out" : "threw"} for PI ${paymentIntent.id} (${err instanceof Error ? err.name : "non-error"})`,
    );
  }
}

/**
 * The ONE entry point index.ts calls on payment_intent.succeeded. Scoped by
 * metadata.type; never throws. The order is recorded FIRST and independently
 * of CAPI (a missing CAPI token or a Meta outage must never cost an order).
 */
export async function handleLeadMeasurementPurchase(
  paymentIntent: PaymentIntentLike,
  supabase: SupabaseLike,
  env: LeadPurchaseEnv = defaultEnv,
): Promise<void> {
  if (!isLeadMeasurementPurchase(paymentIntent)) return;
  await recordLeadOrderFromWebhook(paymentIntent, supabase, env);
  await handleLeadMeasurementCapiPurchase(paymentIntent, supabase, env);
}
