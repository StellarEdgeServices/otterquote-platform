-- gh-1337 rollback.sql — reverses gh1337_claims_referrer_updates_opt_out_forward.sql
--
-- STATUS: DRAFT ONLY, paired with a forward migration that has NOT been applied.
--
-- DATA LOSS WARNING: dropping this column destroys every homeowner consent
-- choice captured since the forward migration ran. That is a consent record,
-- not derived data — it cannot be reconstructed from anything else in the
-- schema. Before running this, export it:
--
--   SELECT id, referrer_updates_opt_out, created_at
--     FROM public.claims
--    WHERE referrer_updates_opt_out IS NOT NULL;
--
-- Behaviour after rollback: the consent gate in send-partner-status-email is
-- written to tolerate the column's absence — the claims lookup errors, the gate
-- logs a warning, falls back to referrals.metadata.referrer_updates_opt_out,
-- and, finding nothing, fails closed. Net effect: no third-party
-- claim-progress emails send at all. That is safe, not broken. Roll back the
-- Edge Function too if sends must resume.

BEGIN;

ALTER TABLE public.claims
  DROP COLUMN IF EXISTS referrer_updates_opt_out;

COMMIT;
