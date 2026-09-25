// gh-2154 P-4 switch-on hardening round (Ben, bus 18:23:17Z item (1)):
// "cron-auth fails CLOSED when CRON_SECRET unset". The prior version of this
// file (merged in #2180) mirrored send-lead-next-step-reminder/cron-auth.ts's
// permissive "no CRON_SECRET configured -> allow anything" branch, which was
// fine for that function's non-send read path but is wrong here: this
// function calls Mailgun and mutates partner_onboarding_sends. If CRON_SECRET
// is ever unset in prod (misconfiguration, secret rotation gap, etc.), the
// old gate let ANY caller with no credentials at all trigger a live send
// sweep. This version removes that branch entirely: with no CRON_SECRET
// configured, the ONLY way in is an exact, constant-time-compared
// service-role Bearer token — never an open door.
//
// Extracted into its own module (duplicated logic, not shared — this repo's
// Edge Function deploy path does not resolve cross-function imports) purely
// so it is unit-testable without spinning up `serve()`.

export interface CronAuthInput {
  /** Deno.env.get("CRON_SECRET") — undefined/empty means "not configured". */
  cronSecret: string | undefined;
  /** req.headers.get("X-Cron-Secret") */
  incomingCronSecret: string | null;
  /** req.headers.get("Authorization") || "" */
  authHeader: string;
  /** Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") */
  serviceRoleKey: string;
}

/**
 * Length-independent constant-time comparison of two strings. Only the
 * length itself is allowed to leak (via the fast-path check), never any
 * information about which characters differ or where — same technique as
 * this directory's own optout.ts:timingSafeEqualStrings.
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True when the request is authorized to trigger a send run. FAIL CLOSED:
 *
 *   1. X-Cron-Secret header matches a CONFIGURED CRON_SECRET exactly
 *      (constant-time).
 *   2. Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> (constant-time),
 *      regardless of whether CRON_SECRET is configured — this is how prod's
 *      cron actually calls this function (vault cron_service_role_key ==
 *      SUPABASE_SERVICE_ROLE_KEY), so it must always work.
 *   3. Anything else — including CRON_SECRET being unset/empty, a missing
 *      serviceRoleKey, a wrong or malformed X-Cron-Secret, a wrong Bearer
 *      value, a non-Bearer Authorization header, or no header at all —
 *      is UNAUTHORIZED. There is no permissive branch: an unset CRON_SECRET
 *      never widens what is accepted, it only removes the X-Cron-Secret path.
 */
export function isCronAuthorized(input: CronAuthInput): boolean {
  const { cronSecret, incomingCronSecret, authHeader, serviceRoleKey } = input;

  if (cronSecret && incomingCronSecret && timingSafeEqualStrings(incomingCronSecret, cronSecret)) {
    return true;
  }

  if (serviceRoleKey && authHeader.startsWith("Bearer ")) {
    return timingSafeEqualStrings(authHeader.slice(7), serviceRoleKey);
  }

  return false;
}
