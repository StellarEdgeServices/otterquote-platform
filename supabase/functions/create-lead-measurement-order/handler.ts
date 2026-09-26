/**
 * create-lead-measurement-order -- the browser half of recording HO-3's
 * no-account measurement order, after Stripe has confirmed the charge.
 *
 * gh-2121 (HO-3, #2121 row 3.2). Called from measure-lead.html AFTER
 * confirmCardPayment() succeeds. Since PR #2226 REVIEW D5 this call is for UX
 * only: stripe-webhook records the SAME order on payment_intent.succeeded, so
 * a closed tab, a dropped network, or a 401/429 here can no longer leave a
 * charge with no order row. Both writers go through the shared
 * recordLeadOrder() (INSERT ... ON CONFLICT (stripe_payment_intent_id) DO
 * NOTHING), so exactly one row exists per PaymentIntent whichever arrives first.
 *
 * Checks, in order: rate limit (fails closed) -> lead_token resolves (401) ->
 * an order for this PaymentIntent already exists (idempotent 200) -> server
 * price -> the PaymentIntent fetched from Stripe (fetchStripeWithTimeout, D14)
 * passes checkLeadPaymentIntent (livemode matches the server's Stripe mode
 * (D7), succeeded, usd, exact price, this lead, this type) -> record. A
 * failed record after a real charge writes platform_alerts_log and tells the
 * buyer not to pay again.
 *
 * Every write here is an INSERT (the order row); the zero-row-update guard
 * does not apply. The one UPDATE this feature performs is notify-measurement-
 * order's admin_notified_at claim, which uses the guard.
 */

import {
  checkLeadPaymentIntent,
  HOVER_PRICE_SETTING_KEY,
  LEAD_PRODUCT_CODE,
  type LeadOrderRowInput,
  type OrderRef,
  type PaymentIntentLike,
  type RecordOutcome,
  resolveRequiredPriceCents,
  type StripeMode,
} from "../_shared/lead-measurement-order.ts";

export { checkLeadPaymentIntent };

export const FUNCTION_NAME = "create-lead-measurement-order";

export const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

export function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

export function json(body: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export function getClientIp(req: Request): string | null {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return null;
}

export function validateBody(
  raw: unknown,
): { ok: true; leadToken: string; paymentIntentId: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Body must be a JSON object" };
  const b = raw as Record<string, unknown>;
  const leadToken = typeof b.lead_token === "string" ? b.lead_token.trim() : "";
  if (!leadToken || leadToken.length < 16 || leadToken.length > 512) {
    return { ok: false, error: "lead_token is required" };
  }
  const paymentIntentId = typeof b.payment_intent_id === "string" ? b.payment_intent_id.trim() : "";
  if (!paymentIntentId || !/^pi_[A-Za-z0-9_]{1,80}$/.test(paymentIntentId)) {
    return { ok: false, error: "Missing or invalid payment_intent_id. A completed payment is required before we can order your report." };
  }
  return { ok: true, leadToken, paymentIntentId };
}

export interface ResolvedLead {
  leadId: string;
  isSynthetic: boolean;
}

export interface Deps {
  stripeMode: StripeMode;
  resolveLead: (leadToken: string) => Promise<ResolvedLead | null>;
  readPriceCents: () => Promise<{ row: { value: unknown } | null; error: { message?: string } | null }>;
  /** Idempotency check FIRST, before touching Stripe. */
  findExistingOrder: (paymentIntentId: string) => Promise<OrderRef | null>;
  /** Stripe PI retrieve via fetchStripeWithTimeout; null on any failure. */
  fetchPaymentIntent: (paymentIntentId: string) => Promise<PaymentIntentLike | null>;
  /** The shared recordLeadOrder(), wired to the real table and platform_alerts_log. */
  recordOrder: (input: LeadOrderRowInput) => Promise<RecordOutcome>;
  checkRateLimit: (bucketIp: string) => Promise<{ allowed: boolean; reason?: string }>;
  /** Admin email via notify-measurement-order (lead_order branch). Called only for a newly inserted row. */
  notifyOrderCreated: (order: { id: string; leadId: string }) => Promise<void>;
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, corsHeaders);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }
  const parsed = validateBody(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 400, corsHeaders);

  const rl = await deps.checkRateLimit(getClientIp(req) ?? "unknown");
  if (!rl.allowed) return json({ error: "Too many requests. Please try again later.", reason: rl.reason }, 429, corsHeaders);

  const lead = await deps.resolveLead(parsed.leadToken);
  if (!lead) return json({ error: "This link is no longer valid. Please start over." }, 401, corsHeaders);

  // Idempotency FIRST: the webhook (or an earlier retry) may already have recorded it.
  const existing = await deps.findExistingOrder(parsed.paymentIntentId);
  if (existing) {
    if (existing.lead_id && existing.lead_id !== lead.leadId) {
      return json({ error: "Payment does not belong to this request. Please contact support." }, 402, corsHeaders);
    }
    return json({ order_id: existing.id, status: existing.status, idempotent: true }, 200, corsHeaders);
  }

  let expectedAmount: number;
  try {
    const { row, error } = await deps.readPriceCents();
    expectedAmount = resolveRequiredPriceCents(HOVER_PRICE_SETTING_KEY, row, error);
  } catch {
    return json({ error: "We could not confirm your order just now. Your payment is safe -- we will finish it and email you. Do not pay again." }, 500, corsHeaders);
  }

  const pi = await deps.fetchPaymentIntent(parsed.paymentIntentId);
  if (!pi) {
    return json({ error: "We could not verify your payment. Please try again or contact support." }, 402, corsHeaders);
  }

  const check = checkLeadPaymentIntent(pi, { expectedAmount, leadId: lead.leadId, stripeMode: deps.stripeMode });
  if (!check.ok) return json({ error: check.error, reason: check.reason }, check.status, corsHeaders);

  const recorded = await deps.recordOrder({
    leadId: lead.leadId,
    paymentIntentId: parsed.paymentIntentId,
    amountCents: check.amount,
    stripeChargeId: check.stripeChargeId,
    isTest: lead.isSynthetic,
    recordedBy: "browser",
  });
  if (recorded.outcome === "failed") {
    // recordLeadOrder already wrote platform_alerts_log. Never invite a second payment.
    return json(
      { error: "Your payment went through, but we could not record the order. Do not pay again — contact support and we will finish it by hand.", payment_captured: true },
      500,
      corsHeaders,
    );
  }
  if (recorded.outcome === "existing") {
    return json({ order_id: recorded.order.id, status: recorded.order.status, idempotent: true }, 200, corsHeaders);
  }

  await deps.notifyOrderCreated({ id: recorded.order.id, leadId: lead.leadId }).catch(() => {
    console.error(`[${FUNCTION_NAME}] notifyOrderCreated failed (order already recorded)`);
  });

  return json({ order_id: recorded.order.id, status: recorded.order.status, product_code: LEAD_PRODUCT_CODE }, 200, corsHeaders);
}
