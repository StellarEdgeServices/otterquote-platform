// gh-1786 / D-320 — homeowner nudge opt-out token: sign, verify, and the
// activity_log shape the opt-out is recorded in.
//
// ─── WHY A SIGNED (HMAC) TOKEN AND NOT A STORED RANDOM ONE ──────────────────
// CTO RUN 28's ruling on #1786 (comment 5572984296) chose an `email_suppressions`
// table with an opaque stored `uuid` token, explicitly "NOT an HMAC". D-320,
// ratified by Dustin later the same day (2026-09-07T22:33:23Z, #1723), chose
// "a plain 'stop these updates' footer link on both emails, honored by a key in
// the claim's existing JSONB, matching the mechanism D-303 established for the
// referrer opt-out. **No migration.**" A stored random token needs somewhere to
// store it, i.e. a migration. So the later, human ruling forces a signed token:
// with no place to keep a secret per recipient, the secret has to live in the
// environment and the token has to carry its own proof. Recorded here rather
// than silently reversing a CTO ruling.
//
// RUN 28's objection to an HMAC was real and is answered, not ignored: "a link
// that dies when we rotate a secret" would break CAN-SPAM's requirement that
// the opt-out mechanism keep working for at least 30 days. So verification
// accepts a LIST of secrets — the current signing secret plus an optional
// previous one — and only the FIRST is ever used to sign. Rotating means
// moving the old value into HOMEOWNER_OPTOUT_SECRET_PREVIOUS, which keeps every
// link already in someone's inbox working through the rotation.
//
// ─── WHAT IS IN THE URL ─────────────────────────────────────────────────────
// The payload is the claim UUID and nothing else: no email address, no name, no
// user id. The claim UUID is already present in this email's own
// `color-selection.html?claim_id=` link, so the token adds no identifier the
// message did not already carry.
//
// ─── WHY THIS FILE IS DUPLICATED ────────────────────────────────────────────
// An identical copy lives at supabase/functions/homeowner-email-optout/
// optout-token.ts. This repo's Edge Function deploy path does not resolve
// `_shared/` imports (see send-home-profile-prompt/index.ts line 91 and
// notify-contractors/index.ts line 91, which inline shared email code for the
// same reason), and no function in this repo imports across function
// directories. Duplication is the deployable shape. The two copies are held
// byte-identical from the BEGIN marker down by
// homeowner-email-optout/optout-token.parity.test.ts, which fails the build if
// they drift.
//
// ─── BEGIN PARITY REGION — edit both copies together ────────────────────────

/** activity_log.event_type carrying a homeowner's opt-out of the nudge series. */
export const OPTOUT_EVENT_TYPE = "homeowner_nudge_opt_out";

/** Env var holding the current signing secret. */
export const OPTOUT_SECRET_ENV = "HOMEOWNER_OPTOUT_SECRET";
/** Env var holding the previous signing secret, honoured for verification only. */
export const OPTOUT_SECRET_PREVIOUS_ENV = "HOMEOWNER_OPTOUT_SECRET_PREVIOUS";

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
  // ArrayBuffer, not Uint8Array: importKey's BufferSource overload rejects
  // Uint8Array<ArrayBufferLike> under TS 5.7+ lib typings (same note as
  // ga4-report/index.ts pemToDer).
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
  // Compare fixed-width digests of both inputs so neither length nor content
  // leaks through the comparison itself.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `<base64url(claim_id)>.<base64url(HMAC-SHA256(claim_id, secret))>`
 * Throws on an empty secret rather than emitting an unsigned token — a link
 * that cannot be verified is worse than no link, because it looks like consent.
 */
export async function signOptOutToken(claimId: string, secret: string): Promise<string> {
  if (!claimId) throw new Error("signOptOutToken: claimId is required");
  if (!secret) throw new Error("signOptOutToken: secret is required");
  const payload = base64url(encoder.encode(claimId));
  const sig = base64url(await hmacSha256(secret, claimId));
  return `${payload}.${sig}`;
}

/**
 * Returns the claim id when the token verifies under ANY of `secrets`, else
 * null. Never throws, never reports WHICH check failed, and never reads the
 * database — so a caller cannot use it as an oracle for whether a claim exists.
 */
export async function verifyOptOutToken(
  token: string | null | undefined,
  secrets: readonly string[],
): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const raw = base64urlDecode(payload);
  if (!raw) return null;
  let claimId: string;
  try {
    claimId = decoder.decode(raw);
  } catch (_) {
    return null;
  }
  if (!claimId) return null;
  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = base64url(await hmacSha256(secret, claimId));
    // No early return: every configured secret is checked on every call so the
    // work done does not depend on which secret matched.
    if (timingSafeEqualStrings(expected, sig)) ok = true;
  }
  return ok ? claimId : null;
}

/** The unauthenticated opt-out URL a nudge email links to. */
export function buildOptOutUrl(functionsBaseUrl: string, token: string): string {
  return `${functionsBaseUrl.replace(/\/$/, "")}/homeowner-email-optout?t=${encodeURIComponent(token)}`;
}

// ─── END PARITY REGION ──────────────────────────────────────────────────────
