-- gh-3217 proof: partners can no longer read referred homeowners' email/phone; get_my_referrals() returns masked names only
-- (draft migrations supabase/migrations_drafts/gh3217a_get_my_referrals.sql = Part A, additive, and gh3217b_referrals_column_allowlist.sql = Part B, the lockdown).
-- Run against production (yeszghaspzwwstvsrioa) as ONE statement batch that is forced to roll back: every row below is a fixture
-- created inside the transaction (auth users, referral agents, referrals, all is_test=true unless a step says otherwise), no real
-- row is read or written, and the last statement is a deliberate RAISE EXCEPTION, so nothing commits (same pattern as
-- gh2997_inherit_is_test_proof.sql).
--   BEFORE the fix : run this file alone.  -> the defect: A1-A4 return data instead of ERR 42501; F1 'ERR 42883' (no function).
--   A ONLY         : replace the @@MIGRATION@@ line with Part A's body (nothing removed: direct reads still work, the RPC is masked).
--   A + B          : replace it with Part A then Part B (BEGIN;/COMMIT; lines removed), same batch  -> the 'Expected AFTER' list below.
--   B ROLLED BACK  : A, B, then B's rollback body (grants restored, function kept)  -> as A ONLY.
--   A ROLLED BACK  : A then A's rollback (function dropped; only valid before the frontend deploys)  -> as BEFORE.
-- Sessions are simulated with SET LOCAL ROLE + request.jwt.claims; a failed statement reports 'ERR <sqlstate>'.
-- Fixture data: partner A owns referrals 'Jane Q Public' (email/phone set), one with a NULL name, one whose name field holds an
--   email address; partner B owns 'Bob Builder'; H is a homeowner (auth user, no referral_agents row).
-- Expected AFTER:
--   P1  anon/authenticated EXECUTE on get_my_referrals -> false,true ; column SELECT homeowner_email/phone/name/metadata for authenticated -> false,false,false,false
--   A1  A: select homeowner_email            -> ERR 42501      A2 homeowner_phone -> ERR 42501   A3 homeowner_name -> ERR 42501
--   A4  A: select *                          -> ERR 42501      A5 metadata -> ERR 42501
--   A6  A: select id,status (allowed cols)   -> 3 rows (own only)     A7 A reading B's rows by id -> 0
--   F1  A: get_my_referrals count            -> 3              F2 display names -> Jane P.,<NULL>,<NULL>  (a name field holding an email, and a NULL name, are not shown)
--   F3  A: row text contains a contact value -> 0              F4 B's name in A's list -> 0
--   F5  result columns mention email/phone/address/city -> false
--   B1  B: get_my_referrals count / names    -> 1 / Bob B.     B2 B sees Jane -> 0
--   H1  homeowner H: get_my_referrals -> 0 ; H2 select homeowner_email -> ERR 42501 ; H3 select id from referrals -> 0
--   N1  anon: get_my_referrals -> ERR 42501 ; N2 anon select id from referrals -> ERR 42501
--   S1  service_role still reads the contact columns (fixture rows with email) -> 4
--   D1  admin session: admin_list_referrals() still returns homeowner_email for the fixture rows (flipped to is_test=false in-txn) -> 3

CREATE TEMP TABLE _r(k text, v text) ON COMMIT DROP;
-- (migration body is spliced here for the AFTER run; the BEFORE run has nothing here)
-- @@MIGRATION@@

-- no admin-notification HTTP call for fixture partners (rolled back with everything else)
ALTER TABLE public.referral_agents DISABLE TRIGGER trg_notify_admin_new_partner;

-- run a scalar query as a simulated session; returns its text value, or 'ERR <sqlstate>'
CREATE FUNCTION pg_temp.as_sess(p_role text, p_uid uuid, p_email text, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text
         ELSE json_build_object('sub', p_uid, 'role', p_role, 'email', p_email)::text END, true);
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := 'ERR ' || SQLSTATE;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN coalesce(v, '<NULL>');
END $f$;

