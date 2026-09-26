/**
 * issue-lead-access-token -- request handling for HO-3's token mint.
 *
 * gh-2121 (HO-3, #2121 row 3.2). Called from js/router-variant-f.js's
 * thank-you screen (f-thanks), right before a CTA button redirects to
 * measure-lead.html / loss-sheet-lead.html, to turn the in-memory lead id
 * into the unguessable, expiring `#lead_token=` (URL fragment, D4) those pages require
 * (Ben's Ruling 3: never the raw lead id).
 *
 * All request handling lives here (no imports, unit-tested per this repo's
 * convention -- see record-lead-details/handler.ts). index.ts only wires it
 * to the service-role client and Deno's server.
 *
 * Usage:
 *   POST /functions/v1/issue-lead-access-token
 *   Body:     { lead_id }
 *   Response: { ok: true, token, expires_at }             200
 *             { ok: false, reason: "lead_out_of_scope" }  200  (not retryable -- unknown/too old lead)
 *             { ok: false, error }                        400 / 429 / 500
 *
 * verify_jwt is pinned to false in supabase/config.toml: the caller is on
 * /start?v=f with no session, same reasoning as record-lead-details. This is
 * the ONE HO-3 function that accepts a client-supplied lead id: it is how the
 * thank-you screen (which just inserted that lead) turns it into a token. What
 * bounds it (PR #2226 REVIEW D3): issue_lead_access_token() checks freshness
 * FIRST and mints nothing for a lead older than 30 minutes, whoever asks;
 * there is no "return the existing token" path (only a hash is stored, D12);
 * at most 5 live tokens per lead; and the per-IP rate limit fails closed. It
 * never returns any lead data -- only a new token.
 */

export const FUNCTION_NAME = "issue-lead-access-token";

export const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

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

/** Same construction as record-lead-details' ipToUuid, namespaced with this function's own name. */
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
  leadId: string;
}

export type Validation = { ok: true; value: ValidBody } | { ok: false; error: string };

export function validateBody(raw: unknown): Validation {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Body must be a JSON object" };
  const b = raw as Record<string, unknown>;
  const leadId = typeof b.lead_id === "string" ? b.lead_id.trim() : "";
  if (!UUID_RE.test(leadId)) return { ok: false, error: "lead_id must be a UUID" };
  return { ok: true, value: { leadId } };
}

export interface TokenRow {
  token: string | null;
  expires_at: string | null;
}

export interface Deps {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, corsHeaders);

  const ip = getClientIp(req);
  const bucket = await ipToUuid(ip ?? "unknown");
  const rl = await deps.rpc("check_rate_limit", { p_function_name: FUNCTION_NAME, p_user_id: bucket });
  // PR #2226 REVIEW D3: fail CLOSED. This endpoint mints bearer credentials;
  // an infra hiccup must not turn into an unmetered mint. It strands nobody:
  // on any non-ok answer the router falls back to the authed pages.
  if (rl.error) {
    console.error(`[${FUNCTION_NAME}] rate limit check failed; failing closed`);
    return json({ ok: false, error: "Too many requests. Please try again later." }, 429, corsHeaders);
  }
  if ((rl.data as { allowed?: boolean } | null)?.allowed !== true) {
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

  const res = await deps.rpc("issue_lead_access_token", { p_lead_id: parsed.value.leadId });
  if (res.error) {
    console.error(`[${FUNCTION_NAME}] issue_lead_access_token rpc failed`);
    return json({ ok: false, error: "Could not issue an access token" }, 500, corsHeaders);
  }
  const rows = Array.isArray(res.data) ? (res.data as TokenRow[]) : [];
  const row = rows[0];
  if (!row || !row.token || !row.expires_at) {
    // Unknown or out-of-scope (>30 min old) lead id: not a server fault, and
    // not retryable -- the SAME shape record-lead-details uses for this case.
    return json({ ok: false, reason: "lead_out_of_scope" }, 200, corsHeaders);
  }
  return json({ ok: true, token: row.token, expires_at: row.expires_at }, 200, corsHeaders);
}
