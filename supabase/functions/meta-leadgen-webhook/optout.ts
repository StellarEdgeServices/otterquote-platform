// gh-2154 P-5 go-live (Ben, bus 2026-09-25T22:17:42Z): the invite email's
// unsubscribe link, "the same pattern as P-4" -- this is a THIRD copy of
// send-partner-onboarding/optout.ts's exact mechanism (itself already
// duplicated once at partner-email-optout/optout-token.ts, held byte-exact
// by that pair's own optout-token.parity.test.ts). Deliberately the SAME
// secret (PARTNER_ONBOARDING_OPTOUT_SECRET) and the SAME endpoint
// (partner-email-optout), not a new invite-specific one: a partner who
// clicks "unsubscribe" on either email is asking to stop partner
// marketing mail from Otter Quotes, not to opt out of one specific
// campaign -- the broader, more conservative reading is also the correct
// CAN-SPAM one. Reusing the existing, already-deployed secret and endpoint
// means this needs no new secret provisioning beyond what P-4 already has
// live.
//
// WHY THIS FILE IS DUPLICATED, NOT IMPORTED: this repo's Edge Function
// deploy path does not resolve imports across function directories (see
// send-homeowner-next-steps/optout-token.ts's own header for the standing
// precedent). Held in parity by optout-token.parity.test.ts in this
// directory, against the canonical partner-email-optout/optout-token.ts
// copy -- same convention partner-email-optout's own parity test already
// uses against send-partner-onboarding/optout.ts.

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