-- fixtures
INSERT INTO auth.users(id, email) VALUES
  ('a3217000-0000-4000-8000-00000000000a','gh3217-a@example.invalid'),
  ('a3217000-0000-4000-8000-00000000000b','gh3217-b@example.invalid'),
  ('a3217000-0000-4000-8000-00000000000c','gh3217-h@example.invalid');
INSERT INTO referral_agents(id, agent_type, first_name, last_name, email, unique_code, user_id, is_test) VALUES
  ('b3217000-0000-4000-8000-00000000000a','re_agent','Proof','A','gh3217-a@example.invalid','GH3217A','a3217000-0000-4000-8000-00000000000a',true),
  ('b3217000-0000-4000-8000-00000000000b','re_agent','Proof','B','gh3217-b@example.invalid','GH3217B','a3217000-0000-4000-8000-00000000000b',true);
INSERT INTO referrals(id, referral_agent_id, homeowner_name, homeowner_email, homeowner_phone, status, is_test) VALUES
  ('c3217000-0000-4000-8000-000000000001','b3217000-0000-4000-8000-00000000000a','Jane Q Public','jane.proof@example.invalid','317-555-0199','registered',true),
  ('c3217000-0000-4000-8000-000000000002','b3217000-0000-4000-8000-00000000000a',NULL,'nameless.proof@example.invalid','317-555-0198','clicked',true),
  ('c3217000-0000-4000-8000-000000000003','b3217000-0000-4000-8000-00000000000a','leak.proof@example.invalid','leak.proof@example.invalid','317-555-0197','registered',true),
  ('c3217000-0000-4000-8000-000000000004','b3217000-0000-4000-8000-00000000000b','Bob Builder','bob.proof@example.invalid','317-555-0196','registered',true);

INSERT INTO _r SELECT 'P1 EXECUTE get_my_referrals anon,authenticated (want false,true)',
  CASE WHEN to_regprocedure('public.get_my_referrals()') IS NULL THEN 'absent'
       ELSE has_function_privilege('anon','public.get_my_referrals()','EXECUTE')::text || ',' || has_function_privilege('authenticated','public.get_my_referrals()','EXECUTE')::text END;
INSERT INTO _r SELECT 'P1 authenticated column SELECT email,phone,name,metadata (want false x4)',
  has_column_privilege('authenticated','public.referrals','homeowner_email','SELECT')::text || ',' ||
  has_column_privilege('authenticated','public.referrals','homeowner_phone','SELECT')::text || ',' ||
  has_column_privilege('authenticated','public.referrals','homeowner_name','SELECT')::text || ',' ||
  has_column_privilege('authenticated','public.referrals','metadata','SELECT')::text;

