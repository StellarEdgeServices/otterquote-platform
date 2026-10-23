-- STATUS: DRAFT, NOT APPLIED. Tier 3 -- needs Dustin's approval to apply (migration-author protocol). Do NOT run from this directory;
-- promote to supabase/migrations/ under a 14-digit UTC version only after it is actually applied (supabase/migrations_drafts/README.md).
-- Rollback: supabase/migrations_rollbacks/gh3051_ga4_mp_conversion_triggers_rollback.sql
--
-- gh-3051: server-side GA4 Measurement Protocol for two homeowner conversions.
-- Ruling: #1940 DECIDED 6369440672 (CTO RUN 77). Evidence: 6369429483 (1 of 4 real non-test claims reached GA4 from the browser).
--
-- SCOPE (CTO ruling on PR #3054 review 6369750036): two events, not three.
--   leads  AFTER INSERT (source='router') -> router_contact_submitted
--   claims AFTER INSERT                   -> claim_started
-- sign_up is deliberately NOT sent server-side. A profiles INSERT fires for every new auth user, contractors included, and profiles.role is
-- not known at insert (see 20260914204825_gh1932_drop_unreliable_homeowner_signup_trigger.sql). A claim already marks a real homeowner
-- conversion, so no profiles trigger exists in this file. The browser's sign_up event is unchanged.
--
-- GO-LIVE WARNING: deploying the ga4-mp-conversion Edge Function AND applying this file starts PRODUCTION sends to GA4 immediately. The
-- function reads GA4_MP_API_SECRET, else falls back to GA4_API_SECRET, which is ALREADY in the Edge Function secret store (create-invoice,
-- create-docusign-envelope and docusign-webhook use it). Setting a secret is therefore NOT a gate. The gate is applying this migration:
-- until it is applied nothing calls the function. To stop sends: run the rollback (drops the triggers). To validate before go-live:
-- deploy the function, then POST {event_type, id, debug:true} with the service-role bearer for an is_test row -- that goes to
-- /debug/mp/collect only and records nothing.
--
-- Mechanism: copies the repo's existing trigger -> pg_net -> Edge Function wiring (gh-1932 trg_notify_admin_new_claim, gh-1994
-- trg_notify_admin_new_router_lead): SECURITY DEFINER plpgsql, service-role key from vault.decrypted_secrets('cron_service_role_key'),
-- jsonb body passed directly to net.http_post, every failure caught and RAISE LOGged so the user's INSERT can never fail because of it.
-- Difference from those: the body is {event_type, id} ONLY. No row content (no email / phone / name / address) crosses pg_net; the
-- ga4-mp-conversion Edge Function reads the row itself and builds a payload with no personal data.
--
-- is_test / is_synthetic rows are skipped here (cheap short-circuit) AND again in the Edge Function (authoritative: also covers synthetic
-- utm values and internal addresses). The Edge Function also skips rows whose created_at is older than 72 h, so a bulk insert, restore or
-- backfill cannot replay historic conversions. pg_net does not retry; the ga4_mp_sent marker table makes a manual or future retry a no-op.
--
-- Additive only: one new table, one new trigger function, two new AFTER INSERT triggers. Nothing existing is altered or dropped.

BEGIN;

DO $gate$
BEGIN
  IF to_regclass('public.leads') IS NULL OR to_regclass('public.claims') IS NULL THEN
    RAISE EXCEPTION 'gh3051 gate: leads / claims missing';
  END IF;
  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE EXCEPTION 'gh3051 gate: vault.decrypted_secrets missing';
  END IF;
END
$gate$;

-- 1. Idempotency marker: one row per (event, source row). The Edge Function INSERTs before sending; a unique violation = already sent.
CREATE TABLE IF NOT EXISTS public.ga4_mp_sent (
  event_name text        NOT NULL CHECK (event_name IN ('router_contact_submitted', 'claim_started')),
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
  ELSIF TG_TABLE_NAME = 'claims' THEN
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
  'gh-3051: AFTER INSERT on leads / claims. POSTs {event_type, id} (no row content) to the ga4-mp-conversion Edge Function via pg_net. SECURITY DEFINER. Non-fatal: errors are logged, never raised, so the insert always succeeds.';

-- 3. Lock the function down (gh-1529 default-privilege drift): a new SECURITY DEFINER function otherwise inherits EXECUTE for PUBLIC / anon /
-- authenticated. Triggers do not need EXECUTE granted to the inserting role, so nothing breaks. Asserted again below.
REVOKE EXECUTE ON FUNCTION public.notify_ga4_mp_conversion() FROM PUBLIC, anon, authenticated;

-- 4. Triggers.
DROP TRIGGER IF EXISTS trg_ga4_mp_lead ON public.leads;
CREATE TRIGGER trg_ga4_mp_lead AFTER INSERT ON public.leads
  FOR EACH ROW WHEN (NEW.source = 'router')
  EXECUTE FUNCTION public.notify_ga4_mp_conversion('router_contact_submitted');

DROP TRIGGER IF EXISTS trg_ga4_mp_claim ON public.claims;
CREATE TRIGGER trg_ga4_mp_claim AFTER INSERT ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_ga4_mp_conversion('claim_started');

DO $assert$
BEGIN
  IF has_function_privilege('anon', 'public.notify_ga4_mp_conversion()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.notify_ga4_mp_conversion()', 'EXECUTE') THEN
    RAISE EXCEPTION 'gh3051 assert: anon/authenticated can still EXECUTE notify_ga4_mp_conversion()';
  END IF;
END
$assert$;

COMMIT;
