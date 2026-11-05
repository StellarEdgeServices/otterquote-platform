-- gh-3409 ROLLBACK: remove the client-insert guard from public.fee_acceptances. Restores today's behaviour (a client INSERT is limited only by the contractor-own policy).
-- Touches only the trigger and the two functions the forward file added. No policy, grant, column or row is changed, so it is independent of PR #3406 (gh-3320) in either order.
-- Rows inserted while the guard was in place are kept (the guard wrote nothing but the rows' own columns). Run ALONE: `psql -v ON_ERROR_STOP=1 -f`. Idempotent.
BEGIN;
DROP TRIGGER IF EXISTS fee_acceptances_guard_client_insert ON public.fee_acceptances;
DROP FUNCTION IF EXISTS public.fee_acceptances_guard_client_insert();
DROP FUNCTION IF EXISTS public.fee_acceptance_text_matches(text, numeric, numeric, numeric);
DO $chk$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.fee_acceptances'::regclass AND tgname = 'fee_acceptances_guard_client_insert')
     OR to_regprocedure('public.fee_acceptances_guard_client_insert()') IS NOT NULL THEN
    RAISE EXCEPTION 'gh3409 rollback: guard still present';
  END IF;
END
$chk$;
COMMIT;
