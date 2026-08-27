-- Migration: 20260827024432_v114_fix_bid_accepted_trigger_and_notify
-- Author: Claude Code (automated, migration-author-code v1.1)
-- Date: 2026-08-26
-- D-numbers: D-182 (deploy tier 3), D-221 (path A deploy), D-261 (ALTER-class change)
-- Rollback: 20260827024432_v114_fix_bid_accepted_trigger_and_notify_rollback.sql
-- Pre-flight: 20260827024432_v114_fix_bid_accepted_trigger_and_notify_pre-flight.md
--
-- gh-1307 (2026-08-27): filename backfilled with its actual applied
-- timestamp prefix (20260827024432, per supabase_migrations.schema_migrations)
-- -- the original filename lacked the YYYYMMDDHHMMSS_ prefix Supabase's
-- migration runner requires, so PR #1297 merging this file did NOT deploy
-- it (contra the PR body's "merging IS the deploy" claim). It was applied
-- directly afterward; re-verified 2026-08-27 that pg_get_functiondef matches
-- this file byte-for-byte. See gh-1307 for the full incident and the CI
-- check that now prevents this.
--
-- Summary (gh-1293): log_bid_accepted() checked NEW.status = 'awarded', a
-- value quotes_status_check has never permitted and that no code path ever
-- writes to quotes (bids.html / contractor-about.html write 'selected').
-- The trigger's condition was therefore always false: activity_log holds
-- 665 bid_submitted rows and zero bid_accepted rows, ever.
--
-- Fix: fire the SAME logging on the value the app actually writes
-- ('selected') instead of widening quotes_status_check to add 'awarded'.
-- This is smaller and lower-risk than an ALTER TABLE ... CHECK change and
-- needs no front-end write-path change (bids.html / contractor-about.html
-- keep writing 'selected' as they do today).
--
-- Also adds the contractor notification that never existed for this event
-- anywhere in the codebase (issue acceptance criteria 2/3/5) -- this is why
-- contractor-signs-first ordering could never be satisfied in practice: the
-- contractor was never told they'd been selected.
--
-- Also tightens this pre-existing trigger function's EXECUTE grant, which
-- defaulted to PUBLIC/anon/authenticated (D-182 danger pattern 9 / v95a
-- lesson) despite being invoked only by the trigger engine, never by RPC.

BEGIN;

CREATE OR REPLACE FUNCTION public.log_bid_accepted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- gh-1293: was NEW.status = 'awarded'; the app writes 'selected'.
  IF NEW.status = 'selected' AND (OLD.status IS NULL OR OLD.status IS DISTINCT FROM 'selected') THEN
    INSERT INTO activity_log (user_id, event_type, title, metadata, is_test)
    SELECT ct.user_id,
           'bid_accepted',
           'Your bid was accepted for ' || COALESCE(c.property_address, 'a project'),
           jsonb_build_object('claim_id', NEW.claim_id, 'quote_id', NEW.id, 'amount', NEW.total_price),
           COALESCE(NEW.is_test, false)
    FROM claims c
    JOIN contractors ct ON ct.id = NEW.contractor_id
    WHERE c.id = NEW.claim_id;

    -- gh-1293 acceptance criteria 2/3/5: no mechanism anywhere notified the
    -- contractor that their bid was accepted.
    INSERT INTO notifications (user_id, claim_id, notification_type, channel, recipient, message_preview)
    SELECT ct.user_id,
           NEW.claim_id,
           'bid_accepted',
           'dashboard',
           '',
           'Your bid was accepted for ' || COALESCE(c.property_address, 'a project') ||
             '. Sign the contract in your dashboard to get started.'
    FROM claims c
    JOIN contractors ct ON ct.id = NEW.contractor_id
    WHERE c.id = NEW.claim_id;
  END IF;
  RETURN NEW;
END;
$function$;

-- gh-1293 / D-182 danger pattern 9: pre-existing default grants this
-- trigger-only function never needed (confirmed via proacl before this
-- migration: PUBLIC, anon, authenticated, service_role, postgres all had
-- EXECUTE). Postgres invokes trigger functions via the executor regardless
-- of the calling role's EXECUTE grant, so revoking these does not affect
-- the trigger firing -- verified on a Supabase branch before filing this
-- migration (see pre-flight.md).
REVOKE ALL ON FUNCTION public.log_bid_accepted() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_bid_accepted() FROM anon;
REVOKE ALL ON FUNCTION public.log_bid_accepted() FROM authenticated;

COMMIT;
