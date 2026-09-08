-- gh-1529 [SECURITY, tier:3b] -- TABLE HALF.
--
-- The FUNCTION half of #1529 shipped as
-- 20260904140000_gh1529_revoke_anon_execute_orphaned_security_definer_fns.sql
-- (PR #1634, merged 2026-09-07T22:51:31Z, NOT YET APPLIED). This file is the
-- second conjunct of the same issue's `closes-on`, which had no migration at
-- all: "the grants join returns 0 RLS tables granting `anon` more than SELECT
-- without a matching anon policy". Closing #1529 on the function half alone
-- would be a two-conjunct criterion reduced to one.
--
-- WHAT THIS REVOKES
-- 51 (table, command) privilege pairs across 21 RLS-enabled tables in
-- `public`, where `anon` holds INSERT / UPDATE / DELETE and NO permissive
-- policy for that command names `anon` or `public`.
--
-- WHY IT CANNOT BREAK A LIVE PATH (structural, not a grep)
-- With RLS enabled and no permissive policy of the command naming `anon` or
-- `public`, PostgreSQL denies every `anon` write of that command REGARDLESS of
-- the table grant. The grant is therefore already inert: revoking it removes
-- surface, not capability. This is the table-half analogue of the function
-- half's `prorettype = trigger` argument -- a property of the engine, not of
-- grep coverage.
--
-- A policy whose `TO` clause is absent has `roles = {public}` and IS evaluated
-- for `anon`. Such policies are treated here as BACKING the grant and their
-- (table, command) pairs are NOT revoked. That is deliberately the
-- conservative reading -- the same reading that kept `contractor_can_bid` off
-- the function half's revoke list when its `quotes` INSERT policy came back
-- `roles={public}` rather than `{authenticated}`.
--
-- NOT TOUCHED, explicitly:
--   * `anon`'s SELECT on any table (21/21 unchanged in the proof below).
--   * `authenticated`'s grants (51/51 unchanged in the proof below) -- the 36
--     `authenticated_security_definer_function_executable` advisor rows remain
--     out of scope for #1529, as stated on the issue since filing.
--   * Any (table, command) pair backed by an `anon`- or `public`-role policy:
--     e.g. `leads` INSERT, `coming_soon_waitlist` INSERT, `contractors`
--     INSERT/UPDATE, `quotes` INSERT, `fee_acceptances` INSERT/UPDATE,
--     `home_profiles` INSERT/UPDATE, `members` INSERT.
--   * `extension_in_public` (pg_net) -- out of scope per the issue body.
--
-- COLUMN-LEVEL GRANTS: none exist. `select count(*) from pg_attribute a join
-- pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
-- where n.nspname='public' and a.attacl is not null` -> 0 (live, 2026-09-08).
-- So a table-level REVOKE is complete and the rollback's table-level GRANT is
-- exact, not approximate.
--
-- PROVEN AGAINST PRODUCTION (yeszghaspzwwstvsrioa) BEFORE THIS FILE EXISTED,
-- in one DO block whose only exit is RAISE EXCEPTION (forced full rollback).
-- Production's own reply, verbatim:
--
--   ERROR:  P0001: GH1529-TABLEHALF-PROOF (deliberate abort => full ROLLBACK):
--   pairs before=51 after-FORWARD=0 after-ROLLBACK=51 | anon SELECT on the 21
--   before=21 after=21 | authenticated same-pairs before=51 after=51 |
--   anon INSERT feature_requests (no policy) pre=42501 post=42501 |
--   anon INSERT leads (policy exists, NOT revoked) pre=SUCCESS post=SUCCESS
--
-- Read it as four controls in one line:
--   * forward removes exactly 51 and rollback restores exactly 51;
--   * `anon` SELECT and `authenticated` are untouched in both directions;
--   * the NEGATIVE control -- an `anon` INSERT on a revoked table -- was
--     ALREADY refused 42501 by RLS *before* the revoke and is still 42501
--     after, which is the whole safety argument, measured;
--   * the POSITIVE control -- an `anon` INSERT on `leads`, a real
--     pre-authentication path -- SUCCEEDS both before and after, proving the
--     revoke does not over-reach onto a live anon flow. A migration that broke
--     it would show `pos_post` as an SQLSTATE here.
--
-- Re-read outside the transaction at 2026-09-08 11:16:23.867751+00:
--   target_pairs_still_granted=51, target_tables=21,
--   proof rows persisted in feature_requests=0, in leads=0.  Nothing applied.
--
-- ⛔ NOT APPLIED BY THIS PR. `apply_migration` has not been called. Applying
-- this is a credential-surface mutation on a live database and belongs to a
-- claim-holder in daylight, per the standing #1529 rulings.

REVOKE DELETE, INSERT, UPDATE ON TABLE public.adjuster_email_requests FROM anon;
REVOKE DELETE, INSERT, UPDATE ON TABLE public.adjusters FROM anon;
REVOKE DELETE, INSERT, UPDATE ON TABLE public.carrier_profiles FROM anon;
REVOKE DELETE, UPDATE ON TABLE public.coming_soon_waitlist FROM anon;
REVOKE DELETE, UPDATE ON TABLE public.contractor_cert_verifications FROM anon;
REVOKE DELETE ON TABLE public.contractors FROM anon;
REVOKE DELETE, INSERT, UPDATE ON TABLE public.cpa_versions FROM anon;
REVOKE DELETE, INSERT, UPDATE ON TABLE public.cron_health FROM anon;
REVOKE DELETE, INSERT, UPDATE ON TABLE public.feature_requests FROM anon;
REVOKE DELETE ON TABLE public.fee_acceptances FROM anon;
REVOKE DELETE, INSERT, UPDATE ON TABLE public.funnel_abandonment_facts FROM anon;
REVOKE DELETE ON TABLE public.home_profiles FROM anon;
REVOKE DELETE, UPDATE ON TABLE public.leads FROM anon;
REVOKE DELETE, INSERT, UPDATE ON TABLE public.material_catalog FROM anon;
REVOKE DELETE, UPDATE ON TABLE public.members FROM anon;
REVOKE DELETE, INSERT ON TABLE public.payment_failures FROM anon;
REVOKE DELETE, INSERT, UPDATE ON TABLE public.platform_settings FROM anon;
REVOKE DELETE, UPDATE ON TABLE public.quotes FROM anon;
REVOKE DELETE, INSERT, UPDATE ON TABLE public.scope_records FROM anon;
REVOKE DELETE, INSERT, UPDATE ON TABLE public.warranty_manifest_drift FROM anon;
REVOKE DELETE, INSERT, UPDATE ON TABLE public.warranty_options FROM anon;
