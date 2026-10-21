-- Proof: gh2559_claims_policy_narrow.sql is a STRICT SUBSET of the two policies it replaces (selected AND quoted).
-- Refs #2559. CTO RUN 70, narrow2. NOT FOR PRODUCTION: run against an EMPTY THROWAWAY Postgres 16 database only
-- (it creates schema auth, tables claims/quotes/contractors/..., roles anon/authenticated/service_role).
--   createdb narrow2 && psql -X -v ON_ERROR_STOP=1 -d narrow2 -f supabase/tests/gh2559_claims_narrow_strict_subset_proof.sql
-- Run from the repo root so the \ir includes resolve relative to this file.
-- The policy text below is production's pg_policies text for public.claims (read 2026-10-18, Supabase MCP SELECT),
-- plus the contractors / quotes / messages / payment_failures / storage policies the contractor flows touch.
-- Phases: LIVE (production text) -> UNAMENDED (the draft as it was on main at sha 05e9a86c, negative control; then the
--         rollback file returns to live) 
--         -> AMENDED (the draft file in this repo) -> ROLLBACK (the rollback file).
-- Contractors: kA selected on cSel and quoted there (and bid on cOpen); kB bid on cOpen and was declined on cLost;
--   kC has NO quote anywhere but is selected_contractor_id on cLost (the state the unamended draft would let read);
--   kD has no quote and is not selected. Every check RAISEs on mismatch; success ends with PROOF PASSED.
\set ON_ERROR_STOP 1
\pset footer off
DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $r$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt()->>'role' $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
CREATE FUNCTION public.is_admin_email() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'email') = 'admin@example.test' $$;

CREATE TABLE contractors (id uuid PRIMARY KEY, user_id uuid, status text, is_test boolean DEFAULT false);
CREATE TABLE claims (id uuid PRIMARY KEY, user_id uuid, status text, ready_for_bids boolean, is_test boolean DEFAULT false,
  selected_contractor_id uuid, platform_fee_charged boolean, property_address text, homeowner_name text, damage_type text, rcv_amount numeric);
CREATE TABLE quotes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, contractor_id uuid, status text, total_price numeric);
CREATE TABLE messages (id serial PRIMARY KEY, claim_id uuid, sender_id uuid, sender_role text, body text);
CREATE TABLE payment_failures (id serial PRIMARY KEY, claim_id uuid, contractor_id uuid, dunning_status text);
CREATE TABLE objects (name text, bucket_id text);  -- stands in for storage.objects
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
ALTER TABLE contractors ENABLE ROW LEVEL SECURITY; ALTER TABLE claims ENABLE ROW LEVEL SECURITY; ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY; ALTER TABLE payment_failures ENABLE ROW LEVEL SECURITY; ALTER TABLE objects ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.get_contractor_quote_claim_ids(p_user_id uuid) RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT q.claim_id FROM quotes q JOIN contractors c ON c.id = q.contractor_id WHERE c.user_id = auth.uid(); $f$;

-- contractors / quotes / messages / payment_failures: live text
CREATE POLICY "Contractors can read own record" ON contractors FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Contractors can read own quotes" ON quotes FOR SELECT TO authenticated USING (contractor_id IN (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid())));
CREATE POLICY "Homeowners can read quotes for their claims" ON quotes FOR SELECT TO authenticated USING (claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid())));
CREATE POLICY "Homeowners can update quotes for their claims" ON quotes FOR UPDATE TO authenticated USING (claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid()))) WITH CHECK (claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid())));
CREATE POLICY contractor_messages ON messages FOR ALL USING (
 (claim_id IN (SELECT quotes.claim_id FROM quotes WHERE quotes.contractor_id = (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid()))))
 AND (claim_id IN (SELECT claims.id FROM claims WHERE claims.selected_contractor_id = (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid())))))
 WITH CHECK ((sender_id = (SELECT auth.uid())) AND (sender_role = 'contractor')
 AND (claim_id IN (SELECT quotes.claim_id FROM quotes WHERE quotes.contractor_id = (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid()))))
 AND (claim_id IN (SELECT claims.id FROM claims WHERE claims.selected_contractor_id = (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid())))));
