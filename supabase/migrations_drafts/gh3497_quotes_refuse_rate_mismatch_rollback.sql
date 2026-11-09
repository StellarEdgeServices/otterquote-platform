-- gh-3497 rollback: removes the displayed-rate check. Restores exactly the state before gh3497_quotes_refuse_rate_mismatch.sql
-- (the trigger and its function did not exist). No data is lost; no row is changed by either direction.
-- NOT APPLIED by the authoring session. After this, the stored and charged rate is again the configured one whatever the form displayed
-- (gh-2519); the CONDITION on #3497 (no insert into or fee_pct update on platform_fee_config) applies again. It lifts again only when #3497 is
-- live INCLUDING the Change Bid / Renew stored-rate fix: part 1 with that fix deployed AND the trigger re-applied.
BEGIN;
DROP TRIGGER IF EXISTS quotes_check_displayed_fee_rate ON public.quotes;
DROP FUNCTION IF EXISTS public.quotes_check_displayed_fee_rate();
COMMIT;
