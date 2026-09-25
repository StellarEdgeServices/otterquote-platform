// gh-2154 P-4 fix round (Ben SHOULD, bus 14:01:57Z, REVIEW FAIL 5833587935):
// "fail closed when CRON_SECRET is unset in prod (mirror the homeowner
// cron-auth pattern / #2167's cron-auth.ts)". This mirrors
// send-lead-next-step-reminder/cron-auth.ts (gh-2121 fix round 1, itself a
// mirror of send-homeowner-next-steps/index.ts's own three-way gate)
// EXACTLY — same precedence, same permissive no-CRON_SECRET branch for
// dev/staging, not a stricter variant. That permissive branch is what makes
// this "fail closed in prod": prod always configures CRON_SECRET (it is
// already in Supabase secrets alongside MAILGUN_API_KEY per this function's
// own index.ts header), so the permissive path is reachable ONLY in an
// environment that has no secret configured at all — dev/staging, exactly
// as the other three functions in this family already treat it. Before this
// file existed, this function's auth check was inlined in index.ts with the
// same logic but untestable in isolation; extracting it changes nothing
// about the gate itself, only makes it independently unit-testable.
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
 * True when the request is authorized to trigger a send run.
 *
 *   1. No CRON_SECRET configured at all -> permissive (dev/staging), same as
 *      send-homeowner-next-steps/index.ts and send-lead-next-step-reminder's
 *      cron-auth.ts.
 *   2. X-Cron-Secret header matches CRON_SECRET exactly.
 *   3. Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>.
 *   4. Anything else (including a wrong secret, a malformed Bearer value, or
 *      no header at all when CRON_SECRET IS configured) -> unauthorized.
 */
export function isCronAuthorized(input: CronAuthInput): boolean {
  const { cronSecret, incomingCronSecret, authHeader, serviceRoleKey } = input;
  if (!cronSecret) return true;
  if (incomingCronSecret && incomingCronSecret === cronSecret) return true;
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7) === serviceRoleKey;
  }
  return false;
}
