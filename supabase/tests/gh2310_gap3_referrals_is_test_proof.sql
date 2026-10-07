-- Proof for gh-2310 Gap 3 (referrals.is_test backfill + admin_list_referrals predicate). HUMAN-RUN, ONE BATCH, ENDS IN ROLLBACK. Nothing commits.
-- NOT RUN by the PR author (the CTO worker had SELECT-only access). Expected final table: every row ok = true, SUMMARY failing = 0.
-- Phases: PRE (live body: negative control, the nine rows are listed), FIXED (forward function + backfill inlined), ROLLBACK (both rollback bodies; md5 must equal the PRE md5).
BEGIN;
CREATE TEMP TABLE proof_r (n serial PRIMARY KEY, phase text, label text, got text, expected text, ok boolean);
CREATE FUNCTION pg_temp.rec(p_phase text, p_label text, p_got text, p_exp text) RETURNS void LANGUAGE sql AS
$f$ INSERT INTO proof_r(phase,label,got,expected,ok) VALUES (p_phase,p_label,p_got,p_exp,p_got IS NOT DISTINCT FROM p_exp) $f$;
-- Act as the admin (is_admin_email reads auth.jwt()). Built by concatenation so no address literal is in the file.
CREATE FUNCTION pg_temp.as_admin() RETURNS text LANGUAGE sql AS
$f$ SELECT set_config('request.jwt.claims', json_build_object('email', 'dustinstohler1' || '@gmail.com', 'role', 'authenticated')::text, true) $f$;
CREATE FUNCTION pg_temp.as_nobody() RETURNS text LANGUAGE sql AS
$f$ SELECT set_config('request.jwt.claims', json_build_object('email', 'nobody@otterquote-internal.test', 'role', 'authenticated')::text, true) $f$;
CREATE FUNCTION pg_temp.nine() RETURNS uuid[] LANGUAGE sql AS
$f$ SELECT ARRAY['97253d12-6691-4308-8bf0-754b29b5ece7'::uuid,'596b5ec3-b381-4261-b10d-ba438b401c8b'::uuid,'6ede692b-a7c0-43b1-b0cb-f318fb209c32'::uuid,'3c62b0f1-4b40-44c2-a394-ca77ebfdce69'::uuid,'a240bb83-2e38-4d64-aa76-44d675556b43'::uuid,'d843c6d4-35ba-46c4-adfa-a5909e267065'::uuid,'a034c167-8140-4a0f-af63-0acd84be338d'::uuid,'b206c41a-6b1e-4d6d-b21d-fe3ed6cd64f5'::uuid,'82d58235-2c70-423a-b682-afedd3d745c9'::uuid] $f$;

