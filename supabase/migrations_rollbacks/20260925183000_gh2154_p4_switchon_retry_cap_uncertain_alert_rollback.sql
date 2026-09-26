-- ============================================================================
-- gh-2154 P-4 SWITCH-ON hardening ROLLBACK: restore
-- claim_partner_onboarding_stage() to its pre-this-migration body
-- (byte-identical to 20260924210000_gh2154_p4_partner_onboarding_ledger.sql)
-- and drop the three new columns (attempt_count, terminal_failure,
-- uncertain_alerted_at).
-- ============================================================================
-- Safe: no other migration or function references any of the three
-- columns. send-partner-onboarding ships its own kill switch OFF and this
-- rollback does not touch the ledger table's rows, only its shape and the
-- claim function's body.

BEGIN;

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
  INSERT INTO public.partner_onboarding_sends (partner_id, stage, status, created_at)
  VALUES (p_partner_id, p_stage, 'pending', now())
  ON CONFLICT (partner_id, stage) DO UPDATE
    SET status = 'pending', created_at = now(), error = NULL, mailgun_id = NULL
    WHERE partner_onboarding_sends.status = 'failed';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$function$;

COMMENT ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) IS
'gh-2154 P-4 (Kevin correction Q3, REOPENED): atomic claim for one (partner_id, stage) — the DB-level enforcement of at-most-one-sender. Called by send-partner-onboarding BEFORE Mailgun, never after. A pending row is never reclaimable, however old — only a failed row is retried automatically; a stale pending row is surfaced (uncertain), never auto-retried.';

REVOKE ALL ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) FROM authenticated;

ALTER TABLE public.partner_onboarding_sends
  DROP COLUMN IF EXISTS attempt_count;

ALTER TABLE public.partner_onboarding_sends
  DROP COLUMN IF EXISTS terminal_failure;

ALTER TABLE public.partner_onboarding_sends
  DROP COLUMN IF EXISTS uncertain_alerted_at;

COMMIT;
