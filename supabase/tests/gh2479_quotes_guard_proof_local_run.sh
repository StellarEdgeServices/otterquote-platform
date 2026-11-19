#!/usr/bin/env bash
# gh-2479 refreshed proof, LOCAL run (refs #3203). Builds a THROWAWAY Postgres database from this repository's supabase/migrations, adds the stand-ins
# listed below, seeds fixture rows that carry production's ids and states, runs supabase/tests/gh2479_quotes_guard_proof.sql and checks the outcome.
# NEVER point this at production: it DROPs and creates the database named by $DB (default gh2479_local).
# Usage: PGHOST=... PGPORT=... PGUSER=postgres [DB=gh2479_local] [DETACH_SQL=path/to/gh3203_detach_admin_login_test_roles.sql] bash supabase/tests/gh2479_quotes_guard_proof_local_run.sh [outdir]
# (NOTE: *.sh is in .gitignore; commit with `git add -f`.)
# WHAT A LOCAL DATABASE IS: the repo's migrations replay with errors (the 2026-11-19 run: see GAPS in the output) because production holds objects that no repo
#   migration creates (gh3239 / gh3245 / gh3330 / gh3321 partner-agreement and no-fee-state migrations, claims.measurement_shape, ...) and because several migrations
#   check production data. Stand-ins used: auth schema + auth.uid/role/jwt/email (production bodies), a vault view, a pg_net-shaped net schema (queue table +
#   http_post(text,jsonb,jsonb,jsonb,int), same signature as pg_net 0.20 on production), cron stubs, is_internal_test_email (production body, otterquote.com added),
#   and migrations_drafts/{gh3009,gh3219,gh3560} applied (production ledger has them; the repo files are drafts).
# It CAN exercise: every guard / trigger / function body that exists in supabase/migrations (quotes + claims + referral_agents + profiles + contractors guards,
#   accept_bid, renew_quote, claims_apply_locked_referral, apply_referral_commission as of gh-2519 (not the gh-3245/3330/3321 gates), track_referral_click,
#   notify_admin_new_contractor), the PR #3674 detach and rollback statements, and the fixture arithmetic.
# It CANNOT exercise: production's actual rows and their drift (the seed only mimics the states read by SELECT on 2026-11-19), production roles/grants
#   beyond the stubs, the real pg_net worker (a queue-table stand-in; "discarded on rollback" is proven for the table insert, not for the worker process),
#   Supabase Vault contents, the gh-3245 / gh-3330 / gh-3321 branches of apply_referral_commission, and any auth.users trigger (handle_new_user).
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"; DB="${DB:-gh2479_local}"; rc=0
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" || exit 2
P="psql -q -d $DB"
$P -v ON_ERROR_STOP=1 -f - <<'STUBS'
-- Local stubs for Supabase platform objects that the repo migrations assume. NOT production.
DO $r$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
END $r$;
CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS extensions; CREATE SCHEMA auth; CREATE SCHEMA vault; CREATE SCHEMA net; CREATE SCHEMA storage; CREATE SCHEMA cron;
GRANT USAGE ON SCHEMA public, auth, extensions, net TO anon, authenticated, service_role;
-- Supabase's default privileges (the baseline relies on them; later repo migrations REVOKE what production revoked)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, created_at timestamptz DEFAULT now(), raw_user_meta_data jsonb DEFAULT '{}', raw_app_meta_data jsonb DEFAULT '{}', email_confirmed_at timestamptz, encrypted_password text, last_sign_in_at timestamptz, phone text, banned_until timestamptz, deleted_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''),(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ select coalesce(nullif(current_setting('request.jwt.claim', true), ''),nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
CREATE VIEW vault.decrypted_secrets AS SELECT 'cron_service_role_key'::text AS name, 'LOCAL-STUB-NOT-A-SECRET'::text AS decrypted_secret, NULL::uuid AS id;
-- pg_net stand-in: same shape as production pg_net 0.20 (queue table; http_post(text,jsonb,jsonb,jsonb,int) inserts a row and returns its id)
CREATE TABLE net.http_request_queue (id bigserial PRIMARY KEY, method text, url text, headers jsonb, body bytea, timeout_milliseconds int);
CREATE FUNCTION net.wake() RETURNS void LANGUAGE sql AS $$ select $$;
CREATE FUNCTION net._urlencode_string(s text) RETURNS text LANGUAGE sql AS $$ select s $$;
CREATE FUNCTION net._encode_url_with_params_array(u text, p text[]) RETURNS text LANGUAGE sql AS $$ select u $$;
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE plpgsql AS $f$
declare request_id bigint; begin
 insert into net.http_request_queue(method,url,headers,body,timeout_milliseconds) values ('POST',url,headers,convert_to(body::text,'UTF8'),timeout_milliseconds) returning id into request_id;
 perform net.wake(); return request_id; end $f$;
