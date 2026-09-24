-- gh-2154 P-3 proof script.
--
-- Run the WHOLE file as one statement batch wrapped in BEGIN ... ROLLBACK
-- against production (yeszghaspzwwstvsrioa). NEVER COMMIT.
--
-- UPDATED at P-3 build time (session rw-f35-20260924T155307-pkau): P-2 is
-- now live on prod (referral_agents.fbclid/li_fat_id/funnel_id/
-- app_first_signed_in_launch_at confirmed present via information_schema
-- this session), and P-3's migration
-- (supabase/migrations/20260924200316_gh2154_p3_partner_new_alert_trigger.sql)
-- is inlined verbatim below (section 2), replacing the earlier
-- placeholder. Also confirmed this session: public.notifications.
-- notification_type has NO CHECK constraint (pg_constraint, contype='c',
-- zero rows), so no constraint change was needed for the new
-- 'admin_new_partner_alert' value.
--
-- pg_net safety, verified before running: net.http_request_queue is an
-- ordinary heap table (pg_class.relkind='r', confirmed live this session)
-- in the same database, so an INSERT into it made by net.http_post() inside
-- this BEGIN...ROLLBACK is undone by the ROLLBACK like any other write --
-- pg_net's background worker only ever sees committed rows, so no real
-- HTTP request (and therefore no real email to Dustin) can result from
-- running section 4's INSERT below inside this transaction.
--
-- This script:
--   1. Inlines P-2's additive columns (idempotent ADD COLUMN IF NOT
--      EXISTS -- a no-op against current prod, kept for standalone
--      runnability against a database that predates P-2).
--   2. Inlines P-3's migration verbatim.
--   3. Asserts, in an aborted transaction: a trigger exists on
--      public.referral_agents, fires AFTER INSERT (not AFTER UPDATE), and
--      its function body calls net.http_post against
--      '/functions/v1/notify-admin-new-partner'.
--   4. Inserts one synthetic is_test=true partner row and updates it,
--      exercising the trigger's INSERT path (and confirming an UPDATE
--      does not have a matching trigger to fire).
--
-- Everything this script writes (test rows, the pg_net queue row) is rolled
-- back by the ROLLBACK that must follow it -- no synthetic row, and no real
-- outbound HTTP request, survives.

BEGIN;

-- ── 1. Apply P-2's migration inline (idempotent ADD COLUMN) ────────────
-- Mirrors supabase/tests/gh2154_p1_proof.sql section 1 and PR #2159's own
-- forward migration. Only the columns this proof reads are needed here;
-- P-2's register_partner/activation-RPC changes are out of scope for a
-- P-3-focused proof.
ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS fbclid text,
  ADD COLUMN IF NOT EXISTS li_fat_id text,
  ADD COLUMN IF NOT EXISTS funnel_id text,
  ADD COLUMN IF NOT EXISTS app_first_signed_in_launch_at timestamptz;

-- ── 2. P-3 migration inlined verbatim ────────────────────────────────────
-- Byte-identical (comment header trimmed for brevity here; full rationale
-- lives in the migration file itself) to
-- supabase/migrations/20260924200316_gh2154_p3_partner_new_alert_trigger.sql.
CREATE OR REPLACE FUNCTION public.notify_admin_new_partner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'net'
AS $function$
DECLARE
  v_service_key TEXT;
BEGIN
  SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
   WHERE name = 'cron_service_role_key';

  IF v_service_key IS NULL THEN
    RAISE LOG 'notify_admin_new_partner: vault secret cron_service_role_key not found — skipping for id=%', NEW.id;
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-admin-new-partner',
    body    := jsonb_build_object('partner_id', NEW.id),
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_admin_new_partner: pg_net call failed for id=% sqlstate=% sqlerrm=%',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_notify_admin_new_partner ON public.referral_agents;

CREATE TRIGGER trg_notify_admin_new_partner
  AFTER INSERT ON public.referral_agents
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_admin_new_partner();

