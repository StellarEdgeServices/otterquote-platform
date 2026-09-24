-- Rollback for: 20260924015735_gh2107_ad_sharing_suppressions.sql
-- GitHub: #2107 (gh-2107 / D-330 half 2)
-- REFUSES while the table holds any row. A row is a person's recorded opt-out from advertising sharing (compliance evidence);
-- dropping the table would destroy it and silently resume sharing with those people. If this must run anyway, the operator
-- first exports the rows and removes them on purpose, in the open. Nothing else depends on the table until the follow-up writer
-- and CAPI check ship; roll those back first.

BEGIN;

DO $rb$
DECLARE
  n integer;
BEGIN
  IF to_regclass('public.ad_sharing_suppressions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.ad_sharing_suppressions' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'gh2107 suppression rollback refused: % row(s) hold a recorded advertising-sharing opt-out (compliance evidence). Export and remove them deliberately first.', n;
    END IF;
  END IF;
END
$rb$;

DROP TABLE IF EXISTS public.ad_sharing_suppressions;

COMMIT;
