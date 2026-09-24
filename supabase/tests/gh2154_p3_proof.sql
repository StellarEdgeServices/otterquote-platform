-- gh-2154 P-3 proof script.
--
-- Run the WHOLE file as one statement batch wrapped in BEGIN ... ROLLBACK
-- against production (yeszghaspzwwstvsrioa). NEVER COMMIT. NOT run in this
-- session (task order: "Do NOT run it against prod").
--
-- P-3 (new-partner alert to Dustin) has NOT been built yet at the time this
-- file is authored. Per Marty's sequence comment (issue #2154, comment
-- 5816579743, section (b) "P-3"), P-3 is a direct structural copy of
-- notify-admin-new-contractor's pg_net-trigger-on-INSERT pattern, pointed at
-- `referral_agents` instead of `contractors`, plus a migration adding that
-- trigger. Live confirmed this session (Supabase MCP, project
-- yeszghaspzwwstvsrioa, SELECT only):
--   * public.referral_agents has NO fbclid/li_fat_id/funnel_id columns yet
--     (P-2, PR #2159, is unmerged/unapplied as of this writing).
--   * public.contractors' own AFTER INSERT OR UPDATE OF status trigger is
--     `trg_notify_admin_new_contractor` -> notify_admin_new_contractor(),
--     confirmed via pg_get_triggerdef.
--   * public.notifications has no dedicated per-partner idempotency column
--     beyond the existing (user_id, notification_type, channel) shape the
--     contractor function already keys on.
--
-- This script therefore:
--   1. Inlines P-2's additive columns (idempotent, matches
--      supabase/tests/gh2154_p1_proof.sql's own convention of inlining P-2
--      so this file is runnable standalone against a database that has not
--      yet had P-2 applied).
--   2. Leaves a clearly marked placeholder for the P-3 migration itself
--      (the new pg_net trigger + trigger function on referral_agents),
--      to be inlined verbatim once P-3 is built, per this task's
--      instruction not to write non-test files.
--   3. Asserts, in an aborted transaction: a trigger exists on
--      public.referral_agents, fires AFTER INSERT (not AFTER UPDATE), and
--      its function body calls net.http_post against
--      '/functions/v1/notify-admin-new-partner'. An UPDATE on the same row
--      must not re-fire it.
--
-- Everything this script writes (test rows) is rolled back by the ROLLBACK
-- that must follow it -- no synthetic row may be left behind.

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

-- ── 2. P-3 migration goes here ──────────────────────────────────────────
-- TODO(P-3 build): inline migration here.
-- Expected shape (per Marty's spec + the notify_admin_new_contractor
-- precedent, supabase/migrations/20260817222018_gh752_move_notify_functions_to_vault.sql
-- section "1 of 2"): a SECURITY DEFINER plpgsql trigger function
-- (e.g. public.notify_admin_new_partner()) that:
--   * resolves the service-role key from vault.decrypted_secrets
--     (name='cron_service_role_key'), the same secret every other
--     notify_admin_* trigger function already uses;
--   * calls net.http_post(url => '<SUPABASE_URL>/functions/v1/notify-admin-new-partner',
--     body => jsonb_build_object('partner_id', NEW.id), headers => ...
--     with the resolved key as Bearer) -- passed as jsonb directly, NOT cast
--     to ::text::bytea (see gh-1932's migration header for why that cast is
--     a live, silently-swallowed bug in the contractor sibling -- P-3 must
--     not repeat it);
--   * is wrapped so pg_net failures are RAISE LOGged, never raised (an
--     alert failure must never fail a real partner signup);
-- and one trigger:
--   CREATE TRIGGER trg_notify_admin_new_partner
--     AFTER INSERT ON public.referral_agents
--     FOR EACH ROW EXECUTE FUNCTION public.notify_admin_new_partner();
-- (AFTER INSERT only -- unlike trg_notify_admin_new_contractor, which also
-- fires on UPDATE OF status because contractors alerts on entry into
-- pending_approval, a partner row has no equivalent status transition to
-- wait for; P-1's register_partner does the INSERT directly.)

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
