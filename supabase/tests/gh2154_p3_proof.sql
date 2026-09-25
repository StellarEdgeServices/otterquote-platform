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
-- UPDATED at P-3 review round 3 (REVIEW FAIL 5833567534, must-fix 1 + c,
-- should-fix 4): the go-live order is column-migration (20260925131429)
-- FIRST, then the trigger migration -- the trigger migration now RAISEs an
-- EXCEPTION if the column is missing, so this script applies 131429 before
-- inlining the trigger migration, matching the corrected real-world order
-- in PR #2170's Deploy order section and sql/schema-pending.json. Also
-- inlines 131429's RLS policy tightening (should-fix 2) and asserts the
-- dedupe path (referral_agent_id set on the synthetic insert) end to end.
--
-- This script:
--   1. Inlines P-2's additive columns (idempotent ADD COLUMN IF NOT
--      EXISTS -- a no-op against current prod, kept for standalone
--      runnability against a database that predates P-2).
--   2. Inlines 131429's migration (notifications.referral_agent_id column,
--      partial unique index, RLS policy tightening) verbatim.
--   3. Inlines P-3's trigger migration verbatim (its own column-exists
--      guard now passes, because step 2 ran first in this same
--      transaction).
--   4. Asserts, in an aborted transaction: the column, its partial unique
--      index and its FK exist; the two notifications RLS policies' WITH
--      CHECK include "referral_agent_id IS NULL"; a trigger exists on
--      public.referral_agents, fires AFTER INSERT (not AFTER UPDATE), and
--      its function body calls net.http_post against
--      '/functions/v1/notify-admin-new-partner'.
--   5. Inserts one synthetic is_test=true partner row, then inserts a
--      matching notifications row with referral_agent_id set (the shape
--      the Edge Function's own INSERT after a real send would use) to
--      prove the column, FK and index all accept the real dedupe write,
--      and updates the partner row, exercising the trigger's INSERT path
--      (and confirming an UPDATE does not have a matching trigger to
--      fire).
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

-- ── 2. 131429 migration inlined verbatim (MUST run before the trigger
--      migration -- see the corrected go-live order above) ───────────────
-- Byte-identical in effect (comment header trimmed for brevity here; full
-- rationale lives in the migration file itself) to
-- supabase/migrations/20260925131429_gh2154_p3_notifications_referral_agent_id.sql.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS referral_agent_id UUID
    REFERENCES public.referral_agents(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS public.notifications_partner_alert_dedupe_idx;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_partner_alert_dedupe_idx
  ON public.notifications (referral_agent_id)
  WHERE referral_agent_id IS NOT NULL
    AND notification_type = 'admin_new_partner_alert';

ALTER POLICY "Authenticated can insert notifications" ON public.notifications
  WITH CHECK (user_id = (select auth.uid()) AND referral_agent_id IS NULL);

ALTER POLICY "Users can update own notifications" ON public.notifications
  WITH CHECK (user_id = (select auth.uid()) AND referral_agent_id IS NULL);

-- ── 3. P-3 trigger migration inlined verbatim ────────────────────────────
-- Byte-identical (comment header trimmed for brevity here; full rationale
-- lives in the migration file itself) to
-- supabase/migrations/20260924200316_gh2154_p3_partner_new_alert_trigger.sql.
-- Its own column-exists guard (must-fix 1, REVIEW FAIL 5833567534) runs
-- here too and passes, because step 2 above already ran in this same
-- transaction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'notifications'
       AND column_name  = 'referral_agent_id'
  ) THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: referral_agent_id guard did not see the column added in step 2.';
  END IF;
END $$;

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

-- ── 4. Assertions (aborted transaction — nothing survives the ROLLBACK) ─

DO $$
DECLARE
  v_col_exists   boolean;
  v_fk_exists    boolean;
  v_idx_def      text;
  v_insert_check text;
  v_update_check text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'notifications'
       AND column_name = 'referral_agent_id' AND is_nullable = 'YES'
  ) INTO v_col_exists;
  IF NOT v_col_exists THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: notifications.referral_agent_id (nullable) not found after step 2.';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
     WHERE tc.table_schema = 'public' AND tc.table_name = 'notifications'
       AND tc.constraint_type = 'FOREIGN KEY' AND kcu.column_name = 'referral_agent_id'
  ) INTO v_fk_exists;
  IF NOT v_fk_exists THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: no FK on notifications.referral_agent_id.';
  END IF;

  SELECT indexdef INTO v_idx_def
    FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'notifications_partner_alert_dedupe_idx';
  IF v_idx_def IS NULL THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: notifications_partner_alert_dedupe_idx not found.';
  END IF;
  IF v_idx_def NOT ILIKE '%UNIQUE%' OR v_idx_def NOT ILIKE '%admin_new_partner_alert%' THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: dedupe index is not a unique index partial on notification_type=admin_new_partner_alert. Definition: %', v_idx_def;
  END IF;

  SELECT pg_get_expr(pol.polwithcheck, pol.polrelid) INTO v_insert_check
    FROM pg_policy pol
   WHERE pol.polrelid = 'public.notifications'::regclass
     AND pol.polname = 'Authenticated can insert notifications';
  IF v_insert_check NOT ILIKE '%referral_agent_id IS NULL%' THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: insert policy WITH CHECK does not require referral_agent_id IS NULL. Definition: %', v_insert_check;
  END IF;

  SELECT pg_get_expr(pol.polwithcheck, pol.polrelid) INTO v_update_check
    FROM pg_policy pol
   WHERE pol.polrelid = 'public.notifications'::regclass
     AND pol.polname = 'Users can update own notifications';
  IF v_update_check NOT ILIKE '%referral_agent_id IS NULL%' THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: update policy WITH CHECK does not require referral_agent_id IS NULL. Definition: %', v_update_check;
  END IF;

  RAISE NOTICE 'gh2154_p3_proof: notifications.referral_agent_id column + FK + partial unique index + RLS WITH CHECK tightening all present. PASS.';
