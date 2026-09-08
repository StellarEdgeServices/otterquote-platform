-- gh-1585 / gh-1438: funnel_abandonment_facts -- post-apply trace file.
--
-- STATUS: APPLIED LIVE on yeszghaspzwwstvsrioa at 2026-09-04T21:20:48Z by CTO run
-- cto-2026-09-04T21:07:41Z via the Supabase Management API SQL endpoint
-- (In Flight/sql/gh1585-optionC-EXECUTED-cto-20260904T210741Z.sql, CEO ruling
-- Option C, gh-1585 comment 5545826513). That path does NOT write a row to
-- supabase_migrations.schema_migrations, so this version (20260904212048) is
-- deliberately NOT in the live ledger. Every statement below is idempotent so a
-- replay (fresh branch, or `db push` treating this file as pending) is a no-op
-- against production. Filed by cto-2026-09-05T03:07:58Z (gh-1438 slice).
--
-- Definition verified against the live table 2026-09-05 (information_schema.columns,
-- pg_constraint, pg_class.relrowsecurity, pg_policies -> zero policies, obj_description).
-- The erasure DML that ran in the same transaction (one INSERT ... SELECT from claims,
-- two DELETEs) is data, not schema, and is NOT part of this migration.

CREATE TABLE IF NOT EXISTS public.funnel_abandonment_facts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_claim_id        uuid        NOT NULL,
  status_at_redaction    text        NOT NULL,
  claim_created_at       timestamptz NOT NULL,
  claim_last_updated_at  timestamptz,
  job_type               text,
  funding_type           text,
  trades                 text[],
  has_measurements       boolean,
  has_material_selection boolean,
  ready_for_bids         boolean,
  is_test                boolean     NOT NULL,
  redacted_at            timestamptz NOT NULL DEFAULT now(),
  redaction_reason       text        NOT NULL
);

COMMENT ON TABLE public.funnel_abandonment_facts IS
  'De-identified funnel outcomes retained after an erasure. Contains no PII and no FK to auth.users. gh-1585.';

-- RLS enabled, no policies: anon/authenticated are denied every row; service_role
-- (the only writer, from the erasure path) bypasses RLS. Matches live
-- (relrowsecurity=true, relforcerowsecurity=false, pg_policies -> 0 rows).
ALTER TABLE public.funnel_abandonment_facts ENABLE ROW LEVEL SECURITY;
