-- ROLLBACK for supabase/migrations_drafts/cto101_revoke_anon_secdef_nonpublic.sql
-- Restores the explicit anon EXECUTE grant on both functions, as the advisor reported it. It does NOT re-grant PUBLIC: fee_acceptance_quarantine_add never held PUBLIC (gh-3409 revoked it), and for
-- notify_admin_out_of_state_claim the PUBLIC grant is not needed for anon to execute it once anon is granted directly. Capture proacl before the forward run if an exact restore is wanted.
BEGIN;
GRANT EXECUTE ON FUNCTION public.fee_acceptance_quarantine_add(public.fee_acceptances, text[], numeric, numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.notify_admin_out_of_state_claim() TO anon;
COMMIT;
