-- v47: SMS consent timestamp columns
-- Adds sms_consent_ts to profiles (homeowners) and contractors.
-- Populated at signup when the user checks the TCPA consent checkbox.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS sms_consent_ts TIMESTAMPTZ;

ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS sms_consent_ts TIMESTAMPTZ;
