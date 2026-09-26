// gh-2154 P-5b (Kevin) — migration-ordering-guard tests.
//
// PR #2182 (P-5) DROPs+CREATEs public.register_partner() with a new 21-arg
// signature. At head 8d783fef it hardcoded v_agreement_version :=
// 'v2-2026-08' and had no ordering guard against #2166 (gh-2155 HI-0b, PR
// #2166), whose CREATE OR REPLACE bumps the live 20-arg register_partner()
// to v_agreement_version := 'v3-2026-09'. Applying P-5's migration after
// #2166 without a fix silently regresses that legal bump back to
// v2-2026-08; applying P-5 before #2166 creates a second, overloaded
// register_partner() instead of a clean replace. Neither is safe.
//
// This file reads the actual migration/rollback SQL as text (same
// sibling-directory-read pattern gh-1314 established for
// supabase/migrations_drafts, extended in .github/workflows/e2e-tests.yml
// to supabase/migrations and supabase/migrations_rollbacks for this test)
// and asserts, structurally, that:
//   (1) the forward migration's new 21-arg register_partner() stamps
//       v3-2026-09, not v2-2026-08;
//   (2) the forward migration contains a PRECONDITION guard that runs
//       BEFORE the DROP FUNCTION statement and checks for v3-2026-09;
//   (3) the rollback's restored 20-arg register_partner() stamps
//       v3-2026-09 (the POST-#2166 shape), not v2-2026-08 (the stale
//       pre-#2166 shape the original rollback targeted).
//
// FAILS on 8d783fef (no guard, v2-2026-08 hardcoded in both the forward
// migration and the rollback). PASSES once the migration/rollback carry
// the v3-2026-09 literal and the guard.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const MIGRATION_PATH =
  "supabase/migrations/20260924213000_gh2154_p5_meta_lead_id.sql";
const ROLLBACK_PATH =
  "supabase/migrations_rollbacks/20260924213000_gh2154_p5_meta_lead_id_rollback.sql";

async function readRepoFile(path: string): Promise<string> {
  // Tests run from the repo root (both locally and in CI's checkout), same
  // convention as price-verify.test.ts's migrations_drafts read.
  return await Deno.readTextFile(path);
}

// Isolates the new 21-arg CREATE FUNCTION public.register_partner(...) block
// in the forward migration, so assertions below can't accidentally match a
// v2/v3 literal mentioned only in a comment.
function extractCreateFunctionBlock(sql: string): string {
  const start = sql.indexOf("CREATE FUNCTION public.register_partner(");
  assert(start !== -1, "expected a CREATE FUNCTION public.register_partner(...) block in the migration");
  const end = sql.indexOf("$function$;", start);
  assert(end !== -1, "expected the CREATE FUNCTION block to close with $function$;");
  return sql.slice(start, end);
}

Deno.test("gh2154 P-5b: forward migration's new register_partner() stamps v3-2026-09", async () => {
  const sql = await readRepoFile(MIGRATION_PATH);
  const block = extractCreateFunctionBlock(sql);

  assert(
    block.includes("v_agreement_version CONSTANT text := 'v3-2026-09'"),
    "expected the new 21-arg register_partner() to stamp v_agreement_version := 'v3-2026-09' (copied from #2166), " +
      "but did not find that literal in the CREATE FUNCTION block",
  );
  assert(
    !block.includes("'v2-2026-08'"),
    "the new 21-arg register_partner() must not stamp the stale v2-2026-08 agreement version " +
      "(this is the exact regression #2166/HI-0b fixed)",
  );
});

Deno.test("gh2154 P-5b: forward migration has a PRECONDITION guard before DROP FUNCTION", async () => {
  const sql = await readRepoFile(MIGRATION_PATH);

  const guardIdx = sql.indexOf("PRECONDITION");
  assert(guardIdx !== -1, "expected a PRECONDITION guard in the migration -- none found");

  const dropIdx = sql.indexOf("DROP FUNCTION IF EXISTS public.register_partner(");
  assert(dropIdx !== -1, "expected the migration to DROP the old 20-arg register_partner()");

  assert(
    guardIdx < dropIdx,
    "the PRECONDITION guard must run BEFORE the DROP FUNCTION statement, so the wrong apply order " +
      "fails loudly instead of dropping/regressing anything first",
  );

  // The guard must actually check for #2166's marker, not just exist as text.
  const guardSection = sql.slice(guardIdx, dropIdx);
  assert(
    guardSection.includes("v3-2026-09") && /RAISE EXCEPTION/i.test(guardSection),
    "the PRECONDITION guard must RAISE EXCEPTION when the live register_partner() does not stamp v3-2026-09",
  );
});

Deno.test("gh2154 P-5b: rollback restores the POST-#2166 (v3-2026-09) register_partner(), not the stale pre-#2166 body", async () => {
  const sql = await readRepoFile(ROLLBACK_PATH);
  const block = extractCreateFunctionBlock(sql);

  assert(
    block.includes("v_agreement_version CONSTANT text := 'v3-2026-09'"),
    "the rollback's restored 20-arg register_partner() must stamp v3-2026-09 (the POST-#2166 shape it " +
      "restores to, per the migration's ORDERING requirement that #2166 applies first) -- got a different literal",
  );
  assert(
    !block.includes("'v2-2026-08'"),
    "the rollback must not restore the stale pre-#2166 v2-2026-08 body -- that would regress the HI-0b fix " +
      "the moment this rollback runs, which is the exact P-5b correction",
  );
});

Deno.test("gh2154 P-5b: rollback's restored register_partner() keeps the pre-P5 20-arg signature (no p_meta_lead_id)", async () => {
  const sql = await readRepoFile(ROLLBACK_PATH);
  const block = extractCreateFunctionBlock(sql);

  assertEquals(
    block.includes("p_meta_lead_id"),
    false,
    "the rollback's restored register_partner() must be the 20-arg (pre-meta_lead_id) signature",
  );
});
