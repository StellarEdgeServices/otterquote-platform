-- gh-1883 [SECURITY]: auth-uniform (the EF fronting /auth/v1/otp and
-- /auth/v1/recover, added in the same PR) calls check_rate_limit() keyed on
-- a synthetic per-IP UUID, same pattern as gh-1724's check-email-exists
-- (see 20260908194734_gh1724_check_email_exists_rate_limit.sql). Without
-- this row, check_rate_limit() denies by default (fail-closed) for any
-- function with no rate_limit_config row -- this migration must ship in
-- the same deploy as the function itself, not after.
--
-- Limits: 10/hour, 30/day, 300/month per IP bucket -- same shape as
-- check-email-exists's own row (itself mirroring register_partner,
-- gh973): an anonymous, form-adjacent auth action a real user hits at most
-- a handful of times per session. Raise if legitimate magic-link/password-
-- reset resend volume is ever throttled.
--
-- Companion rollback: supabase/migrations_rollbacks/gh1883_auth_uniform_rate_limit_rollback.sql

INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('auth-uniform', 10, 30, 300, true, 0.0000, 0.00,
   'gh1883 [SECURITY]: per-IP synthetic-UUID bucket (sha256 of "auth-uniform:<ip>", not a real user_id -- this endpoint is called pre-auth), same shape as check-email-exists (gh1724). Fronts /auth/v1/otp and /auth/v1/recover with a uniform-response EF to close the account-enumeration status/body/timing oracle on those endpoints. Limits are a starting judgment call mirroring check-email-exists/register_partner -- raise if legitimate resend volume is ever throttled.')
ON CONFLICT (function_name) DO NOTHING;
