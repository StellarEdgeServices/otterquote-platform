// gh-2462 Q2 -- inbound gate, payload whitelist and rate-limit helpers for send-support-email.
//
// Before this change the function accepted ANY POST (config.toml pins verify_jwt = false and
// index.ts read no credential, no field limit, no rate limit), so an anonymous caller could
// mail the admin inbox and insert support_tickets rows without bound.
//
// Real callers (all send the project's PUBLIC key in `apikey`, or as the Bearer):
//   - public forms (js/nav.js, tools-voice-ai.html, oq-voice-ai.html, oqom-onboarding.html):
//       apikey: <anon>, Authorization: Bearer <anon>
//   - supabase-js functions.invoke() from signed-in pages: apikey: <anon>, Authorization: Bearer <user JWT>
//   - platform-health-check ping: Authorization: Bearer <service-role key>, body {health_check:true}
// So the gate admits a request when EITHER the `apikey` header OR the Bearer value equals one of:
// the anon key, a publishable key, or a service key. A gate on the user JWT would break the
// public forms, so a user JWT alone is deliberately not enough (the apikey header carries the
// anon key on every supabase-js call).
//
// Env resolution follows process-dunning/caller-gate.ts (SUPABASE_SECRET_KEYS JSON, plus the
// legacy var) and mirrors it for publishable keys (SUPABASE_PUBLISHABLE_KEYS JSON). There is
// no existing publishable-key reader in this repo; the JSON shape is the Supabase runtime's
// sibling of SUPABASE_SECRET_KEYS. Every candidate is compared in constant time with no early
// exit; an empty/unset key never matches, so empty env fails closed.
//
// Local file (not _shared/): the EF body-deploy path does not resolve _shared/ imports.

type KeyInput = string | undefined | null;
type GetEnv = (name: string) => string | undefined;

/** Constant-time string equality (same primitive as process-dunning/caller-gate.ts). */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function jsonValues(raw: string | undefined, label: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return Object.values(parsed).filter((v): v is string => typeof v === "string" && v.length > 0);
    }
  } catch (_e) {
    console.warn(`[send-support-email] ${label} present but not valid JSON -- ignored`);
  }
  return [];
}

/** Anon + publishable + service keys the gate admits. Empty entries are dropped. */
export function acceptedKeys(getEnv: GetEnv): string[] {
  const keys = [
    getEnv("SUPABASE_ANON_KEY") || "",
    getEnv("SUPABASE_SERVICE_ROLE_KEY") || "",
    ...jsonValues(getEnv("SUPABASE_PUBLISHABLE_KEYS"), "SUPABASE_PUBLISHABLE_KEYS"),
    ...jsonValues(getEnv("SUPABASE_SECRET_KEYS"), "SUPABASE_SECRET_KEYS"),
  ];
  return keys.filter((k) => !!k);
}

/** The credentials a request presents: the apikey header and the Bearer value. */
export function presentedCredentials(req: Request): string[] {
  const out: string[] = [];
  const apikey = (req.headers.get("apikey") || "").trim();
  if (apikey) out.push(apikey);
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.get("Authorization") || "").trim());
  const bearer = m ? m[1].trim() : "";
  if (bearer) out.push(bearer);
  return out;
}

/** True only when a presented credential equals a non-empty accepted key. No short-circuit. */
export function hasAcceptedKey(req: Request, keys: readonly KeyInput[]): boolean {
  const presented = presentedCredentials(req);
  let ok = false;
  for (const p of presented) {
    for (const k of keys) {
      if (!k) continue;
      if (constantTimeEqual(p, k)) ok = true;
    }
  }
  return ok;
}

// ── Payload whitelist ────────────────────────────────────────────────────────
export const LIMITS = {
  from_name: 200,
  from_email: 320,
  subject: 200,
  message: 10_000,
  user_id: 64,
} as const;

const ALLOWED_FIELDS = new Set(["from_name", "from_email", "subject", "message", "user_id", "health_check"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SupportPayload {
  from_name: string;
  from_email: string;
  subject?: string;
  message: string;
  user_id?: string;
}

export type PayloadCheck = { ok: true; value: SupportPayload } | { ok: false; error: string };

/** Accepts exactly the form's fields; strings only; length-capped; loose email shape. */
export function validatePayload(raw: unknown): PayloadCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Invalid request body" };
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(k)) return { ok: false, error: `Unknown field: ${k}` };
  }
  for (const k of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const v = body[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return { ok: false, error: `Field must be a string: ${k}` };
    if (v.length > LIMITS[k]) return { ok: false, error: `Field too long: ${k} (max ${LIMITS[k]})` };
  }
  const from_name = body.from_name as string | undefined;
  const from_email = body.from_email as string | undefined;
  const message = body.message as string | undefined;
  if (!from_name || !from_email || !message) {
    return { ok: false, error: "Missing required fields: from_name, from_email, message" };
  }
  if (!EMAIL_RE.test(from_email.trim())) return { ok: false, error: "Invalid from_email" };
  // gh-2477: refuse CR/LF in subject (header-injection hygiene; subject is mailed as a header).
  if (typeof body.subject === "string" && /[\r\n]/.test(body.subject)) {
    return { ok: false, error: "Invalid subject" };
  }
  return {
    ok: true,
    value: {
      from_name,
      from_email,
      subject: (body.subject as string | undefined) || undefined,
      message,
      user_id: (body.user_id as string | undefined) || undefined,
    },
  };
}

// ── Per-IP rate-limit bucket (same design as check-email-exists) ─────────────
export const FUNCTION_NAME = "send-support-email";

export function getClientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}

/** Deterministic synthetic UUID for check_rate_limit's p_user_id, namespaced to this function. */
export async function ipToUuid(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`${FUNCTION_NAME}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
