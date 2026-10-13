-- gh-2310 Gap 3: backfill referrals.is_test = true on the 9 legacy click rows that sit under test/staff referral_agents.
-- STATUS (gh-1438): APPLIED. Tier 3B (production data UPDATE). APPLIED to production (yeszghaspzwwstvsrioa) under R-097 by CTO RUN 64 (claim cto-2026-10-08T16:29:34Z): supabase_migrations.schema_migrations version 20261008210737, name gh2310_gap3_backfill_referrals_is_test; evidence #2310 comment 6069081536.
-- Ruling: #2310 comment 6046227412 (CTO). Review that found the residue: CLOSE-REVIEW 6045581293.
-- Rollback: supabase/migrations_rollbacks/gh2310_gap3_backfill_referrals_is_test_rollback.sql
-- Pre-flight (prints the 9 rows): supabase/migrations_rollbacks/gh2310_gap3_referrals_is_test_pre-flight.md
-- Proof (rolled back, human-run): supabase/tests/gh2310_gap3_referrals_is_test_proof.sql
-- NEVER RE-RUN by hand: this is the filed copy under the ledger version (moved from supabase/migrations_drafts/ after the apply; SQL statements unchanged, header comments only).
--
-- Rows (measured SELECT-only 2026-10-07T20:28Z, project yeszghaspzwwstvsrioa): referrals with is_test=false whose referral_agents row has is_test=true = 9,
-- created 2026-08-05 to 2026-08-27, under three staff/test agents 76c64636, 1927861f, 0a934e11. Match is by EXACT ID LIST (same list as the rollback), not by predicate.
-- The DO block RAISEs (rolling the transaction back) unless exactly 9 rows update, every updated id is in the list, and each row's agent is still is_test=true.
-- referrals has one trigger, referrals_update_stats (AFTER UPDATE); it acts only on a status change, and this UPDATE does not change status, so no counter moves.
-- NOT touched: referral_agents, profiles, claims, any other referrals row (including the 10 rows under non-test agents).

BEGIN;

DO $$
DECLARE
  v_ids uuid[] := ARRAY['97253d12-6691-4308-8bf0-754b29b5ece7'::uuid,'596b5ec3-b381-4261-b10d-ba438b401c8b'::uuid,'6ede692b-a7c0-43b1-b0cb-f318fb209c32'::uuid,'3c62b0f1-4b40-44c2-a394-ca77ebfdce69'::uuid,'a240bb83-2e38-4d64-aa76-44d675556b43'::uuid,'d843c6d4-35ba-46c4-adfa-a5909e267065'::uuid,'a034c167-8140-4a0f-af63-0acd84be338d'::uuid,'b206c41a-6b1e-4d6d-b21d-fe3ed6cd64f5'::uuid,'82d58235-2c70-423a-b682-afedd3d745c9'::uuid];
  v_updated uuid[];
BEGIN
  IF array_length(v_ids, 1) <> 9 THEN
    RAISE EXCEPTION 'gh2310 gap3 guard: id list has % entries, expected 9', array_length(v_ids, 1);
  END IF;

  WITH upd AS (
    UPDATE public.referrals r
       SET is_test = true
      FROM public.referral_agents a
     WHERE r.id = ANY (v_ids)
       AND r.is_test = false
       AND a.id = r.referral_agent_id
       AND a.is_test = true
    RETURNING r.id
  )
  SELECT array_agg(id) INTO v_updated FROM upd;

  IF v_updated IS NULL
     OR array_length(v_updated, 1) <> 9
     OR EXISTS (SELECT 1 FROM unnest(v_updated) u WHERE u <> ALL (v_ids)) THEN
    RAISE EXCEPTION 'gh2310 gap3 guard tripped: updated % rows (expected exactly 9 from the id list)',
      coalesce(array_length(v_updated, 1), 0);
  END IF;
END
$$;

COMMIT;
