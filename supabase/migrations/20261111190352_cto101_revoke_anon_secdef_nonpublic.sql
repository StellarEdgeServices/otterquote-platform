SET LOCAL lock_timeout = '5s';
DO $prereq$
BEGIN
  IF to_regprocedure('public.fee_acceptance_quarantine_add(public.fee_acceptances,text[],numeric,numeric)') IS NULL THEN
    RAISE EXCEPTION 'cto101: fee_acceptance_quarantine_add does not exist (gh-3409 not applied); nothing to revoke';
  END IF;
  IF to_regprocedure('public.notify_admin_out_of_state_claim()') IS NULL THEN
    RAISE EXCEPTION 'cto101: notify_admin_out_of_state_claim does not exist; nothing to revoke';
  END IF;
END
$prereq$;
REVOKE EXECUTE ON FUNCTION public.fee_acceptance_quarantine_add(public.fee_acceptances, text[], numeric, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fee_acceptance_quarantine_add(public.fee_acceptances, text[], numeric, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.notify_admin_out_of_state_claim() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_admin_out_of_state_claim() FROM anon;
DO $final$
BEGIN
  IF has_function_privilege('anon', 'public.fee_acceptance_quarantine_add(public.fee_acceptances,text[],numeric,numeric)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.notify_admin_out_of_state_claim()', 'EXECUTE') THEN
    RAISE EXCEPTION 'cto101: anon still holds EXECUTE; nothing is applied';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fee_acceptance_quarantine_add(public.fee_acceptances,text[],numeric,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'cto101: authenticated lost EXECUTE on fee_acceptance_quarantine_add (the bid-form diversion path needs it); nothing is applied';
  END IF;
END
$final$;