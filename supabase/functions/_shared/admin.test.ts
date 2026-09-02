// Deno unit tests for the gh-1534 canonical admin allow-list.
// Run: deno test supabase/functions/_shared/admin.test.ts
//
// This file exercises the canonical source of truth directly (isAdminEmail /
// isPrimaryAdminEmail / requireAdmin). The Edge Functions that consume it
// INLINE their own copy (see admin.ts's header comment for why — the EF
// body-deploy path does not resolve `_shared/` imports), so this file
// cannot catch drift between a consumer's inlined copy and this canonical
// version by itself. The second Deno.test block below does that structural
// check directly against each consumer's source text, one assertion per
// function, per the gh-1534 work order.

import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  ADMIN_EMAILS,
  isAdminEmail,
  isPrimaryAdminEmail,
  PRIMARY_ADMIN_EMAIL,
  requireAdmin,
} from "./admin.ts";

const NON_ADMIN_EMAIL = "not-an-admin@example.com";
const DIFFERENT_CASE_ADMIN = "Dustinstohler1@Gmail.com";

// ── canonical predicate behavior ───────────────────────────────────────────

Deno.test("ADMIN_EMAILS is the expected two-email union", () => {
  assertEquals(ADMIN_EMAILS, ["dustinstohler1@gmail.com", "dustin@otterquote.com"]);
});

Deno.test("PRIMARY_ADMIN_EMAIL is the single canonical identity", () => {
  assertEquals(PRIMARY_ADMIN_EMAIL, "dustinstohler1@gmail.com");
});

Deno.test("isAdminEmail / requireAdmin: accept every email in ADMIN_EMAILS", () => {
  for (const email of ADMIN_EMAILS) {
    assert(isAdminEmail(email), `expected ${email} to be admin`);
    assert(requireAdmin(email), `expected requireAdmin(${email}) to be true`);
  }
});

Deno.test("isAdminEmail / requireAdmin: reject a non-admin JWT email", () => {
  assertFalse(isAdminEmail(NON_ADMIN_EMAIL));
  assertFalse(requireAdmin(NON_ADMIN_EMAIL));
});

Deno.test("isAdminEmail / requireAdmin: reject null/undefined (unverified caller)", () => {
  assertFalse(isAdminEmail(null));
  assertFalse(isAdminEmail(undefined));
  assertFalse(requireAdmin(null));
  assertFalse(requireAdmin(undefined));
});

Deno.test("isAdminEmail: case-sensitive — does not normalize case", () => {
  assertFalse(
    isAdminEmail(DIFFERENT_CASE_ADMIN),
    "case-sensitive exact match is the strictest of the two pre-consolidation behaviors (gh-1534)",
  );
});

Deno.test("isPrimaryAdminEmail: accepts only the single primary email, not the full union", () => {
  assert(isPrimaryAdminEmail(PRIMARY_ADMIN_EMAIL));
  assertFalse(
    isPrimaryAdminEmail("dustin@otterquote.com"),
    "the secondary admin email must NOT satisfy the primary-only gate — this is the deliberate non-widening split documented in admin.ts",
  );
  assertFalse(isPrimaryAdminEmail(NON_ADMIN_EMAIL));
  assertFalse(isPrimaryAdminEmail(null));
});

// ── structural regression: every consumer still gates identically ─────────
// One assertion per function (gh-1534 work order pt. 4). Reads each
// consumer's inlined source and asserts it still contains the expected
// allow-list constant, so an edit to one inlined copy that silently drifts
// from admin.ts's documented split (ADMIN_EMAILS vs PRIMARY_ADMIN_EMAIL) is
// caught here rather than at review time.

const REPO_FUNCTIONS_DIR = new URL("..", import.meta.url);

async function readConsumerSource(fn: string): Promise<string> {
  const path = new URL(`${fn}/index.ts`, REPO_FUNCTIONS_DIR);
  return await Deno.readTextFile(path);
}

const UNION_CONSUMERS = [
  "approve-payout",
  "reject-payout",
  "mark-payout-paid",
  "get-payout-completion-status",
  "ga4-report",
  "get-business-lines-dashboard",
];

for (const fn of UNION_CONSUMERS) {
  Deno.test(`${fn}: still gates on the full ADMIN_EMAILS union (dustinstohler1@gmail.com, dustin@otterquote.com)`, async () => {
    const src = await readConsumerSource(fn);
    assertStringIncludesBoth(src, ["dustinstohler1@gmail.com", "dustin@otterquote.com"], fn);
  });
}

const PRIMARY_ONLY_CONSUMERS = [
  "admin-contractor-action",
  "mint-test-session",
  "send-measurement-ready",
  "approve-warranty-drift",
  "reject-warranty-drift",
];

for (const fn of PRIMARY_ONLY_CONSUMERS) {
  Deno.test(`${fn}: still gates on PRIMARY_ADMIN_EMAIL only, not widened to the full union`, async () => {
    const src = await readConsumerSource(fn);
    assert(
      src.includes('PRIMARY_ADMIN_EMAIL = "dustinstohler1@gmail.com"'),
      `${fn}/index.ts must define PRIMARY_ADMIN_EMAIL = "dustinstohler1@gmail.com"`,
    );
    assert(
      !src.includes('ADMIN_EMAILS      = ["dustinstohler1@gmail.com", "dustin@otterquote.com"]') &&
        !/const ADMIN_EMAILS\s*=\s*\[/.test(src),
      `${fn}/index.ts must NOT also define a full ADMIN_EMAILS array — that would widen this function's admin gate beyond its pre-gh-1534 behavior`,
    );
  });
}

function assertStringIncludesBoth(src: string, needles: string[], fn: string) {
  for (const needle of needles) {
    assert(src.includes(needle), `${fn}/index.ts is missing expected admin email "${needle}"`);
  }
}
