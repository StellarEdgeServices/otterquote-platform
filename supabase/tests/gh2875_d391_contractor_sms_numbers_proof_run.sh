#!/usr/bin/env bash
# gh-2875 (D-391): run the contractor SMS numbers proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGBIN=<dir with initdb/pg_ctl/psql> bash supabase/tests/gh2875_d391_contractor_sms_numbers_proof_run.sh [outdir]
# Four fresh databases on one throwaway cluster:
#   TODAY     stub schema only (main: no forward)          -> every P line REJECTED 42P01/42883 (the objects do not exist)
#   AFTER     + forward                                    -> client writes refused, sender read service_role only, invariants hold
#   MUTANT    + forward, then client INSERT/UPDATE re-granted and the replace-only block removed from the trigger -> P1/P2/P12 flip (negative control)
#   ROLLBACK  + forward + rollback                         -> same as TODAY (every object gone)
# Exit 0 only if every expectation holds.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
D=supabase/migrations_drafts; T=supabase/tests
FWD=$D/gh2875_d391_contractor_sms_numbers.sql; RB=$D/gh2875_d391_contractor_sms_numbers_rollback.sql
PROOF=$T/gh2875_d391_contractor_sms_numbers_proof.sql
TMP=$(mktemp -d /tmp/gh2875pg.XXXXXX); PORT=${PGPORT_LOCAL:-54375}
"$PGBIN/initdb" -D "$TMP/data" -A trust -U postgres >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null || exit 2
trap '"$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1; rm -rf "$TMP"' EXIT
P() { "$PGBIN/psql" -X -q -h "$TMP" -p "$PORT" -U postgres "$@"; }
P -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE anon NOLOGIN" -c "CREATE ROLE authenticated NOLOGIN" -c "CREATE ROLE service_role NOLOGIN BYPASSRLS" >/dev/null || exit 2
stub() {
  P -d "$1" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid $$;
CREATE FUNCTION public.is_admin_email() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT (auth.jwt() ->> 'email') IN ('dustinstohler1@gmail.com', 'dustin@otterquote.com') $$;
CREATE TABLE public.contractors (id uuid PRIMARY KEY, user_id uuid, is_test boolean NOT NULL DEFAULT false);
GRANT SELECT ON public.contractors TO anon, authenticated, service_role;
-- Supabase's default privileges grant ALL on new public tables to anon/authenticated/service_role; mirror that so the
-- forward file's REVOKE is what is being tested, not an empty default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
SQL
}
rc=0; fail() { echo "EXPECT FAIL: $*"; rc=1; }
run() { local name=$1; shift; local db="gh2875_${name,,}"
  P -d postgres -c "CREATE DATABASE $db" >/dev/null; stub "$db"
  for f in "$@"; do P -d "$db" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>"$OUT/$name-apply.err" || fail "$name: apply $f failed"; done
  P -d "$db" -f "$PROOF" > "$OUT/$name.txt" 2>"$OUT/$name.err"; echo "== $name"; grep -E '^(F|P)[0-9]+ ' "$OUT/$name.txt"; }
run TODAY
run AFTER "$FWD"
printf '%s\n' "GRANT INSERT, UPDATE ON public.contractor_sms_numbers TO authenticated;" \
  "CREATE POLICY mutant_write ON public.contractor_sms_numbers FOR ALL TO authenticated USING (true) WITH CHECK (true);" \
  "CREATE OR REPLACE FUNCTION public.contractor_sms_numbers_before_write() RETURNS trigger LANGUAGE plpgsql AS \$m\$ BEGIN NEW.updated_at := now(); IF NEW.status <> 'verified' THEN NEW.is_primary := false; END IF; RETURN NEW; END \$m\$;" > "$OUT/mutant.sql"
run MUTANT "$FWD" "$OUT/mutant.sql"
run ROLLBACK "$FWD" "$RB"
A=$OUT/AFTER.txt
for k in P1 P2 P3 P6 P7; do grep -q "^$k .*REJECTED 42501" "$A" || fail "AFTER $k must be REJECTED 42501"; done
grep -q '^P4 .*VALUE 4$' "$A" || fail "AFTER P4 must be 4"
grep -q '^P5 .*VALUE 1$' "$A" || fail "AFTER P5 must be 1"
grep -q '^P8 .*ACCEPTED' "$A" || fail "AFTER P8 must be ACCEPTED"
grep -q '^P9 .*VALUE +15550000001\*,+15550000002$' "$A" || fail "AFTER P9 must be +15550000001*,+15550000002"
grep -q '^P10 .*REJECTED 23502' "$A" || fail "AFTER P10 must be REJECTED 23502"
grep -q '^P11 .*REJECTED 23503' "$A" || fail "AFTER P11 must be REJECTED 23503"
for k in P12 P13; do grep -q "^$k .*REJECTED 23514" "$A" || fail "AFTER $k must be REJECTED 23514"; done
grep -q '^P14 .*ACCEPTED rows=1' "$A" || fail "AFTER P14 must be ACCEPTED"
grep -q '^P15 .*VALUE 0$' "$A" || fail "AFTER P15 must be 0"
grep -q '^P16 .*ACCEPTED rows=1' "$A" || fail "AFTER P16 must be ACCEPTED"
grep -q '^P17 .*VALUE +15550000002$' "$A" || fail "AFTER P17 must be +15550000002"
grep -q '^P18 .*REJECTED 23505' "$A" || fail "AFTER P18 must be REJECTED 23505"
grep -q '^P19 .*REJECTED 23514' "$A" || fail "AFTER P19 must be REJECTED 23514"
grep -q '^P20 .*ACCEPTED rows=1' "$A" || fail "AFTER P20 must be ACCEPTED"
grep -q '^P21 .*VALUE +15550000002\*,+15550000004$' "$A" || fail "AFTER P21 must be +15550000002*,+15550000004"
grep -q '^P22 .*REJECTED 23514' "$A" || fail "AFTER P22 must be REJECTED 23514"
grep -q '^P23 .*VALUE all$' "$A" || fail "AFTER P23 must be all"
M=$OUT/MUTANT.txt
for k in P1 P2 P12; do grep -q "^$k .*ACCEPTED" "$M" || fail "MUTANT $k must flip to ACCEPTED (negative control)"; done
for f in TODAY ROLLBACK; do grep -q '^P1 .*REJECTED 42P01' "$OUT/$f.txt" || fail "$f P1 must be REJECTED 42P01 (table absent)"; done
diff <(grep -E '^(F|P)[0-9]+ ' "$OUT/TODAY.txt") <(grep -E '^(F|P)[0-9]+ ' "$OUT/ROLLBACK.txt") >/dev/null && echo "ROLLBACK matches TODAY" || fail "ROLLBACK differs from TODAY"
echo "EXIT=$rc"; exit $rc
