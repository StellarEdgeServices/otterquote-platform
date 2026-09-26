/**
 * create-lead-measurement-order -- request handling for HO-3's no-account
 * $15 measurement purchase (the record-the-order half, after Stripe has
 * confirmed the charge).
 *
 * gh-2121 (HO-3, #2121 row 3.2). Called from measure-lead.html AFTER
 * hoverStripe.confirmCardPayment() has succeeded. Mirrors
 * create-measurement-order's "look the row up server-side, never trust
 * client fields" discipline: the lead_token resolves the lead, the
 * PaymentIntent is fetched from Stripe itself (never trusted from the
 * client), and the row is inserted into lead_measurement_orders (a sibling
 * of hover_orders -- see the migration's own note on why it is a separate
 * table).
 *
 * Ben's Ruling 2: every DB update uses the zero-row-update-guard. This
 * function only ever INSERTs the order row (an insert cannot silently match
 * zero rows the way an UPDATE can), so the guard is not needed for that
 * write -- see index.ts for the one UPDATE this feature performs
 * (issue_lead_access_token is a function, not a raw update) and
 * stripe-webhook's lead-capi.ts for where the guard actually applies on this
 * feature's money path.
 *
 * No imports here (unit-tested with a fake Stripe/DB) -- index.ts wires the
 * real Supabase client and fetch.
 */

export const FUNCTION_NAME = "create-lead-measurement-order";
export const LEAD_MEASUREMENT_PI_TYPE = "lead_measurement_order";
export const LEAD_PRODUCT_CODE = "roof_basic";

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
}

// deno-lint-ignore no-explicit-any
type PaymentIntentLike = any;

export type PaymentCheckResult =
  | { ok: true; amount: number; stripeChargeId: string | null }
  | { ok: false; status: number; error: string };

/**
 * Same checks as create-measurement-order's checkMeasurementPaymentIntent
 * (payment-intent-checks.ts): succeeded, USD, the exact catalog price, and
 * the RIGHT charge -- here scoped to metadata.lead_id matching (instead of
 * claim_id) and metadata.type === lead_measurement_order.
 */
export function checkLeadPaymentIntent(
  pi: PaymentIntentLike,
  ctx: { expectedAmount: number; leadId: string },
): PaymentCheckResult {
  if (pi.status !== "succeeded") {
    return { ok: false, status: 402, error: `Payment must complete before we can order your report. Current payment status: ${pi.status}.` };
  }
  if (pi.currency !== "usd") {
    return { ok: false, status: 402, error: "This payment could not be accepted because it was not made in US dollars. Nothing further has been charged. Please contact support." };
  }
  if (pi.amount !== ctx.expectedAmount) {
    return { ok: false, status: 402, error: "Payment amount does not match the report price. Please contact support." };
  }
  if (pi.metadata?.lead_id !== ctx.leadId) {
    return { ok: false, status: 402, error: "Payment does not belong to this request. Please contact support." };
  }
  if (pi.metadata?.type !== LEAD_MEASUREMENT_PI_TYPE) {
    return { ok: false, status: 402, error: "Payment is not a measurement charge. Please contact support." };
  }
  return { ok: true, amount: pi.amount, stripeChargeId: typeof pi.latest_charge === "string" ? pi.latest_charge : (pi.latest_charge?.id ?? null) };
}

export interface ExistingOrder {
  id: string;
  status: string;
}

export interface Deps {
  resolveLead: (leadToken: string) => Promise<ResolvedLead | null>;
  readPriceCents: () => Promise<{ row: { value: unknown } | null; error: { message?: string } | null }>;
  /** Idempotency check FIRST, before touching Stripe -- same discipline as create-measurement-order. */
  findExistingOrder: (paymentIntentId: string) => Promise<ExistingOrder | null>;
  fetchPaymentIntent: (paymentIntentId: string) => Promise<PaymentIntentLike | null>;
  insertOrder: (row: {
    leadId: string;
    paymentIntentId: string;
    amountCents: number;
    stripeChargeId: string | null;
  }) => Promise<{ id: string; status: string } | { error: string }>;
  checkRateLimit: (bucketIp: string) => Promise<{ allowed: boolean; reason?: string }>;
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
  if (!rl.allowed) return json({ error: "Rate limit exceeded", reason: rl.reason }, 429, corsHeaders);

  // Ruling 3 / negative control: resolved server-side from the token. An
  // invalid/expired token means no lead, and no order is ever written or
  // Stripe call made for it.
  const lead = await deps.resolveLead(parsed.leadToken);
  if (!lead) return json({ error: "This link is no longer valid. Please start over." }, 401, corsHeaders);

  // Idempotency FIRST, before touching Stripe -- a retried request for a
  // PaymentIntent already recorded returns the existing order.
  const existing = await deps.findExistingOrder(parsed.paymentIntentId);
  if (existing) {
    return json({ order_id: existing.id, status: existing.status, idempotent: true }, 200, corsHeaders);
  }

  let expectedAmount: number;
  try {
    const { row, error } = await deps.readPriceCents();
    if (error || row == null || row.value == null) throw new Error("price missing");
    const v = typeof row.value === "number" ? row.value : Number(row.value);
    if (!Number.isFinite(v) || v <= 0) throw new Error("price invalid");
    expectedAmount = v;
  } catch {
    return json({ error: "This report is temporarily unavailable. Please contact support." }, 500, corsHeaders);
  }

  const pi = await deps.fetchPaymentIntent(parsed.paymentIntentId);
  if (!pi) {
    return json({ error: "We could not verify your payment. Please try again or contact support." }, 402, corsHeaders);
  }

  const check = checkLeadPaymentIntent(pi, { expectedAmount, leadId: lead.leadId });
  if (!check.ok) return json({ error: check.error }, check.status, corsHeaders);

  const inserted = await deps.insertOrder({
    leadId: lead.leadId,
    paymentIntentId: parsed.paymentIntentId,
    amountCents: check.amount,
    stripeChargeId: check.stripeChargeId,
  });
  if ("error" in inserted) {
    // The buyer's money has already moved -- never invite a second payment.
    console.error(`[${FUNCTION_NAME}] order insert failed AFTER successful payment for PI ${parsed.paymentIntentId}`);
    return json(
      { error: "Your payment went through, but we could not record the order. Do not pay again — contact support and we will finish it by hand.", payment_captured: true },
      500,
      corsHeaders,
    );
  }

  await deps.notifyOrderCreated({ id: inserted.id, leadId: lead.leadId }).catch((e) => {
    console.error(`[${FUNCTION_NAME}] notifyOrderCreated failed (order already recorded):`, e instanceof Error ? e.message : e);
  });

  return json({ order_id: inserted.id, status: inserted.status, product_code: LEAD_PRODUCT_CODE }, 200, corsHeaders);
}
