/**
 * contractor-sms-verify -- D-391 layer 2 (#2875): the one-time-code ("verify-a-number") step.
 *
 * Two actions on one POST endpoint, body { action: "start" | "check", ... }:
 *   start  -> asks Twilio Verify to text a code to the number. Writes NOTHING to the consent tables.
 *   check  -> asks Twilio Verify whether the code is right. ONLY an "approved" answer writes a
 *             public.contractor_sms_numbers row (the per-number consent record). No approval, no row.
 *
 * Why the logic lives here and not in index.ts: index.ts does the I/O wiring (supabase client, fetch,
 * env); this file is pure over an injected `Deps`, so the tests run offline with fakes.
 *
 * COPY RULE (D-391, #2875 comment 6256542144): this file contains NO consent or legal wording.
 *   - The disclosure text stored on the consent record is read from public.sms_disclosure_versions
 *     (the row the client names AND that is the current, un-retired version). It is never taken from
 *     the request body, so the client cannot write its own consent text.
 *   - Failures are returned as machine codes (error_code); the screen words (layer 3) are not here.
 *   - The text of the code message is the Twilio Verify service/template configuration, not this repo.
 *
 * Safe defaults (every one fails CLOSED -- no text is sent, no record written):
 *   - TWILIO_VERIFY_SERVICE_SID unset            -> 503 verify_not_configured
 *   - no rate_limit_config row for the function  -> check_rate_limit denies -> 429
 *   - rate-limit RPC error                       -> 503
 *   - no current disclosure version row          -> 409 disclosure_unavailable (none is seeded by layer 1)
 *   - consent box not ticked                     -> 400 consent_required
 *   - number on the open suppression list        -> 409 number_suppressed (only a STOP->START releases it)
 */

export type Json = Record<string, unknown>;

export const FUNCTION_NAME = "contractor-sms-verify";
export const RL_START = "contractor-sms-verify-start";
export const RL_CHECK = "contractor-sms-verify-check";
export const SOURCES = ["signup", "settings", "reverify"] as const;
export type Source = typeof SOURCES[number];

export interface ContractorRow { id: string; user_id: string | null }
export interface DisclosureRow { id: string; disclosure_text: string }
export interface NumberInsert {
  contractor_id: string;
  user_id: string;
  phone_e164: string;
  is_primary: boolean;
  verified_at: string;
  last_confirmed_at: string;
  disclosure_version_id: string;
  disclosure_text: string;
  verification_method: "sms_otp";
  source: Source;
  verify_sid: string | null;
  consent_ip: string | null;
  consent_user_agent: string | null;
}

