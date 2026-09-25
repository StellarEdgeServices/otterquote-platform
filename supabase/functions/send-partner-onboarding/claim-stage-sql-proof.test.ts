// gh-2154 P-4 switch-on hardening round (Ben, bus 18:23:17Z item (3) retry
// cap): proves — as an automated test, not just a review claim — that
// claim_partner_onboarding_stage()'s WHERE clause (see
// ./claim-stage-sql-proof.ts's quoted copy, and its own header for why it
// is a quoted copy rather than a live file read of the real migration)
// still contains NO stale-pending reclaim path (the original ruling-c
// invariant, re-asserted, unchanged), AND now also enforces the retry cap
// (attempt_count < 5, terminal_failure excluded). These retry-cap
// assertions FAIL on the pre-switch-on-hardening head (merged in #2180,
// b6ea0ecb) — that version's SQL has no attempt_count/terminal_failure
// reference anywhere.
// Run: deno test supabase/functions/send-partner-onboarding/claim-stage-sql-proof.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { CLAIM_PARTNER_ONBOARDING_STAGE_FUNCTION_BODY as SQL } from "./claim-stage-sql-proof.ts";

Deno.test("proof: the claim function's WHERE clause never reclaims a 'pending' row", () => {
  // The only allowed condition under which the DO UPDATE branch fires
  // requires status = 'failed' (now AND-extended by the retry cap, never
  // OR-extended). If a stale-pending reclaim path existed, the WHERE
  // clause would ALSO test the table-qualified
  // partner_onboarding_sends.status = 'pending' (distinct from the
  // unqualified `SET status = 'pending'` a few lines above it, which is the
  // legitimate "set the claimed status to pending" write every successful
  // claim performs — that one is expected and must stay) — the qualified
  // comparison form must be absent.
  assertEquals(
    SQL.includes("partner_onboarding_sends.status = 'pending'"),
    false,
    "the claim function's WHERE clause must never test for an existing 'pending' status — that is exactly the stale-pending reclaim path being removed",
  );
});

Deno.test("proof: the claim function's WHERE clause carries no staleness/age comparison at all", () => {
  // make_interval / STALE_PENDING_MINUTES / any age-of-claim arithmetic
  // against created_at is the specific mechanism a reclaim would need —
  // its total absence is the strongest available proof there is no
  // takeover path left, whatever it might have been named.
  assertEquals(SQL.includes("make_interval"), false, "no age-based interval arithmetic should remain in the claim function");
  assertEquals(SQL.includes("p_stale_minutes"), false, "p_stale_minutes must not be referenced inside the function BODY (the parameter may still exist on the signature for call-site compatibility, but the body proven here must not consult it)");
});

Deno.test("proof: the WHERE clause is a single 'failed' branch, AND-narrowed by the retry cap — no OR branch remains", () => {
  const whereMatch = SQL.match(
    /WHERE\s+partner_onboarding_sends\.status\s*=\s*'failed'\s*\n\s*AND\s+NOT\s+partner_onboarding_sends\.terminal_failure\s*\n\s*AND\s+partner_onboarding_sends\.attempt_count\s*<\s*5\s*;/,
  );
  assertEquals(
    whereMatch !== null,
    true,
    `expected the WHERE clause to require status='failed' AND NOT terminal_failure AND attempt_count < 5, with no trailing OR branch, got: ${SQL}`,
  );
  // Belt-and-suspenders: no "OR" keyword anywhere in the function body at all.
  assertEquals(/\bOR\b/i.test(SQL), false, "no OR branch should remain in the claim function body");
});

Deno.test("proof (retry cap, NEW): attempt_count is incremented on every reclaim, and starts at 1 on a fresh INSERT", () => {
  assertEquals(SQL.includes("VALUES (p_partner_id, p_stage, 'pending', now(), 1)"), true, "a fresh claim (no existing row) must start attempt_count at 1");
  assertEquals(SQL.includes("attempt_count = partner_onboarding_sends.attempt_count + 1"), true, "a reclaim of a 'failed' row must increment attempt_count");
});

Deno.test("proof (retry cap, NEW): terminal_failure permanently blocks reclaim, independent of attempt_count", () => {
  assertEquals(SQL.includes("AND NOT partner_onboarding_sends.terminal_failure"), true);
});

Deno.test("proof (retry cap, NEW): uncertain_alerted_at is cleared on every legitimate reclaim (fresh attempt, fresh alert eligibility)", () => {
  assertEquals(SQL.includes("uncertain_alerted_at = NULL"), true);
});

Deno.test("proof (positive control): the 'failed' branch itself is still present — this test suite isn't vacuously passing", () => {
  assertEquals(SQL.includes("status = 'failed'"), true);
  assertEquals(SQL.includes("ON CONFLICT (partner_id, stage) DO UPDATE"), true);
});
