-- gh-2154 P-4: partner onboarding sequence idempotency ledger.
--
-- Parent: #2154 (D-333 shared partner foundation), Marty's build-sequence
-- comment 5816579743, item P-4. Stacked on P-1 (7a887e65), P-2 (already
-- applied to prod: referral_agents.app_first_signed_in_launch_at confirmed
-- live), and P-3 (committed, not yet applied to prod at authoring time).
--
-- WHY A NEW TABLE, NOT activity_log: send-homeowner-next-steps' idempotency
-- ledger is activity_log, keyed by (user_id, event_type, metadata->>
-- 'claim_id', metadata->>'stage') because every homeowner claim already has
-- a user_id and activity_log rows are how that function's own screen reads
-- "real activity since signup". referral_agents partners are a different
-- entity (no claim_id, and user_id can be NULL at signup time depending on
-- the recruit-code-linked flow) and this sequence has no analogous "real
-- activity" screen to piggyback on -- overloading activity_log here would
-- buy nothing and cost a NULL-user_id edge case activity_log's own readers
-- do not expect. A dedicated table, unique on (partner_id, stage), is the
-- same GENERAL mechanism (a claim, an outcome, catch 23505 where relevant)
-- applied to its own purpose-built shape.
--
-- KEVIN CORRECTION ROUND (overrules this file's original Q3 framing):
--
--   Q3 -- stamp-before-send was a defect, not a trade-off (same defect
--   gh-2069 fixed in send-homeowner-next-steps: "stops claiming 'sent'
--   before it has sent"). The ledger now has FOUR states instead of two --
--   'pending' (claimed, in flight), 'sent' (Mailgun accepted -- terminal),
--   'failed' (Mailgun rejected or the send threw -- NOT terminal, retried
--   by a later run), 'skipped' (superseded by backlog -- terminal, RUN 22
--   lesson, unchanged). claim_partner_onboarding_stage() below is the
--   atomic, DB-level conditional upsert that can only move a row into
--   'pending' if no 'sent'/'skipped' row exists and no 'pending' claim
--   younger than STALE_PENDING_MINUTES (20; see onboarding-stage.ts) is
--   already there -- this is what actually prevents two overlapping runs
--   from both emailing the same partner the same stage; the send/mark
--   steps are what the Edge Function calls before/after Mailgun, in
--   ./send-partner-onboarding/run-sweep.ts.
--
--   Q1 -- add the D-320-style unsubscribe now, off the same mechanism
--   the homeowner nudge uses (signed per-recipient token, verified by a
--   dedicated unauthenticated endpoint -- see
--   supabase/functions/partner-email-optout/index.ts). Unlike D-320's
--   activity_log-based read (claims have no general JSONB bag, so D-320
--   reuses activity_log's own event rows), referral_agents already HAS a
--   precedent nullable boolean-shaped timestamp for a permanent partner-
--   level gate: app_first_signed_in_launch_at (P-2). onboarding_opted_out_at
--   below is the same shape -- NULL until set, then permanent, read
--   straight off the candidate row (no second table, no second query) --
--   and selectStage in onboarding-stage.ts treats it exactly like
--   activation: checked first, stops everything, no further ledger writes.
--   THIS IS FLAGGED FOR LEGAL-READ AT REVIEW (Kevin's instruction) -- see
--   the build report.
--
-- FAIL-CLOSED (P-2 lesson, Ben's column-lock ruling on that migration):
-- every column here that gates behavior is NOT NULL with a CHECK, so a NULL
-- can never silently pass a guard -- stage and status are both constrained
-- enums, partner_id is NOT NULL and FK'd to referral_agents(id).
-- onboarding_opted_out_at is nullable BY DESIGN (NULL = not opted out; this
-- is the gate value itself, same shape as app_first_signed_in_launch_at),
-- and selectStage's guard treats it correctly: only a NON-NULL value stops
-- anything, so a NULL (including from an unreadable/absent value) fails
-- toward "keep sending on schedule," which is the pre-opt-out default, not
-- toward "silently suppress everyone" -- the same non-fail-open shape
-- app_first_signed_in_launch_at already established.
--
-- Additive only. No existing table, column, function, trigger, or
-- constraint is altered or dropped.
--
-- ROLLBACK: see
-- supabase/migrations_rollbacks/20260924210000_gh2154_p4_partner_onboarding_ledger_rollback.sql
-- -- drops the claim function, the table (and its indexes/constraints with
-- it), and the referral_agents column. Safe: nothing else references either
-- yet (the Edge Function that will is deployed separately, and ships with
-- its own kill switch OFF by default).

BEGIN;

CREATE TABLE IF NOT EXISTS public.partner_onboarding_sends (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES public.referral_agents(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('day0', 'day1', 'day3', 'day7')),
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  skipped_reason text,
  error text,
  mailgun_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  -- The idempotency guarantee itself: at most one ledger row per
  -- (partner, stage), ever. claim_partner_onboarding_stage() below is the
  -- only writer that creates or reclaims this row; markSent/markFailed/
  -- markSkipped (called from run-sweep.ts) only ever UPDATE a row this
  -- function already claimed, or INSERT a fresh 'skipped' row for backlog
  -- (which the same unique constraint protects against a concurrent
  -- double-write, caught as 23505 by the caller).
  CONSTRAINT partner_onboarding_sends_partner_stage_uniq UNIQUE (partner_id, stage)
);

CREATE INDEX IF NOT EXISTS partner_onboarding_sends_partner_id_idx
  ON public.partner_onboarding_sends (partner_id);

COMMENT ON TABLE public.partner_onboarding_sends IS
'gh-2154 P-4: idempotency ledger for send-partner-onboarding — at most one row per (partner_id, stage). status: pending (claimed, in flight) / sent (terminal) / failed (retried by a later run) / skipped (terminal, superseded by backlog per the CTO RUN 22 lesson).';

-- Kevin correction Q3: the atomic claim. Mirrors canClaimStage() in
-- onboarding-stage.ts EXACTLY (see that function's own comment for why a
-- pure JS mirror of this WHERE clause exists) -- a claim succeeds if no row
-- exists yet, OR the existing row is 'failed', OR the existing row is
-- 'pending' and older than p_stale_minutes. 'sent' and 'skipped' rows are
-- never reclaimable. Returns true iff THIS call's claim won.
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
    WHERE partner_onboarding_sends.status = 'failed'
       OR (
         partner_onboarding_sends.status = 'pending'
         AND partner_onboarding_sends.created_at < now() - make_interval(mins => p_stale_minutes)
       );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$function$;

COMMENT ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) IS
'gh-2154 P-4 (Kevin correction Q3): atomic claim for one (partner_id, stage) — the DB-level enforcement of at-most-one-sender. Called by send-partner-onboarding BEFORE Mailgun, never after.';

-- Only the service-role Edge Function calls this — no client ever should.
-- Same default-privilege posture as gh-2154 P-2's record_partner_app_
-- activation() (service_role keeps its schema-level default EXECUTE;
-- explicit REVOKEs only, so CI's permissions-ratchet has nothing new GRANT
-- line to flag).
REVOKE ALL ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_partner_onboarding_stage(uuid, text, integer) FROM authenticated;

-- Kevin correction Q1: permanent partner-level opt-out gate, same shape as
-- P-2's app_first_signed_in_launch_at (nullable timestamptz, NULL = not yet,
-- set once, permanent). Written only by partner-email-optout's service-role
-- client (see that function's index.ts) — no RLS policy exposes writes to
-- anon/authenticated, matching this table's own no-policy default below and
-- referral_agents' existing RLS-enabled posture.
ALTER TABLE public.referral_agents
  ADD COLUMN IF NOT EXISTS onboarding_opted_out_at timestamp with time zone;

COMMENT ON COLUMN public.referral_agents.onboarding_opted_out_at IS
'gh-2154 P-4 (Kevin correction Q1, LEGAL-READ flagged at review): NULL until the partner clicks the D-320-mirrored unsubscribe link in an onboarding email; once set, send-partner-onboarding sends nothing further to this partner, permanently.';

-- No explicit GRANT: this table is written only by the Edge Function's
-- service-role client, never by anon/authenticated directly, and this
-- project's schema-level default privileges do not extend table DML grants
-- the way they extend function EXECUTE (confirmed by the gh-846/gh-2154 P-2
-- precedent migrations, which only ever note the function-EXECUTE default;
-- no prior migration in this repo grants table INSERT/SELECT to anon/
-- authenticated on a brand-new table without an explicit GRANT line).
--
-- RLS: enabled with ZERO policies, matching public.notifications and
-- public.referral_agents (both confirmed live via this repo's baseline
-- schema dump, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` with no
-- accompanying CREATE POLICY for anon/authenticated on the equivalent
-- write path) -- RLS-enabled-no-policy is deny-all for anon/authenticated
-- and does not affect service_role, which bypasses RLS entirely. Fail
-- closed by construction: a future PR that wants any client-facing access
-- to this table must add an explicit policy, not rely on an omission.
ALTER TABLE public.partner_onboarding_sends ENABLE ROW LEVEL SECURITY;

COMMIT;
