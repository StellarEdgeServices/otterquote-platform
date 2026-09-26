// #2123 HO-2 fix round (REVIEW FAIL 5849223003 item 7, optional/cheap) --
// founder/internal/synthetic exclusion for homeowner `is_synthetic`, exactly
// duplicated (not imported -- see below) from
// send-lead-next-step-reminder/founder-filter.ts's isFounderOrTestEmail(),
// which itself duplicates notify-admin-new-homeowner/index.ts's
// isExcludedEmail() plus notify-helpers.ts's ROUTER_LEAD_EXCLUDED_EMAIL_SUFFIX.
// Duplicated rather than imported across function directories -- this
// repo's Edge Function deploy path does not resolve cross-function imports
// (see send-home-profile-prompt/index.ts:91 and notify-contractors/
// index.ts:91 for the same constraint stated at its original point of use).
//
// A real address that merely CONTAINS "test" (e.g. "greatestates@",
// "protest@") is deliberately NOT excluded -- anchored checks only.

/** `leads`-specific reserved suffix (gh-1994, notify-helpers.ts). */
export const ROUTER_LEAD_EXCLUDED_EMAIL_SUFFIX = "@otterquote-internal.test";

/**
 * True when `email` is a founder/internal/QA address, OR matches the
 * `leads`-specific reserved test suffix. An empty/unparseable address is
 * treated as excluded (fails closed).
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
  const FOUNDER_DOMAINS = ["otterquote.com", "tryotterquote.com", "stellaredgeservices.com"];
  if (FOUNDER_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) {
    return true;
  }
  if (lower.includes("stohler")) return true;

  return false;
}