-- ── 3. Assertions (aborted transaction — nothing survives the ROLLBACK) ─

DO $$
DECLARE
  v_triggerdef text;
  v_funcname   text;
  v_funcdef    text;
BEGIN
  SELECT pg_get_triggerdef(t.oid), p.proname
    INTO v_triggerdef, v_funcname
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  WHERE t.tgrelid = 'public.referral_agents'::regclass
    AND NOT t.tgisinternal
    AND pg_get_triggerdef(t.oid) ILIKE '%notify_admin_new_partner%';

  IF v_triggerdef IS NULL THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: no trigger on public.referral_agents calling a notify_admin_new_partner-named function. (Expected once P-3''s migration is inlined above; today this correctly fails because P-3 is not built yet.)';
  END IF;

  -- Must be AFTER INSERT, and must NOT include UPDATE (an UPDATE on an
  -- existing partner row must not re-fire the new-partner alert).
  IF v_triggerdef NOT ILIKE '%AFTER INSERT%' THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: trigger is not AFTER INSERT. Definition: %', v_triggerdef;
  END IF;
  IF v_triggerdef ILIKE '%UPDATE%' THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: trigger also fires on UPDATE (it must be INSERT-only, unlike trg_notify_admin_new_contractor). Definition: %', v_triggerdef;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_funcdef
  FROM pg_proc p
  WHERE p.proname = v_funcname
    AND p.pronamespace = 'public'::regnamespace;

  IF v_funcdef IS NULL OR v_funcdef NOT ILIKE '%net.http_post%' THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: trigger function % does not call net.http_post.', v_funcname;
  END IF;

  IF v_funcdef NOT ILIKE '%/functions/v1/notify-admin-new-partner%' THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: trigger function % does not target /functions/v1/notify-admin-new-partner. Definition: %', v_funcname, v_funcdef;
  END IF;

  RAISE NOTICE 'gh2154_p3_proof: trigger % on referral_agents (AFTER INSERT only) calls % which posts to notify-admin-new-partner. PASS.', v_funcname, v_funcname;
END $$;

-- ── 4. Behavioural check: an UPDATE does not fire the alert ─────────────
-- Insert a synthetic partner row (is_test=true so it can never be mistaken
-- for a real signup even if this script were ever mis-run against prod
-- outside its intended aborted transaction), then UPDATE it, and confirm
-- no second net.http_post-triggering event occurred. Because pg_net calls
-- are async (queued, not synchronously observable inside a single
-- transaction) and this script never COMMITs, the direct, reliable check
-- available here is structural (section 3's trigger-definition assertion:
-- INSERT-only, no UPDATE event) rather than a runtime call count. This
-- mirrors gh2154_p1_proof.sql and gh2154_p2_proof.sql's own limitation on
-- proving pg_net side effects inside a rolled-back transaction.
DO $$
DECLARE
  v_partner_id uuid;
BEGIN
  INSERT INTO public.referral_agents (
    agent_type, first_name, last_name, email, is_test, funnel_id, fbclid
  ) VALUES (
    're_agent', 'GH2154P3', 'ProofSynthetic', 'gh2154-p3-proof-synthetic@example.invalid',
    true, 're-1', 'proof-fbclid-value'
  )
  RETURNING id INTO v_partner_id;

  UPDATE public.referral_agents
     SET company = 'Updated Co'
   WHERE id = v_partner_id;

  -- No assertion possible here beyond "the UPDATE succeeded and the
  -- INSERT-only trigger definition (section 3) makes an UPDATE-triggered
  -- re-alert structurally impossible" -- see comment above. This block
  -- exists so the synthetic row's full lifecycle (insert + update) is
  -- exercised in the same aborted transaction P-3's build will run this
  -- proof against.
  RAISE NOTICE 'gh2154_p3_proof: synthetic partner % inserted and updated inside the aborted transaction; no row survives the ROLLBACK.', v_partner_id;
END $$;

ROLLBACK;
