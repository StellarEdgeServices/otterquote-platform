-- gh-3409 ROLLBACK: remove the client-insert guard from public.fee_acceptances. Restores today's behaviour (a client INSERT is limited only by the contractor-own policy).
-- Touches only the trigger and the three functions the forward file added. No policy, grant, column or row of fee_acceptances is changed, so it is independent of PR #3406 (gh-3320) in either order.
-- The table public.fee_acceptance_quarantine is KEPT on purpose: it holds acceptance records that were diverted from fee_acceptances, and dropping it would destroy them. Export or review its rows, then drop it by hand
-- (DROP TABLE public.fee_acceptance_quarantine) only when a person has decided. Rows already in fee_acceptances are kept. Run ALONE: `psql -v ON_ERROR_STOP=1 -f`. Idempotent.
BEGIN;
DROP TRIGGER IF EXISTS fee_acceptances_guard_client_insert ON public.fee_acceptances;
DROP FUNCTION IF EXISTS public.fee_acceptances_guard_client_insert();
DROP FUNCTION IF EXISTS public.fee_acceptance_quarantine_add(public.fee_acceptances, text[], numeric, numeric);
DROP FUNCTION IF EXISTS public.fee_acceptance_text_check(text, numeric, numeric, numeric);
DO $chk$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.fee_acceptances'::regclass AND tgname = 'fee_acceptances_guard_client_insert')
     OR to_regprocedure('public.fee_acceptances_guard_client_insert()') IS NOT NULL
     OR to_regprocedure('public.fee_acceptance_text_check(text,numeric,numeric,numeric)') IS NOT NULL
     OR to_regprocedure('public.fee_acceptance_quarantine_add(public.fee_acceptances,text[],numeric,numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'gh3409 rollback: guard still present';
  END IF;
END
$chk$;
COMMIT;
