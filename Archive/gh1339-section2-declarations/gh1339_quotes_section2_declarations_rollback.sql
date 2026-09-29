-- gh-1339 ROLLBACK for gh1339_quotes_section2_declarations.sql
--
-- ⛔ Manual reference only. Never rename this into a 14-digit timestamp and
-- never move it into supabase/migrations/ — the CLI would replay it FORWARD
-- and silently undo the migration it exists to revert. That has actually
-- happened here before; see MIGRATIONS-RECONCILIATION-385.md, defect 2.
--
-- ⚠️ DATA LOSS. Dropping the column destroys every declaration a contractor
-- has made. If any bid has been submitted under the declarations requirement,
-- export before running:
--
--   \copy (select id, claim_id, contractor_id, section2_declarations
--            from public.quotes where section2_declarations is not null)
--     to 'gh1339-declarations-backup.csv' csv header
--
-- The forward migration is additive and every existing row is NULL, so
-- rolling back immediately after applying loses nothing.

begin;

drop index if exists public.quotes_section2_declarations_gin;

alter table public.quotes
  drop constraint if exists quotes_section2_declarations_shape;

alter table public.quotes
  drop column if exists section2_declarations;

-- Dropped last: the constraint above depends on it.
drop function if exists public.quotes_section2_declarations_valid(jsonb);

commit;