/** Everything the handler touches outside itself. index.ts wires real ones; tests wire fakes. */
export interface Deps {
  env: (name: string) => string | undefined;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => Date;
  getUser: (token: string) => Promise<{ id: string } | null>;
  getContractor: (id: string) => Promise<ContractorRow | null>;
  /** The newest disclosure version that is effective and not retired, or null if none exists. */
  getCurrentDisclosure: () => Promise<DisclosureRow | null>;
  isSuppressed: (phoneE164: string) => Promise<boolean>;
  /** check_rate_limit(); returns allowed, or "error" if the RPC itself failed. */
  rateLimit: (fn: string, bucketUuid: string) => Promise<"allowed" | "denied" | "error">;
  /** Current verified row for (contractor, phone), if any. */
  findVerified: (contractorId: string, phone: string) => Promise<{ id: string } | null>;
  /** Does the contractor already have a primary number? */
  hasPrimary: (contractorId: string) => Promise<boolean>;
  insertNumber: (row: NumberInsert) => Promise<{ id: string } | { conflict: "primary" | "live" } | { error: string }>;
  bumpConfirmed: (numberId: string, at: string) => Promise<boolean>;
  insertDefaultPreference: (numberId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/** E.164 for US/Canada (NANP) input or an explicit +E.164. Returns null when it cannot be one. */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return null;
  if (s.startsWith("+")) {
    const d = s.slice(1).replace(/[\s().-]/g, "");
    return /^[1-9][0-9]{7,14}$/.test(d) ? `+${d}` : null;
  }
  const digits = s.replace(/[\s().-]/g, "");
  if (!/^[0-9]+$/.test(digits)) return null;
  let n = digits;
  if (n.length === 11 && n.startsWith("1")) n = n.slice(1);
  // NANP: area code and exchange cannot start with 0 or 1.
  return /^[2-9][0-9]{2}[2-9][0-9]{6}$/.test(n) ? `+1${n}` : null;
}

export function maskPhone(e164: string): string {
  return e164.length > 4 ? `***${e164.slice(-4)}` : "***";
}

/** Deterministic UUID-shaped bucket key (a hash, not an identity) -- same trick as check-email-exists. */
export async function bucketUuid(scope: string, value: string): Promise<string> {
  const data = new TextEncoder().encode(`${FUNCTION_NAME}:${scope}:${value}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data)).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const h = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];
const LOCALHOST_RE = /^http:\/\/localhost:\d+$/;

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) || LOCALHOST_RE.test(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Vary": "Origin",
  };
}

function reply(cors: Record<string, string>, status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
  });
}
const fail = (cors: Record<string, string>, status: number, error_code: string) =>
  reply(cors, status, { success: false, error_code });

function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  const ip = (xff ? xff.split(",")[0] : req.headers.get("cf-connecting-ip") ?? "").trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : null;
}

// ---------------------------------------------------------------------------------------------
// Twilio Verify (verify.twilio.com/v2). Basic auth, form-encoded; no secret is ever logged.
// ---------------------------------------------------------------------------------------------

type VerifyResult =
  | { ok: true; status: string; sid: string | null }
  | { ok: false; httpStatus: number; code: number | null };

async function verifyCall(
  d: Deps,
  path: "Verifications" | "VerificationCheck",
  form: Record<string, string>,
): Promise<VerifyResult> {
  const sid = d.env("TWILIO_ACCOUNT_SID");
  const token = d.env("TWILIO_AUTH_TOKEN");
  const svc = d.env("TWILIO_VERIFY_SERVICE_SID");
  if (!sid || !token || !svc) return { ok: false, httpStatus: 503, code: null };
  const res = await d.fetch(`https://verify.twilio.com/v2/Services/${svc}/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${sid}:${token}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
  let j: Json = {};
  try { j = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) return { ok: false, httpStatus: res.status, code: typeof j.code === "number" ? j.code : null };
  return { ok: true, status: String(j.status ?? ""), sid: typeof j.sid === "string" ? j.sid : null };
}

// ---------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------

export async function handle(req: Request, d: Deps): Promise<Response> {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail(cors, 405, "method_not_allowed");

  // 1. Authenticate before reading anything else. No anonymous path.
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/);
  if (!m) return fail(cors, 401, "auth_required");
  const user = await d.getUser(m[1]);
  if (!user) return fail(cors, 401, "auth_invalid");

  // 2. Parse and validate the body.
  let body: Json;
  try {
    const b = await req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) return fail(cors, 400, "bad_body");
    body = b as Json;
  } catch {
    return fail(cors, 400, "bad_json");
  }
  const action = body.action;
  if (action !== "start" && action !== "check") return fail(cors, 400, "bad_action");
  const contractorId = typeof body.contractor_id === "string" ? body.contractor_id : "";
  if (!UUID_RE.test(contractorId)) return fail(cors, 400, "bad_contractor_id");
  const phone = normalizePhone(body.phone);
  if (!phone) return fail(cors, 400, "bad_phone");
  const source = body.source as Source;
  if (!SOURCES.includes(source)) return fail(cors, 400, "bad_source");
  // The box must be ticked on EVERY call. The disclosure the person saw is named by id; its text is read server-side.
  if (body.consent_checked !== true) return fail(cors, 400, "consent_required");
  const disclosureId = typeof body.disclosure_version_id === "string" ? body.disclosure_version_id : "";
  if (disclosureId === "") return fail(cors, 400, "bad_disclosure_version_id");
  let code = "";
  if (action === "check") {
    code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^[0-9]{6}$/.test(code)) return fail(cors, 400, "bad_code");
  }

  // 3. Ownership: the signed-in user must own the contractor.
  const contractor = await d.getContractor(contractorId);
  if (!contractor) return fail(cors, 404, "contractor_not_found");
  if (contractor.user_id !== user.id) return fail(cors, 403, "not_owner");

  // 4. The disclosure the person ticked must be the current one (else they consented to old words).
  const disclosure = await d.getCurrentDisclosure();
  if (!disclosure) return fail(cors, 409, "disclosure_unavailable");
  if (disclosure.id !== disclosureId) return fail(cors, 409, "disclosure_stale");

  // 5. A number on the open suppression list is never texted, not even a code.
  if (await d.isSuppressed(phone)) return fail(cors, 409, "number_suppressed");

  // 6. Rate limit per account AND per number (D-391: "rate-limited per number and per account").
  const rlName = action === "start" ? RL_START : RL_CHECK;
  const buckets = [user.id, await bucketUuid("phone", phone)];
  for (const b of buckets) {
    const r = await d.rateLimit(rlName, b);
    if (r === "error") return fail(cors, 503, "rate_limit_unavailable");
    if (r === "denied") return fail(cors, 429, "rate_limited");
  }

  if (!d.env("TWILIO_VERIFY_SERVICE_SID")) return fail(cors, 503, "verify_not_configured");

  if (action === "start") {
    const form: Record<string, string> = { To: phone, Channel: "sms" };
    const tpl = d.env("TWILIO_VERIFY_TEMPLATE_SID");
    if (tpl) form.TemplateSid = tpl;
    const v = await verifyCall(d, "Verifications", form);
    if (!v.ok) {
      console.error(`[${FUNCTION_NAME}] start failed http=${v.httpStatus} twilio_code=${v.code} to=${maskPhone(phone)}`);
      return fail(cors, v.httpStatus === 429 ? 429 : 502, "code_not_sent");
    }
    return reply(cors, 200, { success: true, status: v.status });
  }

  // action === "check"
  const v = await verifyCall(d, "VerificationCheck", { To: phone, Code: code });
  if (!v.ok) {
    // 404 = no pending verification (expired after 10 min, or already approved/cancelled); 429 = attempts exhausted.
    if (v.httpStatus === 404) return fail(cors, 400, "no_pending_code");
    if (v.httpStatus === 429) return fail(cors, 429, "too_many_attempts");
    console.error(`[${FUNCTION_NAME}] check failed http=${v.httpStatus} twilio_code=${v.code} to=${maskPhone(phone)}`);
    return fail(cors, 502, "check_failed");
  }
  if (v.status !== "approved") return fail(cors, 400, "wrong_code");

  // 7. Approved. This is the only path that writes a consent record.
  const at = d.now().toISOString();
  const existing = await d.findVerified(contractorId, phone);
  if (existing) {
    // Re-verify of an already-verified number: bump the confirmation clock only; the original consent
    // evidence (disclosure id/text, IP, UA, Twilio SID) on the row is left exactly as it was.
    if (!(await d.bumpConfirmed(existing.id, at))) return fail(cors, 500, "record_failed");
    return reply(cors, 200, { success: true, number_id: existing.id, reconfirmed: true });
  }
  const row = (isPrimary: boolean): NumberInsert => ({
    contractor_id: contractorId,
    user_id: user.id,
    phone_e164: phone,
    is_primary: isPrimary,
    verified_at: at,
    last_confirmed_at: at,
    disclosure_version_id: disclosure.id,
    disclosure_text: disclosure.disclosure_text,
    verification_method: "sms_otp",
    source,
    verify_sid: v.sid,
    consent_ip: clientIp(req),
    consent_user_agent: (req.headers.get("user-agent") || "").slice(0, 512) || null,
  });
  let res = await d.insertNumber(row(!(await d.hasPrimary(contractorId))));
  if ("conflict" in res && res.conflict === "primary") res = await d.insertNumber(row(false)); // lost a primary race
  if ("conflict" in res && res.conflict === "live") {
    const again = await d.findVerified(contractorId, phone); // lost a same-number race
    return again ? reply(cors, 200, { success: true, number_id: again.id, reconfirmed: true }) : fail(cors, 500, "record_failed");
  }
  if (!("id" in res)) {
    console.error(`[${FUNCTION_NAME}] record insert failed: ${"error" in res ? res.error : "unknown"}`);
    return fail(cors, 500, "record_failed");
  }
  await d.insertDefaultPreference(res.id);
  return reply(cors, 200, { success: true, number_id: res.id, reconfirmed: false });
}
