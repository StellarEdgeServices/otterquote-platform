-- gh-3816 proof: notify_admin_new_contractor() enqueues the request the Edge Function expects after the fix, fails visibly (never blocking the signup) when it cannot, and is unchanged in owner / SECURITY DEFINER / search_path / grants.
-- ONE transaction that ends in ROLLBACK; nothing commits. THROWAWAY Postgres only (no Supabase branch, no network, no email): pg_net and Vault are STUBS inside the transaction.
--   net.http_post stub has production's exact signature (pg_net 0.20.0): (url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) and writes to net.http_request_queue instead of sending.
-- The "before" state is installed from the real rollback file (= production's body, md5 checked below); the fix from the real forward file (psql \i), so the exact bytes are exercised.
-- NEGATIVE CONTROL: A-steps show TODAY'S behaviour on the same fixture: the call raises 42883, the signup INSERT succeeds, NO queue row, NO visible trace.
-- Usage: PGHOST=... PGUSER=postgres bash supabase/tests/gh3816_notify_admin_new_contractor_body_proof_run.sh
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE proof_r (n serial PRIMARY KEY, label text, got text, expected text, ok boolean);
CREATE FUNCTION pg_temp.rec(p_label text, p_got text, p_exp text) RETURNS void LANGUAGE sql AS
  $f$ INSERT INTO proof_r(label,got,expected,ok) VALUES (p_label,p_got,p_exp,p_got IS NOT DISTINCT FROM p_exp) $f$;
CREATE FUNCTION pg_temp.q(p_sql text) RETURNS text LANGUAGE plpgsql AS
  $f$ DECLARE r text; BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r,'<null>'); EXCEPTION WHEN OTHERS THEN RETURN 'ERR '||SQLSTATE; END $f$;
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS text LANGUAGE plpgsql AS
  $f$ BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN OTHERS THEN RETURN 'REJECTED '||SQLSTATE; END $f$;

-- ---- fixture: roles, stub pg_net (production signature), stub Vault, minimal contractors + platform_alerts_log, production's trigger ----
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $r$;
CREATE SCHEMA net;
CREATE TABLE net.http_request_queue (id bigserial PRIMARY KEY, url text, body jsonb, params jsonb, headers jsonb, timeout_ms integer);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
                              headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS
  $f$ INSERT INTO net.http_request_queue(url,body,params,headers,timeout_ms) VALUES (url,body,params,headers,timeout_milliseconds) RETURNING id $f$;
CREATE SCHEMA vault;
CREATE TABLE vault.secrets (name text PRIMARY KEY, secret text);
CREATE VIEW vault.decrypted_secrets AS SELECT name, secret AS decrypted_secret FROM vault.secrets;
INSERT INTO vault.secrets VALUES ('cron_service_role_key', 'stub-key-not-a-secret');
CREATE TABLE public.contractors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, status text NOT NULL DEFAULT 'pending_approval', is_test boolean NOT NULL DEFAULT false, company_name text);
CREATE TABLE public.platform_alerts_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), alert_type text NOT NULL, function_name text NOT NULL, message text NOT NULL, sent_at timestamptz NOT NULL DEFAULT now(), acknowledged_at timestamptz);
ALTER TABLE public.platform_alerts_log ENABLE ROW LEVEL SECURITY;

-- "before" = production's installed body, from the rollback file
\i supabase/migrations_rollbacks/gh3816_notify_admin_new_contractor_body_rollback.sql
REVOKE ALL ON FUNCTION public.notify_admin_new_contractor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_admin_new_contractor() TO authenticated, service_role;
CREATE TRIGGER trg_notify_admin_new_contractor AFTER INSERT OR UPDATE OF status ON public.contractors FOR EACH ROW EXECUTE FUNCTION notify_admin_new_contractor();

CREATE TEMP TABLE snap AS SELECT now() AS t, pg_get_userbyid(proowner) AS owner, prosecdef AS secdef, proconfig::text AS cfg, proacl::text AS acl, prorettype::regtype::text AS rt, md5(prosrc) AS src_md5
  FROM pg_proc WHERE oid = 'public.notify_admin_new_contractor()'::regprocedure;

SELECT pg_temp.rec('A0a stub net.http_post has production''s signature (pg_net 0.20.0: url, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer)',
  pg_get_function_identity_arguments('net.http_post(text,jsonb,jsonb,jsonb,integer)'::regprocedure), 'url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer');
