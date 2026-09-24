// gh-2154 P-5 — Meta Lead Ads webhook signature verification.
//
// Meta signs every webhook POST body with X-Hub-Signature-256: an HMAC-SHA256
// of the RAW request body, keyed with the app secret, hex-encoded and
// prefixed "sha256=". See Meta's Graph API Webhooks docs (getting-started —
// "Validating Payloads") — cited in this build's report.
//
// No imports on purpose: pure, synchronously testable (apart from the
// unavoidable async crypto.subtle calls), no network, no database. Exercised
// by signature.test.ts under `deno test`.

/** HMAC-SHA256(secret, rawBody), hex-encoded, lowercase. */
export async function computeHmacSha256Hex(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison of two hex strings. Deliberately walks the FULL
 * length of the longer string on every call — it never returns early on the
 * first differing character and never short-circuits on a length mismatch
 * (a length mismatch is folded into the running `diff` via `a.length ^
 * b.length` instead of an early `return false`) — so wall-clock time never
 * leaks how many leading bytes matched. Do not replace this with `a === b`
 * or a loop that `return`s on the first mismatch.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export const SIGNATURE_HEADER = "X-Hub-Signature-256";
export const SIGNATURE_PREFIX = "sha256=";

/**
 * Verifies a Meta webhook POST. Returns false (fail CLOSED) for: an unset
 * app secret, a missing/malformed header, or a signature that does not
 * match the raw body under HMAC-SHA256. The caller MUST pass the raw,
 * unparsed body string — verifying a re-serialized JSON.stringify(parsed)
 * value would accept a body Meta never actually sent.
 */
export async function verifyMetaSignature(
  rawBody: string,
  headerValue: string | null,
  appSecret: string | undefined,
): Promise<boolean> {
  if (!appSecret) return false;
  if (!headerValue) return false;
  if (!headerValue.startsWith(SIGNATURE_PREFIX)) return false;
  const providedHex = headerValue.slice(SIGNATURE_PREFIX.length).trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(providedHex)) return false;
  const computedHex = await computeHmacSha256Hex(appSecret, rawBody);
  return timingSafeEqualHex(providedHex, computedHex);
}
