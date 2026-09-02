/**
 * admin.ts — canonical platform admin allow-list (gh-1534).
 *
 * gh-1534 audit: "THIS PLATFORM HAS NO ADMIN IDENTITY IN THE DATABASE.
 * Admin authorisation is a hardcoded email array duplicated across Edge
 * Functions" (hazard-register-security.md:78, 2026-08-31). Eleven call
 * sites across eleven Edge Functions independently hardcoded either the
 * two-email allow-list below or just the primary email, with no shared
 * definition anywhere. This file is the single source of truth those
 * call sites are kept in sync with.
 *
 * The database-identity half (an `is_admin` column / role, replacing this
 * email allow-list entirely) is a separate, larger change — out of scope
 * here. This consolidation is behavior-neutral: it does not add, remove,
 * or widen who counts as admin anywhere; it only gives the existing
 * hardcoded values one place to be defined and diffed against.
 *
 * ── IMPORTANT: consumers must INLINE this, not import it ──────────────────
 * The EF body-deploy path in this repo does not resolve `_shared/` imports
 * (established precedent: see `_shared/sentry.ts`, `_shared/email.ts`, and
 * `_shared/getHomeownerName.ts` — all three document the same constraint).
 * This file exists so every admin-gate implementation in the codebase can
 * be diffed against ONE source of truth and kept in sync by eye, not so it
 * can be `import`-ed directly into a deployed function. If the deploy path
 * is ever changed to bundle `_shared/`, these exports can become real
 * imports with no signature change.
 *
 * ── Two allow-lists, not one — read before editing ─────────────────────────
 * The eleven call sites pre-consolidation fell into two groups that do NOT
 * accept the same set of emails, and this consolidation preserves that
 * split rather than silently widening the narrower group to the union
 * (gh-1534 PR body has the full per-function reconciliation table):
 *
 *   - ADMIN_EMAILS       — accepted by: approve-payout, reject-payout,
 *     mark-payout-paid, get-payout-completion-status, ga4-report,
 *     get-business-lines-dashboard. These six already accepted both emails
 *     before this change.
 *
 *   - PRIMARY_ADMIN_EMAIL — accepted by: admin-contractor-action,
 *     mint-test-session, send-measurement-ready, approve-warranty-drift,
 *     reject-warranty-drift (email fast-path only; these two also fall
 *     back to a DB `contractors.template_review_role === "admin"` check,
 *     which this file does not touch). These five only ever accepted the
 *     single primary email before this change — do not switch them to
 *     ADMIN_EMAILS without an explicit access-widening decision (Q: raised
 *     on gh-1534; see PR body).
 *
 * Comparison semantics: case-sensitive exact match, no normalization. This
 * is what ten of the eleven pre-existing call sites already did; the
 * eleventh (ga4-report) lower-cased the JWT email before comparing and has
 * been tightened to match the majority (case-sensitive is the strictest of
 * the two observed behaviors — flagged in the gh-1534 PR body).
 */

/** Full admin allow-list. See header — only for the six functions that already accepted both emails pre-consolidation. */
export const ADMIN_EMAILS: readonly string[] = [
  "dustinstohler1@gmail.com",
  "dustin@otterquote.com",
];

/** The single canonical admin identity. See header — for the five functions that only ever accepted this one email pre-consolidation. */
export const PRIMARY_ADMIN_EMAIL = "dustinstohler1@gmail.com";

/**
 * True if `email` is in the full admin allow-list. Case-sensitive exact
 * match. Pass the *verified* email from `supabase.auth.getUser()` (or
 * equivalent verified-JWT lookup) — never a client-supplied value.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && ADMIN_EMAILS.includes(email);
}

/**
 * True if `email` is the single canonical admin identity. Case-sensitive
 * exact match. Pass the *verified* email from `supabase.auth.getUser()`
 * (or equivalent verified-JWT lookup) — never a client-supplied value.
 */
export function isPrimaryAdminEmail(email: string | null | undefined): boolean {
  return !!email && email === PRIMARY_ADMIN_EMAIL;
}

/**
 * requireAdmin(email) — convenience alias for isAdminEmail, named to match
 * the gh-1534 issue text. Reference implementation only (see header): not
 * imported by any deployed function. Each call site inlines the equivalent
 * `!ADMIN_EMAILS.includes(email)` / `!isPrimaryAdminEmail(email)` check and
 * returns its own 401/403 Response shape, which this module intentionally
 * does not standardize (that shape differs by function today and is out of
 * scope for gh-1534).
 */
export function requireAdmin(email: string | null | undefined): boolean {
  return isAdminEmail(email);
}
