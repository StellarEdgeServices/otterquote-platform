/**
 * gh-397 / #689 — shared E2E-test-signal predicate for claim-creation call
 * sites in the React app.
 *
 * Mirrors the CEO-approved contractor predicate (#543, see
 * supabase/functions/notify-contractors/test-exclusion.ts):
 * an @otterquote-internal.test address identifies an E2E/test actor.
 *
 * PR #714 stamped `is_test` on the COI-identity contractor insert
 * (tests/e2e/flows/coi-upload-identity.spec.ts) but never touched any
 * `claims` insert path, so an E2E run driving the live app as
 * test-homeowner@otterquote-internal.test still wrote unflagged "real"
 * claim rows. Every claims-insert call site in the React app should stamp
 * `is_test: isTestEmail(user.email)` at creation using this helper, for
 * parity with the static-site equivalent (`Auth.isTestEmail` in js/auth.js).
 */
export function isTestEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase().endsWith('@otterquote-internal.test');
}
