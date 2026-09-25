// gh-2154 P-4 — same three bot-account email patterns notify-admin-new-partner
// (P-3) and notify-admin-new-contractor match. Duplicated rather than
// imported: this repo's Edge Function deploy path does not resolve _shared/
// imports across function directories (see send-home-profile-prompt's
// emailButton comment, and send-homeowner-next-steps/index.ts's identical
// note on why its own convention constants aren't imported from a shared
// module either) — so every function that needs this owns its own copy,
// byte-identical to the others, verbatim.
export function isTestAccount(email: string): boolean {
  const lower = (email || "").toLowerCase();
  return (
    lower.includes("otterquote-internal.test") ||
    lower.includes("pfw-") ||
    lower.includes("authdoctor")
  );
}

// Ben, DECIDED (bus 14:01:57Z, ruling b — REVIEW FAIL 5833587935): "Always
// skip @otterquote-internal.test and founder/.invalid/.test addresses;
// human is_test gets the [TEST] subject prefix (same as P-3's rule)."
//
// P-3's own precedent for the first half of this (notify-admin-new-partner's
// isInternalTestDomain, REVIEW FAIL 5832785581 should-fix 1): the repo's
// pfw-/authdoctor walk bots all sign up under @otterquote-internal.test,
// which made "is_test wins" alert on every walk run. That domain is excluded
// UNCONDITIONALLY, even when is_test=true, checked BEFORE the is_test check
// below in run-sweep.ts — no import across function directories is possible
// here either, so this mirrors that helper's shape rather than importing it.
//
// "founder/.invalid/.test addresses" extends the same unconditional-skip
// treatment to two more categories this repo already treats as never-real-
// recipients elsewhere: gh-1932's own founder-account exclusion (any address
// containing "stohler" — see notify-admin-new-homeowner/index.ts's
// isExcludedEmail) and the two IANA/RFC 2606-reserved "this is not a real
// mailbox" TLDs, .invalid and .test (of which otterquote-internal.test is
// one specific case — this generalizes to ANY domain ending in either
// reserved TLD, not just that one literal domain).
export function isAlwaysExcludedAddress(email: string): boolean {
  const lower = (email || "").toLowerCase().trim();
  if (!lower || lower.indexOf("@") <= 0) return false; // no usable address; caller's own no-email gate handles this
  const domain = lower.slice(lower.indexOf("@") + 1);
  return (
    lower.includes("stohler") ||
    domain.endsWith(".invalid") ||
    domain.endsWith(".test")
  );
}
