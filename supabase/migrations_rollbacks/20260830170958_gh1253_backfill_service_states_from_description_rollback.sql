-- Rollback for 20260830170958_gh1253_backfill_service_states_from_description.sql
--
-- Restores `service_states` to NULL for exactly the rows the forward half populated.
-- The predicate is the inverse-derivation of the forward half rather than a hardcoded
-- id list: it reverts only rows whose current `service_states` is byte-identical to
-- what the forward migration would have derived from that same row's
-- `service_area_description`, and which still have `service_counties IS NULL`.
-- A row edited by a human or by the profile/pre-approval UI between the forward run
-- and this rollback no longer satisfies that equality and is therefore left alone --
-- which is the intent. This will not clobber a real service area someone set.
--
-- At authoring time the forward half was scoped to a single row
-- (986ce2b6-39fd-4a2c-aba4-a806c618c8c0, "PFW Roofing 1787836001", -> {IN}),
-- so this is expected to revert 1 row.
--
-- Reverting restores the pre-fix behavior for that row: with both service_states and
-- service_counties null, process-auto-bids' inServiceArea fallback returns TRUE and
-- the contractor matches every state again. That is the defect, not a neutral state --
-- only roll back if the forward half caused a worse problem than the one it fixed.
--
-- Refs #1253

UPDATE contractors
   SET service_states = NULL,
       updated_at     = now()
 WHERE service_counties IS NULL
   AND service_area_description ~ '^[A-Z]{2}(,\s*[A-Z]{2})*$'
   AND service_states IS NOT NULL
   AND service_states = string_to_array(replace(service_area_description, ' ', ''), ',');
