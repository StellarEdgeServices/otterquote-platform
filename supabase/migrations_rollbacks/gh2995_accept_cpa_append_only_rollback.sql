-- gh-2995 ROLLBACK: remove accept_cpa() and the append-only table.
-- Run manually only if the gh-2995 forward change must be reverted. Never move into supabase/migrations/ (the CLI would replay it forward).
-- DATA WARNING: this DROPS the acceptance records. Before running it on production, export them
-- (COPY / SELECT * FROM public.contractor_cpa_acceptances) and attach the export to the issue; they are consent evidence.
-- contractors.cpa_version / cpa_accepted_at / agreement_version and the activity_log rows already written are NOT reverted
-- (they are the same columns the pages wrote before). record_cpa_ip() was never touched, so pages on the old path work again.
-- Pages that call rpc('accept_cpa') must be reverted first (or acceptance fails with a missing-function error).
-- To restore the table's rows after a rollback, re-run the forward file and re-insert the export.

DROP FUNCTION IF EXISTS public.accept_cpa(text);
DROP TABLE IF EXISTS public.contractor_cpa_acceptances;
DROP FUNCTION IF EXISTS public.cpa_acceptances_append_only();
