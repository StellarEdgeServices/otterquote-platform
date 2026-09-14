-- v115: gh-1916 / R-134 — real contractor SMS opt-in (Tier 3A additive column).
-- NULL = never asked (the default for every existing row) = no send.
-- The send-side gate lives in code (notify-contractors, process-dunning);
-- this migration only adds the columns those gates and the signup write
-- path read/write. No backfill, no NOT NULL, no default other than NULL.
-- Applied live via mcp__Supabase__apply_migration on 2026-09-14 (project
-- yeszghaspzwwstvsrioa) before this PR was opened; this file makes that
-- change reviewable and keeps the repo's migration history in sync.

ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS sms_opt_in boolean DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sms_opt_in_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS sms_opt_in_source text DEFAULT NULL;

COMMENT ON COLUMN public.contractors.sms_opt_in IS
  'gh-1916/R-134: real TCPA express-consent SMS opt-in, distinct from the legacy sms_consent_ts field. NULL = never asked (no send, pre-migration default for every existing row). TRUE = checked the consent checkbox at contractor-join.html signup. FALSE is reserved for a future explicit decline/STOP path (none exists yet — see sms_opt_in_source). Read by supabase/functions/notify-contractors and supabase/functions/process-dunning before any Twilio send to a contractor number; send-sms itself is recipient-agnostic and cannot gate on this.';
COMMENT ON COLUMN public.contractors.sms_opt_in_at IS
  'gh-1916/R-134: timestamp the consent checkbox was checked at signup. NULL whenever sms_opt_in is not true.';
COMMENT ON COLUMN public.contractors.sms_opt_in_source IS
  'gh-1916/R-134: free-text provenance of the opt-in, e.g. contractor-signup. NULL whenever sms_opt_in is not true.';
