-- gh-3320: PLANTED WRITERS for the pre-flight proof (throwaway Postgres only). Loaded after gh3320_throwaway_schema.sql by the runner's pre-flight phase.
-- Seven functions that write public.fee_acceptances in the seven shapes a naive regex misses, one view, one cron stub row, and two fixture rows for the digest cases.
-- Each function body is never executed; pre-flight check 5 must LIST every name below (gh3320_w1 .. gh3320_w7, gh3320_v_edit, the cron job).
\set ON_ERROR_STOP on
CREATE FUNCTION public.gh3320_w1_plain() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$ BEGIN UPDATE public.fee_acceptances SET fee_pct = 0; END $f$;
CREATE FUNCTION public.gh3320_w2_quoted() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN UPDATE public."fee_acceptances" SET fee_pct = 0; END $f$;
CREATE FUNCTION public.gh3320_w3_only() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN UPDATE ONLY public.fee_acceptances SET fee_pct = 0; END $f$;
CREATE FUNCTION public.gh3320_w4_twospaces() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN DELETE  FROM public.fee_acceptances; END $f$;
CREATE FUNCTION public.gh3320_w5_newline() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN DELETE
  FROM public.fee_acceptances; END $f$;
CREATE FUNCTION public.gh3320_w6_dynamic() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN EXECUTE format('UPDATE %I.%I SET fee_pct = 0', 'public', 'fee_acceptances'); END $f$;
CREATE FUNCTION public.gh3320_w7_truncate() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN TRUNCATE public.fee_acceptances; END $f$;
GRANT EXECUTE ON FUNCTION public.gh3320_w1_plain() TO authenticated;
-- an updatable view owned by the superuser that hands UPDATE to a client role: writes the table with no grant or policy on the table itself
CREATE VIEW public.gh3320_v_edit AS SELECT id, fee_text_displayed FROM public.fee_acceptances;
GRANT SELECT, UPDATE ON public.gh3320_v_edit TO authenticated;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid serial PRIMARY KEY, jobname text, command text);
INSERT INTO cron.job (jobname, command) VALUES ('gh3320_cron_writer', 'DELETE FROM public.fee_acceptances WHERE false');
-- fixture rows for the check-6 digest cases
INSERT INTO public.contractors (id, user_id) VALUES ('eeeeeeee-0000-4000-8000-0000000000a1', 'eeeeeeee-1111-4000-8000-0000000000a1');
INSERT INTO public.claims (id) VALUES ('eeeeeeee-2222-4000-8000-0000000000a1');
INSERT INTO public.quotes (id) VALUES ('eeeeeeee-3333-4000-8000-0000000000a1');
INSERT INTO public.fee_acceptances (id, contractor_id, claim_id, bid_id, fee_pct, fee_basis, fee_amount, fee_text_displayed, accepted_at, ip_address, user_agent)
VALUES ('eeeeeeee-4444-4000-8000-0000000000a1', 'eeeeeeee-0000-4000-8000-0000000000a1', 'eeeeeeee-2222-4000-8000-0000000000a1', 'eeeeeeee-3333-4000-8000-0000000000a1',
        5.00, 'bid_amount', 1000.00, 'Platform fee: $1,000.00 (5.00% of bid)', '2026-01-01 00:00:00+00', '203.0.113.7', 'UA/1.0');
