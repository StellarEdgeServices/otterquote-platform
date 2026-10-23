-- STATUS: DRAFT, NOT APPLIED. Tier 3 -- needs Dustin's approval to apply (migration-author protocol). Do NOT run from this directory;
-- promote to supabase/migrations/ under a 14-digit UTC version only after it is actually applied (supabase/migrations_drafts/README.md).
-- Rollback: supabase/migrations_rollbacks/gh3051_ga4_mp_conversion_triggers_rollback.sql
--
-- gh-3051: server-side GA4 Measurement Protocol for the three homeowner conversions.
-- Ruling: #1940 DECIDED 6369440672 (CTO RUN 77). Evidence: 6369429483 (1 of 4 real non-test claims reached GA4 from the browser).
--
-- Mechanism: copies the repo's existing trigger -> pg_net -> Edge Function wiring (gh-1932 trg_notify_admin_new_claim, gh-1994
-- trg_notify_admin_new_router_lead): SECURITY DEFINER plpgsql, service-role key from vault.decrypted_secrets('cron_service_role_key'),
-- jsonb body passed directly to net.http_post, every failure caught and RAISE LOGged so the user's INSERT can never fail because of it.
-- Difference from those: the body is {event_type, id} ONLY. No row content (no email / phone / name / address) crosses pg_net; the
-- ga4-mp-conversion Edge Function reads the row itself and builds a payload with no personal data.
--
--   leads    AFTER INSERT (source='router')  -> router_contact_submitted
--   profiles AFTER INSERT                    -> sign_up        (fires for every new auth user; profiles.role is not known at insert,
--                                               see 20260914204825's header -- the Edge Function sends no role)
--   claims   AFTER INSERT                    -> claim_started
--
-- is_test / is_synthetic rows are skipped here (cheap short-circuit) AND again in the Edge Function (authoritative: also covers synthetic
-- utm values and internal addresses). pg_net does not retry; the ga4_mp_sent marker table makes a manual or future retry a no-op.
--
-- Additive only: one new table, one new trigger function, three new AFTER INSERT triggers. Nothing existing is altered or dropped.
-- Deploy order: (1) deploy the ga4-mp-conversion Edge Function, (2) set the GA4_MP_API_SECRET secret, (3) apply this file. With (3)
-- before (1) the pg_net calls 404 and are ignored; with (1) before (2) the function logs "not set" and sends nothing.

BEGIN;

DO $gate$
BEGIN
  IF to_regclass('public.leads') IS NULL OR to_regclass('public.profiles') IS NULL OR to_regclass('public.claims') IS NULL THEN
    RAISE EXCEPTION 'gh3051 gate: leads / profiles / claims missing';
  END IF;
  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE EXCEPTION 'gh3051 gate: vault.decrypted_secrets missing';
  END IF;
END
$gate$;

-- 1. Idempotency marker: one row per (event, source row). The Edge Function INSERTs before sending; a unique violation = already sent.
CREATE TABLE IF NOT EXISTS public.ga4_mp_sent (
  event_name text        NOT NULL CHECK (event_name IN ('router_contact_submitted', 'sign_up', 'claim_started')),
  row_id     uuid        NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_name, row_id)
);
-- Service-role only. RLS on with no policy denies anon / authenticated entirely; the explicit grant is gh-2145's rule for new tables.
ALTER TABLE public.ga4_mp_sent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ga4_mp_sent FROM anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.ga4_mp_sent TO service_role;
COMMENT ON TABLE public.ga4_mp_sent IS
  'gh-3051: idempotency marker for server-side GA4 Measurement Protocol sends (one per event + source row). Written only by the ga4-mp-conversion Edge Function (service role). Holds ids and a timestamp, no personal data.';

-- 2. One trigger function, event type passed as TG_ARGV[0].
CREATE OR REPLACE FUNCTION public.notify_ga4_mp_conversion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $$
DECLARE
  v_service_key TEXT;
  v_skip        BOOLEAN := FALSE;
BEGIN
  IF TG_TABLE_NAME = 'leads' THEN
    v_skip := (NEW.is_synthetic IS TRUE) OR NEW.source IS DISTINCT FROM 'router';
  ELSIF TG_TABLE_NAME = 'profiles' OR TG_TABLE_NAME = 'claims' THEN
    v_skip := (NEW.is_test IS TRUE);
  END IF;
  IF v_skip THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
   WHERE name = 'cron_service_role_key';

  IF v_service_key IS NULL THEN
    RAISE LOG 'notify_ga4_mp_conversion: vault secret cron_service_role_key not found -- skipping % for id=%', TG_ARGV[0], NEW.id;
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/ga4-mp-conversion',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := jsonb_build_object('event_type', TG_ARGV[0], 'id', NEW.id)
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_ga4_mp_conversion: pg_net call failed for % id=% sqlstate=% sqlerrm=%', TG_ARGV[0], NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_ga4_mp_conversion() IS
  'gh-3051: AFTER INSERT on leads / profiles / claims. POSTs {event_type, id} (no row content) to the ga4-mp-conversion Edge Function via pg_net. SECURITY DEFINER. Non-fatal: errors are logged, never raised, so the insert always succeeds.';

-- 3. Triggers.
DROP TRIGGER IF EXISTS trg_ga4_mp_lead ON public.leads;
CREATE TRIGGER trg_ga4_mp_lead AFTER INSERT ON public.leads
  FOR EACH ROW WHEN (NEW.source = 'router')
  EXECUTE FUNCTION public.notify_ga4_mp_conversion('router_contact_submitted');

DROP TRIGGER IF EXISTS trg_ga4_mp_signup ON public.profiles;
CREATE TRIGGER trg_ga4_mp_signup AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_ga4_mp_conversion('sign_up');

DROP TRIGGER IF EXISTS trg_ga4_mp_claim ON public.claims;
CREATE TRIGGER trg_ga4_mp_claim AFTER INSERT ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_ga4_mp_conversion('claim_started');

COMMIT;
