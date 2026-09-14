-- v115 rollback: gh-1916 / R-134 — remove contractor SMS opt-in columns.
-- WARNING: rolling this back while notify-contractors/process-dunning still
-- reference sms_opt_in in their deployed code will make those SELECT
-- queries error (column does not exist). Redeploy those two Edge Functions
-- to their pre-gh-1916 versions FIRST, then run this rollback.

ALTER TABLE public.contractors
  DROP COLUMN IF EXISTS sms_opt_in,
  DROP COLUMN IF EXISTS sms_opt_in_at,
  DROP COLUMN IF EXISTS sms_opt_in_source;
