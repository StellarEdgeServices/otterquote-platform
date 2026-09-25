// gh-2121 (LRS HO-1 S21) fix round 1 (CEO RUN 68 REVIEW: FAIL, comment
// 5825698253, must-fix 3): send-lead-next-step-reminder had NO auth gate at
// all before this fix — any caller with only the anon key could invoke it
// and trigger a send run. This mirrors send-homeowner-next-steps/index.ts's
// own three-way gate EXACTLY (same precedence, same permissive
// no-CRON_SECRET branch for dev/staging) rather than inventing a stricter
// variant, per the must-fix's own wording ("require the SAME
// cron-secret/service-role auth check send-homeowner-next-steps uses").
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
 *      send-homeowner-next-steps/index.ts.
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
