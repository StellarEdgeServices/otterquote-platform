-- gh-2619 second-piece proof: thread scope after a contractor switch, and no cross-party UPDATE/DELETE.
-- THROWAWAY POSTGRES ONLY (creates roles and schemas; never point at production). Run from the repo root:
--   createdb gh2619t && psql -d gh2619t -v ON_ERROR_STOP=1 -f supabase/tests/gh2619_messages_thread_scope_proof.sql
-- The schema below is a minimal model of public.messages/claims/contractors/quotes with the policies
-- as they are in production after ledger 20261014112047 (text from CLOSE-REVIEW 6168484981).
-- Phases: LIVE (probes against that policy set) -> forward draft -> NEW probes -> rollback -> ROLLED-BACK probes.
\set ON_ERROR_STOP on
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role;

CREATE TABLE public.profiles (id uuid PRIMARY KEY);
CREATE TABLE public.contractors (id uuid PRIMARY KEY, user_id uuid NOT NULL);
CREATE TABLE public.claims (id uuid PRIMARY KEY, user_id uuid NOT NULL, selected_contractor_id uuid, contractor_switched_at timestamptz);
CREATE TABLE public.quotes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid NOT NULL REFERENCES public.claims(id), contractor_id uuid NOT NULL);
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.profiles(id),
  sender_role text NOT NULL CHECK (sender_role IN ('homeowner','contractor')),
  body text NOT NULL CHECK (char_length(body) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles, public.contractors, public.claims, public.quotes, public.messages TO authenticated, service_role;
ALTER TABLE public.contractors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
-- supporting RLS modelled on production: a contractor sees their own row, their own quotes, and claims they quoted.
CREATE POLICY c_own ON public.contractors FOR SELECT USING (user_id = (SELECT auth.uid()));
CREATE POLICY q_own ON public.quotes FOR SELECT USING (contractor_id IN (SELECT id FROM public.contractors WHERE user_id = (SELECT auth.uid())));
CREATE POLICY cl_owner ON public.claims FOR SELECT USING (user_id = (SELECT auth.uid()));
CREATE POLICY cl_quoted ON public.claims FOR SELECT USING (id IN (SELECT claim_id FROM public.quotes WHERE contractor_id IN (SELECT id FROM public.contractors WHERE user_id = (SELECT auth.uid()))));
-- the three messages policies exactly as live after ledger 20261014112047
CREATE POLICY contractor_messages ON public.messages
  USING (claim_id IN (SELECT quotes.claim_id FROM quotes WHERE quotes.contractor_id = (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid() AS uid)))
         AND claim_id IN (SELECT claims.id FROM claims WHERE claims.selected_contractor_id = (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid() AS uid))))
  WITH CHECK (sender_id = (SELECT auth.uid() AS uid) AND sender_role = 'contractor'
         AND claim_id IN (SELECT quotes.claim_id FROM quotes WHERE quotes.contractor_id = (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid() AS uid)))
         AND claim_id IN (SELECT claims.id FROM claims WHERE claims.selected_contractor_id = (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid() AS uid))));
CREATE POLICY homeowner_messages ON public.messages
  USING (claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid() AS uid)))
  WITH CHECK (sender_id = (SELECT auth.uid() AS uid) AND sender_role = 'homeowner' AND claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid() AS uid)));
CREATE POLICY service_role_messages ON public.messages USING (auth.role() = 'service_role');

-- fixtures (fixed ids). HO homeowner; CA first selected contractor; CB contractor selected after the switch;
-- CX bidder never selected; CN no quote at all.
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-0000000000a1'),('00000000-0000-0000-0000-0000000000b1'),('00000000-0000-0000-0000-0000000000c1'),('00000000-0000-0000-0000-0000000000d1'),('00000000-0000-0000-0000-0000000000e1');
INSERT INTO public.contractors VALUES
 ('10000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b1'),  -- CA
 ('10000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c1'),  -- CB
 ('10000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d1'),  -- CX
 ('10000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000e1');  -- CN
-- claim S: switched (A dropped at 10:00, B selected afterwards). claim U: never switched, A selected.
INSERT INTO public.claims VALUES
 ('20000000-0000-0000-0000-00000000005a','00000000-0000-0000-0000-0000000000a1','10000000-0000-0000-0000-0000000000c1','2026-01-02 10:00+00'),
 ('20000000-0000-0000-0000-00000000005b','00000000-0000-0000-0000-0000000000a1','10000000-0000-0000-0000-0000000000b1',NULL);
