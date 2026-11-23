#!/usr/bin/env bash
# gh-2710 local re-proof (2026-11-23, cto108-b2710). Runs the REAL repo files
#   supabase/migrations_drafts/gh2710_claims_fee_stripe_columns_guard.sql (forward)
#   supabase/migrations_rollbacks/gh2710_claims_fee_stripe_columns_guard_rollback.sql
# on a throwaway local PostgreSQL seeded with the production-shaped claims fee columns, RLS policies, grants,
# is_admin_email() and auth.* helpers (read by SELECT from production 2026-11-23). Local only: production DDL
# (even rolled back) was not run. Usage: PGHOST=/tmp/pg PGPORT=5544 PGUSER=postgres bash this.sh  (needs createdb rights)
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FWD="$ROOT/supabase/migrations_drafts/gh2710_claims_fee_stripe_columns_guard.sql"
RB="$ROOT/supabase/migrations_rollbacks/gh2710_claims_fee_stripe_columns_guard_rollback.sql"
W="$(mktemp -d)"
cat > "$W/seed.sql" <<'SEED'
-- stub roles and Supabase-shaped auth helpers (local throwaway only)
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ select (auth.jwt()->>'sub')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ select auth.jwt()->>'role' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE public.admin_emails (email text primary key);
INSERT INTO public.admin_emails VALUES ('admin@example.test');
-- production definition of is_admin_email(), read via pg_get_functiondef
CREATE OR REPLACE FUNCTION public.is_admin_email() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.admin_emails ae WHERE ae.email = (auth.jwt() ->> 'email')); $$;
-- minimal claims: the fee/stripe columns, user_id, RLS as read from production pg_policy, table grants as read
CREATE TABLE public.claims (id uuid primary key default gen_random_uuid(), user_id uuid not null, is_test boolean default false,
  platform_fee_charged boolean, platform_fee_stripe_id text, platform_fee_amount numeric(10,2));
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can update own claims" ON public.claims FOR UPDATE USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
CREATE POLICY "Users can insert own claims" ON public.claims FOR INSERT WITH CHECK (user_id = (select auth.uid()));
CREATE POLICY "Users can view own claims" ON public.claims FOR SELECT TO authenticated USING (user_id = (select auth.uid()));
CREATE POLICY claims_admin_update ON public.claims FOR UPDATE USING (is_admin_email()) WITH CHECK (is_admin_email());
CREATE POLICY claims_admin_select ON public.claims FOR SELECT USING (is_admin_email());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.claims TO anon, authenticated; GRANT ALL ON public.claims TO service_role;
GRANT SELECT ON public.admin_emails TO authenticated;
INSERT INTO public.claims(id,user_id,is_test,platform_fee_charged,platform_fee_stripe_id,platform_fee_amount)
 VALUES ('82f5dff4-5867-4b7a-88ca-942ce9bfe867','92d669a8-c02a-42c1-9f52-53b7efd06ddf',true,true,'ch_3UAdlB0AJRnqIYPU0vC3SeiG',175.00);
SEED
cat > "$W/probe.sql" <<'PROBE'
\set ON_ERROR_STOP off
\echo '-- owner (authenticated) rewrite'
SET request.jwt.claims = '{"sub":"92d669a8-c02a-42c1-9f52-53b7efd06ddf","role":"authenticated","email":"owner@example.test"}';
SET ROLE authenticated;
BEGIN; UPDATE public.claims SET platform_fee_stripe_id='ch_forged', platform_fee_amount=1 WHERE id='82f5dff4-5867-4b7a-88ca-942ce9bfe867'; ROLLBACK;
BEGIN; UPDATE public.claims SET platform_fee_stripe_id=NULL WHERE id='82f5dff4-5867-4b7a-88ca-942ce9bfe867'; ROLLBACK;
BEGIN; UPDATE public.claims SET platform_fee_stripe_id=platform_fee_stripe_id, platform_fee_amount=platform_fee_amount WHERE id='82f5dff4-5867-4b7a-88ca-942ce9bfe867'; ROLLBACK;
BEGIN; UPDATE public.claims SET is_test=is_test WHERE id='82f5dff4-5867-4b7a-88ca-942ce9bfe867'; ROLLBACK;
RESET ROLE;
\echo '-- service_role (docusign-webhook / stripe-webhook)'
SET request.jwt.claims = '{"role":"service_role"}';
SET ROLE service_role;
UPDATE public.claims SET platform_fee_stripe_id='ch_webhook', platform_fee_amount=250 WHERE id='82f5dff4-5867-4b7a-88ca-942ce9bfe867' RETURNING platform_fee_stripe_id, platform_fee_amount;
RESET ROLE;
\echo '-- admin email as authenticated'
SET request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","email":"admin@example.test"}';
SET ROLE authenticated;
BEGIN; UPDATE public.claims SET platform_fee_amount=251 WHERE id='82f5dff4-5867-4b7a-88ca-942ce9bfe867'; ROLLBACK;
RESET ROLE;
\echo '-- objects'
select (select count(*) from pg_trigger where tgname='claims_guard_fee_stripe_columns') trg, (select count(*) from pg_proc where proname='claims_guard_fee_stripe_columns') fn;
PROBE
P="psql -X"
$P -d postgres -c "drop database if exists gh2710_proof" -c "create database gh2710_proof"
P="$P -d gh2710_proof"
$P -q -f "$W/seed.sql" 2>&1 | grep -v 'already exists'
echo "=== BEFORE FORWARD (negative control)"; $P -f "$W/probe.sql" 2>&1 | grep -vE '^(BEGIN|ROLLBACK|SET|RESET|CONTEXT)'
echo "=== FORWARD"; $P -f "$FWD" 2>&1 | grep -v NOTICE
echo "=== AFTER FORWARD"; $P -f "$W/probe.sql" 2>&1 | grep -vE '^(BEGIN|ROLLBACK|SET|RESET|CONTEXT)'
echo "=== ROLLBACK"; $P -f "$RB" 2>&1 | grep -v NOTICE
echo "=== AFTER ROLLBACK"; $P -f "$W/probe.sql" 2>&1 | grep -vE '^(BEGIN|ROLLBACK|SET|RESET|CONTEXT)'
$P -d postgres -c "drop database gh2710_proof" >/dev/null
