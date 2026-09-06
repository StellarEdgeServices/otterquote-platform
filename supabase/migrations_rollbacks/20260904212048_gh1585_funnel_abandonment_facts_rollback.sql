-- gh-1585 / gh-1438: rollback for 20260904212048_gh1585_funnel_abandonment_facts.sql
-- Reference material only -- run MANUALLY. Never rename into a 14-digit
-- timestamp or place in supabase/migrations/ (README.md, replay-path contract).
--
-- Dropping this table discards the de-identified funnel facts retained by the
-- gh-1585 erasure (CEO Option C). Take a copy first if that record still matters:
--   copy (select * from public.funnel_abandonment_facts) to stdout with csv header;

DROP TABLE IF EXISTS public.funnel_abandonment_facts;
