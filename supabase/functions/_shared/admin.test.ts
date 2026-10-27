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

// gh-3077: the gates now read ONE helper (_shared/admin-gate.ts). Each consumer must call the helper
// that matches the set it accepted before: requireAdmin (both addresses, via live is_admin_email())
// or requirePrimaryAdmin (primary only). A primary-only function must never call requireAdmin.
const UNION_CONSUMERS = [
  "approve-payout",
  "reject-payout",
  "mark-payout-paid",
  "get-payout-completion-status",
  "ga4-report",
  "get-business-lines-dashboard",
  "get-homeowner-list",
  "mark-loss-sheet-reviewed",
];

for (const fn of UNION_CONSUMERS) {
  Deno.test(`${fn}: gates through requireAdmin() only (both addresses via is_admin_email()), no local email list`, async () => {
    const src = await readConsumerSource(fn);
    assert(src.includes("await requireAdmin(req)"), `${fn}/index.ts must call requireAdmin(req)`);
    assert(!src.includes("requirePrimaryAdmin"), `${fn}/index.ts must not narrow to the primary admin`);
    assert(!/ADMIN_EMAILS\s*=/.test(src), `${fn}/index.ts must not define its own admin list`);
  });
}

const PRIMARY_ONLY_CONSUMERS = [
  "admin-contractor-action",
  "admin-reissue-contract",
  "mint-test-session",
  "send-measurement-ready",
  "send-referral-out-email",
  "vault-resync",
];

for (const fn of PRIMARY_ONLY_CONSUMERS) {
  Deno.test(`${fn}: gates through requirePrimaryAdmin() only, not widened to requireAdmin()`, async () => {
    const src = await readConsumerSource(fn);
    assert(src.includes("await requirePrimaryAdmin(req)"), `${fn}/index.ts must call requirePrimaryAdmin(req)`);
    assert(!/\brequireAdmin\(/.test(src), `${fn}/index.ts must NOT call requireAdmin() — that would widen this function's gate`);
    assert(!/ADMIN_EMAILS\s*=/.test(src), `${fn}/index.ts must NOT define its own admin list`);
  });
}

