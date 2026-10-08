-- Rollback for gh2310_gap3_backfill_referrals_is_test (draft in supabase/migrations_drafts/).
-- Restores is_test=false ONLY for the 9 referrals ids measured as false on 2026-10-07 (a predicate-based rollback would also flip rows that were already true).
-- The forward change touches referrals only, so this fully reverts it. Never move into supabase/migrations/ (the CLI would replay it forward).
BEGIN;
UPDATE public.referrals SET is_test = false
 WHERE id IN ('97253d12-6691-4308-8bf0-754b29b5ece7'::uuid,'596b5ec3-b381-4261-b10d-ba438b401c8b'::uuid,'6ede692b-a7c0-43b1-b0cb-f318fb209c32'::uuid,'3c62b0f1-4b40-44c2-a394-ca77ebfdce69'::uuid,'a240bb83-2e38-4d64-aa76-44d675556b43'::uuid,'d843c6d4-35ba-46c4-adfa-a5909e267065'::uuid,'a034c167-8140-4a0f-af63-0acd84be338d'::uuid,'b206c41a-6b1e-4d6d-b21d-fe3ed6cd64f5'::uuid,'82d58235-2c70-423a-b682-afedd3d745c9'::uuid)
   AND is_test = true;
COMMIT;
