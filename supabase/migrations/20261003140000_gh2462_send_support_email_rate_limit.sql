-- gh-2462 Q2: send-support-email now calls check_rate_limit() (per-IP synthetic UUID bucket,
-- same design as check-email-exists, gh-1724 step 2). check_rate_limit() denies by default
-- when a function has no rate_limit_config row, so the row ships in lockstep with the call.
--
-- Additive (Tier 3A): one INSERT ... ON CONFLICT DO NOTHING, no DDL, no GRANT, no RLS change.
-- DEPLOY ORDER: apply this migration BEFORE deploying the Edge Function. Deployed first, every
-- support-form submission would be answered 429 until the row exists.
--
-- Limits (judgment call, not traffic-validated): 20/hour, 60/day, 600/month per IP bucket. A
-- person filing a support request or contractor signup sends a handful at most; the day cap
-- also bounds how much mail one IP can push at the admin inbox. Shared office NATs get
-- generous headroom. Raise if legitimate volume is ever throttled.
--
-- Companion rollback: supabase/migrations_rollbacks/20261003140000_gh2462_send_support_email_rate_limit_rollback.sql

INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('send-support-email', 20, 60, 600, true, 0.0000, 0.00,
   'gh2462 Q2: per-IP synthetic-UUID bucket (sha256 of "send-support-email:<ip>", not a real user_id -- the public support form is called with only the anon key). Limits are a starting judgment call -- raise if legitimate volume is ever throttled.')
ON CONFLICT (function_name) DO NOTHING;
