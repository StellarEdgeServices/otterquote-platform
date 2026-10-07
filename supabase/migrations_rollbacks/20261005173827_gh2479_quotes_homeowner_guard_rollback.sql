-- Rollback for 20261005170000_gh2479_quotes_homeowner_guard.sql (gh-2479, gh-2519).
-- WARNING: this RE-OPENS #2479's quote-move route (a claim owner can re-point a selected quote at a second
-- claim that carries a chosen referral and accrue $200 on the contractor's completion), #2519 (the claim
-- owner can write quotes.total_price) and the partner agent_type self-change. Run it only if a guard
-- blocks a legitimate writer, and re-close the hole as soon as that writer is moved to service_role.
-- The migration replaced nothing, so the rollback only drops what it added. If it was applied, also
-- delete its supabase_migrations.schema_migrations row.
BEGIN;
DROP TRIGGER IF EXISTS quotes_guard_homeowner_columns ON public.quotes;
DROP FUNCTION IF EXISTS public.quotes_guard_homeowner_columns();
DROP TRIGGER IF EXISTS referral_agents_guard_agent_type ON public.referral_agents;
DROP FUNCTION IF EXISTS public.referral_agents_guard_agent_type();
COMMIT;