-- partner A (negative controls: direct contact reads)
INSERT INTO _r SELECT 'A1 A select homeowner_email', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000a','gh3217-a@example.invalid','select homeowner_email from referrals limit 1');
INSERT INTO _r SELECT 'A2 A select homeowner_phone', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000a','gh3217-a@example.invalid','select homeowner_phone from referrals limit 1');
INSERT INTO _r SELECT 'A3 A select homeowner_name', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000a','gh3217-a@example.invalid','select homeowner_name from referrals limit 1');
INSERT INTO _r SELECT 'A4 A select * ', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000a','gh3217-a@example.invalid','select count(*) from (select * from referrals) x');
INSERT INTO _r SELECT 'A5 A select metadata', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000a','gh3217-a@example.invalid','select metadata::text from referrals limit 1');
INSERT INTO _r SELECT 'A6 A select id,status (rows visible)', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000a','gh3217-a@example.invalid','select count(*) from (select id, status from referrals) x');
INSERT INTO _r SELECT 'A7 A reads B''s referral by id', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000a','gh3217-a@example.invalid','select count(*) from referrals where id = ''c3217000-0000-4000-8000-000000000004''');
-- partner A via the RPC
INSERT INTO _r SELECT 'F1 A get_my_referrals count', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000a','gh3217-a@example.invalid','select count(*) from get_my_referrals()');
INSERT INTO _r SELECT 'F2 A display names (null last)', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000a','gh3217-a@example.invalid','select string_agg(coalesce(display_name,''<NULL>''), '','' order by display_name) from get_my_referrals()');
INSERT INTO _r SELECT 'F3 A rows containing a contact value or last name (want 0)', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000a','gh3217-a@example.invalid','select count(*) from get_my_referrals() g where to_jsonb(g)::text ~* ''example.invalid|555-01|Public''');
INSERT INTO _r SELECT 'F4 A sees B''s referral (want 0)', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000a','gh3217-a@example.invalid','select count(*) from get_my_referrals() where id = ''c3217000-0000-4000-8000-000000000004''');
INSERT INTO _r SELECT 'F5 result columns mention email/phone/address/city (want false)',
  CASE WHEN to_regprocedure('public.get_my_referrals()') IS NULL THEN 'absent'
       ELSE (pg_get_function_result(to_regprocedure('public.get_my_referrals()')) ~* 'email|phone|address|city')::text END;
-- partner B
INSERT INTO _r SELECT 'B1 B get_my_referrals count', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000b','gh3217-b@example.invalid','select count(*) from get_my_referrals()');
INSERT INTO _r SELECT 'B1 B display names', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000b','gh3217-b@example.invalid','select string_agg(coalesce(display_name,''<NULL>''), '','') from get_my_referrals()');
INSERT INTO _r SELECT 'B2 B sees Jane (want 0)', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000b','gh3217-b@example.invalid','select count(*) from get_my_referrals() where id = ''c3217000-0000-4000-8000-000000000001''');
-- homeowner session (no referral_agents row)
INSERT INTO _r SELECT 'H1 homeowner get_my_referrals count', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000c','gh3217-h@example.invalid','select count(*) from get_my_referrals()');
INSERT INTO _r SELECT 'H2 homeowner select homeowner_email', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000c','gh3217-h@example.invalid','select homeowner_email from referrals limit 1');
INSERT INTO _r SELECT 'H3 homeowner select id from referrals', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000c','gh3217-h@example.invalid','select count(*) from (select id from referrals) x');
-- signed-out
INSERT INTO _r SELECT 'N1 anon get_my_referrals', pg_temp.as_sess('anon', NULL, NULL, 'select count(*) from get_my_referrals()');
INSERT INTO _r SELECT 'N2 anon select id from referrals', pg_temp.as_sess('anon', NULL, NULL, 'select count(*) from (select id from referrals) x');
-- service role (edge functions) keeps the contact columns
INSERT INTO _r SELECT 'S1 service_role fixture rows with email', pg_temp.as_sess('service_role', NULL, NULL, 'select count(*) from referrals where referral_agent_id in (''b3217000-0000-4000-8000-00000000000a'',''b3217000-0000-4000-8000-00000000000b'') and homeowner_email is not null');
-- admin pages: admin_list_referrals() hides is_test rows, so flip the fixtures to real inside this transaction
UPDATE referral_agents SET is_test = false WHERE id IN ('b3217000-0000-4000-8000-00000000000a','b3217000-0000-4000-8000-00000000000b');
UPDATE referrals SET is_test = false WHERE id IN ('c3217000-0000-4000-8000-000000000001','c3217000-0000-4000-8000-000000000002','c3217000-0000-4000-8000-000000000003');
INSERT INTO _r SELECT 'D1 admin_list_referrals fixture rows with homeowner_email (want 3)', pg_temp.as_sess('authenticated','a3217000-0000-4000-8000-00000000000a','dustin@otterquote.com','select count(*) from admin_list_referrals() where id in (''c3217000-0000-4000-8000-000000000001'',''c3217000-0000-4000-8000-000000000002'',''c3217000-0000-4000-8000-000000000003'') and homeowner_email is not null');

DO $f$
DECLARE s text;
BEGIN
  SELECT string_agg(k || ' => ' || coalesce(v,'NULL'), E'\n' ORDER BY k) INTO s FROM _r;
  RAISE EXCEPTION E'GH3217 PROOF (forced rollback)\n%', s USING ERRCODE = 'P0U01';
END $f$;
