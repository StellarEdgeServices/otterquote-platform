// gh-2272 — source-ORDER assertions on index.ts's admin-gate wiring.
//
// Same technique as send-measurement-ready/verify-send-ordering.test.ts and
// docusign-webhook/gate-ordering.test.ts: a wrong POSITION in an admin gate
// is not caught by a unit test on isolated logic, so these assertions read
// the actual shipped source and check ordering directly.
//
// Run: deno test --allow-read supabase/functions/send-lead-measurement-ready/index-ordering.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const SRC = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const LINES = SRC.split("\n");

function lineOf(needle: string): number {
  const i = LINES.findIndex((l) => l.includes(needle));
  return i === -1 ? -1 : i + 1;
}

Deno.test("gh-2272: PRIMARY_ADMIN_EMAIL matches send-measurement-ready's constant", () => {
  assert(
    SRC.includes('const PRIMARY_ADMIN_EMAIL = "dustinstohler1@gmail.com"'),
    "the admin fast-path email must be the same PRIMARY_ADMIN_EMAIL used by send-measurement-ready",
  );
});

Deno.test("gh-2272: the caller's own JWT is resolved BEFORE isAdmin is computed", () => {
  const getUser = lineOf("await userClient.auth.getUser()");
  const isAdminAssign = lineOf("let isAdmin = user.email === PRIMARY_ADMIN_EMAIL");
  assert(getUser > 0 && isAdminAssign > 0);
  assert(getUser < isAdminAssign, `getUser() (line ${getUser}) must precede isAdmin (line ${isAdminAssign})`);
});

Deno.test("gh-2272: isAdmin falls back to contractors.template_review_role, same as send-measurement-ready", () => {
  assert(
    SRC.includes('adminRow?.template_review_role === "admin"'),
    "the admin gate must fall back to the contractors.template_review_role check",
  );
});

Deno.test("gh-2272: isAdmin is resolved BEFORE handleSendRequest is called", () => {
  const isAdminFallback = lineOf('adminRow?.template_review_role === "admin"');
  const handleCall = lineOf("await handleSendRequest(orderId, isAdmin, user.id, deps)");
  assert(isAdminFallback > 0 && handleCall > 0);
  assert(
    isAdminFallback < handleCall,
    `the admin fallback resolution (line ${isAdminFallback}) must precede the handleSendRequest call (line ${handleCall}) — ` +
      `otherwise a non-admin caller's request could reach handleSendRequest with a stale/undefined isAdmin`,
  );
});

Deno.test("gh-2272: handleSendRequest receives the TRIGGERING ADMIN's own user.id, not a lead id or sentinel (REVIEW: FAIL 5860802819 must-fix 2)", () => {
  assert(
    SRC.includes("await handleSendRequest(orderId, isAdmin, user.id, deps)"),
    "the activity_log attribution must be the resolved caller's own user.id — " +
      "the same auth.users row getUser() already proved exists — not a sentinel or the lead's id",
  );
  assert(
    !SRC.includes("00000000-0000-0000-0000-000000000000"),
    "the all-zero sentinel must not reappear in index.ts — REVIEW: FAIL 5860802819 must-fix 2 found it never satisfies activity_log_user_id_fkey in prod",
  );
});

Deno.test("gh-2272: the actual admin gate decision (403) lives in handleSendRequest, not duplicated ad hoc in index.ts", () => {
  // index.ts must not short-circuit with its own 403 before deferring to the
  // handler — there must be exactly one place that decision is made, so
  // there is one place to audit (mirrors gh-1538's "exactly one definition"
  // test for verifySend).
  const inlineForbidden = LINES.filter((l) => l.includes('"Forbidden: admin role required"'));
  assertEquals(inlineForbidden.length, 0, "index.ts must not itself return the Forbidden body; handleSendRequest owns that decision");
});
