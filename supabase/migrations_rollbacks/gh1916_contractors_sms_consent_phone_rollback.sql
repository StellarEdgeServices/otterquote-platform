-- STATUS (gh-1438, as of 2026-10-14T15:07:42Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh1916_contractors_sms_consent_phone (the STATUS is the set's; it describes the forward migration)
-- EVIDENCE: written by gh-1916 (D-383); forward is one ADD COLUMN, so the rollback is one DROP COLUMN
-- REPO COPY: none in supabase/migrations/ (this is a manual reference rollback)
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- ROLLBACK for supabase/migrations_drafts/gh1916_contractors_sms_consent_phone.sql
-- Manual reference only. Never rename into a 14-digit timestamp or move into supabase/migrations/.
-- Roll the Edge Functions and pages back FIRST (they select this column); dropping it first makes
-- notify-contractors, process-dunning and send-contractor-nudge error on their SELECTs.
-- Data lost: the stored consented numbers (re-derivable only from the contractor's own record at the time).

ALTER TABLE public.contractors DROP COLUMN IF EXISTS sms_consent_phone;