CREATE POLICY homeowner_messages ON messages FOR ALL USING (claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid())))
 WITH CHECK ((sender_id = (SELECT auth.uid())) AND (sender_role = 'homeowner') AND (claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid()))));
CREATE POLICY contractor_select_own_payment_failures ON payment_failures FOR SELECT USING (contractor_id IN (SELECT contractors.id FROM contractors WHERE contractors.user_id = (SELECT auth.uid())));
CREATE POLICY "Contractors can view biddable claim docs" ON objects FOR SELECT TO authenticated USING ((bucket_id = 'claim-documents') AND (EXISTS (SELECT 1 FROM (claims c JOIN contractors ct ON ((ct.user_id = auth.uid()) AND (ct.status = 'active')))
  WHERE ((c.id)::text = split_part(objects.name,'/',2)) AND (c.selected_contractor_id = ct.id) AND (c.platform_fee_charged IS TRUE))));

-- claims: the 8 live policies, verbatim text
CREATE POLICY "Contractors can view biddable claims" ON claims FOR SELECT USING ((ready_for_bids = true) AND (status = ANY (ARRAY['active','bidding','pending'])) AND ((SELECT auth.uid()) IN (SELECT contractors.user_id FROM contractors WHERE contractors.status = 'active')) AND ((is_test = false) OR ((is_test = true) AND ((SELECT auth.uid()) IN (SELECT contractors.user_id FROM contractors WHERE (contractors.status = 'active') AND (contractors.is_test = true))))));
CREATE POLICY "Contractors can view claims for their quotes" ON claims FOR SELECT TO authenticated USING (id IN (SELECT get_contractor_quote_claim_ids((SELECT auth.uid()))));
CREATE POLICY "Users can delete own claims" ON claims FOR DELETE USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can insert own claims" ON claims FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can update own claims" ON claims FOR UPDATE USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can view own claims" ON claims FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE POLICY claims_admin_select ON claims FOR SELECT USING (is_admin_email());
CREATE POLICY claims_admin_update ON claims FOR UPDATE USING (is_admin_email()) WITH CHECK (is_admin_email());

-- owner-run stand-in for bidder_claim_summary: same FROM/JOIN/WHERE as the live view, two columns
CREATE VIEW bidder_claim_summary WITH (security_barrier=true) AS
 SELECT c.id, c.damage_type FROM claims c JOIN contractors ct ON ct.user_id = (SELECT auth.uid())
 WHERE ct.status = 'active' AND c.ready_for_bids IS TRUE AND c.status = ANY (ARRAY['active','bidding','pending']) AND c.is_test = ct.is_test
    OR c.selected_contractor_id = ct.id OR EXISTS (SELECT 1 FROM quotes q WHERE q.claim_id = c.id AND q.contractor_id = ct.id);
GRANT SELECT ON bidder_claim_summary TO authenticated;


-- ---------------------------------------------------------------- data
INSERT INTO contractors VALUES
 ('a0000000-0000-0000-0000-00000000000a','a1000000-0000-0000-0000-00000000000a','active',false),
 ('b0000000-0000-0000-0000-00000000000b','b1000000-0000-0000-0000-00000000000b','active',false),
 ('c0000000-0000-0000-0000-00000000000c','c1000000-0000-0000-0000-00000000000c','active',false),
 ('d0000000-0000-0000-0000-00000000000d','d1000000-0000-0000-0000-00000000000d','active',false);
INSERT INTO claims VALUES
 ('11111111-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001','bidding',true,false,NULL,NULL,'1 Open St','Hank Open','hail',10000),
 ('22222222-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000002','awarded',false,false,'a0000000-0000-0000-0000-00000000000a',true,'2 Won Rd','Wanda Won','wind',20000),
 ('33333333-0000-0000-0000-000000000003','e1000000-0000-0000-0000-000000000001','awarded',false,false,'c0000000-0000-0000-0000-00000000000c',true,'3 Lost Ln','Hank Open','hail',30000);
