-- gh-3374 (second bump) ROLLBACK: put the server-held agreement label back to 'v3-2026-11'.
-- Run manually only if the v4 forward change must be reverted. Never move into supabase/migrations/ (the CLI would replay it forward).
-- contractors.agreement_version values already stamped 'v4-2026-11' are NOT rewritten (each is a true record of what was current when that contractor accepted).
-- Refuses (55000) if the row holds anything other than 'v4-2026-11'; a re-run after success is a no-op.

DO $unbump$
DECLARE
  cur text;
BEGIN
  SELECT a.version_label INTO cur FROM public.agreement_version_current a WHERE a.singleton FOR UPDATE;
  IF cur IS NULL THEN
    RAISE EXCEPTION 'gh3374 v4 rollback: public.agreement_version_current has no row' USING ERRCODE = '55000';
  END IF;
  IF cur = 'v3-2026-11' THEN
    RAISE NOTICE 'gh3374 v4 rollback: already v3-2026-11, nothing to do';
    RETURN;
  END IF;
  IF cur <> 'v4-2026-11' THEN
    RAISE EXCEPTION 'gh3374 v4 rollback: expected v4-2026-11, found %', cur USING ERRCODE = '55000';
  END IF;
  UPDATE public.agreement_version_current SET version_label = 'v3-2026-11', set_at = now() WHERE singleton;
END
$unbump$;
