-- gh-2154 P-4 SWITCH-ON hardening (Ben, bus 18:23:17Z, items (2) and (3)):
--
--   (2) uncertain rows must raise an admin alert (reused P-3
--       notify-admin-new-partner Mailgun/ADMIN_EMAIL pattern), not just a
--       console.error log. Dedupe so a still-'pending' uncertain row does
--       not re-alert every 15-minute cron tick forever: a new nullable
--       uncertain_alerted_at timestamp on the ledger row is set the first
--       time it is included in an alert, and run-sweep.ts only alerts on
--       rows where this is still NULL (see run-sweep.ts's alert-filtering
--       comment). It is reset to NULL whenever a row is legitimately
--       reclaimed (a fresh attempt starting clean), so a row that goes
--       'failed' -> retried -> pending-and-uncertain again in a LATER
--       attempt can alert again — this column tracks "already alerted for
--       THIS pending episode," not "ever alerted."
--
--   (3) retry cap on 'failed' sends: a 'failed' stage must not be retried
--       forever. Two additive nullable/defaulted columns:
--         - attempt_count integer NOT NULL DEFAULT 0 — the total number of
--           times claim_partner_onboarding_stage() has claimed this
--           (partner, stage) row (the very first claim already counts as
--           attempt 1). Incremented atomically inside the SAME conditional
--           upsert that performs the claim — see the CREATE OR REPLACE
--           below — so there is no separate read-then-write race.
--         - terminal_failure boolean NOT NULL DEFAULT false — set true by
--           the Edge Function (run-sweep.ts markFailed) when Mailgun
--           rejects the send with a permanent 4xx (any code except 429,
--           which is a rate limit and IS retried). Once true, the row is
--           NEVER reclaimable again, regardless of attempt_count.
--       claim_partner_onboarding_stage() is CREATE OR REPLACE'd (identical
--       signature: p_partner_id uuid, p_stage text, p_stale_minutes integer
--       DEFAULT 20 — unchanged, so no call site needs to change) to refuse
--       reclaiming a 'failed' row once attempt_count >= 5 OR
--       terminal_failure is true. This is layered on TOP of the existing
--       "only 'failed' is ever reclaimable, 'pending' never is, however
--       old" rule from the P-4 ledger migration (20260924210000) — that
--       rule is unchanged and re-asserted here, not loosened.
--
-- Additive only. No existing column, table, trigger, or constraint is
-- dropped. claim_partner_onboarding_stage()'s signature and SECURITY
-- DEFINER / search_path are preserved exactly; its REVOKEs are re-issued
-- (CREATE OR REPLACE does not itself revoke privileges, but this repo's
-- convention — gh-2154 P-2's record_partner_app_activation() precedent —
-- is to state them explicitly in every migration that touches the
-- function, so a reviewer never has to chase an earlier file to confirm
-- the grant posture).
--
-- Base migration this stacks on: 20260924210000_gh2154_p4_partner_onboarding_ledger.sql
-- (already applied to prod — see #2180's go-live steps). This migration
-- does not edit that file; it is a fresh, separate ALTER + CREATE OR
-- REPLACE, per the standing rule that an applied migration is never
-- rewritten in place.
--
-- APPLY-BEFORE-MERGE: this migration must be applied to prod, with a
-- read-back, BEFORE this PR merges (see the PR body's go-live order).
--
-- ROLLBACK: see
-- supabase/migrations_rollbacks/20260925183000_gh2154_p4_switchon_retry_cap_uncertain_alert_rollback.sql
-- -- restores claim_partner_onboarding_stage() to its pre-this-migration
-- body (byte-identical to 20260924210000's CREATE OR REPLACE) and drops the
-- three new columns. Safe: no other migration or function references
-- attempt_count, terminal_failure, or uncertain_alerted_at.

BEGIN;

ALTER TABLE public.partner_onboarding_sends
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.partner_onboarding_sends
  ADD COLUMN IF NOT EXISTS terminal_failure boolean NOT NULL DEFAULT false;

ALTER TABLE public.partner_onboarding_sends
  ADD COLUMN IF NOT EXISTS uncertain_alerted_at timestamp with time zone;

COMMENT ON COLUMN public.partner_onboarding_sends.attempt_count IS
'gh-2154 P-4 switch-on hardening: total number of times this (partner_id, stage) row has been claimed (the first claim is attempt 1). Incremented only inside claim_partner_onboarding_stage()''s conditional upsert. A ''failed'' row with attempt_count >= 5 is never reclaimed again.';

COMMENT ON COLUMN public.partner_onboarding_sends.terminal_failure IS
'gh-2154 P-4 switch-on hardening: set true by send-partner-onboarding when Mailgun rejects a send with a permanent 4xx (any code except 429). Once true, this row is never reclaimed by claim_partner_onboarding_stage(), regardless of attempt_count.';

COMMENT ON COLUMN public.partner_onboarding_sends.uncertain_alerted_at IS
'gh-2154 P-4 switch-on hardening: NULL until this row has been included in an admin uncertain-outcome alert email. Set once, by the Edge Function, right after sending that alert, so a still-pending uncertain row is not re-alerted on every 15-minute cron tick. Reset to NULL whenever the row is legitimately reclaimed (a fresh attempt), by claim_partner_onboarding_stage() below.';

-- Kevin, gh-2154 P-4 switch-on hardening round (Ben, bus 18:23:17Z item (3)):
-- CREATE OR REPLACE, identical signature to 20260924210000's version. Adds
-- the retry cap (attempt_count < 5 AND NOT terminal_failure) on top of the
-- existing "only 'failed' is reclaimable" rule -- the 'pending' branch that
-- rule removed stays removed; this migration only narrows the 'failed'
-- branch further, never widens anything.
CREATE OR REPLACE FUNCTION public.claim_partner_onboarding_stage(
  p_partner_id     uuid,
  p_stage          text,
  p_stale_minutes  integer DEFAULT 20
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows integer;
BEGIN
  INSERT INTO public.partner_onboarding_sends (partner_id, stage, status, created_at, attempt_count)
  VALUES (p_partner_id, p_stage, 'pending', now(), 1)
  ON CONFLICT (partner_id, stage) DO UPDATE
    SET status = 'pending',
        created_at = now(),
        error = NULL,
        mailgun_id = NULL,
        uncertain_alerted_at = NULL,
        attempt_count = partner_onboarding_sends.attempt_count + 1
    WHERE partner_onboarding_sends.status = 'failed'
      AND NOT partner_onboarding_sends.terminal_failure
      AND partner_onboarding_sends.attempt_count < 5;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$function$;

COMMENT ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) IS
'gh-2154 P-4 switch-on hardening: atomic claim for one (partner_id, stage), with a retry cap. A ''failed'' row is reclaimable only while attempt_count < 5 and terminal_failure is false; a ''pending'' row is never reclaimable, however old (unchanged from 20260924210000). A permanent 4xx Mailgun rejection sets terminal_failure=true immediately (see run-sweep.ts markFailed), ending retries before the count cap is even reached.';

REVOKE ALL ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) FROM authenticated;

COMMIT;