INSERT INTO quotes(claim_id,contractor_id,status,total_price) VALUES
 ('11111111-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','submitted',9000),
 ('11111111-0000-0000-0000-000000000001','b0000000-0000-0000-0000-00000000000b','submitted',9500),
 ('22222222-0000-0000-0000-000000000002','a0000000-0000-0000-0000-00000000000a','selected',19000),
 ('33333333-0000-0000-0000-000000000003','b0000000-0000-0000-0000-00000000000b','declined',31000);

-- ---------------------------------------------------------------- snapshot function
CREATE TABLE snap (phase text, who text, ids text);
CREATE FUNCTION take_snap(p_phase text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r record; v text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
     ('kA_selected_quoted','a1000000-0000-0000-0000-00000000000a'),
     ('kB_bidder','b1000000-0000-0000-0000-00000000000b'),
     ('kC_selected_NO_quote','c1000000-0000-0000-0000-00000000000c'),
     ('kD_nonbidder','d1000000-0000-0000-0000-00000000000d'),
     ('homeowner_e1','e1000000-0000-0000-0000-000000000001'),
     ('homeowner_e2','e2000000-0000-0000-0000-000000000002')) AS t(who,uid) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', r.uid, 'role','authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT coalesce(string_agg(left(c.id::text,2), ',' ORDER BY c.id), '') INTO v FROM claims c;
    RESET ROLE;
    INSERT INTO snap VALUES (p_phase, r.who, v);
  END LOOP;
END $f$;

CREATE TABLE pol (phase text, h text);
CREATE FUNCTION take_pol(p_phase text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO pol SELECT p_phase, md5(string_agg(policyname||'|'||cmd||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), E'\n' ORDER BY policyname))
  FROM pg_policies WHERE schemaname='public' AND tablename='claims' $f$;

-- ---------------------------------------------------------------- phase LIVE
SELECT take_snap('1_live'); SELECT take_pol('1_live');

-- ---------------------------------------------------------------- phase UNAMENDED (negative control)
-- The draft as on main at sha 05e9a86c, inline: selected_contractor_id = own, no quote conjunction.
BEGIN;
DROP POLICY "Contractors can view biddable claims" ON public.claims;
DROP POLICY "Contractors can view claims for their quotes" ON public.claims;
CREATE POLICY "Contractors can view claims they are selected on" ON public.claims FOR SELECT TO authenticated
USING (selected_contractor_id IN (SELECT ct.id FROM public.contractors ct WHERE ct.user_id = (SELECT auth.uid())));
SELECT take_snap('2_unamended');
COMMIT;
-- back to live text through the rollback file, so the AMENDED phase starts from production's policies
\ir ../migrations_rollbacks/gh2559_claims_policy_narrow_rollback.sql
SELECT take_snap('2b_restored');

-- ---------------------------------------------------------------- phase AMENDED (the file in this repo)
\ir ../migrations/20261018220426_gh2559_claims_policy_narrow.sql
SELECT take_snap('3_amended');

-- ---------------------------------------------------------------- phase ROLLBACK (the file in this repo)
\ir ../migrations_rollbacks/gh2559_claims_policy_narrow_rollback.sql
SELECT take_snap('4_rollback'); SELECT take_pol('4_rollback');

-- ---------------------------------------------------------------- report
\pset format aligned
SELECT who, max(ids) FILTER (WHERE phase='1_live') AS live, max(ids) FILTER (WHERE phase='2_unamended') AS unamended_draft,
       max(ids) FILTER (WHERE phase='3_amended') AS amended_draft, max(ids) FILTER (WHERE phase='4_rollback') AS after_rollback
FROM snap GROUP BY who ORDER BY who;
SELECT phase, h AS claims_policy_fingerprint_md5 FROM pol ORDER BY phase;

