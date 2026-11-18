-- gh-2988 proof: public.bidder_claim_summary masks rcv_amount, acv_amount and deductible_amount (NULL) while claims.loss_sheet_parsed_at IS NULL.
-- Forward : supabase/migrations_drafts/gh2988_bidder_summary_mask_unparsed_figures.sql
-- Rollback: supabase/migrations_drafts/gh2988_bidder_summary_mask_unparsed_figures_rollback.sql
-- Runner  : supabase/tests/gh2988_mask_proof_run.sh  (throwaway Postgres 16 in a temp dir; NEVER production; no production write of any kind).
-- Usage   : psql -v ON_ERROR_STOP=1 -v fwd=<forward file> -v rb=<rollback file> -f gh2988_mask_proof.sql   against a SCRATCH database that already holds the
--           stub schema (supabase/tests/gh2988_mask_proof_scratch_schema.sql) and the CURRENT view text (loaded by the runner from
--           supabase/migrations/20261020162602_gh2559_d390_redact_contact_until_fee.sql, md5 2e2eef13fe2bce2f68b0970c5e7f7c67 = live).
-- Roles are set the way PostgREST sets them: SET LOCAL ROLE authenticated + request.jwt.claim.sub (the stub auth.uid() reads it).
-- Fixtures (scratch only): K1 = an active contractor (a bidder); K2 = an active contractor who is the selected contractor on claim S.
--   A = open claim, parsed estimate (rcv 12000 / acv 8000 / deductible 1000) that is then SWAPPED: the claims_guard_a0_parse_state effect is simulated by
--       nulling loss_sheet_parsed_at, parsed_line_items and contractor_scope_summary (the guard never touches the three figures; that is the defect).
--   B = open claim, parsed (parsed_at set), figures 25000 / 20000 / 2500  -> NEGATIVE CONTROL: a parsed claim must keep its figures.
--   S = claim with K2 selected, unparsed, figures present                 -> the mask applies to every caller, the selected contractor included.
-- Phases: p0 = view as it is today; p1 = after the forward file; p2 = after the rollback file.
-- Expected: p0 A_swapped shows the OLD figures (the defect, the negative control for the mask); p1 A_swapped NULL x3; p1 B_parsed keeps; p1 S NULL;
--           p1 A_reparsed keeps; p2 A_swapped shows the old figures again (rollback restores the old behaviour); the other 37 columns identical in every phase;
--           claims data checksum identical before and after each migration; definition md5 back to the original after the rollback.
\set ON_ERROR_STOP on
\set QUIET on
CREATE TABLE gh2988_obs (phase text, label text, n int, rcv numeric, acv numeric, ded numeric, other_md5 text, defmd5 text, cols text, acl text, opts text, cmt text);
CREATE TABLE gh2988_data (phase text, claims_md5 text);
GRANT ALL ON gh2988_obs TO authenticated;
CREATE FUNCTION gh2988_probe(p_phase text, p_label text, p_user uuid, p_claim uuid) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE r record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) AS n, max(v.rcv_amount) AS rcv, max(v.acv_amount) AS acv, max(v.deductible_amount) AS ded,
         md5(string_agg((to_jsonb(v) - 'rcv_amount' - 'acv_amount' - 'deductible_amount')::text, '|' ORDER BY v.id)) AS om
    INTO r FROM public.bidder_claim_summary v WHERE v.id = p_claim;
  EXECUTE 'RESET ROLE';
  INSERT INTO gh2988_obs VALUES (p_phase, p_label, r.n, r.rcv, r.acv, r.ded, r.om,
    md5(pg_get_viewdef('public.bidder_claim_summary'::regclass, true)),
    (SELECT string_agg(a.attnum || ':' || a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) FROM pg_attribute a
       WHERE a.attrelid = 'public.bidder_claim_summary'::regclass AND a.attnum > 0 AND NOT a.attisdropped),
    (SELECT relacl::text FROM pg_class WHERE oid = 'public.bidder_claim_summary'::regclass),
    (SELECT reloptions::text FROM pg_class WHERE oid = 'public.bidder_claim_summary'::regclass),
    md5(obj_description('public.bidder_claim_summary'::regclass, 'pg_class')));
END $f$;

-- fixtures
INSERT INTO contractors (id, user_id, status, is_test) VALUES
 ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000b1','active',false),
 ('00000000-0000-4000-8000-0000000000a2','00000000-0000-4000-8000-0000000000b2','active',false);
INSERT INTO claims (id, status, ready_for_bids, trades, job_type, rcv_amount, acv_amount, deductible_amount, parsed_line_items, contractor_scope_summary, loss_sheet_parsed_at, estimate_filename, selected_contractor_id, platform_fee_charged) VALUES
 ('00000000-0000-4000-8000-00000000c0a1','active',true,'{roofing}','replacement',12000.00,8000.00,1000.00,'[{"d":"old line"}]','old scope',now(),'old.pdf',NULL,false),
 ('00000000-0000-4000-8000-00000000c0b1','active',true,'{roofing}','replacement',25000.00,20000.00,2500.00,'[{"d":"line"}]','scope',now(),'b.pdf',NULL,false),
 ('00000000-0000-4000-8000-00000000c0e1','active',true,'{roofing}','replacement',31000.00,24000.00,2000.00,NULL,NULL,NULL,'s.pdf','00000000-0000-4000-8000-0000000000a2',true);
