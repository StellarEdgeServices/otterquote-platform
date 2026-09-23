/**
 * record-lead-details -- request handling for the Arm F details + consent write.
 *
 * gh-2122 (Arm F, #2121 row 1.1). Authorised by Ben, CEO RUN 66, "A: MIGRATION:
 * GO" on #2122 (comment 5802853627). Companion to
 * supabase/migrations/20260923211259_gh2122_leads_details_consent.sql, which
 * adds leads.funding_type / property_address / fbc / fbp, the lead_consents
 * table, the record_lead_details() RPC this file calls, and this function's
 * rate_limit_config row.
 *
 * WHY A SERVER HOP AT ALL. The browser cannot write these fields itself: an anon
 * client has no UPDATE policy on `leads` and no INSERT policy on lead_consents,
 * and the client IP -- which D-299 requires be retained with the consent -- is
 * not visible to page JavaScript. This function reads the IP and user agent from
 * the request, so both are SERVER-OBSERVED: a `ip` or `user_agent` key in the
 * request body is ignored (there is a test for exactly that).
 *
 * This file has NO imports on purpose: it is unit-tested by
 * handler.test.ts under `deno test --allow-read=...` (no --allow-net), and it is
 * deployed beside index.ts as an ordinary local module (same layout as
 * notify-admin-new-homeowner/notify-helpers.ts).
 *
 * PII discipline. The address and the consent text are personal data. They go to
 * the database only. They are never logged here and never echoed in a response.
 */

export const FUNCTION_NAME = "record-lead-details";

// Same origin list as check-email-exists (a pre-auth, browser-called EF).
export const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

