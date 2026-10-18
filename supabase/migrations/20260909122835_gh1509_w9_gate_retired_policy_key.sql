-- gh-1509 (D-319): the client-readable `platform_settings` allowlist does
-- not include `w9_gate_retired`, so `partner-dashboard.html` and
-- `admin-referrals.html` -- which read the flag the same client-side way
-- they read `D204_HARD_FILTER` -- get RLS-filtered to 0 rows regardless of
-- the row's real value, resolving to `w9GateRetired = false` no matter
-- what the flag actually is. The three payout EFs (`approve-payout`,
-- `notify-partner-w9`, `process-payout-reminders`) are unaffected -- they
-- read via service-role clients, which bypass RLS entirely.
--
-- Filed by the CTO as a follow-up to half A (#1545) in comment 5514854954
-- (2026-09-02T19:05:01Z); R-097 24h risk brief posted 2026-09-03T18:40:26Z
-- (comment 5530428267); window closed 2026-09-04T18:40:06Z with no
-- objection; `tier:3b-approved` applied by CTO run cto-2026-09-04T18:26:08Z
-- (comment 5545246895); dispatched in comment 5545414037
-- (2026-09-04T19:20:45Z), which is explicit that this PR's scope is STEPS
-- 1-2 ONLY -- forward + rollback, proven in a rolled-back transaction,
-- NOT APPLIED. Flipping `w9_gate_retired = true` in `platform_settings`
-- and the production demonstration (partner dashboard + approve-payout on
-- an is_test fixture) are the CTO's own step, explicitly withheld from
-- this lane.
--
-- Live policy re-read immediately before authoring this file (prod,
-- yeszghaspzwwstvsrioa, read-only):
--   select policyname, cmd, roles, permissive, qual, with_check
--   from pg_policies where schemaname='public' and tablename='platform_settings';
-- returned exactly ONE policy, matching the repo's newest definition in
-- 20260825113728_gh1245_admin_measurements_rls.sql byte-for-byte -- no
-- drift between live and repo. See the companion pre-flight.md for the
-- full enumeration and the BEGIN...ROLLBACK proof transcript.
--
-- This migration is additive to the allowlist ARRAY only: the five
-- existing keys (D204_HARD_FILTER, hover_measurement_price,
-- platform_fee_percentage, skip_hover_in_test, measurement_products) are
-- preserved verbatim; 'w9_gate_retired' is appended. No key is removed,
-- no other policy on this table is touched (platform_settings carries
-- exactly this one RLS policy total -- confirmed live, see pre-flight.md).
-- Classed Tier 3B regardless of diff size per constitution entry 3 ("a
-- change is tiered by what its pipeline executes, not by its diff") --
-- this is a DROP POLICY + CREATE POLICY RLS rewrite.
--
-- Rollback: 20260904234257_gh1509_w9_gate_retired_policy_key_rollback.sql
-- Pre-flight: 20260904234257_gh1509_w9_gate_retired_policy_key_pre-flight.md
--
-- NOT APPLIED by this session. apply_migration was never called; every
-- statement below was proven only inside a BEGIN...ROLLBACK transaction
-- against production (transcript in pre-flight.md). Authored + PR opened
-- only. Steps 3-4 (flip the flag; production demonstration) are
-- @exec:cto's per the 2026-09-04T19:20:45Z dispatch.

DROP POLICY IF EXISTS "Authenticated can read public settings" ON public.platform_settings;

CREATE POLICY "Authenticated can read public settings" ON public.platform_settings
  FOR SELECT
  TO authenticated
  USING (key = ANY (ARRAY[
    'D204_HARD_FILTER'::text,
    'hover_measurement_price'::text,
    'platform_fee_percentage'::text,
    'skip_hover_in_test'::text,
    'measurement_products'::text,
    'w9_gate_retired'::text
  ]));