\set k1 '00000000-0000-4000-8000-0000000000b1'
\set k2 '00000000-0000-4000-8000-0000000000b2'
\set cA '00000000-0000-4000-8000-00000000c0a1'
\set cB '00000000-0000-4000-8000-00000000c0b1'
\set cS '00000000-0000-4000-8000-00000000c0e1'

-- p0: today's view
SELECT gh2988_probe('p0','A_parsed',:'k1',:'cA') \g /dev/null
INSERT INTO gh2988_data SELECT 'p0', md5(string_agg(c::text,'|' ORDER BY id)) FROM claims c;
UPDATE claims SET loss_sheet_parsed_at = NULL, parsed_line_items = NULL, contractor_scope_summary = NULL WHERE id = :'cA';  -- the swap, as the guard leaves it
SELECT gh2988_probe('p0','A_swapped',:'k1',:'cA') \g /dev/null
SELECT gh2988_probe('p0','S_unparsed',:'k2',:'cS') \g /dev/null
SELECT gh2988_probe('p0','B_parsed',:'k1',:'cB') \g /dev/null
INSERT INTO gh2988_data SELECT 'p0b', md5(string_agg(c::text,'|' ORDER BY id)) FROM claims c;

-- forward
\i :fwd
INSERT INTO gh2988_data SELECT 'p1', md5(string_agg(c::text,'|' ORDER BY id)) FROM claims c;
SELECT gh2988_probe('p1','A_swapped',:'k1',:'cA') \g /dev/null
SELECT gh2988_probe('p1','B_parsed',:'k1',:'cB') \g /dev/null
SELECT gh2988_probe('p1','S_unparsed',:'k2',:'cS') \g /dev/null
UPDATE claims SET loss_sheet_parsed_at = now(), parsed_line_items = '[{"d":"new line"}]', contractor_scope_summary = 'new scope' WHERE id = :'cA';  -- re-parse completes
SELECT gh2988_probe('p1','A_reparsed',:'k1',:'cA') \g /dev/null
UPDATE claims SET loss_sheet_parsed_at = NULL, parsed_line_items = NULL, contractor_scope_summary = NULL WHERE id = :'cA';  -- back to the swapped state
INSERT INTO gh2988_data SELECT 'p1b', md5(string_agg(c::text,'|' ORDER BY id)) FROM claims c;

-- rollback
\i :rb
INSERT INTO gh2988_data SELECT 'p2', md5(string_agg(c::text,'|' ORDER BY id)) FROM claims c;
SELECT gh2988_probe('p2','A_swapped',:'k1',:'cA') \g /dev/null
SELECT gh2988_probe('p2','B_parsed',:'k1',:'cB') \g /dev/null

