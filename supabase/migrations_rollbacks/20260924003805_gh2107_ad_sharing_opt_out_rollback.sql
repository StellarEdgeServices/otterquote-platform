-- Rollback for: 20260924003805_gh2107_ad_sharing_opt_out.sql
-- GitHub: #2107 (gh-2107 / D-330 half 2)
-- REFUSES while any profile has a recorded opt-out. A recorded opt-out is compliance evidence (when and how a person
-- opted out of advertising sharing) and dropping the columns would destroy it and silently resume sharing for those
-- people. If this must run anyway, the operator first exports those rows and clears the flags on purpose, in the open.
-- Once no row holds a value, it drops the constraint and the three columns. Existing rows and every other column are
-- untouched. Nothing else in the database depends on the columns until the follow-up writers ship; roll those back first.

BEGIN;

DO $rb$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM public.profiles
   WHERE ad_sharing_opt_out IS NOT NULL
      OR ad_sharing_opt_out_at IS NOT NULL
      OR ad_sharing_opt_out_source IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'gh2107 rollback refused: % profile row(s) hold an ad-sharing opt-out record (compliance evidence). Export and clear them deliberately first.', n;
  END IF;
END
$rb$;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_ad_sharing_opt_out_source_check;
ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS ad_sharing_opt_out_source,
  DROP COLUMN IF EXISTS ad_sharing_opt_out_at,
  DROP COLUMN IF EXISTS ad_sharing_opt_out;

COMMIT;
