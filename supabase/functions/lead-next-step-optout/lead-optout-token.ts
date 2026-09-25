// gh-2121 (LRS HO-1 S21) — signed opt-out token for the lead next-step
// reminder's "Stop these updates" link.
//
// Same HMAC-over-stored-secret shape send-homeowner-next-steps/
// optout-token.ts already established for D-320 (see that file's header for
// the full "why HMAC, not a stored random token" reasoning — unchanged
// here), reused rather than re-argued. Two differences from that file,
// both load-bearing:
//
//   1. The payload is prefixed "lead:" before signing/encoding, so a token
//      minted for a CLAIM (send-homeowner-next-steps' own opt-out) can never
//      be replayed here as a LEAD id, or vice versa, even though both may be
//      signed with the same secret (see point 2). Namespacing the payload,
//      not the secret, is the minimal change that closes that cross-use
//      without provisioning a brand-new Supabase secret for a single field.
//
//   2. It reuses the SAME environment variables (HOMEOWNER_OPTOUT_SECRET /
//      HOMEOWNER_OPTOUT_SECRET_PREVIOUS) send-homeowner-next-steps already
//      reads — both are already set in Supabase secrets and both opt-out
//      mechanisms have the identical CAN-SPAM requirement (a working
//      opt-out link for at least 30 days across a secret rotation). If a
//      dedicated secret is ever preferred, that is a small follow-up (new
//      env var, no schema change), not required for this PR.
//
// Duplicated (not imported) from optout-token.ts for the same reason that
// file states for its own claim-side duplicate: this repo's Edge Function
// deploy path does not resolve `_shared/` imports and no function here
// imports across function directories.

export const LEAD_OPTOUT_SECRET_ENV = "HOMEOWNER_OPTOUT_SECRET";
export const LEAD_OPTOUT_SECRET_PREVIOUS_ENV = "HOMEOWNER_OPTOUT_SECRET_PREVIOUS";

const LEAD_TOKEN_PREFIX = "lead:";

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

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `<base64url("lead:"+leadId)>.<base64url(HMAC-SHA256("lead:"+leadId, secret))>`
 * Throws on an empty leadId/secret rather than emitting an unsigned or
 * unkeyed token.
 */
export async function signLeadOptOutToken(leadId: string, secret: string): Promise<string> {
  if (!leadId) throw new Error("signLeadOptOutToken: leadId is required");
  if (!secret) throw new Error("signLeadOptOutToken: secret is required");
  const namespaced = LEAD_TOKEN_PREFIX + leadId;
  const payload = base64url(encoder.encode(namespaced));
  const sig = base64url(await hmacSha256(secret, namespaced));
  return `${payload}.${sig}`;
}

/**
 * Returns the lead id when `token` verifies under ANY of `secrets` AND its
 * decoded payload carries the "lead:" prefix, else null. Never throws, never
 * reveals which check failed, never reads the database.
 */
export async function verifyLeadOptOutToken(
  token: string | null | undefined,
  secrets: readonly string[],
): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const raw = base64urlDecode(payload);
  if (!raw) return null;
  let namespaced: string;
  try {
    namespaced = decoder.decode(raw);
  } catch (_) {
    return null;
  }
  if (!namespaced.startsWith(LEAD_TOKEN_PREFIX)) return null; // wrong namespace — e.g. a claim token
  const leadId = namespaced.slice(LEAD_TOKEN_PREFIX.length);
  if (!leadId) return null;

  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = base64url(await hmacSha256(secret, namespaced));
    if (timingSafeEqualStrings(expected, sig)) ok = true;
  }
  return ok ? leadId : null;
}

/** The unauthenticated opt-out URL this email's footer links to. */
export function buildLeadOptOutUrl(functionsBaseUrl: string, token: string): string {
  return `${functionsBaseUrl.replace(/\/$/, "")}/lead-next-step-optout?t=${encodeURIComponent(token)}`;
}
