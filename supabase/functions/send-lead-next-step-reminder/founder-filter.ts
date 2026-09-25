// gh-2121 (LRS HO-1 S21) — founder/internal/synthetic exclusion for the lead
// next-step reminder.
//
// `leads` has no `is_test` column (same fact notify-helpers.ts already
// documents for gh-1994's router_lead alert) but DOES have `is_synthetic`
// (gh-2055, nullable boolean, NULL/false = real, true = synthetic fixture
// data). This module combines that column check with the SAME anchored
// email-pattern exclusion `notify-admin-new-homeowner/index.ts`'s
// `isExcludedEmail()` already uses for founder/internal addresses, plus the
// `leads`-specific reserved suffix `notify-helpers.ts` already established
// for gh-1994 (`@otterquote-internal.test`). Duplicated rather than
// imported — this repo's Edge Function deploy path does not resolve
// `_shared/` imports and no function here imports across function
// directories (see send-home-profile-prompt/index.ts:91 and
// notify-contractors/index.ts:91 for the same constraint stated at its
// original point of use).
//
// A real address that merely CONTAINS "test" (e.g. "greatestates@",
// "protest@") is deliberately NOT excluded — anchored checks only.

/** `leads`-specific reserved suffix (gh-1994, notify-helpers.ts). */
export const ROUTER_LEAD_EXCLUDED_EMAIL_SUFFIX = "@otterquote-internal.test";

/**
 * True when `email` is a founder/internal/QA address by the same anchored
 * rules `notify-admin-new-homeowner/index.ts`'s `isExcludedEmail()` uses, OR
 * matches the `leads`-specific reserved test suffix. An empty/unparseable
 * address is treated as excluded (fails closed — see `hasUsableEmail` for
 * the separate "no email at all" check this function does not duplicate).
 */
export function isFounderOrTestEmail(email: unknown): boolean {
  const lower = String(email ?? "").toLowerCase().trim();
  const at = lower.indexOf("@");
  if (!lower || at <= 0) return true; // no usable address — fail closed

  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);

  if (lower.endsWith(ROUTER_LEAD_EXCLUDED_EMAIL_SUFFIX)) return true;
  if (local === "test") return true;
  if (/^test[0-9+._-]/.test(local)) return true;
  if (local.includes("+test")) return true;
  if (["example.com", "example.org", "test.local"].includes(domain)) return true;
  if (
    domain === "otterquote.com" ||
    domain === "tryotterquote.com" ||
    domain === "stellaredgeservices.com"
  ) {
    return true;
  }
  if (lower.includes("stohler")) return true;

  return false;
}

/** True when `email` is present and non-blank ("only to leads with an email"). */
export function hasUsableEmail(email: unknown): boolean {
  return typeof email === "string" && email.trim().length > 0;
}

/**
 * `leads.is_synthetic` is a nullable boolean (gh-2055): NULL or false is a
 * real lead, true is synthetic fixture data. Only an explicit `true`
 * excludes — NULL must never be treated as "synthetic" (that would silently
 * suppress every lead captured before gh-2055 shipped, none of which this
 * column was ever meant to describe).
 */
export function isSyntheticLead(isSynthetic: unknown): boolean {
  return isSynthetic === true;
}