END $$;

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

-- ── 5. Behavioural check: an UPDATE does not fire the alert, and the ────
--      dedupe write path (what the Edge Function's own INSERT does after a
--      real send) round-trips through the column/FK/index/RLS added above.
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
  v_partner_id      uuid;
  v_notification_id uuid;
  v_row_count       int;
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

  -- Mirrors the INSERT the Edge Function makes after a successful send
  -- (notify-admin-new-partner/index.ts): channel='email',
  -- notification_type='admin_new_partner_alert', referral_agent_id set.
  -- This is the "one synthetic is_test insert producing a row" the go-live
  -- read-back requires -- proves the column, FK and partial unique index
  -- all accept the real write shape, not just that they exist.
  INSERT INTO public.notifications (
    user_id, channel, notification_type, referral_agent_id, recipient, message_preview
  ) VALUES (
    NULL, 'email', 'admin_new_partner_alert', v_partner_id,
    'dustinstohler1@gmail.com', '[TEST] New Partner Signup — GH2154P3 ProofSynthetic'
  )
  RETURNING id INTO v_notification_id;

  SELECT count(*) INTO v_row_count
    FROM public.notifications
   WHERE referral_agent_id = v_partner_id
     AND notification_type = 'admin_new_partner_alert';

  IF v_notification_id IS NULL OR v_row_count <> 1 THEN
    RAISE EXCEPTION 'gh2154_p3_proof FAILED: synthetic admin_new_partner_alert notification row was not produced for partner %.', v_partner_id;
  END IF;

  -- No assertion possible for the trigger's own net.http_post call beyond
  -- "the UPDATE succeeded and the INSERT-only trigger definition (section
  -- 4) makes an UPDATE-triggered re-alert structurally impossible" -- see
  -- comment above. This block exists so the synthetic row's full lifecycle
  -- (partner insert + update, notification insert) is exercised in the
  -- same aborted transaction P-3's build will run this proof against.
  RAISE NOTICE 'gh2154_p3_proof: synthetic partner % inserted and updated, synthetic notification % (referral_agent_id set) produced 1 row, all inside the aborted transaction; nothing survives the ROLLBACK. PASS.', v_partner_id, v_notification_id;
END $$;

ROLLBACK;
