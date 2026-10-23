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
-- ADVERTISING-SHARING OPT-OUT (D-323 + D-336; PR #3054 LEGAL-READ: FAIL 6371271800, ruling 6371298079). GA4 is linked to Google
-- Ads with Personalized Advertising (D-323), so this send is a "share" under privacy.html Section 12, and D-336's opt-out (the stored
-- ad_sharing_opt_out flag, Global Privacy Control, Sec-GPC: 1) gates it exactly as js/ga-gate.js gates GA4 in the browser. This
-- file therefore also:
--   * adds a nullable ad_sharing_opt_out column to leads and claims (TRUE = opted out, FALSE = the page reported no opt-out,
--     NULL = not reported / unknown);
--   * records it AT INSERT with a BEFORE INSERT trigger, from the insert request's headers as PostgREST exposes them in
--     request.headers: `sec-gpc: 1` (the browser's own GPC header) or `x-oq-ad-optout: 1` (the page saw the oq_ad_optout cookie or
--     navigator.globalPrivacyControl) -> TRUE; `x-oq-ad-optout: 0` and no GPC -> FALSE; anything else -> NULL. The cookie itself is
--     Domain=.otterquote.com and never reaches the Supabase host, which is why the page carries it as a header (same pattern and
--     same reason as gh-2068's x-oq-internal; the hosted gateway's CORS preflight reflects x-oq-ad-optout, checked 2026-10-23);
--   * skips the pg_net call unless the column is exactly FALSE (cheap short-circuit). The Edge Function re-checks the column plus
--     profiles.ad_sharing_opt_out and the ad_sharing_suppressions list, and sends only when every signal is a definite "no".
-- NULL is NOT sent: a row from an old cached page, another insert path, or before this trigger existed has an unknown opt-out, and
-- an unknown opt-out is not shared (D-336 precedent in stripe-webhook; ga-gate.js).
--
-- Additive only: one new table, two new nullable columns, two new trigger functions, two BEFORE and two AFTER INSERT triggers.
-- Nothing existing is altered or dropped.

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

-- 1b. D-336 opt-out state recorded at insert (see header). Nullable, no default: catalog-only ADD COLUMN.
ALTER TABLE public.leads  ADD COLUMN IF NOT EXISTS ad_sharing_opt_out boolean;
ALTER TABLE public.claims ADD COLUMN IF NOT EXISTS ad_sharing_opt_out boolean;
COMMENT ON COLUMN public.leads.ad_sharing_opt_out IS
  'gh-3051 / D-336: advertising-sharing opt-out (privacy.html Section 12) as reported by the inserting request. TRUE = Sec-GPC: 1 or X-OQ-Ad-Optout: 1 (oq_ad_optout cookie or GPC); FALSE = X-OQ-Ad-Optout: 0 and no GPC; NULL = not reported (unknown). Set only by record_ad_sharing_opt_out_at_insert(). The server-side GA4 send goes out only when FALSE.';
COMMENT ON COLUMN public.claims.ad_sharing_opt_out IS
  'gh-3051 / D-336: advertising-sharing opt-out (privacy.html Section 12) as reported by the inserting request. TRUE = Sec-GPC: 1 or X-OQ-Ad-Optout: 1 (oq_ad_optout cookie or GPC); FALSE = X-OQ-Ad-Optout: 0 and no GPC; NULL = not reported (unknown). Set only by record_ad_sharing_opt_out_at_insert(). The server-side GA4 send goes out only when FALSE (and profiles.ad_sharing_opt_out is not TRUE).';

CREATE OR REPLACE FUNCTION public.record_ad_sharing_opt_out_at_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_headers jsonb;
  v_gpc     text;
  v_page    text;
BEGIN
  -- Own BEGIN/EXCEPTION, like every request.headers read in this codebase (gh-2068): a missing or malformed GUC never fails the
  -- insert; it leaves the state unknown (NULL), which is not sent.
  BEGIN
    v_headers := COALESCE(NULLIF(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;
  IF v_headers IS NULL THEN
    -- Never CLEAR an opt-out the row already carries; otherwise unknown.
    NEW.ad_sharing_opt_out := CASE WHEN NEW.ad_sharing_opt_out IS TRUE THEN TRUE ELSE NULL END;
    RETURN NEW;
  END IF;
  v_gpc  := btrim(COALESCE(v_headers->>'sec-gpc', ''));
  v_page := btrim(COALESCE(v_headers->>'x-oq-ad-optout', ''));
  IF NEW.ad_sharing_opt_out IS TRUE
     OR v_gpc = '1'
     OR v_page = '1'
     OR COALESCE(v_headers->>'cookie', '') ~ '(^|; )oq_ad_optout=1(;|$)' THEN
    NEW.ad_sharing_opt_out := TRUE;
  ELSIF v_page = '0' THEN
    NEW.ad_sharing_opt_out := FALSE;
  ELSE
    NEW.ad_sharing_opt_out := NULL;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.record_ad_sharing_opt_out_at_insert() IS
  'gh-3051 / D-336: BEFORE INSERT on leads / claims. Records the inserting request''s advertising-sharing opt-out (Sec-GPC: 1, X-OQ-Ad-Optout, oq_ad_optout cookie) in NEW.ad_sharing_opt_out: TRUE / FALSE / NULL (unknown). Never clears a TRUE; never fails the insert.';
REVOKE EXECUTE ON FUNCTION public.record_ad_sharing_opt_out_at_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ad_sharing_opt_out_lead ON public.leads;
CREATE TRIGGER trg_ad_sharing_opt_out_lead BEFORE INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.record_ad_sharing_opt_out_at_insert();
DROP TRIGGER IF EXISTS trg_ad_sharing_opt_out_claim ON public.claims;
CREATE TRIGGER trg_ad_sharing_opt_out_claim BEFORE INSERT ON public.claims
  FOR EACH ROW EXECUTE FUNCTION public.record_ad_sharing_opt_out_at_insert();

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
  -- D-336 short-circuit: only a definite FALSE (the page reported no opt-out and there was no GPC) reaches the Edge Function.
  IF NEW.ad_sharing_opt_out IS DISTINCT FROM FALSE THEN
    v_skip := TRUE;
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
