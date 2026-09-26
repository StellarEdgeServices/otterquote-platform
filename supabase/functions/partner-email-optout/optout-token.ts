// gh-2154 P-4 (Kevin correction Q1) — partner onboarding opt-out token: sign,
// verify. Mirrors send-homeowner-next-steps/optout-token.ts's D-320
// mechanism exactly (HMAC-SHA256 over the payload, current-plus-previous
// secret list for rotation, base64url encode/decode, timing-safe compare) —
// the payload is a partner id instead of a claim id, and the two env var
// names are PARTNER_ONBOARDING_OPTOUT_SECRET / _PREVIOUS instead of
// HOMEOWNER_OPTOUT_SECRET / _PREVIOUS. Everything else is the SAME
// mechanism, reused rather than re-invented, per Kevin's instruction
// ("mirror it for partners, reusing the same mechanism if it is generic").
//
// WHY THIS FILE IS DUPLICATED, NOT IMPORTED: this repo's Edge Function
// deploy path does not resolve `_shared/` imports and no function imports
// across function directories (see send-homeowner-next-steps/optout-
// token.ts's own header for the standing precedent). An identical copy
// lives at supabase/functions/send-partner-onboarding/optout.ts, held in
// parity by optout-token.parity.test.ts in this directory (same convention
// homeowner-email-optout/optout-token.parity.test.ts already uses).
//
// ─── BEGIN PARITY REGION — edit both copies together ────────────────────────

/** Env var holding the current signing secret. */
export const PARTNER_OPTOUT_SECRET_ENV = "PARTNER_ONBOARDING_OPTOUT_SECRET";
/** Env var holding the previous signing secret, honoured for verification only. */
export const PARTNER_OPTOUT_SECRET_PREVIOUS_ENV = "PARTNER_ONBOARDING_OPTOUT_SECRET_PREVIOUS";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch (_) {
    return null;
  }
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const raw = encoder.encode(secret);
  const keyBuf = new ArrayBuffer(raw.length);
  new Uint8Array(keyBuf).set(raw);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const msg = encoder.encode(message);
  const msgBuf = new ArrayBuffer(msg.length);
  new Uint8Array(msgBuf).set(msg);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, msgBuf));
}

/** Length-independent constant-time comparison of two base64url strings. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `<base64url(partner_id)>.<base64url(HMAC-SHA256(partner_id, secret))>`
 * Throws on an empty secret rather than emitting an unsigned token.
 */
export async function signPartnerOptOutToken(partnerId: string, secret: string): Promise<string> {
  if (!partnerId) throw new Error("signPartnerOptOutToken: partnerId is required");
  if (!secret) throw new Error("signPartnerOptOutToken: secret is required");
  const payload = base64url(encoder.encode(partnerId));
  const sig = base64url(await hmacSha256(secret, partnerId));
  return `${payload}.${sig}`;
}

/**
 * Returns the partner id when the token verifies under ANY of `secrets`,
 * else null. Never throws, never reports WHICH check failed, and never
 * reads the database — so a caller cannot use it as an oracle for whether a
 * partner id exists.
 */
export async function verifyPartnerOptOutToken(
  token: string | null | undefined,
  secrets: readonly string[],
): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const raw = base64urlDecode(payload);
  if (!raw) return null;
  let partnerId: string;
  try {
    partnerId = decoder.decode(raw);
  } catch (_) {
    return null;
  }
  if (!partnerId) return null;
  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = base64url(await hmacSha256(secret, partnerId));
    if (timingSafeEqualStrings(expected, sig)) ok = true;
  }
  return ok ? partnerId : null;
}

/** The unauthenticated opt-out URL a partner onboarding email links to. */
export function buildPartnerOptOutUrl(functionsBaseUrl: string, token: string): string {
  return `${functionsBaseUrl.replace(/\/$/, "")}/partner-email-optout?t=${encodeURIComponent(token)}`;
}

/** Whether a signing secret is configured — mirrors D-320's
 * canSendWithOptOut exactly: no verifiable link can be built without one,
 * so the correct behaviour is to send NOTHING. */
export function canSendWithOptOut(signingSecret: string | null | undefined): boolean {
  return typeof signingSecret === "string" && signingSecret.length > 0;
}

// ─── END PARITY REGION ──────────────────────────────────────────────────────