INSERT INTO public.quotes (claim_id, contractor_id) VALUES
 ('20000000-0000-0000-0000-00000000005a','10000000-0000-0000-0000-0000000000b1'),
 ('20000000-0000-0000-0000-00000000005a','10000000-0000-0000-0000-0000000000c1'),
 ('20000000-0000-0000-0000-00000000005a','10000000-0000-0000-0000-0000000000d1'),
 ('20000000-0000-0000-0000-00000000005b','10000000-0000-0000-0000-0000000000b1'),
 ('20000000-0000-0000-0000-00000000005b','10000000-0000-0000-0000-0000000000d1');
INSERT INTO public.messages (id, claim_id, sender_id, sender_role, body, created_at) VALUES
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-00000000005a','00000000-0000-0000-0000-0000000000a1','homeowner','S1 to CA (before switch)','2026-01-01 09:00+00'),
 ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-00000000005a','00000000-0000-0000-0000-0000000000b1','contractor','S2 CA reply (before switch)','2026-01-01 09:30+00'),
 ('30000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-00000000005a','00000000-0000-0000-0000-0000000000a1','homeowner','S3 to CB (after switch)','2026-01-03 09:00+00'),
 ('30000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-00000000005b','00000000-0000-0000-0000-0000000000a1','homeowner','U1 never switched','2026-01-01 09:00+00'),
 ('30000000-0000-0000-0000-000000000005','20000000-0000-0000-0000-00000000005b','00000000-0000-0000-0000-0000000000b1','contractor','U2 CA reply never switched','2026-01-01 09:30+00');

