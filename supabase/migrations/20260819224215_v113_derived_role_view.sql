-- Migration: 20260819224215_v113_derived_role_view
-- Author: Claude Code (automated, run-work rw-909-f22-b4vw)
-- Date: 2026-08-19
-- D-numbers: D-182 (deploy tier 3), D-221 (path A deploy)
-- Rollback: 20260819224215_v113_derived_role_view_rollback.sql
-- Pre-flight: 20260819224215_v113_derived_role_view_pre-flight.md
--
-- gh-1307 (2026-08-27): filename backfilled with its actual applied
-- timestamp prefix (20260819224215, per supabase_migrations.schema_migrations)
-- -- the original filename lacked the YYYYMMDDHHMMSS_ prefix Supabase's
-- migration runner requires, so the CLI-driven runner never picked this file
-- up. The migration itself DID reach production, but only because it was
-- applied directly (matching schema_migrations exactly, re-verified
-- 2026-08-27: view definition + grants both match this file byte-for-byte).
-- See gh-1307 for the full incident and the CI check that now prevents this.
--
-- Summary: Adds a read-only, auth-scoped VIEW that derives a user's
-- functional role from fact tables (contractors, referral_agents, claims)
-- instead of the single-scalar profiles.role column. Purely additive —
-- no existing table, column, policy, or function is touched. Implements
-- gh-909 Option C (Dustin, CEO board 2026-08-17) per the scoping writeup
-- in gh-909 comment 5320260678, with the two build details APPROVED
-- verbatim in gh-909 comment 5346445233 (2026-08-19):
--   1. Build as a VIEW, not a SECURITY DEFINER RPC.
--   2. Owning a claim counts toward being a homeowner.
--
-- SECURITY MODEL (per gh-909 comment 5320260678's access-control risk):
-- the concern is not letting a caller enumerate other users' roles. This
-- view satisfies that two ways, deliberately redundant (belt-and-suspenders
-- rather than "pick one"):
--   (a) CREATE VIEW ... WITH (security_invoker = true) [PG15+ view option,
--       confirmed available -- this project runs PostgreSQL 17.6] means the
--       view executes with the CALLING role's own permissions, not the
--       view owner's. Every fact table it reads (contractors, referral_agents,
--       profiles, claims) has RLS ENABLED (verified live 2026-08-19) with a
--       same-row-only SELECT policy for the authenticated role (e.g.
--       "profiles_user_read": id = auth.uid()). So even a hand-rolled SELECT
--       against this view with someone else's id in a WHERE clause returns
--       nothing extra -- RLS on the underlying tables still applies.
--   (b) On top of (a), the view body itself hardcodes auth.uid() as the only
--       anchor -- it does not accept or join on a caller-supplied user id at
--       all, and its outer WHERE clause drops the row entirely when
--       auth.uid() IS NULL (unauthenticated / anon callers get zero rows,
--       matching getRole()'s existing "no user -> null" contract). So even
--       if a future edit to an underlying table's RLS policy were ever
--       loosened, this view still cannot be used to look up another user's
--       facts -- there is no code path in its definition that reads any
--       user id other than the caller's own auth.uid().
-- Grants: explicit REVOKE + GRANT below (same discipline as the Supabase
-- function-grant-default trap, applied here to a view instead of a
-- function -- default privileges on newly created public relations grant
-- broad access to anon/authenticated; confirmed live on this project's
-- other views, e.g. state_summary/org_summary/contribution_summary all
-- carry anon SELECT via default privileges). anon gets nothing; only
-- authenticated may SELECT, and RLS + auth.uid()-anchoring above scope
-- that further to the caller's own row.
--
-- PRECEDENCE (matches js/auth.js getRole()'s existing order, extended with
-- the claims fact per the 2026-08-19 approval -- see gh-909 comment
-- 5320260678 "Proposed migration phases" step 1: "keep it identical to
-- getRole()'s current order ... so this is a representation change, not a
-- behavior change"):
--   1. contractors row exists for this user_id            -> 'contractor'
--   2. active referral_agents row (status='active')        -> agent_type
--   3. owns >=1 claims row (claims.user_id = auth.uid())    -> 'homeowner'
--   4. profiles.role is not null                            -> profiles.role
--   5. default                                               -> 'homeowner'
--
-- Known, accepted limits (unchanged by this migration, documented in
-- Docs/profiles-role-single-scalar.md and gh-909 comment 5320260678):
--   - NULL-linkage partners (referral_agents.user_id IS NULL, registered via
--     register_partner but never claimed) remain invisible -- there is no
--     auth.uid() to join on until claim_partner_account runs. Live count as
--     of 2026-08-19 re-verification: 6 (was 5 on 2026-08-15 -- see pre-flight
--     doc for the premise-drift note).
--   - This view still returns a single precedence pick, not a set. A
--     dual-role user (contractor + active partner) still resolves to
--     'contractor' from this view alone. redirectToDashboard()/
--     requireAuth()'s existing surface-awareness logic (which page the user
--     is already on) is UNCHANGED by this migration and remains the
--     mechanism that disambiguates dual-role users for routing -- this
--     migration only relocates where getRole() gets its single-value FACT
--     from (profiles.role scalar -> this view), it does not touch precedence
--     or routing behavior. is_contractor / is_active_partner / owns_claim /
--     profile_role are exposed as separate columns precisely so a future
--     caller that DOES need the full fact set (rather than one precedence
--     pick) does not have to re-derive it from scratch.

BEGIN;

CREATE VIEW public.resolved_user_role
WITH (security_invoker = true)
AS
WITH me AS (
  SELECT auth.uid() AS user_id
),
facts AS (
  SELECT
    me.user_id,
    EXISTS (
      SELECT 1 FROM public.contractors c WHERE c.user_id = me.user_id
    ) AS is_contractor,
    (
      SELECT ra.agent_type
      FROM public.referral_agents ra
      WHERE ra.user_id = me.user_id AND ra.status = 'active'
      LIMIT 1
    ) AS active_partner_agent_type,
    EXISTS (
      SELECT 1 FROM public.claims cl WHERE cl.user_id = me.user_id
    ) AS owns_claim,
    (
      SELECT p.role FROM public.profiles p WHERE p.id = me.user_id
    ) AS profile_role
  FROM me
)
SELECT
  user_id,
  is_contractor,
  (active_partner_agent_type IS NOT NULL) AS is_active_partner,
  active_partner_agent_type AS partner_agent_type,
  owns_claim,
  profile_role,
  CASE
    WHEN is_contractor THEN 'contractor'
    WHEN active_partner_agent_type IS NOT NULL THEN active_partner_agent_type
    WHEN owns_claim THEN 'homeowner'
    WHEN profile_role IS NOT NULL THEN profile_role
    ELSE 'homeowner'
  END AS derived_role
FROM facts
WHERE user_id IS NOT NULL;

COMMENT ON VIEW public.resolved_user_role IS
  'gh-909 Option C (D-182 v113). Read-only, auth.uid()-scoped derived role '
  'view. SECURITY INVOKER + RLS on all four underlying tables + hardcoded '
  'auth.uid() anchoring means a caller can only ever see their own row. '
  'Precedence: contractors row -> active referral_agents.agent_type -> '
  'owns a claims row (homeowner) -> profiles.role -> ''homeowner'' default. '
  'profiles.role is fallback/signup-lane metadata only as of this migration, '
  'not authoritative. See Docs/profiles-role-single-scalar.md and gh-909.';

REVOKE ALL ON public.resolved_user_role FROM PUBLIC;
REVOKE ALL ON public.resolved_user_role FROM anon;
GRANT SELECT ON public.resolved_user_role TO authenticated;

COMMIT;
