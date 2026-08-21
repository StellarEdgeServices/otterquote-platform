-- Rollback: gh749_add_service_states_to_contractors_rollback.sql
-- Reverts: gh749_add_service_states_to_contractors.sql
-- Status: DRAFT — forward migration not yet applied.
-- GitHub: #749
--
-- Purely additive forward migration (one new nullable column + a backfill
-- UPDATE confined to that same column), so rollback is a plain DROP COLUMN.
-- No guard is needed: service_states is not referenced by any FK, view,
-- RLS policy, or constraint, and dropping it cannot destroy data in
-- service_area_description or service_counties (both untouched by the
-- forward migration).

BEGIN;

ALTER TABLE public.contractors
  DROP COLUMN IF EXISTS service_states;

COMMIT;
