-- gh-3259 probe for the THROWAWAY Postgres proof (runner: gh3259_referrals_column_revoke_proof_run.sh). NEVER run against production.
-- Read-only: every probe runs inside one transaction that the runner opens with -1 and this file ends with ROLLBACK.
-- A partner session is simulated exactly as PostgREST does it for a partner's access token: SET LOCAL ROLE authenticated plus the
-- JWT claims GUC (request.jwt.claims, read by auth.uid()). Each probe prints "PROBE <id> => <result>", where a failed statement
-- prints "ERR <sqlstate>" (42501 = permission denied) and a NULL prints <NULL>.
BEGIN;
CREATE FUNCTION pg_temp.as_sess(p_role text, p_uid uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text
         ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
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

CREATE TEMP TABLE _p(n serial, k text, v text);
-- partner A (owns c...001 with job_value 18450.00 and c...002)
INSERT INTO _p(k, v) SELECT 'J1 partnerA select job_value',
  pg_temp.as_sess('authenticated', 'a3259000-0000-4000-8000-00000000000a', $q$select string_agg(coalesce(job_value::text,'null'), ',' order by created_at) from public.referrals$q$);
INSERT INTO _p(k, v) SELECT 'S1 partnerA select status',
  pg_temp.as_sess('authenticated', 'a3259000-0000-4000-8000-00000000000a', $q$select string_agg(status, ',' order by created_at) from public.referrals$q$);
INSERT INTO _p(k, v) SELECT 'S2 partnerA filter on status (PostgREST ?status=eq.)',
  pg_temp.as_sess('authenticated', 'a3259000-0000-4000-8000-00000000000a', $q$select count(*)::text from public.referrals where status = 'job_completed'$q$);
INSERT INTO _p(k, v) SELECT 'J2 partnerA old dashboard loadStats select',
  pg_temp.as_sess('authenticated', 'a3259000-0000-4000-8000-00000000000a', $q$select count(*)::text from (select status, job_value, commission_amount from public.referrals where referral_agent_id = 'b3259000-0000-4000-8000-00000000000a') s$q$);
INSERT INTO _p(k, v) SELECT 'K1 partnerA allowed columns',
  pg_temp.as_sess('authenticated', 'a3259000-0000-4000-8000-00000000000a', $q$select count(*)::text || ' rows, fee ' || coalesce(sum(commission_amount)::text,'null') from (select id, created_at, referral_agent_id, commission_amount from public.referrals) s$q$);
INSERT INTO _p(k, v) SELECT 'K2 partnerA recruit earnings read',
  pg_temp.as_sess('authenticated', 'a3259000-0000-4000-8000-00000000000a', $q$select coalesce(sum(recruit_commission_amount)::text,'null') from public.referrals where referral_agent_id in ('b3259000-0000-4000-8000-00000000000a') and recruit_commission_amount is not null$q$);
INSERT INTO _p(k, v) SELECT 'K3 partnerA cannot see partnerB rows (RLS)',
  pg_temp.as_sess('authenticated', 'a3259000-0000-4000-8000-00000000000a', $q$select count(*)::text from public.referrals where referral_agent_id = 'b3259000-0000-4000-8000-00000000000b'$q$);
INSERT INTO _p(k, v) SELECT 'F1 partnerA get_my_referrals() status,job_value',
  pg_temp.as_sess('authenticated', 'a3259000-0000-4000-8000-00000000000a', $q$select string_agg(coalesce(status,'null') || ':' || coalesce(job_value::text,'null'), ',' order by created_at) from public.get_my_referrals()$q$);
INSERT INTO _p(k, v) SELECT 'F2 partnerB get_my_referrals() count',
  pg_temp.as_sess('authenticated', 'a3259000-0000-4000-8000-00000000000b', $q$select count(*)::text from public.get_my_referrals()$q$);
INSERT INTO _p(k, v) SELECT 'H1 homeowner select job_value',
  pg_temp.as_sess('authenticated', 'a3259000-0000-4000-8000-00000000000c', $q$select count(job_value)::text from public.referrals$q$);
INSERT INTO _p(k, v) SELECT 'N1 anon select job_value',
  pg_temp.as_sess('anon', NULL, $q$select count(job_value)::text from public.referrals$q$);
INSERT INTO _p(k, v) SELECT 'R1 service_role select job_value,status',
  pg_temp.as_sess('service_role', NULL, $q$select string_agg(status || ':' || coalesce(job_value::text,'null'), ',' order by created_at) from public.referrals$q$);
INSERT INTO _p(k, v) SELECT 'D1 admin_list_referrals() job_value (SECURITY DEFINER)',
  pg_temp.as_sess('authenticated', 'a3259000-0000-4000-8000-00000000000a', $q$select string_agg(coalesce(job_value::text,'null'), ',' order by job_value nulls last) from public.admin_list_referrals()$q$);
INSERT INTO _p(k, v) SELECT 'G1 closes-on has_column_privilege(authenticated, job_value)',
  has_column_privilege('authenticated', 'public.referrals', 'job_value', 'SELECT')::text;
INSERT INTO _p(k, v) SELECT 'G2 has_column_privilege(authenticated, status)',
  has_column_privilege('authenticated', 'public.referrals', 'status', 'SELECT')::text;
INSERT INTO _p(k, v) SELECT 'G3 authenticated UPDATE/DELETE privileges unchanged',
  has_column_privilege('authenticated', 'public.referrals', 'job_value', 'UPDATE')::text || ',' ||
  has_table_privilege('authenticated', 'public.referrals', 'DELETE')::text || ',' ||
  has_table_privilege('authenticated', 'public.referrals', 'INSERT')::text;

SELECT 'PROBE ' || k || ' => ' || v FROM _p ORDER BY n;
ROLLBACK;