CREATE FUNCTION net.http_get(url text, params jsonb DEFAULT '{}', headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$ select 0::bigint $$;
CREATE FUNCTION cron.schedule(a text, b text, c text) RETURNS bigint LANGUAGE sql AS $$ select 0::bigint $$;
CREATE FUNCTION cron.schedule(b text, c text) RETURNS bigint LANGUAGE sql AS $$ select 0::bigint $$;
CREATE FUNCTION cron.unschedule(a text) RETURNS boolean LANGUAGE sql AS $$ select true $$;
CREATE FUNCTION cron.unschedule(a bigint) RETURNS boolean LANGUAGE sql AS $$ select true $$;
CREATE TABLE cron.job (jobid bigserial, jobname text, schedule text, command text);
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS $$ select string_to_array(name,'/') $$;

STUBS
echo "== replay supabase/migrations (errors expected; counted, first error per file kept)"
n=0; f=0; : > "$OUT/replay.log"
for m in $(ls supabase/migrations/*.sql | sort); do n=$((n+1)); e=$($P -f "$m" 2>&1 >/dev/null | grep -m1 ERROR); [ -n "$e" ] && { f=$((f+1)); echo "$(basename $m) :: $e" >> "$OUT/replay.log"; }; done
echo "migrations replayed=$n files_with_an_error=$f (GAPS, see $OUT/replay.log)"
$P -v ON_ERROR_STOP=1 -f - <<'OVERLAY'
-- STUB of production's public.is_internal_test_email (production body in 20261003014844 + gh2154 otterquote.com addition); local only.
CREATE OR REPLACE FUNCTION public.is_internal_test_email(p_email text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
 SELECT CASE WHEN p_email IS NULL THEN false ELSE
  split_part(lower(btrim(p_email)),'@',2) IN ('stellaredgeservices.com','tryotterquote.com','stohlerroof.com','otterquote-internal.test','otterquote.com')
  OR (split_part(lower(btrim(p_email)),'@',2)='gmail.com' AND split_part(split_part(lower(btrim(p_email)),'@',1),'+',1) IN ('dustinstohler1')) END $$;

OVERLAY
for d in gh3009_admin_emails_table gh3219_partner_credit_lock gh3560_renew_quote_rpc; do $P -v ON_ERROR_STOP=1 -f supabase/migrations_drafts/$d.sql >/dev/null 2>"$OUT/$d.err" || { echo "overlay $d FAILED"; cat "$OUT/$d.err"; rc=1; }; done
$P -v ON_ERROR_STOP=1 -f - <<'GAPS'
-- Objects production has that no file in supabase/migrations creates (found while replaying; local stand-ins, NOT production definitions):
ALTER TABLE public.claims ADD COLUMN IF NOT EXISTS measurement_shape text;

GAPS
$P -v ON_ERROR_STOP=1 -f - <<'SEED'
-- LOCAL fixture rows with the production ids and the production states read on 2026-11-19 (SELECT). Everything is is_test. NOT production data.
INSERT INTO auth.users (id, email, created_at) VALUES
 ('f6c14b57-59dc-43ce-b510-04277a71f5af','owner@otterquote.com','2026-04-28 18:55:26.174939+00'),
 ('6a9ec731-85d4-4076-ae99-bc77829ee393','stranger@otterquote.com','2026-04-29 00:00:00+00'),
 ('d4def812-aebc-444c-bdee-f68bccc19b61','k1@otterquote.com','2026-04-29 00:00:00+00'),
 ('189b85ad-0ab0-4e54-9083-c51c3ef42a1d','k2@otterquote.com','2026-04-29 00:00:00+00'),
 ('92d669a8-0000-0000-0000-000000000001','k3@otterquote.com','2026-04-29 00:00:00+00'),
 ('ac869f4e-9afe-4244-a390-0fff42cdc6e9','otq-test-partner@otterquote.com','2026-10-01 00:00:00+00'),
 ('3ea4d929-b916-4cc9-a285-d052df397992','dustinstohler1@gmail.com','2026-03-01 00:00:00+00'),
 ('02fbf1c3-0000-0000-0000-0000000000a1','agent1@otterquote.com','2026-04-29 00:00:00+00'),
 ('770c7bd8-0000-0000-0000-0000000000a2','agent2@otterquote.com','2026-04-29 00:00:00+00'),
 ('8fa0d121-0000-0000-0000-0000000000a3','k0@otterquote.com','2026-04-29 00:00:00+00');
INSERT INTO public.profiles (id, email, is_test, role) SELECT id, email, true, 'homeowner' FROM auth.users ON CONFLICT (id) DO UPDATE SET is_test=true;
INSERT INTO public.admin_emails (email) VALUES ('dustin@otterquote.com'),('dustinstohler1@gmail.com') ON CONFLICT DO NOTHING;
INSERT INTO public.contractors (id, user_id, company_name, contact_name, email, status, is_test, has_payment_method, coi_file_url, coi_expires_at, attestation_accepted_at, stripe_payment_method_id, stripe_payment_method_last4) VALUES
 ('986ce2b6-39fd-4a2c-aba4-a806c618c8c0','d4def812-aebc-444c-bdee-f68bccc19b61','K1 Test','K1','k1@otterquote.com','active',true,false,'x','2027-06-01',now(),NULL,NULL),
 ('bb07fc40-3607-4f3f-ac44-dffd4ca95111','189b85ad-0ab0-4e54-9083-c51c3ef42a1d','K2 Test','K2','k2@otterquote.com','active',true,false,'x','2027-12-31',now(),NULL,NULL),
 ('2bc792be-b677-4ac1-bc68-94b1561d9757','92d669a8-0000-0000-0000-000000000001','K3 Test','K3','k3@otterquote.com','active',true,true,'x','2026-12-31',now(),'pm_local','4242'),
 ('8fa0d121-0000-0000-0000-000000000001','8fa0d121-0000-0000-0000-0000000000a3','K0 Test','K0','k0@otterquote.com','active',true,true,'x','2027-12-31',now(),'pm_local','4242'),
 ('ee452a12-c16e-4d30-9d2c-df8128fbce52','3ea4d929-b916-4cc9-a285-d052df397992','Stohler Roofing, LLC','Dustin','dustin@stohlerroof.com','pending_approval',true,false,NULL,NULL,NULL,NULL,NULL);
UPDATE public.profiles SET role='contractor' WHERE id='3ea4d929-b916-4cc9-a285-d052df397992';
INSERT INTO public.referral_agents (id, user_id, agent_type, first_name, last_name, email, unique_code, status, is_test) VALUES
 ('02fbf1c3-6063-4b9e-98d0-387560ed6d97','02fbf1c3-0000-0000-0000-0000000000a1','re_agent','Agent','One','agent1@otterquote.com','8C61OKGF','active',true),
 ('56c1319a-6376-4405-8ccc-88a574d7ede4','ac869f4e-9afe-4244-a390-0fff42cdc6e9','re_agent','Test','Partner','otq-test-partner@otterquote.com','TESTPART','active',true),
 ('1927861f-8836-49ce-a528-08c432cc69cc','3ea4d929-b916-4cc9-a285-d052df397992','home_inspector','Dustin','Stohler','dustinstohler1@gmail.com','DUSTIN01','active',true),
 ('0a0a0a0a-0000-0000-0000-000000000002','770c7bd8-0000-0000-0000-0000000000a2','re_agent','Agent','Two','agent2@otterquote.com','ZZZZ0002','active',true);
INSERT INTO public.referrals (id, referral_agent_id, status, is_test, created_at) VALUES ('770c7bd8-532b-4f75-8a82-dfca275fcd98','0a0a0a0a-0000-0000-0000-000000000002','clicked',true,'2026-09-26 12:00:00+00');
INSERT INTO public.claims (id, user_id, is_test, status, selected_contractor_id, selected_bid_amount, property_state) VALUES
 ('4d764e19-0549-43db-a967-9ab564f05f23','f6c14b57-59dc-43ce-b510-04277a71f5af',true,'bidding',NULL,NULL,'IN'),
 ('8dcf76f1-f518-4363-a37f-192dec10b9bb','f6c14b57-59dc-43ce-b510-04277a71f5af',true,'bidding',NULL,NULL,'IN'),
 ('374a2053-de6c-4f9a-9974-2e22714a4795','f6c14b57-59dc-43ce-b510-04277a71f5af',true,'bidding',NULL,NULL,'IN'),
 ('6aea8081-a3a3-4a22-a1a8-1becb7fedcb6','f6c14b57-59dc-43ce-b510-04277a71f5af',true,'bidding',NULL,NULL,'IN');
SET session_replication_role = replica; -- seed only: skip the D-199 bid gate trigger (needs contractor_templates)
INSERT INTO public.quotes (id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, status, bid_status, is_test, cancelled_at, homeowner_signed_at, contractor_signed_at) VALUES
 ('ff1f8323-1e74-43d6-a6b4-116b940dfa65','4d764e19-0549-43db-a967-9ab564f05f23','986ce2b6-39fd-4a2c-aba4-a806c618c8c0',13560,5,678,'declined','superseded',true,'2026-10-26 14:08:38+00',now(),now()),
 ('0a334300-2a4a-4ba6-ac77-efea0fa73179','8dcf76f1-f518-4363-a37f-192dec10b9bb','bb07fc40-3607-4f3f-ac44-dffd4ca95111',15000,5,750,'declined','cancelled',true,NULL,NULL,NULL),
 ('be305d7c-7982-4e37-89a3-95b2ae79ce63','374a2053-de6c-4f9a-9974-2e22714a4795','bb07fc40-3607-4f3f-ac44-dffd4ca95111',15000,5,750,'declined','active',true,NULL,NULL,NULL),
 ('6fd064f1-4d3f-4fda-af82-da9363a6812f','8dcf76f1-f518-4363-a37f-192dec10b9bb','2bc792be-b677-4ac1-bc68-94b1561d9757',15000,5,750,'selected','active',true,NULL,NULL,NULL),
 ('471b2b5a-fb94-4558-aaf7-aa1670d000a2','374a2053-de6c-4f9a-9974-2e22714a4795','2bc792be-b677-4ac1-bc68-94b1561d9757',15000,5,750,'selected','active',true,NULL,NULL,NULL),
 ('6e3d1807-b96c-4595-8153-ad7e39dc4aa7','6aea8081-a3a3-4a22-a1a8-1becb7fedcb6','bb07fc40-3607-4f3f-ac44-dffd4ca95111',15000,5,750,'selected','active',true,NULL,now(),now());
RESET session_replication_role;
-- production states of the claims: c1 bidding (sel 8fa0d121), cs and cb awarded to k3, the q2 claim contract_signed
UPDATE public.claims SET selected_contractor_id='8fa0d121-0000-0000-0000-000000000001' WHERE id='4d764e19-0549-43db-a967-9ab564f05f23';
UPDATE public.claims SET selected_contractor_id='2bc792be-b677-4ac1-bc68-94b1561d9757', selected_bid_amount=15000, status='awarded' WHERE id IN ('8dcf76f1-f518-4363-a37f-192dec10b9bb','374a2053-de6c-4f9a-9974-2e22714a4795');
UPDATE public.claims SET selected_contractor_id='bb07fc40-3607-4f3f-ac44-dffd4ca95111', selected_bid_amount=15000, status='contract_signed' WHERE id='6aea8081-a3a3-4a22-a1a8-1becb7fedcb6';

SEED
[ $? -eq 0 ] || { echo "SEED FAILED"; exit 2; }
echo "== proof (oq.proof_local=1: no email belt, so the real notify trigger path runs)"
psql -q -d "$DB" -c "ALTER DATABASE $DB SET oq.proof_local = '1'"
fp() { psql -At -d "$DB" -c "SELECT md5(string_agg(t, '|' ORDER BY k)) FROM (SELECT 'q'||id k, to_jsonb(q)::text t FROM public.quotes q UNION ALL SELECT 'c'||id, to_jsonb(c)::text FROM public.claims c UNION ALL SELECT 'k'||id, to_jsonb(k)::text FROM public.contractors k UNION ALL SELECT 'a'||id, to_jsonb(a)::text FROM public.referral_agents a UNION ALL SELECT 'p'||id, to_jsonb(p)::text FROM public.profiles p UNION ALL SELECT 'u'||id, created_at::text FROM auth.users UNION ALL SELECT 'r'||id, to_jsonb(r)::text FROM public.referrals r UNION ALL SELECT 'y'||id, to_jsonb(y)::text FROM public.payout_approvals y) s"; }
FP0=$(fp); QN0=$(psql -At -d "$DB" -c "SELECT count(*) FROM net.http_request_queue")
psql -q -d "$DB" -v VERBOSITY=terse -f supabase/tests/gh2479_quotes_guard_proof.sql > "$OUT/proof.out" 2> "$OUT/proof.err"
grep -q GH2479_QUOTES_FORCED_ROLLBACK "$OUT/proof.err" && echo "forced rollback: yes" || { echo "forced rollback: NOT SEEN"; rc=1; }
cat "$OUT/proof.err" | sed 's/^psql:[^ ]*ERROR:  P0001: GH2479_QUOTES_FORCED_ROLLBACK//' | grep -E '^(PASS|FAIL|INFO|FIXTURE|GUARDS|SUMMARY|CONTEXT)' | cut -c1-400 > "$OUT/proof.lines"
cat "$OUT/proof.lines"
FP1=$(fp); QN1=$(psql -At -d "$DB" -c "SELECT count(*) FROM net.http_request_queue")
[ "$FP0" = "$FP1" ] && echo "fingerprint before == after ($FP0): the batch changed nothing that committed" || { echo "FINGERPRINT CHANGED $FP0 -> $FP1"; rc=1; }
[ "$QN0" = "$QN1" ] && echo "net.http_request_queue rows before == after ($QN0)" || { echo "QUEUE CHANGED $QN0 -> $QN1"; rc=1; }
grep -q '^SUMMARY' "$OUT/proof.lines" || { echo "no SUMMARY line"; rc=1; }
F=$(grep -c '^FAIL' "$OUT/proof.lines"); echo "FAIL lines: $F"; [ "$F" = 0 ] || rc=1
# the statements the proof carries for #3203 must be the PR's, byte for byte
if [ -n "${DETACH_SQL:-}" ] && [ -f "$DETACH_SQL" ]; then
  R="${DETACH_SQL%.sql}_rollback.sql"
  for f in "$DETACH_SQL" "$R"; do python3 - "$f" supabase/tests/gh2479_quotes_guard_proof.sql <<'PY' || rc=1
import re,sys
src=open(sys.argv[1]).read(); proof=open(sys.argv[2]).read()
body=re.sub(r'(?m)^--.*\n','',src)
stm=re.findall(r'(DO \$\$.*?END \$\$;|UPDATE public\.\w+ SET .*?;)',body,re.S)
miss=[s for s in stm if s not in proof]
print(sys.argv[1].split('/')[-1],'statements',len(stm),'missing from proof:',len(miss))
sys.exit(1 if miss or not stm else 0)
PY
  done
else echo "DETACH_SQL not given: byte-equality check of the #3203 statements skipped"; fi
exit $rc
