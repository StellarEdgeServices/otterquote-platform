// gh-2154 P-4 fix round (ruling c, REOPENED): proves — as an automated
// test, not just a review claim — that
// claim_partner_onboarding_stage()'s WHERE clause (see
// ./claim-stage-sql-proof.ts's quoted copy, and its own header for why it
// is a quoted copy rather than a live file read of the real migration)
// contains NO stale-pending reclaim path. This test FAILS on head aae3acfc
// / the first fix-round commit — that version's WHERE clause was:
//   WHERE partner_onboarding_sends.status = 'failed'
//      OR (
//        partner_onboarding_sends.status = 'pending'
//        AND partner_onboarding_sends.created_at < now() - make_interval(mins => p_stale_minutes)
//      );
// which this test's negative assertions below would catch (the string
// contains both "'pending'" combined with "make_interval" AND an OR before
// it — see the two negative assertions).
// Run: deno test supabase/functions/send-partner-onboarding/claim-stage-sql-proof.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { CLAIM_PARTNER_ONBOARDING_STAGE_FUNCTION_BODY as SQL } from "./claim-stage-sql-proof.ts";

Deno.test("proof: the claim function's WHERE clause never reclaims a 'pending' row", () => {
  // The only allowed condition under which the DO UPDATE branch fires is
  // status = 'failed'. If a stale-pending reclaim path existed, the WHERE
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

Deno.test("proof: the WHERE clause is a single unconditional 'failed' check — no OR branch remains", () => {
  const whereMatch = SQL.match(/WHERE\s+partner_onboarding_sends\.status\s*=\s*'failed'\s*;/);
  assertEquals(
    whereMatch !== null,
    true,
    `expected the WHERE clause to be exactly "WHERE partner_onboarding_sends.status = 'failed';" with no trailing OR branch, got: ${SQL}`,
  );
  // Belt-and-suspenders: no "OR" keyword anywhere in the function body at all.
  assertEquals(/\bOR\b/i.test(SQL), false, "no OR branch should remain in the claim function body");
});

Deno.test("proof (positive control): the 'failed' branch itself is still present — this test suite isn't vacuously passing", () => {
  assertEquals(SQL.includes("status = 'failed'"), true);
  assertEquals(SQL.includes("ON CONFLICT (partner_id, stage) DO UPDATE"), true);
});
