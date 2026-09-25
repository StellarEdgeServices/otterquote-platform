// gh-2154 P-5r — signed partner-invite token: sign, verify. Same mechanism
// as partner-email-optout/optout-token.ts (HMAC-SHA256 over the payload,
// current-plus-previous secret list for rotation, base64url encode/decode,
// timing-safe compare), reused rather than re-invented -- the payload is
// namespaced "invite:<referral_agent_id>" (not a bare id) so an invite
// token can never be mistaken for, or replayed as, an opt-out token even if
// the two secrets were ever accidentally shared.
//
// WHY THIS FILE IS DUPLICATED, NOT IMPORTED: this repo's Edge Function
// deploy path does not resolve `_shared/` imports and no function imports
// across function directories -- see send-homeowner-next-steps/optout-
// token.ts's header for the standing precedent. An identical copy lives at
// supabase/functions/meta-leadgen-webhook/invite-token.ts (the sender),
// held in parity by invite-token.parity.test.ts in each directory.
//
// ─── BEGIN PARITY REGION — edit both copies together ────────────────────────

/** Env var holding the current signing secret. */
export const PARTNER_INVITE_SECRET_ENV = "PARTNER_INVITE_SECRET";
/** Env var holding the previous signing secret, honoured for verification only. */
export const PARTNER_INVITE_SECRET_PREVIOUS_ENV = "PARTNER_INVITE_SECRET_PREVIOUS";

/** Namespace prefix -- see file header. */
const INVITE_NS = "invite:";

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
 * `<base64url("invite:"+referralAgentId)>.<base64url(HMAC-SHA256(payload, secret))>`
 * Throws on an empty id/secret rather than emitting an unsigned token.
 */
export async function signPartnerInviteToken(referralAgentId: string, secret: string): Promise<string> {
  if (!referralAgentId) throw new Error("signPartnerInviteToken: referralAgentId is required");
  if (!secret) throw new Error("signPartnerInviteToken: secret is required");
  const message = `${INVITE_NS}${referralAgentId}`;
  const payload = base64url(encoder.encode(message));
  const sig = base64url(await hmacSha256(secret, message));
  return `${payload}.${sig}`;
}

/**
 * Returns the referral_agents id when the token verifies under ANY of
 * `secrets` AND carries the "invite:" namespace prefix, else null. Never
 * throws, never reports WHICH check failed, and never reads the database --
 * so a caller cannot use it as an oracle for whether an id exists.
 */
export async function verifyPartnerInviteToken(
  token: string | null | undefined,
  secrets: readonly string[],
): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const raw = base64urlDecode(payload);
  if (!raw) return null;
  let message: string;
  try {
    message = decoder.decode(raw);
  } catch (_) {
    return null;
  }
  if (!message.startsWith(INVITE_NS)) return null;
  const referralAgentId = message.slice(INVITE_NS.length);
  if (!referralAgentId) return null;
  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = base64url(await hmacSha256(secret, message));
    if (timingSafeEqualStrings(expected, sig)) ok = true;
  }
  return ok ? referralAgentId : null;
}

/** The unauthenticated invite/accept URL an invite email links to. */
export function buildPartnerInviteUrl(pageBaseUrl: string, token: string): string {
  return `${pageBaseUrl.replace(/\/$/, "")}?invite=${encodeURIComponent(token)}`;
}

/** Whether a signing secret is configured -- mirrors D-320's
 * canSendWithOptOut: no verifiable invite link can be built without one, so
 * the correct behaviour is to send NOTHING. */
export function canSignInvite(signingSecret: string | null | undefined): boolean {
  return typeof signingSecret === "string" && signingSecret.length > 0;
}

// ─── END PARITY REGION ──────────────────────────────────────────────────────
