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
