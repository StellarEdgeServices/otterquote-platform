/**
 * create-lead-payment-intent -- request handling for HO-3's no-account
 * measurement purchase.
 *
 * gh-2121 (HO-3, #2121 row 3.2). Called from measure-lead.html in two modes:
 *
 *   mode "preview" (page load): resolves the lead_token, refuses a lead that
 *     has already ordered (409 already_ordered), and returns the price from
 *     platform_settings.hover_measurement_price -- the SAME setting the charge
 *     uses -- so the page never shows a hard-coded price (PR #2226 L3). No
 *     Stripe call.
 *   mode "create" (the buyer ticked the consent box and tapped Pay): all of the
 *     above, then records the clickwrap assent in lead_consents (L1; no assent
 *     row = no PaymentIntent), then creates the PaymentIntent.
 *
 * Money-path rules (Ben's Ruling 2 + PR #2226 REVIEW):
 *   - the price is read server-side on every call; the client never sends one;
 *   - Stripe is called only through fetchStripeWithTimeout, with an
 *     Idempotency-Key that is a pure function of (lead, price, GPC flag), so a
 *     change in any of them never collides with an earlier key (D10);
 *   - a lead with an order in any status other than cancelled/refunded is
 *     refused BEFORE any PaymentIntent is created (D10);
 *   - the Stripe key comes from server config (STRIPE_MODE), never the Origin
 *     header (D7) -- wired in index.ts;
 *   - the rate limit fails CLOSED (D3), wired in index.ts;
 *   - metadata[is_synthetic] rides on the PaymentIntent (D11).
 *
 * No imports except the pure _shared module (this repo's convention for a
 * handler unit-tested with fakes). index.ts wires the real clients.
 */

import {
  HOVER_PRICE_SETTING_KEY,
  isBlockingOrderStatus,
  LEAD_MEASUREMENT_PI_TYPE,
  PlatformSettingMissingError,
  resolveRequiredPriceCents,
  type StripeMode,
} from "../_shared/lead-measurement-order.ts";

export { LEAD_MEASUREMENT_PI_TYPE, PlatformSettingMissingError, resolveRequiredPriceCents };

export const FUNCTION_NAME = "create-lead-payment-intent";

export const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

/**
 * L1: the clickwrap label rendered on measure-lead.html, character for
 * character. The server refuses a create whose consent_text differs, so the
 * recorded evidence is always the text actually shown. Wording mirrors the
 * authed purchase's account-signup line ("By creating an account, you agree to
 * our Terms of Service and Privacy Policy." -- react-app/app/get-started/page.tsx)
 * as a first-person checkbox; flagged for Dustin on the PR (Tier C).
 */
export const MEASURE_TERMS_CONSENT_TEXT = "I agree to our Terms of Service and Privacy Policy.";
export const MEASURE_TERMS_CONSENT_KEY = "ho3_measure_terms";
/** Which documents the assent covers, by their on-page effective dates (terms.html / privacy.html). */
export const MEASURE_TERMS_DOC_VERSIONS = { terms_effective: "2026-03-16", privacy_effective: "2026-09-24" };

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

export async function ipToUuid(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${FUNCTION_NAME}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

export interface ValidBody {
  leadToken: string;
  mode: "preview" | "create";
  termsAccepted: boolean;
  consentText: string;
  pageUrl: string | null;
}

export function validateBody(raw: unknown): { ok: true; value: ValidBody } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Body must be a JSON object" };
  const b = raw as Record<string, unknown>;
  const leadToken = typeof b.lead_token === "string" ? b.lead_token.trim() : "";
  if (!leadToken || leadToken.length < 16 || leadToken.length > 512) {
    return { ok: false, error: "lead_token is required" };
  }
  const mode = b.mode === "preview" ? "preview" : "create";
  const pageUrl = typeof b.page_url === "string" ? b.page_url.slice(0, 500) : null;
  return {
    ok: true,
    value: {
      leadToken,
      mode,
      termsAccepted: b.terms_accepted === true,
      consentText: typeof b.consent_text === "string" ? b.consent_text : "",
      pageUrl,
    },
  };
}

export interface ResolvedLead {
  leadId: string;
  email: string | null;
  isSynthetic: boolean;
}

/** The idempotency key: a pure function of the lead, the price and the GPC flag (D10). */
export function leadPaymentIntentIdempotencyKey(leadId: string, amountCents: number, gpcOptOut: boolean): string {
  return `${LEAD_MEASUREMENT_PI_TYPE}-${leadId}-${amountCents}-gpc${gpcOptOut ? 1 : 0}`;
}

/** The Stripe create body: a pure function of the same inputs as the key, plus the lead's is_synthetic flag (a property of the lead, so still one body per key). */
export function buildLeadPaymentIntentForm(
  leadId: string,
  amountCents: number,
  gpcOptOut: boolean,
  isSynthetic: boolean,
): URLSearchParams {
  const form = new URLSearchParams();
  form.append("amount", String(amountCents));
  form.append("currency", "usd");
  form.append("description", "Complete Property Report");
  form.append("metadata[lead_id]", leadId);
  form.append("metadata[type]", LEAD_MEASUREMENT_PI_TYPE);
  form.append("metadata[is_synthetic]", isSynthetic ? "1" : "0");
  form.append("metadata[terms_consent_key]", MEASURE_TERMS_CONSENT_KEY);
  if (gpcOptOut) form.append("metadata[ad_sharing_opt_out]", "1");
  form.append("automatic_payment_methods[enabled]", "true");
  return form;
}

