-- gh-2121 (LRS HO-1 S21): next-step reminder email for a router lead that
-- has not yet reached a goal (a $15 measurement purchase or a loss-sheet
-- upload) one day after it was captured.
--
-- Scope, per Dustin's ruling (issue #2121, comment 5821760029, verbatim
-- "One next step reminder email is approved.") and the approved copy
-- (comment 5821796976, approved: comment 5824921642, "2. Approved."): ONE
-- email, sent the day after the lead, only if no goal event has been
-- recorded for that lead (the S16 write-back, PR #2163, is its stop
-- condition), only to leads with an email, on top of the human callback.
--
-- Tier: 3A (D-182) -- purely additive. Two new nullable columns on `leads`
-- (idempotency stamp + opt-out stamp), no backfill, no existing column
-- touched, no RLS/GRANT change on `leads` itself. One new row in the
-- existing `rate_limit_config` table (this repo's established per-function
-- kill-switch mechanism -- see supabase/functions/resend-hover-link/
-- index.ts's own "Global kill switch check" against this exact table),
-- inserted with enabled=false so the send path this migration enables
-- ships OFF by default; the sending Edge Function
-- (send-lead-next-step-reminder, added in this same PR, NOT part of this
-- migration) refuses to send anything while that row reads enabled=false.
--
-- WHY THE KILL SWITCH DEFAULTS OFF (stop-condition gap, stated plainly):
-- PR #2163 (merged) added leads.converted_user_id / set_lead_converted() /
-- public.lead_goal_events, but its own body's "Known follow-up not in this
-- PR" section says `?lead=` is still not captured at all on
-- `/help-measurements` or `/help-estimate` themselves -- the two pages this
-- email's own CTAs link to. Until that follow-up lands, a homeowner who
-- clicks either CTA in this email and completes a purchase/upload will NOT
-- have it linked back to the originating lead, so this email's own stop
-- condition (no goal recorded) cannot see a goal reached via its own CTA.
-- Sending on a broken stop condition risks repeat-nagging someone who did
-- act. This migration and its Edge Function are built and reviewable now;
-- turning `rate_limit_config.enabled` to true for this function name is a
-- separate, later decision once that capture gap is closed (or the risk is
-- otherwise accepted) -- not part of this PR's scope, and not something
-- this migration file does.
--
-- WHY TWO COLUMNS ON `leads` AND NOT `activity_log`:
-- `activity_log.user_id` is NOT NULL (see 20260101000000_v000_baseline_
-- schema.sql:113-120), and a pre-conversion lead has no user_id at all --
-- the exact reason `send-homeowner-next-steps`' own D-320 opt-out mechanism
-- (activity_log.metadata.claim_id, see optout-filter.ts's header comment)
-- cannot be reused here without inventing a fake user_id. Two columns
-- directly on `leads` need no such workaround and cost nothing per-row
-- until this feature ships (both NULL until this function runs, matching
-- the is_synthetic / prefill_used_at precedent already on this table).
--
-- Schema/policy re-verified LIVE (production yeszghaspzwwstvsrioa) before
-- drafting this file:
--   SELECT column_name FROM information_schema.columns WHERE
--     table_schema='public' AND table_name='leads';
--   -> confirms next_step_reminder_sent_at / next_step_reminder_opted_out_at
--      are not already present (no collision).
--   SELECT function_name, enabled FROM rate_limit_config WHERE
--     function_name = 'send-lead-next-step-reminder';
--   -> zero rows (first insert for this function name).
--
-- Statements below are safe to run more than once (repo convention:
-- `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`).
--
-- ROLLBACK: see
-- supabase/migrations_rollbacks/20260925020000_gh2121_lead_next_step_reminder_rollback.sql

BEGIN;

-- 1. Idempotency stamp -- "send at most once per lead". A direct UPDATE ...
--    WHERE next_step_reminder_sent_at IS NULL ... RETURNING (in the Edge
--    Function) makes the check-and-stamp atomic, the same pattern
--    get_lead_prefill() already uses on this table for prefill_used_at.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS next_step_reminder_sent_at timestamptz NULL DEFAULT NULL;

COMMENT ON COLUMN public.leads.next_step_reminder_sent_at IS
  'gh-2121 (LRS HO-1 S21): stamped once by send-lead-next-step-reminder the first (and only) time this lead is sent the next-step reminder email. NULL until sent. A second selection pass must never re-stamp or re-send a row where this is already set.';

-- 2. D-320-style opt-out stamp -- "Stop these updates" footer link, honored.
--    A dedicated column (not activity_log, see header comment) so an
--    unauthenticated recipient (this is a pre-signup lead, never signed in)
--    can flip it via a signed, single-purpose token with no session at all,
--    the same shape send-homeowner-next-steps/optout-token.ts already
--    established for claims.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS next_step_reminder_opted_out_at timestamptz NULL DEFAULT NULL;

COMMENT ON COLUMN public.leads.next_step_reminder_opted_out_at IS
  'gh-2121 (LRS HO-1 S21), D-320-style opt-out: stamped by the lead-next-step-optout Edge Function when this lead''s "Stop these updates" link is used. NULL means never opted out. A non-NULL value must suppress this lead from every future selection pass, permanently -- this migration adds no un-opt-out path, matching D-320''s own claims-side mechanism.';

-- 3. Kill switch -- this repo's existing per-function mechanism
--    (rate_limit_config.enabled, already read by resend-hover-link/index.ts
--    for its own "Global kill switch check"). Inserted OFF (enabled=false)
--    per the stop-condition gap explained above -- turning this on is a
--    separate decision, not part of this migration.
INSERT INTO public.rate_limit_config (function_name, enabled, notes)
VALUES (
  'send-lead-next-step-reminder',
  false,
  'gh-2121 (LRS HO-1 S21): kill switch for the lead next-step reminder email. Defaults OFF -- PR #2163''s own follow-up (?lead= capture on /help-measurements and /help-estimate) has not landed, so a goal reached via this email''s own CTAs is not yet linked back to the originating lead and the stop condition cannot see it. Do not flip to true without re-checking that gap first.'
)
ON CONFLICT (function_name) DO NOTHING;

COMMIT;
