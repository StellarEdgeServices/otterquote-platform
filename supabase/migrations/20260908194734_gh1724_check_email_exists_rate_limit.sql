-- gh-1724 [SECURITY] step 2: check-email-exists had no rate_limit_config
-- row, so if it ever called check_rate_limit() the RPC would deny by
-- default (fail-closed) -- but it never called it at all before this PR.
-- Refuted 2026-09-08 (In Flight/reports/cto30-refute-1724-20260908.md):
-- 30/30 unauthenticated requests accepted, no limiter observed rejecting a
-- burst. This migration adds the missing config row; the companion change
-- in supabase/functions/check-email-exists/index.ts (same PR) adds the
-- actual check_rate_limit() call, keyed on a per-IP synthetic UUID
-- (sha256("check-email-exists:<client IP>") reshaped into UUID form) since
-- this endpoint is called pre-auth and has no real user_id to key on.
--
-- Judgment call, not traffic-validated: 10/hour, 30/day, 300/month per IP
-- bucket -- same shape as gh973's register_partner (10/30/300), the
-- closest analog: an anonymous, form-adjacent endpoint a real applicant
-- hits at most a handful of times. Raise if legitimate signup volume is
-- ever throttled.
--
-- Companion rollback: supabase/migrations_rollbacks/gh1724_check_email_exists_rate_limit_rollback.sql

INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('check-email-exists', 10, 30, 300, true, 0.0000, 0.00,
   'gh1724 step 2: per-IP synthetic-UUID bucket (sha256 of "check-email-exists:<ip>", not a real user_id -- this endpoint is called pre-auth). Rate limit added to close the account-enumeration burst vector the status-disclosure fix (PR #1806) did not address. Limits are a starting judgment call mirroring register_partner (gh973) -- raise if legitimate signup volume is ever throttled.')
ON CONFLICT (function_name) DO NOTHING;