/** Sec-GPC: 1 header or a JSON body `{ gpc: true }` -- the same signal create-payment-intent's ad-sharing-opt-out.ts detects. */
export function detectGpcSignal(headers: Headers, body: Record<string, unknown>): boolean {
  if (headers.get("Sec-GPC") === "1") return true;
  return body?.gpc === true;
}

export interface ConsentRecord {
  leadId: string;
  consentKey: string;
  consentText: string;
  pageUrl: string | null;
  userAgent: string | null;
  ip: string | null;
  payload: Record<string, unknown>;
}

export interface Deps {
  stripeMode: StripeMode;
  /** Resolves a lead_token to a lead, or null when unknown/expired -- the ONLY path to a lead_id here. */
  resolveLead: (leadToken: string) => Promise<ResolvedLead | null>;
  /** platform_settings.hover_measurement_price -- the SAME setting create-payment-intent reads (D-181/D-291). */
  readPriceCents: () => Promise<{ row: { value: unknown } | null; error: { message?: string } | null }>;
  /** Latest order status for this lead (any row), or null when none; throws/returns error on a failed read. */
  findLeadOrderStatuses: (leadId: string) => Promise<{ statuses: string[]; error: boolean }>;
  checkRateLimit: (bucketUserId: string) => Promise<{ allowed: boolean; reason?: string }>;
  /** INSERT into lead_consents ON CONFLICT (lead_id, consent_key) DO NOTHING. */
  recordConsent: (c: ConsentRecord) => Promise<{ ok: boolean }>;
  /** POST /v1/payment_intents via fetchStripeWithTimeout with the given Idempotency-Key. */
  createPaymentIntent: (form: URLSearchParams, idempotencyKey: string) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>;
  logPlatformAlert: (message: string) => Promise<void>;
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  const corsHeaders = buildCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, corsHeaders);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, corsHeaders);
  }
  const parsed = validateBody(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 400, corsHeaders);
  const body = parsed.value;

  const ip = getClientIp(req);
  const rl = await deps.checkRateLimit(await ipToUuid(ip ?? "unknown"));
  if (!rl.allowed) {
    return json({ error: "Too many requests. Please try again later.", reason: rl.reason }, 429, corsHeaders);
  }

  // Ruling 3 / negative control: the client value is a TOKEN, never a lead id.
  // An invalid or expired token is refused BEFORE any Stripe call.
  const lead = await deps.resolveLead(body.leadToken);
  if (!lead) {
    return json({ error: "This link is no longer valid. Please start over." }, 401, corsHeaders);
  }

  // D10: never charge a lead that has already ordered. A failed read refuses
  // (fail closed) rather than risk a second charge.
  const existing = await deps.findLeadOrderStatuses(lead.leadId);
  if (existing.error) {
    return json({ error: "We could not load your order. Please try again." }, 503, corsHeaders);
  }
  const blocking = existing.statuses.find(isBlockingOrderStatus);
  if (blocking) {
    return json({ error: "already_ordered", already_ordered: true, order_status: blocking }, 409, corsHeaders);
  }

  let amountCents: number;
  try {
    const { row, error } = await deps.readPriceCents();
    amountCents = resolveRequiredPriceCents(HOVER_PRICE_SETTING_KEY, row, error);
  } catch (err) {
    const message = err instanceof PlatformSettingMissingError ? err.message : `platform_setting_missing: ${HOVER_PRICE_SETTING_KEY}`;
    console.error(`[${FUNCTION_NAME}] ${message}`);
    await deps.logPlatformAlert(message).catch(() => {});
    return json({ error: "This report is temporarily unavailable. Please try again later." }, 500, corsHeaders);
  }

  const livemode = deps.stripeMode === "live";

  // L3: the page renders the price from THIS response -- the same number the charge uses.
  if (body.mode === "preview") {
    return json({ amount: amountCents, currency: "usd", livemode }, 200, corsHeaders);
  }

  // L1: an unticked box, or a label that is not the exact approved text, is
  // refused before anything is recorded or charged.
  if (!body.termsAccepted || body.consentText !== MEASURE_TERMS_CONSENT_TEXT) {
    return json({ error: "Please check the box to agree to the Terms of Service and Privacy Policy.", reason: "consent_required" }, 400, corsHeaders);
  }
  const consent = await deps.recordConsent({
    leadId: lead.leadId,
    consentKey: MEASURE_TERMS_CONSENT_KEY,
    consentText: MEASURE_TERMS_CONSENT_TEXT,
    pageUrl: body.pageUrl,
    userAgent: req.headers.get("user-agent"),
    ip,
    payload: { source: "measure-lead", funnel_id: "ho-3", amount_cents: amountCents, currency: "usd", ...MEASURE_TERMS_DOC_VERSIONS },
  });
  if (!consent.ok) {
    console.error(`[${FUNCTION_NAME}] consent record failed; no PaymentIntent created`);
    return json({ error: "Could not initialize payment. Please try again." }, 500, corsHeaders);
  }

  const gpcOptOut = detectGpcSignal(req.headers, raw as Record<string, unknown>);
  const form = buildLeadPaymentIntentForm(lead.leadId, amountCents, gpcOptOut, lead.isSynthetic);
  const idempotencyKey = leadPaymentIntentIdempotencyKey(lead.leadId, amountCents, gpcOptOut);

  const result = await deps.createPaymentIntent(form, idempotencyKey);
  if (!result.ok) {
    console.error(`[${FUNCTION_NAME}] Stripe create failed (HTTP ${result.status})`);
    return json({ error: "Could not initialize payment. Please try again." }, 502, corsHeaders);
  }

  const pi = result.body;
  return json(
    {
      client_secret: pi.client_secret ?? null,
      payment_intent_id: pi.id,
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency,
      livemode: pi.livemode === true,
    },
    200,
    corsHeaders,
  );
}
