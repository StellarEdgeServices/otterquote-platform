-- gh-1994: new-lead admin alert for the front-door router. Dustin's GO
-- recorded verbatim on issue #1994 comment 5706456515 ("GO on the new-lead
-- alert email."), which is the R-097 waiver for this one change:
--   "It covers adding a router-lead event type to the admin-alert Edge
--    Function (notify-admin-new-homeowner or a sibling), plus a short
--    internal email to Dustin: name, email, phone, role, partner industry,
--    attribution source. The email goes to the admin only, never to a
--    visitor."
--   Scope limits (same comment): no customer-facing copy, no SMS, phone
--   numbers carry no consent (manual callback only).
--
-- Investigated and reported, not built, by the gh-1994 phase-2 dispatch
-- (issue comment 5704424267 / PR #2003 item 5): notify-admin-new-homeowner's
-- normalizeBody() is a closed union of exactly claim_created/signup_sweep/
-- signup_backfill and cannot carry a pre-signup router `leads` row without
-- either a 400 or a factually wrong "new claim" email -- confirmed again by
-- this file's own author reading
-- supabase/functions/notify-admin-new-homeowner/index.ts (main@8cd6e22683)
-- before drafting this migration. This file adds the fourth event type,
-- `router_lead`, alongside the matching Edge Function change (this PR's
-- sibling diff to index.ts / new notify-helpers.ts).
--
-- Additive only: one new nullable `leads` column, one new trigger function,
-- one new AFTER UPDATE trigger. No existing table, column, function or
-- trigger is altered or dropped.
--
-- Trigger mechanism mirrors the repo's own claim_created precedent exactly
-- (supabase/migrations/20260914195746_gh1932_notify_admin_new_homeowner_triggers.sql,
-- trg_notify_admin_new_claim / notify_admin_new_claim()): a SECURITY DEFINER
-- plpgsql trigger function resolves the service-role key from
-- vault.decrypted_secrets (name='cron_service_role_key' -- the same secret
-- that function, notify_admin_new_homeowner_signup(), and 10+ live cron jobs
-- already use) and calls net.http_post() with it as a Bearer token, passing
-- the jsonb body directly (not the ...::text::bytea cast that same file's
-- own header comment documents as broken on notify_admin_new_contractor).
-- pg_net failures are caught and RAISE LOGged, never raised -- a role
-- selection must never fail because the alert call failed. Chosen over
-- adding this call directly inside set_lead_role() (the other option this
-- dispatch named) for the same reason the repo already separates
-- claims-insert from notify_admin_new_claim(): set_lead_role() is a
-- SECURITY DEFINER RPC called directly by an anonymous client on the hot
-- path of the router's Step 2/2a click, and its own migration (fix round 3,
-- REVIEW 5702597120 B1) was already hardened once around exactly what that
-- function returns and how start.html branches on it -- adding a network
-- call and a second failure mode inside that function's body would be a
-- second, unrelated place that same review would need to reason about. A
-- trigger keeps the alert entirely out of the anon-facing RPC's control
-- flow and return value, exactly like claim_created never touches whatever
-- inserted the claims row.
--
-- WHEN clause fires on the actual role-set transition (OLD.role IS NULL AND
-- NEW.role IS NOT NULL) -- "after set_lead_role succeeds, so the email
-- carries role" (this dispatch's instruction) -- not on every leads UPDATE
-- (update_lead_contact's contact-info-only UPDATEs never touch role, so they
-- never fire this trigger).
--
-- Dedupe: "one email per lead" is enforced in the Edge Function via an
-- atomic `UPDATE leads SET alerted_at = now() WHERE id = $1 AND alerted_at
-- IS NULL RETURNING id` (see notify-admin-new-homeowner/index.ts's
-- handleRouterLead) -- only the caller whose UPDATE actually flips the
-- column from NULL sends the email, so a retried delivery or a second role
-- change on the same lead before prefill (set_lead_role's own 30-minute/
-- prefill_used_at guard allows more than one role write before the
-- destination page redeems the id) can fire this trigger more than once
-- without ever sending a second email. The trigger function ALSO checks
-- NEW.alerted_at IS NULL as a cheap short-circuit to skip the network call
-- entirely once a lead is already known-alerted -- belt-and-suspenders, not
-- the authoritative check (a race between two near-simultaneous role writes
-- could still pass this check twice; the Edge Function's atomic UPDATE is
-- what actually guarantees "one email").
--
-- is_test exclusion: `leads` has no is_test column (confirmed live,
-- 2026-09-16, restated in the phase-1 migration's own header: production
-- information_schema.columns for public.leads lists no such column). Per
-- this dispatch's own simplification, the exclusion is a single reserved
-- email suffix no real visitor's address can end in:
-- '@otterquote-internal.test' (case-insensitive) -- checked both here (to
-- skip the pg_net call entirely, mirroring notify_admin_new_homeowner_signup's
-- own belt-and-suspenders is_test/email check) and again, authoritatively,
-- in the Edge Function's isRouterLeadExcluded() (same constant, single
-- source: supabase/functions/notify-admin-new-homeowner/notify-helpers.ts).
--
-- Sweep for a lead that never picks a role: NOT built. This repo already has
-- a cron-driven sweep pattern (pg_cron job "gh1932-homeowner-signup-sweep",
-- supabase/migrations/20260914211825_gh1932_homeowner_signup_sweep_cron.sql
-- -- referenced by PR #2003 item 5's own investigation), so a "role never
-- set within 15 minutes" sweep is technically buildable the same way, but
-- Dustin's GO comment does not ask for one and this dispatch's own task
-- description says to add it "only if the repo has a cron pattern for it;
-- else note as follow-up" without deciding the alert copy/threshold for an
-- incomplete (no role, so no email/phone/role-appropriate destination)
-- lead -- left as a QUESTION/follow-up in this PR's evidence rather than
-- guessed at here.

BEGIN;

-- 1. Dedupe column --------------------------------------------------------
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS alerted_at timestamptz;

COMMENT ON COLUMN public.leads.alerted_at IS
  'gh-1994: stamped by notify-admin-new-homeowner (event_type=router_lead) the moment it sends the one-time new-lead admin alert for this row -- an atomic UPDATE ... WHERE alerted_at IS NULL is what actually enforces "one email per lead"; NULL means not yet alerted (or alert not yet attempted/failed).';

-- 2. Trigger function ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_admin_new_router_lead()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  v_service_key TEXT;
BEGIN
  -- Belt-and-suspenders short-circuit -- the Edge Function's atomic
  -- alerted_at UPDATE is the authoritative dedupe (see header comment).
  IF NEW.alerted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.email ILIKE '%@otterquote-internal.test' THEN
    RAISE LOG 'notify_admin_new_router_lead: skipping excluded test lead id=% email=%', NEW.id, NEW.email;
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
   WHERE name = 'cron_service_role_key';

  IF v_service_key IS NULL THEN
    RAISE LOG 'notify_admin_new_router_lead: vault secret cron_service_role_key not found -- skipping for id=%', NEW.id;
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-admin-new-homeowner',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := jsonb_build_object(
      'event_type', 'router_lead',
      'record',     to_jsonb(NEW)
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'notify_admin_new_router_lead: pg_net call failed for id=% sqlstate=% sqlerrm=%',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_admin_new_router_lead() IS
'gh-1994: fires via pg_net on leads UPDATE the moment role transitions from NULL to non-NULL (router Step 2/2a, via set_lead_role()). Calls notify-admin-new-homeowner (event_type=router_lead) to alert Dustin of a new router lead. SECURITY DEFINER. Non-fatal: errors are logged, not raised.';

-- 3. Trigger -----------------------------------------------------------
DROP TRIGGER IF EXISTS trg_notify_admin_new_router_lead ON public.leads;

CREATE TRIGGER trg_notify_admin_new_router_lead
  AFTER UPDATE ON public.leads
  FOR EACH ROW
  WHEN (OLD.role IS NULL AND NEW.role IS NOT NULL)
  EXECUTE FUNCTION public.notify_admin_new_router_lead();

COMMENT ON TRIGGER trg_notify_admin_new_router_lead ON public.leads IS
'gh-1994: fires after a leads row''s role transitions from NULL to non-NULL (set_lead_role success). Calls notify_admin_new_router_lead() to alert Dustin of a new router lead.';

COMMIT;

-- =============================================================================
-- ROLLBACK (gh-1994 router-lead alert) -- run as a single transaction to
-- revert this migration. Mirrors the inline-comment rollback convention
-- already used by 20260914195746_gh1932_notify_admin_new_homeowner_triggers.sql
-- and 20260916132127_gh1994_router_leads_columns.sql (this file was not
-- granted a separate supabase/migrations_rollbacks/ file either). Dropping
-- the trigger and function is sufficient to stop new alerts; alerted_at is
-- also dropped here for a fully clean revert, since nothing else in the
-- schema depends on it.
-- =============================================================================
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_notify_admin_new_router_lead ON public.leads;
-- DROP FUNCTION IF EXISTS public.notify_admin_new_router_lead();
-- ALTER TABLE public.leads DROP COLUMN IF EXISTS alerted_at;
-- COMMIT;
