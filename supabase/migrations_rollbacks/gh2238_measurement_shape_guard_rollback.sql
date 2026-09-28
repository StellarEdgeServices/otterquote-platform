-- gh2238_measurement_shape_guard_rollback.sql
-- Rollback for: 20260927133100_gh2238_measurement_shape_guard.sql
-- GitHub: #2238
--
-- Drops the guard trigger and function only -- nothing else on public.claims
-- was touched by the forward migration (no grants revoked, no RLS policies
-- changed, no columns added). Restoring this REOPENS the hole gh-2238 exists
-- to close: a homeowner's own JWT can again PATCH their claim's
-- measurement_shape to 'full' via PostgREST and block every contractor's
-- upgrade purchase on that claim (ALREADY_DETAILED) via the #1411 D-317
-- payment-intent gate. Only run this if the forward migration is actively
-- breaking a legitimate writer (admin-measurements.html's flip-on-deliver
-- flow, or a service_role caller).

begin;

drop trigger if exists claims_guard_measurement_shape on public.claims;
drop function if exists public.claims_guard_measurement_shape();

commit;
