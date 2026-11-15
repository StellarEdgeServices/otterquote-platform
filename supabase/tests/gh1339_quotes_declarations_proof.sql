-- gh-1339 proof on a THROWAWAY Postgres only. Minimal stub tables (claims, quotes); the trigger and function under test
-- are loaded from supabase/migrations_drafts/ by the runner (marker below), never stubbed.
DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $r$;
CREATE TABLE public.claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_type text, funding_type text, trades text[]);
CREATE TABLE public.quotes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid REFERENCES public.claims(id),
  trade_type text, scope_summary text, status text DEFAULT 'submitted');
CREATE TABLE public.results(n serial, label text, outcome text);
-- @@MIGRATION@@
CREATE FUNCTION public.try(label text, sql text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE sql; INSERT INTO public.results(label,outcome) VALUES (label,'ACCEPTED');
EXCEPTION WHEN others THEN INSERT INTO public.results(label,outcome) VALUES (label,'REFUSED '||SQLSTATE||' '||left(SQLERRM,90));
END $$;
INSERT INTO claims(id,job_type,funding_type,trades) VALUES
 ('00000000-0000-0000-0000-000000000001','retail','cash',ARRAY['roofing']),
 ('00000000-0000-0000-0000-000000000002','insurance_rcv','insurance',ARRAY['roofing']),
 ('00000000-0000-0000-0000-000000000003','retail','cash',ARRAY['siding']);
-- a legacy retail roofing quote with NO declarations, inserted before any guard is considered (trigger disabled for the seed)
DO $$ BEGIN
  IF to_regprocedure('public.enforce_quote_section2_declarations()') IS NOT NULL THEN ALTER TABLE quotes DISABLE TRIGGER quotes_require_section2_declarations; END IF;
  INSERT INTO quotes(id,claim_id,trade_type,scope_summary) VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','roofing','{"brand":"x"}');
  IF to_regprocedure('public.enforce_quote_section2_declarations()') IS NOT NULL THEN ALTER TABLE quotes ENABLE TRIGGER quotes_require_section2_declarations; END IF;
END $$;
\set good '''{"brand":"x","declarations":{"gutters":{"state":"extra","rate_cents":450},"chimney":{"state":"not_offered","rate_cents":null},"skylights":{"state":"not_offered","rate_cents":null},"ice_water_shield":{"state":"included","rate_cents":null},"drip_edge":{"state":"included","rate_cents":null}}}'''
\set missing1 '''{"brand":"x","declarations":{"gutters":{"state":"included","rate_cents":null},"chimney":{"state":"not_offered","rate_cents":null},"skylights":{"state":"not_offered","rate_cents":null},"ice_water_shield":{"state":"included","rate_cents":null}}}'''
\set extra0 '''{"brand":"x","declarations":{"gutters":{"state":"extra","rate_cents":0},"chimney":{"state":"not_offered","rate_cents":null},"skylights":{"state":"not_offered","rate_cents":null},"ice_water_shield":{"state":"included","rate_cents":null},"drip_edge":{"state":"included","rate_cents":null}}}'''
\set C1 '00000000-0000-0000-0000-000000000001'
\set C2 '00000000-0000-0000-0000-000000000002'
\set C3 '00000000-0000-0000-0000-000000000003'
SELECT try('N1 retail roofing, NO declarations key', format($q$INSERT INTO quotes(claim_id,trade_type,scope_summary) VALUES (%L,'roofing','{"brand":"x"}')$q$, :'C1'));
SELECT try('N2 retail roofing, scope_summary NULL', format($q$INSERT INTO quotes(claim_id,trade_type,scope_summary) VALUES (%L,'roofing',NULL)$q$, :'C1'));
SELECT try('N3 retail roofing, scope_summary not JSON', format($q$INSERT INTO quotes(claim_id,trade_type,scope_summary) VALUES (%L,'roofing','Auto text')$q$, :'C1'));
SELECT try('N4 retail roofing, drip_edge row missing', format($q$INSERT INTO quotes(claim_id,trade_type,scope_summary) VALUES (%L,'roofing',%L)$q$, :'C1', :missing1));
SELECT try('N5 retail roofing, extra with rate_cents 0', format($q$INSERT INTO quotes(claim_id,trade_type,scope_summary) VALUES (%L,'roofing',%L)$q$, :'C1', :extra0));
SELECT try('N6 retail roofing, trade_type NULL (defaults to roofing), no declarations', format($q$INSERT INTO quotes(claim_id,trade_type,scope_summary) VALUES (%L,NULL,'{"brand":"x"}')$q$, :'C1'));
SELECT try('P1 retail roofing, all five declared (GOOD)', format($q$INSERT INTO quotes(claim_id,trade_type,scope_summary) VALUES (%L,'roofing',%L)$q$, :'C1', :good));
SELECT try('P2 insurance roofing, no declarations (control: gate does not apply)', format($q$INSERT INTO quotes(claim_id,trade_type,scope_summary) VALUES (%L,'roofing','{"brand":"x"}')$q$, :'C2'));
SELECT try('P3 retail SIDING-only claim, trade_type roofing default, no declarations', format($q$INSERT INTO quotes(claim_id,trade_type,scope_summary) VALUES (%L,'roofing','{"brand":"x"}')$q$, :'C3'));
SELECT try('P4 retail roofing claim, trade_type gutters, no declarations', format($q$INSERT INTO quotes(claim_id,trade_type,scope_summary) VALUES (%L,'gutters','{"brand":"x"}')$q$, :'C1'));
SELECT try('P5 legacy quote, status-only UPDATE (no declarations on row)', $q$UPDATE quotes SET status='selected' WHERE id='00000000-0000-0000-0000-0000000000a1'$q$);
SELECT try('N7 legacy quote, UPDATE scope_summary to still-no-declarations', $q$UPDATE quotes SET scope_summary='{"brand":"y"}' WHERE id='00000000-0000-0000-0000-0000000000a1'$q$);
SELECT try('P6 legacy quote, UPDATE scope_summary adds all five', format($q$UPDATE quotes SET scope_summary=%L WHERE id='00000000-0000-0000-0000-0000000000a1'$q$, :good));
SELECT try('N8 declared quote, UPDATE strips declarations', $q$UPDATE quotes SET scope_summary='{"brand":"z"}' WHERE id='00000000-0000-0000-0000-0000000000a1'$q$);
SELECT try('N9 insurance quote re-pointed to retail roofing claim without declarations', format($q$UPDATE quotes SET claim_id=%L WHERE claim_id=%L$q$, :'C1', :'C2'));
SELECT 'GUARD PROOF' AS hdr;
SELECT format('%s | %s', label, outcome) FROM results ORDER BY n;
SELECT 'FN_EXEC anon='||has_function_privilege('anon','public.enforce_quote_section2_declarations()','EXECUTE')||' authenticated='||has_function_privilege('authenticated','public.enforce_quote_section2_declarations()','EXECUTE')
  WHERE to_regprocedure('public.enforce_quote_section2_declarations()') IS NOT NULL;
SELECT 'ROWS retail-roofing quotes now: '||count(*) FROM quotes WHERE claim_id='00000000-0000-0000-0000-000000000001';
