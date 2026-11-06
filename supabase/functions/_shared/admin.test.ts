// Deno structural tests for the Edge Function admin gates (gh-1534, reworked in gh-3077).
// Run: deno test --allow-read=supabase/functions supabase/functions/_shared/admin.test.ts
//
// _shared/admin.ts (the gh-1534 reference allow-list) was deleted in gh-3077: every gate now reads
// _shared/admin-gate.ts (behaviour tests in admin-gate.test.ts). This file reads each consumer's source and
// asserts it still calls the helper matching the set it accepted before (requireAdmin: both addresses via
// is_admin_email(); requirePrimaryAdmin: primary only) and carries no email list of its own.

import { assert } from "https://deno.land/std@0.177.0/testing/asserts.ts";
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


Deno.test("gh-3077: _shared/admin.ts stays deleted (its literal list must not come back)", async () => {
  let exists = true;
  try {
    await Deno.stat(new URL("admin.ts", import.meta.url));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) exists = false;
    else throw e;
  }
  assert(!exists, "_shared/admin.ts was deleted by gh-3077; admin gates read _shared/admin-gate.ts");
});
