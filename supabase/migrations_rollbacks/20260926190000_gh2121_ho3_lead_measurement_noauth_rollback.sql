-- Rollback for supabase/migrations/20260926190000_gh2121_ho3_lead_measurement_noauth.sql.
-- Lives in supabase/migrations_rollbacks/ (PR #2226 REVIEW D9) so no migration
-- applier ever runs it. Run by hand only if HO-3 is withdrawn after the forward
-- migration was applied, and only AFTER the router has been reverted (so no
-- visitor is sent to the no-account pages) and the four HO-3 Edge Functions are
-- undeployed. Reverses the forward migration step-for-step, in reverse order.
--
-- Safe to run even if the forward migration only partially applied (every
-- statement is IF EXISTS / conditional).
--
-- DATA WARNING: dropping lead_measurement_orders / lead_loss_sheet_uploads
-- deletes paid-order and upload records. Export them first
-- (select * from public.lead_measurement_orders; ... lead_loss_sheet_uploads)
-- and refund or fulfil any open order before running this.

delete from public.rate_limit_config
where function_name in (
  'issue-lead-access-token',
  'create-lead-payment-intent',
  'create-lead-measurement-order',
  'record-lead-loss-sheet-upload'
);

drop function if exists public.resolve_lead_by_token(text);
drop function if exists public.issue_lead_access_token(uuid);

-- Storage objects (if any were uploaded while this was live) are NOT deleted
-- here: an operator must empty the bucket (or decide what to keep) first, or
-- this delete fails on the objects' foreign key, which is the intended guard.
delete from storage.buckets where id = 'lead-loss-sheets';

drop table if exists public.lead_loss_sheet_uploads;
drop table if exists public.lead_measurement_orders;
drop table if exists public.lead_access_tokens;
