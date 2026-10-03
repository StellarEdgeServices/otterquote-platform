-- Rollback for 20260930130000_gh2310_gap2_backfill_referral_agents_is_test.
-- Restores is_test=false ONLY for the 9 referral_agents ids measured as false on 2026-09-29
-- (a predicate-based rollback would also flip rows that were already true). Carlos McGuire (503f015b) is not in the list.
-- The forward migration is referral_agents-only, so this fully reverts it.
BEGIN;
-- gh-886 guard trigger: claim service_role for this transaction only (see forward migration).
SELECT set_config('request.jwt.claim.role', 'service_role', true);
UPDATE public.referral_agents SET is_test = false
 WHERE id IN ('1927861f-8836-49ce-a528-08c432cc69cc'::uuid,'0a934e11-5cac-4607-a63c-7446fe446f81'::uuid,'bdfe2bbf-bbc6-42b9-9213-02b36ebb46fa'::uuid,'f05146f5-f397-4e68-9720-e4394e9c7bd4'::uuid,'9320942a-90c0-4517-b5b7-919f8b2652b8'::uuid,'1280cf58-d89d-4311-b016-c1ff06f29477'::uuid,'0db676cc-0c3f-4c9b-bd25-65952572d6df'::uuid,'5f9ea879-255d-499c-879d-806a9f84eb04'::uuid,'1a61675f-b972-4dd4-a483-d5aa0d9757dc'::uuid);
COMMIT;
