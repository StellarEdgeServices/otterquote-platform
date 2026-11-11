-- STATUS (gh-1438, as of 2026-10-31): NOT APPLIED
-- FILE ROLE: rollback file of set gh1916_contractor_sms_disclosure_v3_seed (rollback and pre-flight are siblings in this directory)
-- EVIDENCE: drafted 2026-10-31 under #1916 / #2875. No database was read or written to produce this file.
-- REPO COPY: none. When applied, file the rollback under supabase/migrations_rollbacks/ beside the forward's ledger version.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback of the disclosure seed. A disclosure version that any consent record already references MUST NOT be deleted (the record's
-- disclosure_version_id is a foreign key, and the row is TCPA evidence). So this RETIRES the row (the screen then offers nothing again) and
-- deletes it only when nothing references it. Replace the id below with the signed version tag that was applied.
BEGIN;
DO $rb$
DECLARE
  v_id text := 'contractor-v3-REPLACE-WITH-APPLIED-ID';
BEGIN
  IF v_id LIKE '%REPLACE%' THEN
    RAISE EXCEPTION 'gh1916 rollback: set v_id to the applied disclosure version id first';
  END IF;
  UPDATE public.sms_disclosure_versions SET retired_at = now() WHERE id = v_id AND retired_at IS NULL;
  DELETE FROM public.sms_disclosure_versions d
   WHERE d.id = v_id
     AND NOT EXISTS (SELECT 1 FROM public.contractor_sms_numbers n WHERE n.disclosure_version_id = d.id);
END
$rb$;
COMMIT;