-- ---------------------------------------------------------------- assertions
DO $chk$
DECLARE
  function_dummy int;
  bad text;
  g text := '';
  function_get text;
BEGIN
  -- helper
  CREATE TEMP TABLE s AS SELECT * FROM snap;
  -- 1. AMENDED: bidder and non-bidder read 0 base rows
  FOR bad IN SELECT who FROM s WHERE phase='3_amended' AND who IN ('kB_bidder','kD_nonbidder','kC_selected_NO_quote') AND ids <> '' LOOP
    RAISE EXCEPTION 'FAIL amended: % reads rows (%)', bad, (SELECT ids FROM s WHERE phase='3_amended' AND who=bad); END LOOP;
  -- 2. AMENDED: selected contractor with a quote keeps its row, only that one
  IF (SELECT ids FROM s WHERE phase='3_amended' AND who='kA_selected_quoted') <> '22' THEN
    RAISE EXCEPTION 'FAIL amended: kA should read exactly claim 22, got %', (SELECT ids FROM s WHERE phase='3_amended' AND who='kA_selected_quoted'); END IF;
  -- 3. NEGATIVE CONTROL: unamended draft lets kC (selected, NO quote) read 1 row; amended reads 0
  IF (SELECT ids FROM s WHERE phase='2_unamended' AND who='kC_selected_NO_quote') <> '33' THEN
    RAISE EXCEPTION 'FAIL control: unamended draft should give kC exactly claim 33'; END IF;
  -- 4. STRICT SUBSET: for every user, AMENDED rows are contained in LIVE rows; and no new row appears for anyone
  FOR bad IN SELECT a.who FROM s a JOIN s l ON l.who=a.who AND l.phase='1_live'
             WHERE a.phase='3_amended'
               AND EXISTS (SELECT 1 FROM unnest(string_to_array(a.ids,',')) x WHERE x <> '' AND x <> ALL(string_to_array(l.ids,','))) LOOP
    RAISE EXCEPTION 'FAIL subset: % gained a row under the amended draft', bad; END LOOP;
  -- 4b. control for the subset test: the UNAMENDED draft is NOT a subset (kC gains claim 33)
  IF NOT EXISTS (SELECT 1 FROM s a JOIN s l ON l.who=a.who AND l.phase='1_live'
             WHERE a.phase='2_unamended'
               AND EXISTS (SELECT 1 FROM unnest(string_to_array(a.ids,',')) x WHERE x <> '' AND x <> ALL(string_to_array(l.ids,',')))) THEN
    RAISE EXCEPTION 'FAIL control: subset test cannot see the unamended gain'; END IF;
  -- 5. homeowners unchanged in every phase
  IF EXISTS (SELECT 1 FROM s WHERE who LIKE 'homeowner%' GROUP BY who HAVING count(DISTINCT ids) <> 1) THEN
    RAISE EXCEPTION 'FAIL: a homeowner read changed between phases'; END IF;
  IF EXISTS (SELECT 1 FROM s l JOIN s r ON r.who=l.who AND r.phase='2b_restored' WHERE l.phase='1_live' AND l.ids IS DISTINCT FROM r.ids) THEN
    RAISE EXCEPTION 'FAIL rollback from the unamended state: reads differ from live'; END IF;
  -- 6. rollback restores every read and the policy text exactly
  IF EXISTS (SELECT 1 FROM s l JOIN s r ON r.who=l.who AND r.phase='4_rollback' WHERE l.phase='1_live' AND l.ids IS DISTINCT FROM r.ids) THEN
    RAISE EXCEPTION 'FAIL rollback: reads differ from live'; END IF;
  IF (SELECT count(DISTINCT h) FROM pol) <> 1 THEN
    RAISE EXCEPTION 'FAIL rollback: claims policy fingerprint differs from live'; END IF;
  RAISE NOTICE 'PROOF PASSED: amended reads: kB=0 kD=0 kC=0 kA=claim 22 only; unamended control: kC=1; subset holds for all users; rollback restores reads and policy text exactly';
END $chk$;
