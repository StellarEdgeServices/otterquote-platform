// mint-test-session/caller-auth.ts
//
// Pure caller-gate logic for mint-test-session (gh-2305), split out of
// index.ts (same pattern as gate.ts) so it is unit-testable with no live
// Supabase client and no serve() listener.
//
// Two caller paths:
//   (a) admin_jwt    - Authorization Bearer JWT resolves (via the injected
//                      resolveUserEmail, i.e. auth.getUser) to
//                      PRIMARY_ADMIN_EMAIL. Unchanged from gh-1513.
//   (b) exec_service - header X-Exec-Mint-Secret matches the EXEC_MINT_SECRET
//                      Edge Function secret. The Authorization header then
//                      carries the project anon-key JWT, which only serves to
//                      satisfy the verify_jwt = true gateway check.
//
// Path (b) is FAIL-CLOSED: it is denied when EXEC_MINT_SECRET is unset,
// empty, or shorter than EXEC_MINT_SECRET_MIN_LENGTH (gh-2305 amendment 1: a
// short or placeholder value is treated as unset). A service-role Bearer
// alone is never accepted.
//
// The header value and the secret are never logged (gh-2305 amendment 2);
// a mismatch logs only the fixed marker EXEC_MISMATCH_LOG.

export const EXEC_MINT_HEADER = "x-exec-mint-secret";
export const EXEC_MINT_SECRET_MIN_LENGTH = 32;
export const EXEC_MISMATCH_LOG = "caller_denied: exec_service_mismatch";

export type CallerKind = "admin_jwt" | "exec_service";

export type CallerDecision =
  | { ok: true; caller: CallerKind; actor: string }
  | { ok: false };

/** Actor label recorded in activity_log.metadata.actor for path (b). */
export const EXEC_SERVICE_ACTOR = "exec_service";

async function sha256(s: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return new Uint8Array(buf);
}

/**
 * Constant-time string equality. Both sides are hashed to fixed-length
 * digests first so neither the content nor the length of the secret leaks
 * through timing, then the digests are compared with a full-length XOR
 * accumulate (no early exit).
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = ha.length ^ hb.length;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ (hb[i] ?? 0);
  return diff === 0;
}

export interface AuthorizeCallerArgs {
  /** Bearer token already extracted from Authorization (non-empty). */
  token: string;
  /** Raw X-Exec-Mint-Secret header value, or null if absent. */
  execHeader: string | null;
  /** Value of the EXEC_MINT_SECRET Edge Function secret, or undefined. */
  execSecret: string | undefined;
  primaryAdminEmail: string;
  /** Resolves a Bearer token to its user's email (auth.getUser), or null. */
  resolveUserEmail: (token: string) => Promise<string | null>;
}

export async function authorizeCaller(
  args: AuthorizeCallerArgs,
): Promise<CallerDecision> {
  const { token, execHeader, execSecret, primaryAdminEmail, resolveUserEmail } = args;

  if (execHeader !== null) {
    // Path (b). Any header presence commits to this path: a mismatch is a
    // denial, never a fall-through to path (a).
    const secretUsable =
      typeof execSecret === "string" &&
      execSecret.length >= EXEC_MINT_SECRET_MIN_LENGTH;
    // Always run the compare (against the header itself when the secret is
    // unusable) so the denial path costs the same; result is then ignored.
    const equal = await constantTimeEqual(execHeader, secretUsable ? execSecret! : execHeader);
    if (secretUsable && equal) {
      return { ok: true, caller: "exec_service", actor: EXEC_SERVICE_ACTOR };
    }
    console.error(`[mint-test-session] ${EXEC_MISMATCH_LOG}`);
    return { ok: false };
  }

  // Path (a): unchanged admin-JWT allow-list.
  const email = await resolveUserEmail(token);
  if (email !== null && email === primaryAdminEmail) {
    return { ok: true, caller: "admin_jwt", actor: email };
  }
  return { ok: false };
}