export const FUNDING_VALUES = ["insurance", "cash", "unsure"];
// The only field names the client may list as "submitted" in the payload summary.
const SUBMITTED_FIELD_NAMES = ["name", "phone", "email", "address", "funding"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Best-effort client IP. `cf-connecting-ip` is set by the Cloudflare edge in
 * front of this project and cannot be forged by the caller the way a
 * client-supplied x-forwarded-for entry sometimes can, so it wins; the first
 * x-forwarded-for hop is the fallback. Returns null when neither is present
 * (the RPC then stores no ip rather than a made-up one).
 */
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

/**
 * Deterministic per-IP synthetic UUID for check_rate_limit()'s p_user_id (this
 * endpoint is pre-auth and has no real user id). Same construction as
 * check-email-exists, namespaced with THIS function's name so the same IP hashes
 * to a different bucket than it does for any other caller.
 */
export async function ipToUuid(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${FUNCTION_NAME}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Trim, drop control characters, cap length. Non-string or empty -> null. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // deno-lint-ignore no-control-regex
  const stripped = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!stripped) return null;
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/** Only an https URL on otterquote.com (or a subdomain) is kept; anything else is dropped, never trusted. */
export function cleanPageUrl(v: unknown): string | null {
  const s = cleanText(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:") return null;
    if (host !== "otterquote.com" && !host.endsWith(".otterquote.com")) return null;
    return s;
  } catch {
    return null;
  }
}

export interface ValidBody {
  leadId: string;
  fundingType: string | null;
  propertyAddress: string | null;
  fbc: string | null;
  fbp: string | null;
  consentKey: string;
  consentGiven: boolean;
  consentText: string;
  pageUrl: string | null;
  submittedFields: string[];
}

export type Validation = { ok: true; value: ValidBody } | { ok: false; error: string };

/**
 * Validate and normalise the request body. The lead id, the consent key and the
 * consent text are REQUIRED (they are what the evidence row is made of); the
 * consent text is stored verbatim apart from the length cap, because it is
 * evidence of what was displayed. Everything else is optional and degrades to
 * null rather than rejecting the request.
 */
export function validateBody(raw: unknown): Validation {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Body must be a JSON object" };
  const b = raw as Record<string, unknown>;

  const leadId = typeof b.lead_id === "string" ? b.lead_id.trim() : "";
  if (!UUID_RE.test(leadId)) return { ok: false, error: "lead_id must be a UUID" };

  const consent = b.consent;
  if (!consent || typeof consent !== "object") return { ok: false, error: "consent is required" };
  const c = consent as Record<string, unknown>;
  const consentKey = cleanText(c.key, 100);
  if (!consentKey) return { ok: false, error: "consent.key is required" };
  if (typeof c.given !== "boolean") return { ok: false, error: "consent.given must be true or false" };
  // Verbatim: only the length cap (matching the column's 2000-char cap in the RPC) is applied.
  const consentText = typeof c.text === "string" && c.text.trim() ? c.text.slice(0, 2000) : "";
  if (!consentText) return { ok: false, error: "consent.text (the exact rendered string) is required" };

  const fundingRaw = typeof b.funding_type === "string" ? b.funding_type.trim().toLowerCase() : "";
  const fundingType = FUNDING_VALUES.includes(fundingRaw) ? fundingRaw : null;

  const submittedFields = Array.isArray(b.submitted_fields)
    ? (b.submitted_fields as unknown[]).filter((f): f is string => typeof f === "string" && SUBMITTED_FIELD_NAMES.includes(f))
    : [];

  return {
    ok: true,
    value: {
      leadId,
      fundingType,
      propertyAddress: cleanText(b.property_address, 300),
      fbc: cleanText(b.fbc, 200),
      fbp: cleanText(b.fbp, 200),
      consentKey,
      consentGiven: c.given,
      consentText,
      pageUrl: cleanPageUrl(b.page_url),
      submittedFields,
    },
  };
}

/** What the record_lead_details() RPC is called with. ip / user_agent are server-observed only. */
export function buildRpcArgs(v: ValidBody, ip: string | null, userAgent: string | null): Record<string, unknown> {
  return {
    p_lead_id: v.leadId,
    p_funding_type: v.fundingType,
    p_property_address: v.propertyAddress,
    p_fbc: v.fbc,
    p_fbp: v.fbp,
    p_consent_key: v.consentKey,
    p_consent_given: v.consentGiven,
    p_consent_text: v.consentText,
    p_page_url: v.pageUrl,
    p_user_agent: cleanText(userAgent, 1000),
    p_ip: ip,
    // Non-PII summary of what was submitted (no address, no name, no phone, no email).
    p_payload: {
      source: "router-arm-f",
      funding_type: v.fundingType,
      submitted_fields: v.submittedFields,
    },
  };
}

export interface Deps {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  report: (error: unknown, ctx: { fn: string; op?: string; extra?: Record<string, unknown> }) => Promise<void>;
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, corsHeaders);

  // Per-IP burst gate, before the body is parsed. Fail OPEN if the limiter RPC
  // itself errors (an infra hiccup must not drop a real lead's consent record);
  // an explicit { allowed: false } is the guard doing its job and always 429s.
  const ip = getClientIp(req);
  const bucket = await ipToUuid(ip ?? "unknown");
  const rl = await deps.rpc("check_rate_limit", { p_function_name: FUNCTION_NAME, p_user_id: bucket });
  if (rl.error) {
    console.error(`[${FUNCTION_NAME}] rate limit check failed, failing open`);
  } else if (!(rl.data as { allowed?: boolean } | null)?.allowed) {
    return json({ ok: false, error: "Too many requests. Please try again later." }, 429, corsHeaders);
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400, corsHeaders);
  }
  const parsed = validateBody(raw);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400, corsHeaders);

  const args = buildRpcArgs(parsed.value, ip, req.headers.get("user-agent"));
  const res = await deps.rpc("record_lead_details", args);
  if (res.error) {
    // Report WITHOUT the payload: the address and consent text are personal data.
    await deps.report(res.error, { fn: FUNCTION_NAME, op: "record_lead_details", extra: { lead_id: parsed.value.leadId } });
    return json({ ok: false, error: "Could not record details" }, 500, corsHeaders);
  }
  if (res.data !== true) {
    // Lead unknown, older than the 30-minute window, or already redeemed: not a
    // server fault, and not retryable, so 200 with ok:false.
    return json({ ok: false, reason: "lead_out_of_scope" }, 200, corsHeaders);
  }
  return json({ ok: true }, 200, corsHeaders);
}
