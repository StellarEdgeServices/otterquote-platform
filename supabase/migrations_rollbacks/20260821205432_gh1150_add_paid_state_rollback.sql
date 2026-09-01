-- Rollback: gh1021_add_paid_state_rollback.sql
-- Reverts: gh1021_add_paid_state.sql
-- Status: DRAFT — forward migration not yet applied.
-- GitHub: #1150 AC2
--
-- Safety guard: refuses to run (raises and aborts the whole transaction) if
-- any row in payout_approvals already carries status='paid'. Without this
-- guard, rolling back would either destroy live money-state data (dropping
-- paid_at out from under a paid row) or immediately violate the narrowed
-- 5-value CHECK constraint on re-add. As of the pre-verification captured in
-- gh1021_add_paid_state_pre-flight.md, payout_approvals holds exactly 1 row
-- (status='pending_approval', no paid rows), so this guard is a no-op if
-- invoked today — it exists for correctness against FUTURE state, once the
-- Tier-3B sibling child starts writing 'paid' rows, not current state.

BEGIN;

DO $$
DECLARE
  v_paid_count INT;
BEGIN
  SELECT count(*) INTO v_paid_count
    FROM public.payout_approvals
   WHERE status = 'paid';

  IF v_paid_count > 0 THEN
    RAISE EXCEPTION 'gh1021_add_paid_state_rollback: refusing to run — % row(s) in payout_approvals already carry status=''paid''. Rolling back would drop paid_at (destroying that data) and/or violate the narrowed CHECK constraint. Resolve those rows (migrate them to a terminal status that survives the narrowed constraint) before rolling back this migration.', v_paid_count;
  END IF;
END $$;

ALTER TABLE public.payout_approvals
  DROP CONSTRAINT IF EXISTS payout_approvals_status_check;

ALTER TABLE public.payout_approvals
  ADD CONSTRAINT payout_approvals_status_check
  CHECK (status = ANY (ARRAY[
    'pending_approval'::text,
    'approved'::text,
    'rejected'::text,
    'auto_approved'::text,
    'pre_approved'::text
  ]));

ALTER TABLE public.payout_approvals
  DROP COLUMN IF EXISTS paid_at;

COMMIT;
