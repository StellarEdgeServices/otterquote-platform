-- v53-switch-reason-survey.sql
-- D-171: Homeowner switch-contractor self-serve UX layer
-- Adds switch_reason_survey JSONB to claims to persist the survey
-- payload submitted by the homeowner when requesting a contractor switch.
--
-- Schema: { reasons: string[], notes: string, submitted_at: timestamptz }
-- Populated by the switch-contractor Edge Function.
-- Applied: April 23, 2026 (Session ~358)

ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS switch_reason_survey JSONB;

COMMENT ON COLUMN claims.switch_reason_survey IS
  'D-171: Survey payload from homeowner switch request. '
  'Schema: { reasons: string[], notes: string, submitted_at: timestamptz }';
