-- gh-2559 / D-390 proof: Unicode probes (review 6256187448 D1) and bidder-view parity. THROWAWAY POSTGRES ONLY. Included by gh2559_d390_redact_proof.sql.
-- NEGATIVE CONTROL expectations: every form leaked before the fix except U06 and U09 (zero-width characters are non-alphanumeric separators, so the old patterns already caught them) and the plain U12 control.
-- A probe LEAKS when the phone tail (0142) or the e-mail local part / domain (zelda, example) is still readable after NFKC folding the output.
CREATE FUNCTION t.fwall(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg(CASE WHEN ascii(c) BETWEEN 33 AND 126 THEN chr(ascii(c) + 65248) ELSE c END, '' ORDER BY n) FROM regexp_split_to_table(p, '') WITH ORDINALITY AS s(c, n) $$;
CREATE FUNCTION t.circ(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg(CASE WHEN c ~ '[0-9]' THEN chr(CASE WHEN c = '0' THEN 9450 ELSE 9311 + c::int END) ELSE c END, '' ORDER BY n) FROM regexp_split_to_table(p, '') WITH ORDINALITY AS s(c, n) $$;
CREATE FUNCTION t.mathbold(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg(CASE WHEN c ~ '[0-9]' THEN chr(120782 + c::int) ELSE c END, '' ORDER BY n) FROM regexp_split_to_table(p, '') WITH ORDINALITY AS s(c, n) $$;
CREATE FUNCTION t.zw(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg(c, chr(8203) ORDER BY n) FROM regexp_split_to_table(p, '') WITH ORDINALITY AS s(c, n) $$;
CREATE FUNCTION t.leaks(p text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT p IS NOT NULL AND normalize(p, NFKC) ~* '0142|zelda|example' $$;
-- the corpus: (label, text with a phone or an e-mail address in a Unicode form)
CREATE TABLE t.ucorpus (label text, txt text);
INSERT INTO t.ucorpus VALUES
 ('U01 full-width phone digits, ASCII dashes', 'call ' || translate('317-555-0142', '0123456789', U&'\FF10\FF11\FF12\FF13\FF14\FF15\FF16\FF17\FF18\FF19') || ' after five'),
 ('U02 full-width phone, full-width dashes', 'call ' || translate('317-555-0142', '0123456789-', U&'\FF10\FF11\FF12\FF13\FF14\FF15\FF16\FF17\FF18\FF19\FF0D') || ' after five'),
 ('U03 full-width phone with full-width brackets', t.fwall('(317) 555-0142')),
 ('U04 circled digits', 'cell ' || t.circ('3175550142') || ' ok'),
 ('U05 mathematical bold digits', 'cell ' || t.mathbold('317-555-0142') || ' ok'),
 ('U06 zero-width spaces inside a phone (held before the fix too)', 'cell ' || t.zw('317-555-0142') || ' ok'),
 ('U07 e-mail with full-width at-sign only', 'mail zelda.q' || U&'\FF20' || 'example.invalid ok'),
 ('U08 e-mail wholly full-width', 'mail ' || t.fwall('zelda.q@example.invalid') || ' ok'),
 ('U09 e-mail with soft hyphen and zero-width space (held before the fix too)', 'mail zel' || U&'\00AD' || 'da.q' || U&'\200B' || '@example.invalid ok'),
 ('U10 e-mail spelled at/dot in full-width letters', 'mail ' || t.fwall('zelda.q at example dot invalid') || ' ok'),
 ('U11 e-mail with small commercial at (U+FE6B)', 'mail zelda.q' || U&'\FE6B' || 'example.invalid ok'),
 ('U12 ASCII phone and e-mail (plain control, must also redact)', 'call 317-555-0142 or zelda.q@example.invalid');
-- the probes: function direct (the path of the Scope of Work and the notification e-mail, which call the function by rpc), the bidder view as the
-- SELECTED contractor before the fee (notes), and the thread view (homeowner-sent message). p_expect_leak = true runs the NEGATIVE CONTROL.
CREATE FUNCTION t.unicode_probes(p_phase text, p_expect_leak boolean) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  KS text := '00000000-0000-0000-0000-0000000000b1'; C1 text := '20000000-0000-0000-0000-0000000000c1'; H text := '00000000-0000-0000-0000-0000000000a1';
  r record; got text; lk boolean;
BEGIN
  FOR r IN SELECT * FROM t.ucorpus ORDER BY label LOOP
    -- function direct
    got := public.d390_redact_contact(r.txt); lk := t.leaks(got);
    INSERT INTO t.results VALUES (p_phase, 'F ' || r.label, 'function: ' || CASE WHEN lk THEN 'LEAKS' ELSE 'redacted' END,
      CASE WHEN p_expect_leak AND r.label !~ '^U(12|06|09)' THEN lk ELSE NOT lk END);
    -- notes via the bidder view, selected contractor, fee not charged
    UPDATE public.claims SET homeowner_notes = r.txt WHERE id = C1::uuid;
    got := t.as_user('authenticated', KS, format($q$SELECT homeowner_notes FROM public.bidder_claim_summary WHERE id = %L$q$, C1)); lk := t.leaks(got);
    INSERT INTO t.results VALUES (p_phase, 'N ' || r.label, 'notes view: ' || CASE WHEN lk THEN 'LEAKS' ELSE 'redacted' END,
      CASE WHEN p_expect_leak AND r.label !~ '^U(12|06|09)' THEN lk ELSE NOT lk END);
    -- thread view, homeowner-sent message, fee not charged
    DELETE FROM public.messages WHERE claim_id = C1::uuid AND body = r.txt;
    INSERT INTO public.messages (claim_id, sender_id, sender_role, body, created_at) VALUES (C1::uuid, H::uuid, 'homeowner', r.txt, '2026-01-02 10:00+00');
    got := t.as_user('authenticated', KS, format($q$SELECT body FROM public.contractor_thread_messages WHERE claim_id = %L AND sender_role = 'homeowner' AND created_at = '2026-01-02 10:00+00'$q$, C1)); lk := t.leaks(got);
    INSERT INTO t.results VALUES (p_phase, 'T ' || r.label, 'thread view: ' || CASE WHEN lk THEN 'LEAKS' ELSE 'redacted' END,
      CASE WHEN p_expect_leak AND r.label !~ '^U(12|06|09)' THEN lk ELSE NOT lk END);
    DELETE FROM public.messages WHERE claim_id = C1::uuid AND created_at = '2026-01-02 10:00+00';
  END LOOP;
  UPDATE public.claims SET homeowner_notes = 'Call me on 317-555-0142 or write zelda.q@example.invalid. Tree fell on the back slope.' WHERE id = C1::uuid;
END $f$;

-- parity: the function's output equals the bidder view's redaction of the same text, on a corpus that holds only phone and e-mail shapes (the view also
-- applies web, street and name rules the function does not hold, by design). The view is read as a plain bidder (KB) on C3, whose address and the
-- profile name share no word with the corpus.
CREATE TABLE t.pcorpus (txt text);
INSERT INTO t.pcorpus SELECT txt FROM t.ucorpus UNION ALL SELECT x FROM (VALUES
 ('call 317-555-0142 now'), ('(317) 555-0142'), ('317.555.0142'), ('3175550142'), ('+1 317 555 0142'), ('555/0142'), ('555\0142'),
 ('mail me at a.b+c@example.invalid ok'), ('me at example dot invalid'), ('x (at) y (dot) invalid'), ('a @ b . invalid'),
 ('Two layers, 30 squares, 8/12 pitch, 2400 sq ft.'), ('Tree fell on the back slope'), ('cafe' || U&'\0301' || ' roof, 12 squares'),
 ('tel 317' || U&'\00A0' || '555' || U&'\00A0' || '0142'), (t.fwall('317 555 0142')), (translate('3175550142', '0123456789', U&'\FF10\FF11\FF12\FF13\FF14\FF15\FF16\FF17\FF18\FF19')),
 ('line one' || chr(10) || 'phone 317-555-0142' || chr(10) || 'zelda.q@example.invalid')) v(x);
CREATE FUNCTION t.parity(p_phase text, p_neg boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE KB text := '00000000-0000-0000-0000-0000000000c1'; C3 text := '20000000-0000-0000-0000-0000000000c3'; r record; v text; f text; n int := 0;
BEGIN
  FOR r IN SELECT txt FROM t.pcorpus LOOP
    n := n + 1;
    UPDATE public.claims SET homeowner_notes = r.txt WHERE id = C3::uuid;
    v := t.as_user('authenticated', KB, format($q$SELECT homeowner_notes FROM public.bidder_claim_summary WHERE id = %L$q$, C3));
    f := public.d390_redact_contact(r.txt);
    INSERT INTO t.results VALUES (p_phase, 'PAR' || lpad(n::text, 2, '0') || ' function = bidder view', CASE WHEN v IS NOT DISTINCT FROM f THEN 'equal' ELSE 'DIFFERENT' END, p_neg OR v IS NOT DISTINCT FROM f);
  END LOOP;
  UPDATE public.claims SET homeowner_notes = 'Call me on 317-555-0142 or write zelda.q@example.invalid. Tree fell on the back slope.' WHERE id = C3::uuid;
END $f$;
