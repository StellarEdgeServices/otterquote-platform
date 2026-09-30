-- Migration: 20260928233000_gh2310_backfill_legacy_internal_test_profiles
-- GitHub: #2310 Gap 1 (residual of #1961), PROFILES ONLY. Gap 2 (referral_agents) and contractors are NOT touched.
-- Tier: 3B (production data UPDATE). NOT APPLIED. Do not apply, merge or deploy without R-097 notice.
-- Rollback: supabase/migrations_rollbacks/20260928233000_gh2310_backfill_legacy_internal_test_profiles_rollback.sql
-- Proof: supabase/tests/gh2310_backfill_proof.sql (BEGIN ... ROLLBACK only)
--
-- Summary: one-time is_test=true on the 26 exact profile ids (all synthetic @otterquote-internal.test,
-- created 2026-09-26, is_test=false) that predate #1961's INSERT-only trigger.
-- Measured SELECT-only on production (yeszghaspzwwstvsrioa) 2026-09-28: 26 by id = 26 by domain;
-- 33 domain rows already true; 17 off-domain true; 42 off-domain false (all untouched).
--
-- Match is by EXACT ID LIST (same list as the rollback), not by domain. The DO block RAISEs
-- (rolling back the transaction) unless exactly 26 rows are updated and every updated id is in the list.
-- Idempotent re-run: the guard would raise (0 rows); the migration is single-apply by design.
-- NOT touched, deliberately: contractors (incl. "Ceo48 GH2000 Test Co"), claims, referral_agents
-- (23 rows are owned by these 26 profiles: Gap 2, still open on #2310).

BEGIN;

DO $$
DECLARE
  v_ids uuid[] := ARRAY['0035a84f-06b1-4d6a-bc59-50eda2ed4b23'::uuid,'13dedaf2-4f1c-41d7-8dfe-bb59c76c36b9'::uuid,'1b25aaa9-e97c-4137-88fc-860dfcbb770d'::uuid,'217f9a2b-3cb9-4e1f-80bc-561b3c5d419c'::uuid,'24bd2fbb-8ec3-44bc-8495-5c0adaef1f3c'::uuid,'35911e4a-5b44-4fe6-8adb-87d0d570ba7a'::uuid,'36e3bd10-f654-46e1-8e6d-d628ccce386f'::uuid,'3824977b-7e12-4d58-abb5-539d3e89aff8'::uuid,'47e2a089-80ee-418e-8df7-334dd0dfb720'::uuid,'540bfe34-b089-4de0-a91b-b0fe865acc1f'::uuid,'5abd41ac-b762-44fd-b488-66e6416f942f'::uuid,'6cb13a05-c47d-4d01-aafd-f5f9c1b1dc9e'::uuid,'7cfb31d8-4a63-4040-8b28-5e66f6b49885'::uuid,'7f0c8fa4-84a1-4c91-85e3-431ecf5778d9'::uuid,'856f0fb7-69cc-4ec9-b3fe-5e8278f03416'::uuid,'86b74193-3b48-43ac-902e-da0f91fd916b'::uuid,'881abc4f-0159-49bc-b0af-cef8e1b53afd'::uuid,'89f8f4a4-d96a-4f0b-8d33-ec4167c75522'::uuid,'94a098c9-8e26-4967-88ec-23d13296f283'::uuid,'9b02cc41-33b0-4124-bf5b-76472f6ac8a4'::uuid,'9f6af792-c4db-400b-982c-e5f301d40aa1'::uuid,'b0a4887b-4e7a-41e6-bf6b-d4809191421f'::uuid,'b7bbc16e-4faf-4c05-9a6c-f3c057ca95a5'::uuid,'dfaf5b32-776b-4711-b604-f145a8fd86a1'::uuid,'f2443143-f2eb-4e31-85a5-b04ec7236fb5'::uuid,'fe97bbb6-6117-4147-98e4-be28e9f78bda'::uuid];
  v_updated uuid[];
BEGIN
  IF array_length(v_ids, 1) <> 26 THEN
    RAISE EXCEPTION 'gh2310 guard: id list has % entries, expected 26', array_length(v_ids, 1);
  END IF;

  WITH upd AS (
    UPDATE public.profiles
       SET is_test = true
     WHERE id = ANY (v_ids)
       AND is_test = false
    RETURNING id
  )
  SELECT array_agg(id) INTO v_updated FROM upd;

  IF v_updated IS NULL
     OR array_length(v_updated, 1) <> 26
     OR EXISTS (SELECT 1 FROM unnest(v_updated) u WHERE u <> ALL (v_ids)) THEN
    RAISE EXCEPTION 'gh2310 guard tripped: updated % rows (expected exactly 26 from the id list)',
      coalesce(array_length(v_updated, 1), 0);
  END IF;
END
$$;

COMMIT;
