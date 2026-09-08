-- Migration: gh1724_check_email_exists_rate_limit
-- GitHub: #1724 (SECURITY - check-email-exists account-enumeration oracle)
-- D-numbers: D-182 (deploy tier 3), D-221 (path A deploy), D-261 (Tier 3A additive)
-- Rollback: supabase/migrations_rollbacks/gh1724_check_email_exists_rate_limit_rollback.sql
--
-- NOT YET APPLIED. Tier 3 - requires Dustin approval before apply (per the
-- CTO30 rate-limit brief and D-182). Applying this is what ARMS the per-IP
-- rate limiter that supabase/functions/check-email-exists/index.ts already
-- calls: until this row exists, check_rate_limit('check-email-exists', ...)
-- returns "No rate limit config found ... Denying by default", which the
-- Edge Function treats as ALLOW (fail-open), so the function is a behavioural
-- no-op ahead of this migration and cannot cause a signup outage.
--
-- gh-1724 step 2 registers 'check-email-exists' in the SAME rate_limit_config
-- machinery already used by ~25 Edge Functions (sibling precedent:
-- 20260818214635_gh973_register_partner_rate_limit_gate.sql). The Edge
-- Function buckets each anonymous caller by a uuid synthesized from client IP
-- (rate_limits.caller_id is a uuid; this endpoint has no auth.uid()), so these
-- limits are PER-IP, not global.
--
-- Limits are a starting judgment call, NOT traffic-validated. A legitimate
-- contractor signup pre-check fires ~1-3 calls per person per session from one
-- IP; 30/hour/IP leaves generous headroom for retries while capping bulk
-- enumeration from a single source to 30 addresses/hour (vs unlimited today).
-- Raise max_per_hour if a shared-NAT origin ever throttles real signups.
-- monthly_budget_cap = 0 (no per-call vendor cost; this is a DB lookup only),
-- so the budget-cap branch of check_rate_limit is inert for this row.

INSERT INTO public.rate_limit_config
  (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes)
VALUES
  ('check-email-exists', 30, 120, 1000, true, 0.0000, 0.00,
   'gh1724 step 2: per-IP rate limit on the anonymous check-email-exists Edge Function (account-enumeration hardening). Bucketed by a uuid derived from client IP inside the EF. Limits are a starting judgment call, not traffic-validated - raise max_per_hour if legitimate signup volume from a shared NAT is ever throttled. No per-call vendor cost, so monthly_budget_cap is 0/inert.')
ON CONFLICT (function_name) DO NOTHING;