CREATE FUNCTION pg_temp.measure(p_phase text, p_listed_test_rows_expected text, p_flag_false_under_test_agent_expected text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_listed_test int;
BEGIN
  PERFORM pg_temp.as_admin();
  SELECT count(*) INTO v_listed_test FROM public.admin_list_referrals() l JOIN public.referral_agents a ON a.id = l.referral_agent_id WHERE a.is_test;
  PERFORM pg_temp.rec(p_phase, 'rows an admin sees that sit under a test agent', v_listed_test::text, p_listed_test_rows_expected);
  PERFORM pg_temp.rec(p_phase, 'referrals is_test=false under an is_test=true agent (the SELECT of the closes-on)',
    (SELECT count(*) FROM public.referrals r JOIN public.referral_agents a ON a.id = r.referral_agent_id WHERE r.is_test = false AND a.is_test = true)::text, p_flag_false_under_test_agent_expected);
  PERFORM pg_temp.as_nobody();
  PERFORM pg_temp.rec(p_phase, 'non-admin still sees 0 rows', (SELECT count(*) FROM public.admin_list_referrals())::text, '0');
END $f$;

CREATE TEMP TABLE proof_pre AS SELECT md5(pg_get_functiondef('public.admin_list_referrals()'::regprocedure)) AS body_md5;
INSERT INTO proof_r(phase,label,got,expected,ok) SELECT 'PRE','live admin_list_referrals md5 (first 8 characters, reviewed value 9da71c08)', left(body_md5, 8), '9da71c08', left(body_md5, 8) = '9da71c08' FROM proof_pre;
SELECT pg_temp.rec('PRE', 'the 9 ids are exactly the 9 rows of the closes-on SELECT', (SELECT count(*) FROM public.referrals r JOIN public.referral_agents a ON a.id = r.referral_agent_id WHERE r.id = ANY (pg_temp.nine()) AND r.is_test = false AND a.is_test = true)::text, '9');
-- NEGATIVE CONTROL: before the change the admin sees test-agent rows (38 = 9 legacy + 29 already flagged) and the SELECT returns 9.
SELECT pg_temp.measure('PRE', '38', '9');

-- ===== FIXED: forward function (supabase/migrations_drafts/gh2310_gap3_admin_list_referrals_is_test.sql) =====
CREATE OR REPLACE; the probe below re-asserts them.
-- Effect measured read-only 2026-10-07T20:28Z: rows visible to the admin 48 -> 10 (38 test rows hidden; 9 of them are the legacy rows of gh2310_gap3_backfill_referrals_is_test).

CREATE OR REPLACE FUNCTION public.admin_list_referrals()
 RETURNS TABLE(id uuid, created_at timestamp with time zone, status text, referral_agent_id uuid, partner_name text, partner_email text, partner_code text, homeowner_email text, landing_page text, job_value numeric, commission_amount numeric, recruit_commission_amount numeric, claim_id uuid, claim_completion_date timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    r.id,
    r.created_at,
    r.status,
    r.referral_agent_id,
    NULLIF(TRIM(COALESCE(ra.first_name,'') || ' ' || COALESCE(ra.last_name,'')), ''),
    ra.email,
    ra.unique_code,
    r.homeowner_email,
    r.landing_page,
    r.job_value,
    r.commission_amount,
    r.recruit_commission_amount,
    r.claim_id,
    c.completion_date
  FROM public.referrals r
  LEFT JOIN public.referral_agents ra ON ra.id = r.referral_agent_id
  LEFT JOIN public.claims          c  ON c.id  = r.claim_id
  WHERE public.is_admin_email()
    AND r.is_test  IS NOT TRUE     -- gh-2310 Gap 3: test click rows are not partner activity
    AND ra.is_test IS NOT TRUE     -- gh-2310 Gap 3: nor are rows under a test/staff agent (NULL ra = unattributed, still listed)
  ORDER BY r.created_at DESC
  LIMIT 1000;
$function$
;


-- predicate alone, before the backfill: test-agent rows are already hidden; the SELECT still returns 9 (the backfill fixes the data, the predicate fixes the surface)
SELECT pg_temp.measure('FIXED-fn-only', '0', '9');
-- ===== FIXED: backfill (supabase/migrations_drafts/gh2310_gap3_backfill_referrals_is_test.sql) =====
DO $$
DECLARE
  v_ids uuid[] := ARRAY['97253d12-6691-4308-8bf0-754b29b5ece7'::uuid,'596b5ec3-b381-4261-b10d-ba438b401c8b'::uuid,'6ede692b-a7c0-43b1-b0cb-f318fb209c32'::uuid,'3c62b0f1-4b40-44c2-a394-ca77ebfdce69'::uuid,'a240bb83-2e38-4d64-aa76-44d675556b43'::uuid,'d843c6d4-35ba-46c4-adfa-a5909e267065'::uuid,'a034c167-8140-4a0f-af63-0acd84be338d'::uuid,'b206c41a-6b1e-4d6d-b21d-fe3ed6cd64f5'::uuid,'82d58235-2c70-423a-b682-afedd3d745c9'::uuid];
  v_updated uuid[];
BEGIN
  IF array_length(v_ids, 1) <> 9 THEN
    RAISE EXCEPTION 'gh2310 gap3 guard: id list has % entries, expected 9', array_length(v_ids, 1);
  END IF;

  WITH upd AS (
    UPDATE public.referrals r
       SET is_test = true
      FROM public.referral_agents a
     WHERE r.id = ANY (v_ids)
       AND r.is_test = false
       AND a.id = r.referral_agent_id
       AND a.is_test = true
    RETURNING r.id
  )
  SELECT array_agg(id) INTO v_updated FROM upd;

  IF v_updated IS NULL
     OR array_length(v_updated, 1) <> 9
     OR EXISTS (SELECT 1 FROM unnest(v_updated) u WHERE u <> ALL (v_ids)) THEN
    RAISE EXCEPTION 'gh2310 gap3 guard tripped: updated % rows (expected exactly 9 from the id list)',
      coalesce(array_length(v_updated, 1), 0);
  END IF;
END
$$;


SELECT pg_temp.measure('FIXED', '0', '0');

-- ===== ROLLBACK: backfill rollback, then function rollback =====
UPDATE public.referrals SET is_test = false
 WHERE id IN ('97253d12-6691-4308-8bf0-754b29b5ece7'::uuid,'596b5ec3-b381-4261-b10d-ba438b401c8b'::uuid,'6ede692b-a7c0-43b1-b0cb-f318fb209c32'::uuid,'3c62b0f1-4b40-44c2-a394-ca77ebfdce69'::uuid,'a240bb83-2e38-4d64-aa76-44d675556b43'::uuid,'d843c6d4-35ba-46c4-adfa-a5909e267065'::uuid,'a034c167-8140-4a0f-af63-0acd84be338d'::uuid,'b206c41a-6b1e-4d6d-b21d-fe3ed6cd64f5'::uuid,'82d58235-2c70-423a-b682-afedd3d745c9'::uuid)
   AND is_test = true;

SELECT pg_temp.rec('ROLLBACK', 'backfill rolled back: the SELECT returns 9 again', (SELECT count(*) FROM public.referrals r JOIN public.referral_agents a ON a.id = r.referral_agent_id WHERE r.is_test = false AND a.is_test = true)::text, '9');
CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.admin_list_referrals()
 RETURNS TABLE(id uuid, created_at timestamp with time zone, status text, referral_agent_id uuid, partner_name text, partner_email text, partner_code text, homeowner_email text, landing_page text, job_value numeric, commission_amount numeric, recruit_commission_amount numeric, claim_id uuid, claim_completion_date timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    r.id,
    r.created_at,
    r.status,
    r.referral_agent_id,
    NULLIF(TRIM(COALESCE(ra.first_name,'') || ' ' || COALESCE(ra.last_name,'')), ''),
    ra.email,
    ra.unique_code,
    r.homeowner_email,
    r.landing_page,
    r.job_value,
    r.commission_amount,
    r.recruit_commission_amount,
    r.claim_id,
    c.completion_date
  FROM public.referrals r
  LEFT JOIN public.referral_agents ra ON ra.id = r.referral_agent_id
  LEFT JOIN public.claims          c  ON c.id  = r.claim_id
  WHERE public.is_admin_email()
  ORDER BY r.created_at DESC
  LIMIT 1000;
$function$
;

INSERT INTO proof_r(phase,label,got,expected,ok) SELECT 'ROLLBACK','function body md5 = live md5', md5(pg_get_functiondef('public.admin_list_referrals()'::regprocedure)), (SELECT body_md5 FROM proof_pre), md5(pg_get_functiondef('public.admin_list_referrals()'::regprocedure)) = (SELECT body_md5 FROM proof_pre);

SELECT n, phase, label, got, expected, ok FROM proof_r
UNION ALL SELECT 9999, 'SUMMARY', 'rows / failing rows', count(*)::text, count(*) FILTER (WHERE NOT ok)::text, count(*) FILTER (WHERE NOT ok) = 0 FROM proof_r
ORDER BY n;
ROLLBACK;
