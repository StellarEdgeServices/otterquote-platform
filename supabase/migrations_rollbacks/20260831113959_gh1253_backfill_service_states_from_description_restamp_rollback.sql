-- Rollback for 20260831113959_gh1253_backfill_service_states_from_description_restamp.sql
--
-- Identical predicate to the original migration's rollback
-- (20260830170958_gh1253_backfill_service_states_from_description_rollback.sql):
-- reverts only rows whose current `service_states` is byte-identical to what the
-- forward migration would have derived from that row's `service_area_description`,
-- and which still have `service_counties IS NULL`. A row edited by a human or by the
-- profile/pre-approval UI since the forward run no longer satisfies that equality and
-- is left alone -- this will not clobber a real service area someone set.
--
-- Reverting restores the pre-fix behavior: with both service_states and
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
