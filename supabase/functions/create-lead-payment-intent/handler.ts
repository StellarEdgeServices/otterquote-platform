/**
 * create-lead-payment-intent -- request handling for HO-3's no-account $15
 * measurement purchase.
 *
 * gh-2121 (HO-3, #2121 row 3.2). Called from measure-lead.html. Mirrors
 * create-payment-intent's hover_measurement branch (D-181: the price is read
 * server-side from platform_settings.hover_measurement_price, NEVER a
 * client-supplied amount -- see price-setting.ts in that function, reused
 * here as-is) but for a lead_token instead of a signed-in user + claim_id.
 *
 * Ben's Ruling 2 (money path):
 *   - reuse the EXACT current measurement price (platform_settings.hover_measurement_price)
 *     -- never a new hardcoded price;
 *   - use fetchStripeWithTimeout (create-payment-intent/stripe-fetch.ts) and an Idempotency-Key;
 *   - resolve the lead server-side from a lead_token (Ruling 3) -- the client
 *     never supplies a lead_id, and an invalid/expired token is rejected before
 *     Stripe is ever contacted (the negative control this module is tested against).
 *
 * No imports here (this repo's convention for a handler unit-tested with a
 * fake Stripe/DB -- see record-lead-details/handler.ts, payment-intent-checks.ts).
 * index.ts wires this to the real Supabase client, fetchStripeWithTimeout, and Deno's server.
 */

export const FUNCTION_NAME = "create-lead-payment-intent";

export const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

/** Shared with stripe-webhook's lead-capi.ts and create-lead-measurement-order -- the metadata.type this whole feature emits. */
export const LEAD_MEASUREMENT_PI_TYPE = "lead_measurement_order";

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

export function validateBody(raw: unknown): { ok: true; leadToken: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Body must be a JSON object" };
  const b = raw as Record<string, unknown>;
  const leadToken = typeof b.lead_token === "string" ? b.lead_token.trim() : "";
  if (!leadToken || leadToken.length < 16 || leadToken.length > 512) {
    return { ok: false, error: "lead_token is required" };
  }
  return { ok: true, leadToken };
}

/** Same shape/failure discipline as create-payment-intent's price-setting.ts (reused verbatim there; duplicated here narrowly because Edge Functions cannot import across function directories -- see stripe-fetch.ts's own note on that constraint). */
export class PlatformSettingMissingError extends Error {
  readonly settingKey: string;
  constructor(settingKey: string, detail?: string) {
    super(`platform_setting_missing: ${settingKey}${detail ? ` — ${detail}` : ""}`);
    this.name = "PlatformSettingMissingError";
    this.settingKey = settingKey;
  }
}

export function resolveRequiredPriceCents(
  settingKey: string,
  row: { value: unknown } | null | undefined,
  readError: { message?: string } | null | undefined,
): number {
  if (readError) throw new PlatformSettingMissingError(settingKey, readError.message);
  if (row == null || row.value === null || row.value === undefined) {
    throw new PlatformSettingMissingError(settingKey, "no row");
  }
  const resolved = typeof row.value === "number" ? row.value : Number(row.value);
  if (!Number.isFinite(resolved) || resolved <= 0 || !Number.isInteger(resolved)) {
    throw new PlatformSettingMissingError(settingKey, `value is not a valid positive integer (cents): ${JSON.stringify(row.value)}`);
  }
  return resolved;
}

export interface ResolvedLead {
  leadId: string;
  email: string | null;
  isSynthetic: boolean;
}

/** The Stripe create body + its Idempotency-Key, as pure functions of the lead id and price -- a function of nothing per-request, same discipline as create-payment-intent's standard-create-form.ts. */
export function buildLeadPaymentIntentForm(leadId: string, amountCents: number, gpcOptOut: boolean): URLSearchParams {
  const form = new URLSearchParams();
  form.append("amount", String(amountCents));
  form.append("currency", "usd");
  form.append("description", "Complete Property Report");
  form.append("metadata[lead_id]", leadId);
  form.append("metadata[type]", LEAD_MEASUREMENT_PI_TYPE);
  if (gpcOptOut) form.append("metadata[ad_sharing_opt_out]", "1");
  form.append("automatic_payment_methods[enabled]", "true");
  return form;
}

export function leadPaymentIntentIdempotencyKey(leadId: string): string {
  return `${LEAD_MEASUREMENT_PI_TYPE}-${leadId}`;
}

/** Sec-GPC: 1 header or a JSON body `{ gpc: true }` -- same signal create-payment-intent's ad-sharing-opt-out.ts detects, narrowly reimplemented here (Edge Functions cannot import across function directories). */
export function detectGpcSignal(headers: Headers, body: Record<string, unknown>): boolean {
  if (headers.get("Sec-GPC") === "1") return true;
  return body?.gpc === true;
}

export interface Deps {
  /** Resolves a lead_token to a lead, or null when the token is unknown/expired -- the ONLY path to a lead_id in this function. */
  resolveLead: (leadToken: string) => Promise<ResolvedLead | null>;
  /** platform_settings.hover_measurement_price -- the SAME setting create-payment-intent reads (D-181/D-291). */
  readPriceCents: () => Promise<{ row: { value: unknown } | null; error: { message?: string } | null }>;
  checkRateLimit: (bucketUserId: string) => Promise<{ allowed: boolean; reason?: string; counts?: unknown }>;
  /** POST to Stripe /v1/payment_intents with the given form + Idempotency-Key. Callers use fetchStripeWithTimeout in production. */
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

  const ip = getClientIp(req);
  const bucket = await ipToUuid(ip ?? "unknown");
  const rl = await deps.checkRateLimit(bucket);
  if (!rl.allowed) {
    return json({ error: "Rate limit exceeded", reason: rl.reason }, 429, corsHeaders);
  }

  // Ruling 3 / negative control: the client-supplied value is a TOKEN, never
  // a lead id. An invalid or expired token resolves to null here and the
  // request is refused BEFORE any Stripe call is attempted -- no charge is
  // ever created for an invalid lead.
  const lead = await deps.resolveLead(parsed.leadToken);
  if (!lead) {
    return json({ error: "This link is no longer valid. Please start over." }, 401, corsHeaders);
  }

  let amountCents: number;
  try {
    const { row, error } = await deps.readPriceCents();
    amountCents = resolveRequiredPriceCents("hover_measurement_price", row, error);
  } catch (err) {
    const message = err instanceof PlatformSettingMissingError ? err.message : "platform_setting_missing: hover_measurement_price";
    console.error(`[${FUNCTION_NAME}] ${message}`);
    await deps.logPlatformAlert(message).catch(() => {});
    return json({ error: message }, 500, corsHeaders);
  }

  const gpcOptOut = detectGpcSignal(req.headers, raw as Record<string, unknown>);
  const form = buildLeadPaymentIntentForm(lead.leadId, amountCents, gpcOptOut);
  const idempotencyKey = leadPaymentIntentIdempotencyKey(lead.leadId);

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
    },
    200,
    corsHeaders,
  );
}