SELECT pg_temp.rec('A0b the rollback file installs production''s exact body (md5(prosrc) = production value read 2026-11-19)', (SELECT src_md5 FROM snap), '4299011d821deb9a9981c9a729a1a721');
SELECT pg_temp.rec('A0c ... and pg_get_functiondef matches production''s md5', md5(pg_get_functiondef('public.notify_admin_new_contractor()'::regprocedure)), '06115f96f1bcf2a44dddea259f76e7c5');
SELECT pg_temp.rec('A0d the before body contains the bytea cast', (SELECT (prosrc LIKE '%::text::bytea%')::text FROM pg_proc WHERE oid='public.notify_admin_new_contractor()'::regprocedure), 'true');

-- ---- A: NEGATIVE CONTROL (today) ----
SELECT pg_temp.rec('A1 NEGATIVE CONTROL: the production call expression raises 42883 (no bytea overload)',
  pg_temp.try($$SELECT net.http_post(url := 'x', body := '{}'::jsonb::text::bytea, headers := '{}'::jsonb)$$), 'REJECTED 42883');
SELECT pg_temp.rec('A2 NEGATIVE CONTROL: before the fix, a real-looking pending_approval contractor INSERT succeeds',
  pg_temp.try($$INSERT INTO public.contractors (id,email,status) VALUES ('aaaaaaaa-0000-4000-8000-000000000001','neg@example.com','pending_approval')$$), 'ok');
SELECT pg_temp.rec('A3 NEGATIVE CONTROL: ... and NO request is queued', pg_temp.q($$SELECT count(*)::text FROM net.http_request_queue$$), '0');
SELECT pg_temp.rec('A4 NEGATIVE CONTROL: ... and NO visible trace (platform_alerts_log empty): the failure is invisible', pg_temp.q($$SELECT count(*)::text FROM public.platform_alerts_log$$), '0');

-- ---- B: the fix, from the real forward file ----
\i supabase/migrations_drafts/gh3816_notify_admin_new_contractor_body.sql
SELECT pg_temp.rec('B0 the forward file left owner / SECURITY DEFINER / search_path / ACL / return type unchanged',
  (SELECT (pg_get_userbyid(p.proowner)=s.owner AND p.prosecdef=s.secdef AND p.proconfig::text=s.cfg AND p.proacl::text IS NOT DISTINCT FROM s.acl AND p.prorettype::regtype::text=s.rt)::text FROM pg_proc p, snap s WHERE p.oid='public.notify_admin_new_contractor()'::regprocedure), 'true');
SELECT pg_temp.rec('B0a ... and the body did change (md5 differs)', (SELECT (md5(p.prosrc) <> s.src_md5)::text FROM pg_proc p, snap s WHERE p.oid='public.notify_admin_new_contractor()'::regprocedure), 'true');
SELECT pg_temp.rec('B0b no bytea cast and no secret-looking literal in the new body',
  (SELECT (prosrc NOT LIKE '%bytea%' AND prosrc !~ 'eyJ[A-Za-z0-9_-]{10}' AND prosrc !~ 'sb_secret')::text FROM pg_proc WHERE oid='public.notify_admin_new_contractor()'::regprocedure), 'true');
SELECT pg_temp.rec('B0c only the three intended differences: the body line, plus two handler additions (alert INSERTs = 2)',
  (SELECT (length(prosrc)-length(replace(prosrc,'platform_alerts_log','')))/length('platform_alerts_log') FROM pg_proc WHERE oid='public.notify_admin_new_contractor()'::regprocedure)::text, '2');

