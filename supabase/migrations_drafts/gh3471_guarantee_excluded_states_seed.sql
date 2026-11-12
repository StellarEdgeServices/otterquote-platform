-- gh-3471 (#3427 D6): SEED of the excluded-state list for the covered-state check. DATA ONLY, separate from the schema draft gh3471_guarantee_covered.sql.
-- STATUS (gh-1438, as of 2026-11-12T20:17:22Z): APPLIED (ledger version 20261109170434, name gh3471_guarantee_excluded_states_seed; read-only ledger query, CTO RUN 104, #3324; the lines below are the pre-apply drafting record)
-- SOURCE: Dustin, 2026-11-09 10:33 ET, in Marty's chat (CTO RUN 100), verbatim, recorded on #3471 comment 6744041238:
--   "#3471: excluded states are FL, LA, TX, OK, AR, KS, NE, MI, KY (Dustin 11-09), stored as config."
--   (Also Ben, #3471 comment 6743820392: "Approve the 9", 2026-11-09 10:23 ET.)
-- THE LIST IS RECORDED EXACTLY AS GIVEN, in that order: FL, LA, TX, OK, AR, KS, NE, MI, KY. MI = Michigan, KY = Kentucky.
--   MI NOTE: the #3321 no-partner-fee list uses MS (Mississippi), not MI. Marty has asked Dustin to confirm MI. It is NOT changed here; if Dustin rules MS, it is a one-row
--   UPDATE of this platform_settings value (no deploy, no migration).
-- WHERE IT LIVES: platform_settings, key 'guarantee_excluded_states' (the list, a JSON array: the only thing create-measurement-order reads) and key
--   'guarantee_excluded_states_source' (provenance: Dustin's sentence verbatim and the date; read by nobody's code, kept beside the list for the audit trail,
--   since platform_settings has no reason/added_by columns).
-- ORDER: apply AFTER gh3471_guarantee_covered.sql (either order is safe: the function reads this row only for orders with a clock, and writes guarantee_covered only
--   if the column exists, retrying without it otherwise). Seeding turns coverage on: from the next order, a real paid order records true/false instead of NULL.
-- IDEMPOTENT: ON CONFLICT (key) DO NOTHING. If a row already exists with a DIFFERENT value it is left alone and a WARNING says so (a later ruling wins over this seed).
-- GUARD: refuses (raises, nothing committed) if public.platform_settings is missing.
-- Rollback: supabase/migrations_rollbacks/gh3471_guarantee_excluded_states_seed_rollback.sql (deletes exactly these two rows, only while they still hold the seeded values).
-- TRANSACTION: carries its own BEGIN ... COMMIT; run it ALONE (psql -v ON_ERROR_STOP=1 -f). Never wrap it.

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.platform_settings') IS NULL THEN
    RAISE EXCEPTION 'gh3471 seed refused: table public.platform_settings does not exist';
  END IF;
END
$guard$;

INSERT INTO public.platform_settings (key, value) VALUES
  ('guarantee_excluded_states', '["FL","LA","TX","OK","AR","KS","NE","MI","KY"]'::jsonb),
  ('guarantee_excluded_states_source', jsonb_build_object(
     'source', '#3471: excluded states are FL, LA, TX, OK, AR, KS, NE, MI, KY (Dustin 11-09), stored as config.',
     'decided_by', 'Dustin',
     'date', '2026-11-09',
     'recorded', 'StellarEdgeServices/otterquote-platform#3471 comment 6744041238',
     'note', 'MI recorded as given; #3321 uses MS; Marty asked Dustin to confirm MI'))
ON CONFLICT (key) DO NOTHING;

DO $check$
DECLARE v jsonb;
BEGIN
  SELECT value INTO v FROM public.platform_settings WHERE key = 'guarantee_excluded_states';
  IF v IS DISTINCT FROM '["FL","LA","TX","OK","AR","KS","NE","MI","KY"]'::jsonb THEN
    RAISE WARNING 'gh3471 seed: guarantee_excluded_states already held a different value and was left unchanged: %', v;
  END IF;
END
$check$;

COMMIT;
