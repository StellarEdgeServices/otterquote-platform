-- gh-1438 reconciliation (cto61, 2026-10-06T19:47:53Z): renamed from 20260930130000_gh2310_gap2_backfill_referral_agents_is_test.sql to the REAL applied ledger version.
-- Ledger row: supabase_migrations.schema_migrations version=20261003014821 (SELECT-only read 2026-10-06). Content check: statements normalized md5 0503d5dd = file.
-- Executable SQL body unchanged; only the filename version prefix and this banner changed.
-- Migration: 20260930130000_gh2310_gap2_backfill_referral_agents_is_test
-- GitHub: #2310 Gap 2 (residual of #1961), referral_agents ONLY. Gap 1 (profiles) was applied separately (20260928233000_...).
-- Tier: 3B (production data UPDATE). NOT APPLIED. Do not apply, merge or deploy without R-097 notice.
-- Rollback: supabase/migrations_rollbacks/20260930130000_gh2310_gap2_backfill_referral_agents_is_test_rollback.sql
-- Proof: supabase/tests/gh2310_gap2_referral_agents_proof.sql (BEGIN ... ROLLBACK only)
--
-- Summary: one-time is_test=true on 9 exact referral_agents ids that are attributable to Dustin or Stacy
-- (staff domains stohlerroof.com / stellaredgeservices.com / tryotterquote.com, "Dustin's/Stacy's boutique",
-- Dustin's or Stacy's own gmail address or plus-addresses). Measured SELECT-only on production
-- (yeszghaspzwwstvsrioa) 2026-09-29: 10 rows had is_test=false; this migration flips 9 of them.
--
-- DELIBERATELY EXCLUDED: 503f015b-c52f-4e35-a8f9-26243709f32f (Carlos McGuire). CEO ruling 5911272800 on #2310:
-- treated as a real partner (8 referrals, has an auth user); stays is_test=false. Do not add him to v_ids.
--
-- Match is by EXACT ID LIST (same list as the rollback), not by domain. The DO block RAISEs
-- (rolling back the transaction) unless exactly 9 rows are updated and every updated id is in the list.
-- Idempotent re-run: the guard would raise (0 rows); the migration is single-apply by design.
-- NOT touched: profiles, contractors, claims, and the forward domain trigger (separate PR, not built here).

BEGIN;

DO $$
DECLARE
  v_ids uuid[] := ARRAY['1927861f-8836-49ce-a528-08c432cc69cc'::uuid,'0a934e11-5cac-4607-a63c-7446fe446f81'::uuid,'bdfe2bbf-bbc6-42b9-9213-02b36ebb46fa'::uuid,'f05146f5-f397-4e68-9720-e4394e9c7bd4'::uuid,'9320942a-90c0-4517-b5b7-919f8b2652b8'::uuid,'1280cf58-d89d-4311-b016-c1ff06f29477'::uuid,'0db676cc-0c3f-4c9b-bd25-65952572d6df'::uuid,'5f9ea879-255d-499c-879d-806a9f84eb04'::uuid,'1a61675f-b972-4dd4-a483-d5aa0d9757dc'::uuid];
  v_carlos constant uuid := '503f015b-c52f-4e35-a8f9-26243709f32f'::uuid;
  v_updated uuid[];
BEGIN
  IF array_length(v_ids, 1) <> 9 THEN
    RAISE EXCEPTION 'gh2310 gap2 guard: id list has % entries, expected 9', array_length(v_ids, 1);
  END IF;
  IF v_carlos = ANY (v_ids) THEN
    RAISE EXCEPTION 'gh2310 gap2 guard: Carlos McGuire (503f015b) must not be in the id list (CEO ruling 5911272800)';
  END IF;

  -- gh-886 trigger referral_agents_guard_payout_columns rejects is_test changes unless auth.role()='service_role'
  -- or an admin JWT; a migration connection has neither. Claim service_role for THIS TRANSACTION ONLY (is_local=true).
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  WITH upd AS (
    UPDATE public.referral_agents
       SET is_test = true
     WHERE id = ANY (v_ids)
       AND is_test = false
    RETURNING id
  )
  SELECT array_agg(id) INTO v_updated FROM upd;

  IF v_updated IS NULL
     OR array_length(v_updated, 1) <> 9
     OR EXISTS (SELECT 1 FROM unnest(v_updated) u WHERE u <> ALL (v_ids)) THEN
    RAISE EXCEPTION 'gh2310 gap2 guard tripped: updated % rows (expected exactly 9 from the id list)',
      coalesce(array_length(v_updated, 1), 0);
  END IF;
END
$$;

COMMIT;