INSERT INTO public.contractors (id,email,status) VALUES ('bbbbbbbb-0000-4000-8000-000000000001','pos@example.com','pending_approval');
SELECT pg_temp.rec('B1 AFTER FIX: one pending_approval contractor INSERT queues exactly ONE request', pg_temp.q($$SELECT count(*)::text FROM net.http_request_queue$$), '1');
SELECT pg_temp.rec('B2 ... to the notify-admin-new-contractor Edge Function URL', pg_temp.q($$SELECT url FROM net.http_request_queue$$), 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-admin-new-contractor');
SELECT pg_temp.rec('B3 ... with jsonb body exactly {"contractor_id": "<the new id>"} (the one field the Edge Function reads, a string)',
  pg_temp.q($$SELECT (body = jsonb_build_object('contractor_id','bbbbbbbb-0000-4000-8000-000000000001') AND jsonb_typeof(body->'contractor_id')='string' AND (SELECT count(*) FROM jsonb_object_keys(body))=1)::text FROM net.http_request_queue$$), 'true');
SELECT pg_temp.rec('B4 ... with Content-Type and a Bearer Authorization header carrying the Vault key (stub value, compared not printed)',
  pg_temp.q($$SELECT (headers->>'Content-Type'='application/json' AND headers->>'Authorization'='Bearer '||(SELECT secret FROM vault.secrets WHERE name='cron_service_role_key'))::text FROM net.http_request_queue$$), 'true');
SELECT pg_temp.rec('B5 ... and no alert row on success', pg_temp.q($$SELECT count(*)::text FROM public.platform_alerts_log$$), '0');

-- test accounts: is_test contractor behaviour AS DESIGNED (the function filters by email pattern, not by the is_test column; the Edge Function does the same)
INSERT INTO public.contractors (id,email,status,is_test) VALUES ('bbbbbbbb-0000-4000-8000-000000000002','t1@otterquote-internal.test','pending_approval',true);
SELECT pg_temp.rec('B6 is_test contractor whose email matches a test pattern: INSERT ok, NO new request (skipped by design)', pg_temp.q($$SELECT count(*)::text FROM net.http_request_queue$$), '1');
INSERT INTO public.contractors (id,email,status,is_test) VALUES ('bbbbbbbb-0000-4000-8000-000000000003','t2@example.com','pending_approval',true);
SELECT pg_temp.rec('B7 is_test contractor with an ordinary email: ONE new request (the function does not read is_test; a real email would go to the admin)', pg_temp.q($$SELECT count(*)::text FROM net.http_request_queue$$), '2');

-- status filter unchanged
INSERT INTO public.contractors (id,email,status) VALUES ('bbbbbbbb-0000-4000-8000-000000000004','s1@example.com','active');
SELECT pg_temp.rec('B8 INSERT with status active: no request', pg_temp.q($$SELECT count(*)::text FROM net.http_request_queue$$), '2');
UPDATE public.contractors SET status='pending_approval' WHERE id='bbbbbbbb-0000-4000-8000-000000000004';
SELECT pg_temp.rec('B9 UPDATE active -> pending_approval: one request', pg_temp.q($$SELECT count(*)::text FROM net.http_request_queue$$), '3');
UPDATE public.contractors SET company_name='x' WHERE id='bbbbbbbb-0000-4000-8000-000000000004';
UPDATE public.contractors SET status='pending_approval' WHERE id='bbbbbbbb-0000-4000-8000-000000000004';
SELECT pg_temp.rec('B10 UPDATE of another column / same status: no request', pg_temp.q($$SELECT count(*)::text FROM net.http_request_queue$$), '3');

-- ---- C: failure is visible and never blocks the signup ----
DELETE FROM net.http_request_queue;
CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
                              headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'forced pg_net failure' USING ERRCODE = 'XX000'; END $f$;
SELECT pg_temp.rec('C1 FORCED FAILURE in net.http_post: the contractor INSERT still succeeds',
  pg_temp.try($$INSERT INTO public.contractors (id,email,status) VALUES ('cccccccc-0000-4000-8000-000000000001','f1@example.com','pending_approval')$$), 'ok');
SELECT pg_temp.rec('C2 ... the contractor row exists', pg_temp.q($$SELECT count(*)::text FROM public.contractors WHERE id='cccccccc-0000-4000-8000-000000000001'$$), '1');
SELECT pg_temp.rec('C3 ... nothing queued', pg_temp.q($$SELECT count(*)::text FROM net.http_request_queue$$), '0');
SELECT pg_temp.rec('C4 ... ONE visible trace row in platform_alerts_log (type, function, id, sqlstate, sqlerrm; no email address)',
  pg_temp.q($$SELECT (count(*)=1 AND bool_and(alert_type='contractor_admin_notify_failed' AND function_name='notify_admin_new_contractor' AND message LIKE '%cccccccc-0000-4000-8000-000000000001%' AND message LIKE '%XX000%' AND message LIKE '%forced pg_net failure%' AND message NOT LIKE '%f1@example.com%'))::text FROM public.platform_alerts_log$$), 'true');
ALTER TABLE public.platform_alerts_log RENAME TO platform_alerts_log_x;
SELECT pg_temp.rec('C5 FORCED FAILURE of the log write as well: the contractor INSERT still succeeds',
  pg_temp.try($$INSERT INTO public.contractors (id,email,status) VALUES ('cccccccc-0000-4000-8000-000000000002','f2@example.com','pending_approval')$$), 'ok');
SELECT pg_temp.rec('C6 ... and that contractor row exists', pg_temp.q($$SELECT count(*)::text FROM public.contractors WHERE id='cccccccc-0000-4000-8000-000000000002'$$), '1');
ALTER TABLE public.platform_alerts_log_x RENAME TO platform_alerts_log;
-- missing Vault key
CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
                              headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS
  $f$ INSERT INTO net.http_request_queue(url,body,params,headers,timeout_ms) VALUES (url,body,params,headers,timeout_milliseconds) RETURNING id $f$;
DELETE FROM public.platform_alerts_log;
DELETE FROM vault.secrets WHERE name='cron_service_role_key';
SELECT pg_temp.rec('C7 Vault key missing: INSERT ok, nothing queued, ONE visible trace row naming the vault secret',
  pg_temp.try($$INSERT INTO public.contractors (id,email,status) VALUES ('cccccccc-0000-4000-8000-000000000003','v1@example.com','pending_approval')$$)
  || ' / ' || pg_temp.q($$SELECT count(*)::text FROM net.http_request_queue$$)
  || ' / ' || pg_temp.q($$SELECT (count(*)=1 AND bool_and(alert_type='contractor_admin_notify_failed' AND message LIKE '%vault secret cron_service_role_key not found%' AND message LIKE '%cccccccc-0000-4000-8000-000000000003%'))::text FROM public.platform_alerts_log$$),
  'ok / 0 / true');
INSERT INTO vault.secrets VALUES ('cron_service_role_key', 'stub-key-not-a-secret');

-- ---- D: idempotent forward, exact rollback (static no-destructive-DDL check of both files is in the runner) ----
\i supabase/migrations_drafts/gh3816_notify_admin_new_contractor_body.sql
SELECT pg_temp.rec('D1 the forward file re-run changes nothing (same grants, same body)', (SELECT (p.proacl::text IS NOT DISTINCT FROM s.acl AND p.prosecdef=s.secdef)::text FROM pg_proc p, snap s WHERE p.oid='public.notify_admin_new_contractor()'::regprocedure), 'true');
\i supabase/migrations_rollbacks/gh3816_notify_admin_new_contractor_body_rollback.sql
SELECT pg_temp.rec('D2 the rollback file restores production''s exact body (md5 = production) and the same grants',
  (SELECT (md5(p.prosrc)='4299011d821deb9a9981c9a729a1a721' AND p.proacl::text IS NOT DISTINCT FROM s.acl AND p.prosecdef=s.secdef AND p.proconfig::text=s.cfg)::text FROM pg_proc p, snap s WHERE p.oid='public.notify_admin_new_contractor()'::regprocedure), 'true');
DELETE FROM net.http_request_queue;
INSERT INTO public.contractors (id,email,status) VALUES ('dddddddd-0000-4000-8000-000000000001','rb@example.com','pending_approval');
SELECT pg_temp.rec('D3 after rollback the old behaviour returns (insert ok, nothing queued): the rollback is real', pg_temp.q($$SELECT count(*)::text FROM net.http_request_queue$$), '0');
\i supabase/migrations_drafts/gh3816_notify_admin_new_contractor_body.sql
INSERT INTO public.contractors (id,email,status) VALUES ('dddddddd-0000-4000-8000-000000000002','fw@example.com','pending_approval');
SELECT pg_temp.rec('D4 forward again after the rollback: one request queued', pg_temp.q($$SELECT count(*)::text FROM net.http_request_queue$$), '1');

SELECT 'FAILING=' || count(*) FILTER (WHERE NOT ok) || ' of ' || count(*) FROM proof_r;
SELECT n || ' | ' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || ' | ' || label || ' | got=' || got || CASE WHEN ok THEN '' ELSE ' | expected=' || expected END FROM proof_r ORDER BY n;
ROLLBACK;
