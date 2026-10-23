-- gh-2881 digit-fold PROOF (review 6256286136 O1). THROWAWAY POSTGRES ONLY. Run via supabase/tests/gh2881_d390_digit_fold_proof_run.sh (it builds :applied_view).
-- Phases: A-before (PR #2880's migration applied, NO digit fold: U13/U14 LEAK = the NEGATIVE CONTROL) -> gh2881_d390_digit_fold.sql -> B-after (redacted;
-- plain job text unchanged) -> forward run twice -> C-rollback (leak again, view text == phase A). Runs in one rolled-back session.
\set ON_ERROR_STOP on
\i supabase/tests/gh2559_d390_redact_proof_model.sql
\i supabase/migrations_drafts/gh2559_d390_redact_contact_until_fee.sql
CREATE FUNCTION t.arind(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT translate(p, '0123456789', U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669') $$;
CREATE FUNCTION t.extarind(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT translate(p, '0123456789', U&'\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9') $$;
-- a probe LEAKS when the phone tail survives after the output's Arabic-Indic digits are read as ASCII
CREATE FUNCTION t.leaks(p text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL AND translate(p, U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9', '01234567890123456789') ~ '0142' $$;
CREATE TABLE t.dcorpus (label text, txt text, must_redact boolean);
INSERT INTO t.dcorpus VALUES
 ('U13 Arabic-Indic digits, ASCII dashes', 'call ' || t.arind('317-555-0142') || ' after five', true),
 ('U13b Arabic-Indic digits, contiguous', 'cell ' || t.arind('3175550142') || ' ok', true),
 ('U14 Extended Arabic-Indic digits, contiguous', 'call ' || t.extarind('3175550142') || ' after five', true),
 ('U14b Extended Arabic-Indic digits, parenthesised', 'call (' || t.extarind('317') || ') ' || t.extarind('555-0142') || ' now', true),
 ('U12 ASCII phone (plain control)', 'call 317-555-0142 now', true);
CREATE TABLE t.keep (label text, txt text);
-- (this function over-redacts dates and long figures by design on non-contract views; the Scope of Work uses its own narrower path. Only plain job text must survive here.)
INSERT INTO t.keep VALUES ('prose and a 4-digit figure', 'Tree fell on the back slope, 2400 sq ft'), ('pitch', 'Two layers, 30 squares, 8/12 pitch');
CREATE FUNCTION t.digit_probes(p_phase text, p_expect_leak boolean) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  KS text := '00000000-0000-0000-0000-0000000000b1'; C1 text := '20000000-0000-0000-0000-0000000000c1'; H text := '00000000-0000-0000-0000-0000000000a1';
  r record; got text; lk boolean; exp_leak boolean;
BEGIN
  FOR r IN SELECT * FROM t.dcorpus ORDER BY label LOOP
    exp_leak := p_expect_leak AND r.label !~ '^U12';
    got := public.d390_redact_contact(r.txt); lk := t.leaks(got);
    INSERT INTO t.results VALUES (p_phase, 'F ' || r.label, 'function: ' || CASE WHEN lk THEN 'LEAKS' ELSE 'redacted' END, lk = exp_leak);
    UPDATE public.claims SET homeowner_notes = r.txt WHERE id = C1::uuid;
    got := t.as_user('authenticated', KS, format($q$SELECT homeowner_notes FROM public.bidder_claim_summary WHERE id = %L$q$, C1)); lk := t.leaks(got);
    INSERT INTO t.results VALUES (p_phase, 'N ' || r.label, 'notes view (selected contractor): ' || CASE WHEN lk THEN 'LEAKS' ELSE 'redacted' END, lk = exp_leak);
    DELETE FROM public.messages WHERE claim_id = C1::uuid AND created_at = '2026-01-02 10:00+00';
    INSERT INTO public.messages (claim_id, sender_id, sender_role, body, created_at) VALUES (C1::uuid, H::uuid, 'homeowner', r.txt, '2026-01-02 10:00+00');
    got := t.as_user('authenticated', KS, format($q$SELECT body FROM public.contractor_thread_messages WHERE claim_id = %L AND sender_role = 'homeowner' AND created_at = '2026-01-02 10:00+00'$q$, C1)); lk := t.leaks(got);
    INSERT INTO t.results VALUES (p_phase, 'T ' || r.label, 'thread view: ' || CASE WHEN lk THEN 'LEAKS' ELSE 'redacted' END, lk = exp_leak);
    DELETE FROM public.messages WHERE claim_id = C1::uuid AND created_at = '2026-01-02 10:00+00';
  END LOOP;
  FOR r IN SELECT * FROM t.keep ORDER BY label LOOP
    got := public.d390_redact_contact(r.txt);
    INSERT INTO t.results VALUES (p_phase, 'K ' || r.label, 'function leaves it as typed: ' || (got = r.txt)::text, got = r.txt);
  END LOOP;
  UPDATE public.claims SET homeowner_notes = 'Call me on 317-555-0142 or write zelda.q@example.invalid. Tree fell on the back slope.' WHERE id = C1::uuid;
END $f$;
SELECT t.digit_probes('A-before', true);
INSERT INTO t.snap VALUES ('viewA', md5(pg_get_viewdef('public.bidder_claim_summary'::regclass))), ('fnA', md5(pg_get_functiondef('public.d390_redact_contact(text)'::regprocedure)));
\i supabase/migrations_drafts/gh2881_d390_digit_fold.sql
SELECT t.digit_probes('B-after', false);
\i supabase/migrations_drafts/gh2881_d390_digit_fold.sql
SELECT t.digit_probes('B2-after-rerun', false);
INSERT INTO t.results SELECT 'B-after', 'G1 view and function changed by the forward file',
  (md5(pg_get_viewdef('public.bidder_claim_summary'::regclass)) <> (SELECT v FROM t.snap WHERE k='viewA'))::text || '/' || (md5(pg_get_functiondef('public.d390_redact_contact(text)'::regprocedure)) <> (SELECT v FROM t.snap WHERE k='fnA'))::text,
  md5(pg_get_viewdef('public.bidder_claim_summary'::regclass)) <> (SELECT v FROM t.snap WHERE k='viewA') AND md5(pg_get_functiondef('public.d390_redact_contact(text)'::regprocedure)) <> (SELECT v FROM t.snap WHERE k='fnA');
INSERT INTO t.results SELECT 'B-after', 'G2 grants unchanged: authenticated SELECT on the view, anon none, EXECUTE on the function as before',
  has_table_privilege('authenticated','public.bidder_claim_summary','SELECT')::text || '/' || has_table_privilege('anon','public.bidder_claim_summary','SELECT')::text,
  has_table_privilege('authenticated','public.bidder_claim_summary','SELECT') AND NOT has_table_privilege('anon','public.bidder_claim_summary','SELECT');
\i supabase/migrations_drafts/gh2881_d390_digit_fold_rollback.sql
\i supabase/migrations_drafts/gh2881_d390_digit_fold_rollback.sql
SELECT t.digit_probes('C-rollback', true);
INSERT INTO t.results SELECT 'C-rollback', 'R1 view and function text restored to the pre-fold md5',
  'view/fn', md5(pg_get_viewdef('public.bidder_claim_summary'::regclass)) = (SELECT v FROM t.snap WHERE k='viewA') AND md5(pg_get_functiondef('public.d390_redact_contact(text)'::regprocedure)) = (SELECT v FROM t.snap WHERE k='fnA');
\echo ==== RESULTS (phase | probe | detail | ok) ====
SELECT phase, probe, detail, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS verdict FROM t.results WHERE phase ~ '^(A|B|C)' ORDER BY phase, probe;
SELECT count(*) FILTER (WHERE NOT ok) AS failures, count(*) AS probes FROM t.results WHERE phase ~ '^(A|B|C)' \gset
\echo failures=:failures probes=:probes
DO $v$ BEGIN IF (SELECT count(*) FROM t.results WHERE phase ~ '^(A|B|C)' AND NOT ok) > 0 THEN RAISE EXCEPTION 'PROOF FAILED'; END IF; END $v$;
