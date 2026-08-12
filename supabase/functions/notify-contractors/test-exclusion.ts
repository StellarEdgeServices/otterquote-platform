// #543 item 3 — homeowner-facing matching exclusion for test contractors.
//
// A contractor is excluded from new_opportunity matching when either:
//   * contractors.is_test = true, or
//   * their email is an E2E-internal address (@otterquote-internal.test).
//
// Approved predicate (issue #543, CEO comment 2026-07-13):
//   is_test = true OR email LIKE '%@otterquote-internal.test'
// The email check is case-insensitive here (strictly safer than SQL LIKE).

export interface TestExcludableContractor {
  is_test?: boolean | null;
  email?: string | null;
}

export function isExcludedTestContractor(c: TestExcludableContractor): boolean {
  if (c.is_test === true) return true;
  const email = (c.email ?? "").trim().toLowerCase();
  return email.endsWith("@otterquote-internal.test");
}

// #564 — symmetric test-world fan-out selection for new_opportunity.
//
// Real claims (claimIsTest = false): notify real contractors only — the #543
// exclusion predicate above, unchanged (v69 behavior preserved).
// Test claims (claimIsTest = true): notify test contractors ONLY, defined
// strictly as contractors.is_test = true — mirroring the v96 RLS carve-out.
// An internal-email row WITHOUT the flag cannot SEE a test claim under v96,
// so it must not be notified of one either (it receives nothing at all).
//
// Approved: #564 CEO decision comment 2026-07-13 (Option A, fan-out symmetry).
export function selectFanOutContractors<T extends TestExcludableContractor>(
  contractors: T[],
  claimIsTest: boolean,
): T[] {
  if (claimIsTest) {
    return contractors.filter((c) => c.is_test === true);
  }
  return contractors.filter((c) => !isExcludedTestContractor(c));
}
