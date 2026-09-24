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
-- same GENERAL mechanism (stamp, unique index, catch 23505 as "already
-- sent") applied to its own purpose-built shape.
--
-- FAIL-CLOSED (P-2 lesson, Ben's column-lock ruling on that migration):
-- every column here that gates behavior is NOT NULL with a CHECK, so a NULL
-- can never silently pass a guard -- stage and status are both constrained
-- enums, partner_id is NOT NULL and FK'd to referral_agents(id).
--
-- Additive only. No existing table, column, function, trigger, or
-- constraint is altered or dropped.
--
-- ROLLBACK: see
-- supabase/migrations_rollbacks/20260924210000_gh2154_p4_partner_onboarding_ledger_rollback.sql
-- -- drops the table (and its indexes/constraints with it). Safe: nothing
-- else references this table yet (the Edge Function that will is deployed
-- separately, and ships with its own kill switch OFF by default).

BEGIN;

CREATE TABLE IF NOT EXISTS public.partner_onboarding_sends (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES public.referral_agents(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('day0', 'day1', 'day3', 'day7')),
  status text NOT NULL CHECK (status IN ('sent', 'skipped')),
  skipped_reason text,
  mailgun_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  -- The idempotency guarantee itself: at most one ledger row per
  -- (partner, stage), ever -- a losing concurrent insert hits this and is
  -- caught as 23505 by send-partner-onboarding's runOnboardingSweep.
  CONSTRAINT partner_onboarding_sends_partner_stage_uniq UNIQUE (partner_id, stage)
);

CREATE INDEX IF NOT EXISTS partner_onboarding_sends_partner_id_idx
  ON public.partner_onboarding_sends (partner_id);

COMMENT ON TABLE public.partner_onboarding_sends IS
'gh-2154 P-4: idempotency ledger for send-partner-onboarding — at most one row per (partner_id, stage), status sent or skipped (skipped = superseded by a later due stage on a backlog run, per the CTO RUN 22 lesson).';

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
