-- gh-3374 ROLLBACK: put the server-held agreement label back to 'v2-2026-10'.
-- Run manually only if the gh-3374 forward change must be reverted. Never move into supabase/migrations/ (the CLI would replay it forward).
-- contractors.agreement_version values already stamped 'v3-2026-11' are NOT rewritten (each is a true record of what was current when that contractor accepted).
-- Refuses (55000) if the row holds anything other than 'v3-2026-11'; a re-run after success is a no-op.

DO $unbump$
DECLARE
  cur text;
BEGIN
  SELECT a.version_label INTO cur FROM public.agreement_version_current a WHERE a.singleton FOR UPDATE;
  IF cur IS NULL THEN
    RAISE EXCEPTION 'gh3374 rollback: public.agreement_version_current has no row' USING ERRCODE = '55000';
  END IF;
  IF cur = 'v2-2026-10' THEN
    RAISE NOTICE 'gh3374 rollback: already v2-2026-10, nothing to do';
    RETURN;
  END IF;
  IF cur <> 'v3-2026-11' THEN
    RAISE EXCEPTION 'gh3374 rollback: expected v3-2026-11, found %', cur USING ERRCODE = '55000';
  END IF;
  UPDATE public.agreement_version_current SET version_label = 'v2-2026-10', set_at = now() WHERE singleton;
END
$unbump$;
