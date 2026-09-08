-- gh-1314 step 4 — ROLLBACK for gh1314_persist_signed_price.sql.
--
-- Drops data. Safe only because these five columns are written by exactly one
-- function (docusign-webhook) and read by nothing in the application: they exist
-- for audit queries. Anything already recorded in them is ALSO in
-- platform_alerts_log as a message string, so the rollback loses queryability,
-- not the underlying facts.

begin;

alter table public.claims drop constraint if exists claims_signed_price_reason_check;
alter table public.claims drop constraint if exists claims_signed_price_verdict_check;

alter table public.claims
  drop column if exists signed_price_checked_at,
  drop column if exists signed_price_reason,
  drop column if exists signed_price_verdict,
  drop column if exists signed_price_raw,
  drop column if exists signed_contract_price;

commit;