-- probe: run one statement as an authenticated user in a sub-transaction that is always rolled back
CREATE FUNCTION public.try_as(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION 'rb:%', n;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'rb:%' THEN RETURN 'rows=' || substr(SQLERRM, 4); END IF;
    RETURN 'REFUSED';
  END;
END $f$;

CREATE FUNCTION public.report(p_phase text) RETURNS TABLE (phase text, probe text, result text) LANGUAGE plpgsql AS $f$
DECLARE
  HO uuid := '00000000-0000-0000-0000-0000000000a1'; CA uuid := '00000000-0000-0000-0000-0000000000b1';
  CB uuid := '00000000-0000-0000-0000-0000000000c1'; CX uuid := '00000000-0000-0000-0000-0000000000d1';
  CN uuid := '00000000-0000-0000-0000-0000000000e1';
  S text := '20000000-0000-0000-0000-00000000005a'; U text := '20000000-0000-0000-0000-00000000005b';
BEGIN
  phase := p_phase;
  probe := 'P01 CB (selected AFTER switch) SELECT claim S (3 rows exist; 2 are pre-switch)'; result := public.try_as(CB, format('SELECT * FROM public.messages WHERE claim_id=%L', S)); RETURN NEXT;
  probe := 'P02 CB SELECT the pre-switch rows S1,S2 only'; result := public.try_as(CB, format('SELECT * FROM public.messages WHERE claim_id=%L AND created_at < %L', S, '2026-01-02 10:00+00')); RETURN NEXT;
  probe := 'P03 CB DELETE pre-switch row S1 (previous contractor thread)'; result := public.try_as(CB, format('DELETE FROM public.messages WHERE id=%L', '30000000-0000-0000-0000-000000000001')); RETURN NEXT;
  probe := 'P04 CB DELETE homeowner row S3'; result := public.try_as(CB, format('DELETE FROM public.messages WHERE id=%L', '30000000-0000-0000-0000-000000000003')); RETURN NEXT;
  probe := 'P05 CB UPDATE homeowner row S3 body'; result := public.try_as(CB, format('UPDATE public.messages SET body=%L WHERE id=%L', 'edited by CB', '30000000-0000-0000-0000-000000000003')); RETURN NEXT;
  probe := 'P06 CB INSERT as contractor (selected, has quote)'; result := public.try_as(CB, format('INSERT INTO public.messages (claim_id,sender_id,sender_role,body) VALUES (%L,%L,%L,%L)', S, CB, 'contractor', 'hi')); RETURN NEXT;
  probe := 'P07 HO SELECT claim S (homeowner keeps full history, expect 3)'; result := public.try_as(HO, format('SELECT * FROM public.messages WHERE claim_id=%L', S)); RETURN NEXT;
  probe := 'P08 HO INSERT as homeowner'; result := public.try_as(HO, format('INSERT INTO public.messages (claim_id,sender_id,sender_role,body) VALUES (%L,%L,%L,%L)', S, HO, 'homeowner', 'hi')); RETURN NEXT;
  probe := 'P09 HO DELETE contractor-sent row S2'; result := public.try_as(HO, format('DELETE FROM public.messages WHERE id=%L', '30000000-0000-0000-0000-000000000002')); RETURN NEXT;
  probe := 'P10 HO UPDATE contractor-sent row S2 body'; result := public.try_as(HO, format('UPDATE public.messages SET body=%L WHERE id=%L', 'edited by HO', '30000000-0000-0000-0000-000000000002')); RETURN NEXT;
  probe := 'P11 HO DELETE own row S1'; result := public.try_as(HO, format('DELETE FROM public.messages WHERE id=%L', '30000000-0000-0000-0000-000000000001')); RETURN NEXT;
  probe := 'P12 CA (previous contractor, no longer selected) SELECT claim S'; result := public.try_as(CA, format('SELECT * FROM public.messages WHERE claim_id=%L', S)); RETURN NEXT;
  probe := 'P13 CX (non-selected bidder) SELECT claim S'; result := public.try_as(CX, format('SELECT * FROM public.messages WHERE claim_id=%L', S)); RETURN NEXT;
  probe := 'P14 CX INSERT as contractor on claim S'; result := public.try_as(CX, format('INSERT INTO public.messages (claim_id,sender_id,sender_role,body) VALUES (%L,%L,%L,%L)', S, CX, 'contractor', 'hi')); RETURN NEXT;
  probe := 'P15 CN (no quote) SELECT claim S'; result := public.try_as(CN, format('SELECT * FROM public.messages WHERE claim_id=%L', S)); RETURN NEXT;
  probe := 'P16 CA (selected, claim U never switched) SELECT claim U (expect 2)'; result := public.try_as(CA, format('SELECT * FROM public.messages WHERE claim_id=%L', U)); RETURN NEXT;
  probe := 'P17 CA INSERT as contractor on claim U'; result := public.try_as(CA, format('INSERT INTO public.messages (claim_id,sender_id,sender_role,body) VALUES (%L,%L,%L,%L)', U, CA, 'contractor', 'hi')); RETURN NEXT;
  probe := 'P18 CA DELETE homeowner row U1'; result := public.try_as(CA, format('DELETE FROM public.messages WHERE id=%L', '30000000-0000-0000-0000-000000000004')); RETURN NEXT;
  probe := 'P19 CX SELECT claim U'; result := public.try_as(CX, format('SELECT * FROM public.messages WHERE claim_id=%L', U)); RETURN NEXT;
END $f$;

\echo === PHASE 1: LIVE policies (production after ledger 20261014112047) ===
SELECT probe, result FROM public.report('live');
SELECT policyname, cmd FROM pg_policies WHERE tablename='messages' ORDER BY policyname;
\echo === PHASE 2: forward draft applied ===
\i supabase/migrations_drafts/gh2619_messages_thread_scope_and_no_cross_delete.sql
SELECT probe, result FROM public.report('new');
SELECT policyname, cmd FROM pg_policies WHERE tablename='messages' ORDER BY policyname;
\echo === PHASE 2b: forward draft applied a second time must refuse (order gate) ===
\set ON_ERROR_STOP off
\i supabase/migrations_drafts/gh2619_messages_thread_scope_and_no_cross_delete.sql
ROLLBACK;
\set ON_ERROR_STOP on
\echo === PHASE 2c: service_role can still delete (service_role_messages untouched) ===
BEGIN;
SET LOCAL ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',true);
WITH d AS (DELETE FROM public.messages WHERE id='30000000-0000-0000-0000-000000000001' RETURNING 1) SELECT count(*) AS service_role_deleted FROM d;
ROLLBACK;
\echo === PHASE 3: rollback applied ===
\i supabase/migrations_rollbacks/gh2619_messages_thread_scope_and_no_cross_delete_rollback.sql
SELECT probe, result FROM public.report('rolledback');
SELECT policyname, cmd FROM pg_policies WHERE tablename='messages' ORDER BY policyname;
