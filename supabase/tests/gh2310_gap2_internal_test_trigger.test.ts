// gh-2310 Gap 2 (domain trigger) -- static structural test. No DB connection needed.
// Reads the migration, rollback and proof SQL as text and asserts the properties that can be checked
// without Postgres. The behavioural proof is supabase/tests/gh2310_gap2_internal_test_trigger_proof.sql
// (BEGIN ... ROLLBACK), which the applier runs against production.
//
// Run: deno test --allow-read=supabase supabase/tests/gh2310_gap2_internal_test_trigger.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";

const STEM = "20260930140000_gh2310_gap2_referral_agents_internal_test_trigger";
const FORWARD = `supabase/migrations/${STEM}.sql`;
const ROLLBACK = `supabase/migrations_rollbacks/${STEM}_rollback.sql`;
const PREFLIGHT = `supabase/migrations/${STEM}_pre-flight.md`;
const PROOF = "supabase/tests/gh2310_gap2_internal_test_trigger_proof.sql";

const read = (p: string) => Deno.readTextFile(p);
// Strip SQL line comments so assertions target executable text.
const code = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

Deno.test("all four artifacts exist", async () => {
  for (const p of [FORWARD, ROLLBACK, PREFLIGHT, PROOF]) {
    const st = await Deno.stat(p);
    assert(st.isFile, p);
  }
});

Deno.test("no gmail address literal in any new file (Stacy's address must not be in the repo)", async () => {
  for (const p of [FORWARD, ROLLBACK, PREFLIGHT, PROOF]) {
    const s = await read(p);
    const hits = s.match(/[A-Za-z0-9._%+-]+@gmail\.com/gi) ?? [];
    // Dustin's plus-address examples in the proof are built by concatenation, so no literal is expected at all.
    assertEquals(hits, [], `${p} contains gmail literal(s): ${hits.join(", ")}`);
  }
});

Deno.test("gmail base-address IN list is exactly ('dustinstohler1', %L) -- no other hard-coded base", async () => {
  const s = code(await read(FORWARD));
  const m = s.match(/IN \('dustinstohler1',\s*%L\)/);
  assert(m, "gmail IN list is not ('dustinstohler1', %L)");
  // The only single-quoted local-part-looking literals adjacent to gmail logic: nothing else after 'gmail.com'.
  assertEquals((s.match(/'gmail\.com'/g) ?? []).length >= 2, true); // helper rule + apply-time assertion
});

Deno.test("domain list matches the spec exactly", async () => {
  const s = code(await read(FORWARD));
  const m = s.match(/IN\s*\(\s*'stellaredgeservices\.com',\s*'tryotterquote\.com',\s*'stohlerroof\.com',\s*'otterquote-internal\.test'\s*\)/);
  assert(m, "domain IN-list differs from the spec");
});

Deno.test("Stacy is read at apply time from the named row and the migration RAISEs on every bad state", async () => {
  const s = code(await read(FORWARD));
  assert(s.includes("0a934e11-5cac-4607-a63c-7446fe446f81"));
  assert(s.includes("EXECUTE format("));
  assert(s.includes("%L"));
  const raises = (s.match(/RAISE EXCEPTION/g) ?? []).length;
  assert(raises >= 4, `expected >=4 RAISE EXCEPTION (missing row, null email, non-gmail, empty base); got ${raises}`);
  assert(/IF NOT FOUND THEN\s+RAISE EXCEPTION/.test(s), "missing-row case must RAISE");
  assert(/<> 'gmail\.com'/.test(s), "non-gmail case must RAISE");
});

Deno.test("trigger is BEFORE INSERT only, uses the helper, never sets false", async () => {
  const s = code(await read(FORWARD));
  assert(/CREATE TRIGGER referral_agents_set_is_test_internal\s+BEFORE INSERT ON public\.referral_agents/.test(s));
  assert(!/BEFORE (INSERT )?OR UPDATE|BEFORE UPDATE/i.test(s), "must be INSERT-only");
  assert(s.includes("public.is_internal_test_email(NEW.email)"), "trigger fn must call the helper");
  assert(s.includes("NEW.is_test := true"));
  assert(!/NEW\.is_test\s*:=\s*false/i.test(s), "must never set false");
});

Deno.test("helper: IMMUTABLE, SECURITY INVOKER, pinned search_path; privileges revoked with no GRANT", async () => {
  const s = code(await read(FORWARD));
  assert(/IMMUTABLE/.test(s) && /SECURITY INVOKER/.test(s));
  assertEquals((s.match(/SET search_path = pg_catalog, public/g) ?? []).length, 2);
  assert(/REVOKE ALL ON FUNCTION public\.is_internal_test_email\(text\) FROM PUBLIC, anon, authenticated/.test(s));
  assert(/REVOKE ALL ON FUNCTION public\.referral_agents_flag_internal_test\(\) FROM PUBLIC, anon, authenticated/.test(s));
  assert(!/\bGRANT\b/i.test(s), "no GRANT lines (permissions-ratchet gh-1767)");
});

Deno.test("rollback drops the trigger and both functions, in that order, with no data change", async () => {
  const s = code(await read(ROLLBACK));
  const t = s.indexOf("DROP TRIGGER IF EXISTS referral_agents_set_is_test_internal ON public.referral_agents");
  const f1 = s.indexOf("DROP FUNCTION IF EXISTS public.referral_agents_flag_internal_test()");
  const f2 = s.indexOf("DROP FUNCTION IF EXISTS public.is_internal_test_email(text)");
  assert(t > -1 && f1 > t && f2 > f1, "expected trigger, trigger fn, helper drop order");
  assert(!/\b(UPDATE|DELETE|INSERT)\b/i.test(s), "rollback must not touch data");
  assert(!/CASCADE/i.test(s), "no CASCADE");
});

Deno.test("proof script is BEGIN..ROLLBACK, has a negative control, and asserts with RAISE EXCEPTION", async () => {
  const s = code(await read(PROOF));
  assert(/^\s*BEGIN;/m.test(s) && /^\s*ROLLBACK;/m.test(s));
  assert(!/^\s*COMMIT;/m.test(s), "proof must never COMMIT");
  assert(/DISABLE TRIGGER referral_agents_set_is_test_internal/.test(s), "negative control missing");
  assert((s.match(/RAISE EXCEPTION/g) ?? []).length >= 3);
  for (const d of ["stellaredgeservices.com", "tryotterquote.com", "stohlerroof.com", "otterquote-internal.test"]) {
    assert(s.includes(d), `proof does not cover ${d}`);
  }
  assert(s.includes("'dustinstohler10+gh2310' || p_run") && s.includes("stellaredgeservices.com.evil.io"), "near-miss controls missing");
});