CREATE TABLE gh2988_res (n int, verdict text, name text, detail text);
INSERT INTO gh2988_res
WITH o AS (SELECT * FROM gh2988_obs),
 g AS (SELECT * FROM o WHERE phase='p0' AND label='A_swapped'),
 t(n, name, ok, detail) AS (
  SELECT 1, 'N0 negative control: with today''s view the swapped (unparsed) claim still shows the OLD rcv/acv/deductible to a bidder',
         (SELECT rcv=12000 AND acv=8000 AND ded=1000 AND n=1 FROM o WHERE phase='p0' AND label='A_swapped'),
         (SELECT 'rcv='||rcv||' acv='||acv||' ded='||ded FROM o WHERE phase='p0' AND label='A_swapped')
  UNION ALL SELECT 2, 'U1 after the forward file: swapped/unparsed claim returns the row with NULL rcv, acv and deductible',
         (SELECT n=1 AND rcv IS NULL AND acv IS NULL AND ded IS NULL FROM o WHERE phase='p1' AND label='A_swapped'),
         (SELECT 'n='||n||' rcv='||coalesce(rcv::text,'NULL')||' acv='||coalesce(acv::text,'NULL')||' ded='||coalesce(ded::text,'NULL') FROM o WHERE phase='p1' AND label='A_swapped')
  UNION ALL SELECT 3, 'P1 negative control of the mask: a PARSED claim keeps rcv/acv/deductible after the forward file',
         (SELECT n=1 AND rcv=25000 AND acv=20000 AND ded=2500 FROM o WHERE phase='p1' AND label='B_parsed'),
         (SELECT 'rcv='||rcv||' acv='||acv||' ded='||ded FROM o WHERE phase='p1' AND label='B_parsed')
  UNION ALL SELECT 4, 'P2 the same claim A shows its figures again once the re-parse sets loss_sheet_parsed_at (a settled parse is not masked)',
         (SELECT n=1 AND rcv=12000 AND acv=8000 AND ded=1000 FROM o WHERE phase='p1' AND label='A_reparsed'),
         (SELECT 'rcv='||rcv||' acv='||acv||' ded='||ded FROM o WHERE phase='p1' AND label='A_reparsed')
  UNION ALL SELECT 5, 'S1 selected contractor on an unparsed claim also reads NULL (mask is caller-independent; stated in the file header)',
         (SELECT n=1 AND rcv IS NULL AND acv IS NULL AND ded IS NULL FROM o WHERE phase='p1' AND label='S_unparsed'),
         (SELECT 'rcv='||coalesce(rcv::text,'NULL')||' acv='||coalesce(acv::text,'NULL')||' ded='||coalesce(ded::text,'NULL') FROM o WHERE phase='p1' AND label='S_unparsed')
  UNION ALL SELECT 6, 'S0 before the forward file the same selected-contractor row showed its figures',
         (SELECT n=1 AND rcv=31000 AND acv=24000 AND ded=2000 FROM o WHERE phase='p0' AND label='S_unparsed'),
         (SELECT 'rcv='||rcv||' acv='||acv||' ded='||ded FROM o WHERE phase='p0' AND label='S_unparsed')
  UNION ALL SELECT 7, 'R1 after the rollback the swapped claim shows the old figures again (rollback restores the old behaviour)',
         (SELECT n=1 AND rcv=12000 AND acv=8000 AND ded=1000 FROM o WHERE phase='p2' AND label='A_swapped'),
         (SELECT 'rcv='||rcv||' acv='||acv||' ded='||ded FROM o WHERE phase='p2' AND label='A_swapped')
  UNION ALL SELECT 8, 'R2 after the rollback the parsed claim still shows its figures',
         (SELECT rcv=25000 AND acv=20000 AND ded=2500 FROM o WHERE phase='p2' AND label='B_parsed'), 'parsed control'
  UNION ALL SELECT 9, 'D1 the other 37 columns of claim A are byte-identical in p0, p1 and p2 (only the three figures change)',
         (SELECT count(DISTINCT other_md5)=1 FROM o WHERE label='A_swapped'), (SELECT string_agg(DISTINCT left(other_md5,8),',') FROM o WHERE label='A_swapped')
  UNION ALL SELECT 10, 'D2 the other 37 columns of the parsed claim B are identical before/after',
         (SELECT count(DISTINCT other_md5)=1 FROM o WHERE label='B_parsed'), (SELECT string_agg(DISTINCT left(other_md5,8),',') FROM o WHERE label='B_parsed')
  UNION ALL SELECT 11, 'C1 column names, order and types (40 columns, rcv/acv/deductible numeric(10,2) at 16/17/18) identical in every phase',
         (SELECT count(DISTINCT cols)=1 AND bool_and(cols LIKE '%16:rcv_amount:numeric(10,2),17:acv_amount:numeric(10,2),18:deductible_amount:numeric(10,2)%') AND bool_and(length(cols)-length(replace(cols,':',''))=80) FROM o), 'signature'
  UNION ALL SELECT 12, 'G1 grants (relacl), reloptions (security_barrier) and view comment identical in every phase',
         (SELECT count(DISTINCT acl)=1 AND count(DISTINCT opts)=1 AND count(DISTINCT cmt)=1 AND bool_and(opts='{security_barrier=true}') FROM o),
         (SELECT min(acl)||' '||min(opts) FROM o)
  UNION ALL SELECT 13, 'M1 definition md5 differs between p0 and p1, and the rollback restores the p0 md5 exactly',
         (SELECT (SELECT defmd5 FROM o WHERE phase='p0' AND label='A_swapped') <> (SELECT defmd5 FROM o WHERE phase='p1' AND label='A_swapped')
             AND (SELECT defmd5 FROM o WHERE phase='p0' AND label='A_swapped') = (SELECT defmd5 FROM o WHERE phase='p2' AND label='A_swapped')),
         (SELECT string_agg(phase||'='||left(defmd5,8),' ' ORDER BY phase) FROM (SELECT DISTINCT phase, defmd5 FROM o) z)
  UNION ALL SELECT 14, 'X1 no data change: claims checksum identical before and after the forward file and after the rollback (apart from the test steps themselves)',
         (SELECT (SELECT claims_md5 FROM gh2988_data WHERE phase='p0b') = (SELECT claims_md5 FROM gh2988_data WHERE phase='p1')
             AND (SELECT claims_md5 FROM gh2988_data WHERE phase='p1b') = (SELECT claims_md5 FROM gh2988_data WHERE phase='p2')),
         (SELECT string_agg(phase||'='||left(claims_md5,8),' ' ORDER BY phase) FROM gh2988_data)
 )
SELECT n, CASE WHEN ok IS TRUE THEN 'PASS' ELSE 'FAIL' END, name, detail FROM t;
\set QUIET off
\pset format aligned
SELECT * FROM gh2988_res ORDER BY n;
SELECT 1000 AS n, CASE WHEN count(*) FILTER (WHERE verdict='FAIL')=0 THEN 'PASS' ELSE 'FAIL' END AS verdict, 'OVERALL' AS name,
       count(*) FILTER (WHERE verdict='PASS')||' PASS, '||count(*) FILTER (WHERE verdict='FAIL')||' FAIL' AS detail FROM gh2988_res;
