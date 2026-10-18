-- gh-2559 / D-390 proof. THROWAWAY POSTGRES ONLY. Run via supabase/tests/gh2559_d390_redact_proof_run.sh (it builds :applied_view and passes the file paths).
-- Phases: 1-live (applied bidder view, PR #2777 policies; the leak is the NEGATIVE CONTROL) -> forward draft -> 2-new -> fee flips on C1 -> 3-rollback.
\set ON_ERROR_STOP on
\i supabase/tests/gh2559_d390_redact_proof_model.sql
SELECT t.run_phase('1-live', 'live');
\i supabase/migrations_drafts/gh2559_d390_redact_contact_until_fee.sql
SELECT t.run_phase('2-new', 'new');
-- the forward file can be run twice (idempotent: CREATE OR REPLACE, DROP POLICY IF EXISTS)
\i supabase/migrations_drafts/gh2559_d390_redact_contact_until_fee.sql
SELECT t.run_phase('2b-new-rerun', 'new');
-- the fee clears on C1: the same reads now return the text as typed, on both surfaces
UPDATE public.claims SET platform_fee_charged = true WHERE id = '20000000-0000-0000-0000-0000000000c1';
INSERT INTO t.results SELECT '2c-fee-cleared', 'F1 selected contractor, view notes, fee now charged',
  t.flags(t.as_user('authenticated','00000000-0000-0000-0000-0000000000b1',$q$SELECT homeowner_notes FROM public.bidder_claim_summary WHERE id='20000000-0000-0000-0000-0000000000c1'$q$)),
  t.flags(t.as_user('authenticated','00000000-0000-0000-0000-0000000000b1',$q$SELECT homeowner_notes FROM public.bidder_claim_summary WHERE id='20000000-0000-0000-0000-0000000000c1'$q$)) = 'has_phone=true,has_email=true';
INSERT INTO t.results SELECT '2c-fee-cleared', 'F2 selected contractor, thread view homeowner msg, fee now charged',
  t.flags(t.as_user('authenticated','00000000-0000-0000-0000-0000000000b1',$q$SELECT body FROM public.contractor_thread_messages WHERE claim_id='20000000-0000-0000-0000-0000000000c1' AND sender_role='homeowner'$q$)),
  t.flags(t.as_user('authenticated','00000000-0000-0000-0000-0000000000b1',$q$SELECT body FROM public.contractor_thread_messages WHERE claim_id='20000000-0000-0000-0000-0000000000c1' AND sender_role='homeowner'$q$)) = 'has_phone=true,has_email=true';
INSERT INTO t.results SELECT '2c-fee-cleared', 'F3 selected contractor, base messages homeowner rows, fee now charged',
  t.as_user('authenticated','00000000-0000-0000-0000-0000000000b1',$q$SELECT count(*)::text FROM public.messages WHERE claim_id='20000000-0000-0000-0000-0000000000c1' AND sender_role='homeowner'$q$),
  t.as_user('authenticated','00000000-0000-0000-0000-0000000000b1',$q$SELECT count(*)::text FROM public.messages WHERE claim_id='20000000-0000-0000-0000-0000000000c1' AND sender_role='homeowner'$q$) = '1';
-- NULL fee flag behaves like false (the column is nullable): redacts
UPDATE public.claims SET platform_fee_charged = NULL WHERE id = '20000000-0000-0000-0000-0000000000c1';
INSERT INTO t.results SELECT '2d-fee-null', 'F4 fee flag NULL redacts like false',
  t.flags(t.as_user('authenticated','00000000-0000-0000-0000-0000000000b1',$q$SELECT homeowner_notes FROM public.bidder_claim_summary WHERE id='20000000-0000-0000-0000-0000000000c1'$q$)),
  t.flags(t.as_user('authenticated','00000000-0000-0000-0000-0000000000b1',$q$SELECT homeowner_notes FROM public.bidder_claim_summary WHERE id='20000000-0000-0000-0000-0000000000c1'$q$)) = 'has_phone=false,has_email=false';
UPDATE public.claims SET platform_fee_charged = false WHERE id = '20000000-0000-0000-0000-0000000000c1';
-- the function, direct: shapes it must remove and plain job text it must keep
INSERT INTO t.results SELECT '2e-function', 'U' || n, left(r, 0) || CASE WHEN r = e THEN 'as expected' ELSE 'MISMATCH' END, r = e
FROM (SELECT row_number() OVER () n, public.d390_redact_contact(i) r, e FROM (VALUES
  ('call 317-555-0142 now', 'call [removed] now'),
  ('(317) 555-0142', '[removed]'),
  ('317.555.0142', '[removed]'),
  ('3175550142', '[removed] '),
  ('+1 317 555 0142', '+1 [removed]'),
  ('555/0142', '[removed]'),
  ('mail me at a.b+c@example.com ok', 'mail me at [removed] ok'),
  ('me at example dot com', '[removed]'),
  ('Two layers, 30 squares, 8/12 pitch, 2400 sq ft.', 'Two layers, 30 squares, 8/12 pitch, 2400 sq ft.'),
  ('Tree fell on the back slope', 'Tree fell on the back slope')) v(i, e)) q;
\i supabase/migrations_drafts/gh2559_d390_redact_contact_until_fee_rollback.sql
SELECT t.run_phase('4-after-rollback', 'live');
\echo ==== RESULTS (phase | probe | detail | ok) ====
SELECT phase, probe, detail, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS verdict FROM t.results ORDER BY phase, probe;
SELECT count(*) FILTER (WHERE NOT ok) AS failures, count(*) AS probes FROM t.results \gset
\echo failures=:failures probes=:probes
DO $v$ BEGIN IF (SELECT count(*) FROM t.results WHERE NOT ok) > 0 THEN RAISE EXCEPTION 'PROOF FAILED'; END IF; END $v$;
