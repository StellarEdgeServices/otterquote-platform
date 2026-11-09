-- gh-3471 seed ROLLBACK. Run manually only if the seeded excluded-state list must be removed. Never move into supabase/migrations/.
-- Deletes EXACTLY the two rows gh3471_guarantee_excluded_states_seed.sql inserts, and only while they still hold the seeded values: a list changed by a later ruling
-- (e.g. MI -> MS) is NOT deleted by this file. Safe to run twice. Schema untouched.
-- Effect: the list becomes unset again, so new orders record guarantee_covered NULL (logged, no alert) until a list is set.
BEGIN;
DELETE FROM public.platform_settings
 WHERE (key = 'guarantee_excluded_states' AND value = '["FL","LA","TX","OK","AR","KS","NE","MI","KY"]'::jsonb)
    OR (key = 'guarantee_excluded_states_source' AND value->>'source' = '#3471: excluded states are FL, LA, TX, OK, AR, KS, NE, MI, KY (Dustin 11-09), stored as config.');
COMMIT;
