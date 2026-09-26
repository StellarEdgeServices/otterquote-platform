-- Rollback for 20260926190000_gh2121_ho3_lead_measurement_noauth.sql.
-- Not applied automatically by any tooling in this repo -- kept beside the
-- forward migration per Ben's Ruling 1 ("additive-only ... with a rollback
-- file"), to be run by hand if HO-3 is withdrawn after the migration has
-- already been applied. Reverses step-for-step, in reverse order.
--
-- Safe to run even if the forward migration only partially applied (every
-- statement is IF EXISTS / conditional).

delete from public.rate_limit_config
where function_name in (
  'issue-lead-access-token',
  'create-lead-payment-intent',
  'create-lead-measurement-order',
  'record-lead-loss-sheet-upload'
);

revoke all on function public.resolve_lead_by_token(text) from service_role;
drop function if exists public.resolve_lead_by_token(text);

revoke all on function public.issue_lead_access_token(uuid) from service_role;
drop function if exists public.issue_lead_access_token(uuid);

-- Storage objects (if any were uploaded while this was live) are NOT deleted
-- by this rollback -- an operator should confirm the bucket is empty (or
-- decide what to do with any uploaded loss sheets) before dropping it.
delete from storage.buckets where id = 'lead-loss-sheets';

drop index if exists public.lead_loss_sheet_uploads_lead_id_idx;
drop table if exists public.lead_loss_sheet_uploads;

drop index if exists public.lead_measurement_orders_lead_id_idx;
drop table if exists public.lead_measurement_orders;

drop index if exists public.leads_access_token_key;
alter table public.leads
  drop column if exists access_token_expires_at,
  drop column if exists access_token;
