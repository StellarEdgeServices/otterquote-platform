-- Rollback for 20260820214032_gh945_backfill_activity_log_is_test_propagation_gap.sql
-- Restores is_test = false on the exact 6 rows the forward migration flagged true.
-- Data-only, reversible, no schema change.

UPDATE public.activity_log
SET is_test = false
WHERE id IN (
  'a35f6506-ced3-4e14-ba6e-199434626fa9',
  '52501761-2706-42eb-a410-105997976219',
  '622107ab-7fc3-4961-8ab3-a584fb79bd97',
  'ea5009ee-988d-4c50-903f-c090842d9c36',
  '9fd675bc-2eef-43ab-8358-01539d113113',
  'aae60b6d-a98b-4f0f-a572-05c4bd2ec115'
);
