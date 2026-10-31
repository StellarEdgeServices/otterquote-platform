#!/usr/bin/env bash
# gh-3256 proof runner. THROWAWAY POSTGRES ONLY -- never point this at production.
# Needs a throwaway cluster whose bootstrap superuser is named supabase_admin (as on Supabase), so that `postgres` can be the
# non-superuser, non-member migration role it is in production:
#   initdb -D <dir> -U supabase_admin -A trust ; pg_ctl -D <dir> start
# Usage (repo root): PGHOST=... PGPORT=... bash supabase/tests/gh3256_default_privs_proof_run.sh [outdir]
# Phases:
#   C  CAPABILITY  as postgres: ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin ... -> 42501 (why supabase_admin is out of scope
#                  and the CI gate is the fallback); postgres is not superuser and not a member of supabase_admin.
#   0  BEFORE      a table postgres creates gives anon/authenticated TRUNCATE, and `TRUNCATE` as authenticated succeeds
#                  (negative control: the defect is real on the production-shaped model).
#   1  AFTER       forward (run as postgres): a NEW table postgres creates refuses TRUNCATE to anon/authenticated (42501) and keeps
#                  every other privilege; service_role keeps TRUNCATE; the BEFORE table is untouched; a table supabase_admin creates
#                  still gets TRUNCATE (the documented gap the CI gate covers).
#   2  RERUN       forward again: no change.
#   3  ROLLBACK    pg_default_acl identical to BEFORE; a table created after it gets TRUNCATE again; rollback twice is safe.
#   4  REAPPLY     forward again after rollback: same as AFTER.
#   5  MUTANTS     forward/rollback variants with one defect each; every one must be killed.
#   6  GATE vs PG  every fixture of scripts/new-table-truncate-revoke-check.py is run on real Postgres with today's defaults; the
#                  detector's verdict must match whether a new public table really keeps client TRUNCATE (one documented,
#                  deliberately conservative exception).
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
FWD="$D/gh3256_default_privs_no_client_truncate.sql"; RBK="$D/gh3256_default_privs_no_client_truncate_rollback.sql"
SETUP="$T/gh3256_default_privs_scratch_setup.sql"
DB=gh3256_proof; rc=0
export PGOPTIONS='-c client_min_messages=warning'
SU="psql -X -q -At -U supabase_admin"; PG="psql -X -q -At -U postgres"
ok()  { echo "CHECK PASS: $*"; }
bad() { echo "CHECK FAIL: $*"; rc=1; }

fresh() {
  $SU -d postgres -c "DROP DATABASE IF EXISTS $1" >/dev/null 2>&1
  $SU -d postgres -v ON_ERROR_STOP=1 -f "$SETUP" >/dev/null 2>&1 || true   # roles are cluster-wide; idempotent
  $SU -d postgres -c "CREATE DATABASE $1 OWNER postgres" >/dev/null || { echo "cannot create $1"; exit 2; }
  $SU -d "$1" -v ON_ERROR_STOP=1 -f "$SETUP" >/dev/null || { echo "setup failed on $1"; exit 2; }
}
defacl() { $SU -d "$1" -c "select defaclrole::regrole || '|' || defaclnamespace::regnamespace || '|' || defaclobjtype::text || '|' || defaclacl::text from pg_default_acl order by 1"; }
# tbl_facts <db> <table>: anon/auth TRUNCATE, anon/auth SELECT+INSERT+UPDATE+DELETE, service_role TRUNCATE, a real TRUNCATE as authenticated
tbl_facts() {
  local t="$2"
  $SU -d "$1" -c "select 'priv ' || has_table_privilege('anon','public.$t','TRUNCATE') || ',' || has_table_privilege('authenticated','public.$t','TRUNCATE')
      || ' other ' || (has_table_privilege('anon','public.$t','SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER')
                       AND has_table_privilege('authenticated','public.$t','SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER'))
      || ' service ' || has_table_privilege('service_role','public.$t','TRUNCATE')"
  local r
  r=$($PG -d "$1" -c "begin; set local role authenticated; truncate public.$t; rollback;" 2>&1)
  if [ -z "$r" ]; then echo "truncate-as-authenticated OK"; else echo "truncate-as-authenticated $(echo "$r" | grep -o 'permission denied' | head -1)"; fi
}
mk_pg_table() { $PG -d "$1" -v ON_ERROR_STOP=1 -c "create table public.$2 (id int)" >/dev/null; }
mk_sa_table() { $SU -d "$1" -v ON_ERROR_STOP=1 -c "create table public.$2 (id int)" >/dev/null; }
apply_pg() { $PG -d "$1" -v ON_ERROR_STOP=1 -f "$2" > "$OUT/apply-$3.log" 2>&1; }
OPEN="priv true,true other true service true
truncate-as-authenticated OK"
CLOSED="priv false,false other true service true
truncate-as-authenticated permission denied"

echo "== C. CAPABILITY (why supabase_admin's defaults are not in the migration)"
fresh "$DB"
F=$($SU -d "$DB" -c "select rolsuper::text || ',' || pg_has_role('postgres','supabase_admin','MEMBER')::text from pg_roles where rolname='postgres'")
[ "$F" = "false,false" ] && ok "postgres: rolsuper=false, member of supabase_admin=false (as in production)" || bad "role facts $F"
E=$($PG -d "$DB" -c "begin; alter default privileges for role supabase_admin in schema public revoke truncate on tables from anon, authenticated; rollback;" 2>&1)
echo "$E" | grep -q "permission denied" && ok "postgres cannot alter supabase_admin's defaults: $(echo "$E" | grep -o 'ERROR:.*' | head -1)" || bad "postgres altered supabase_admin's defaults: $E"
defacl "$DB" > "$OUT/defacl0.txt"
grep -q "postgres|public|r|{postgres=arwdDxt/postgres,anon=arwdDxt/postgres,authenticated=arwdDxt/postgres,service_role=arwdDxt/postgres}" "$OUT/defacl0.txt" \
  && grep -q "supabase_admin|public|r|{postgres=arwdDxt/supabase_admin,anon=arwdDxt/supabase_admin,authenticated=arwdDxt/supabase_admin,service_role=arwdDxt/supabase_admin}" "$OUT/defacl0.txt" \
  && ok "model default ACLs = production's (PG16 has no MAINTAIN)" || { bad "model default ACLs"; cat "$OUT/defacl0.txt"; }

echo "== 0. BEFORE (negative control)"
mk_pg_table "$DB" t_before
B=$(tbl_facts "$DB" t_before); [ "$B" = "$OPEN" ] && ok "BEFORE: new postgres table -> anon/authenticated TRUNCATE, and TRUNCATE as authenticated succeeds" || bad "BEFORE facts: $B"

echo "== 1. AFTER"
apply_pg "$DB" "$FWD" after && ok "forward applied as postgres" || bad "forward failed: $(cat "$OUT/apply-after.log")"
defacl "$DB" > "$OUT/defacl_after.txt"
diff "$OUT/defacl0.txt" "$OUT/defacl_after.txt" | grep '^[<>]' | sed 's/^/  /'
[ "$(diff "$OUT/defacl0.txt" "$OUT/defacl_after.txt" | grep -c '^[<>]')" = 2 ] && grep -q "postgres|public|r|{postgres=arwdDxt/postgres,anon=arwdxt/postgres,authenticated=arwdxt/postgres,service_role=arwdDxt/postgres}" "$OUT/defacl_after.txt" \
  && ok "AFTER: exactly one default-ACL row changed (postgres, public, tables): anon/authenticated arwdDxt -> arwdxt" || bad "AFTER default ACL diff"
mk_pg_table "$DB" t_after
A=$(tbl_facts "$DB" t_after); [ "$A" = "$CLOSED" ] && ok "AFTER: new postgres table -> no client TRUNCATE (42501 as authenticated), other privileges and service_role TRUNCATE kept" || bad "AFTER facts: $A"
[ "$(tbl_facts "$DB" t_before)" = "$OPEN" ] && ok "AFTER: the table created BEFORE is untouched (existing tables are #3252's scope)" || bad "existing table changed"
mk_sa_table "$DB" t_sa_after
[ "$(tbl_facts "$DB" t_sa_after | head -1)" = "priv true,true other true service true" ] && ok "AFTER: a table created as supabase_admin still gets client TRUNCATE (documented gap -> CI gate)" || bad "supabase_admin table facts"

echo "== 2. RERUN"
apply_pg "$DB" "$FWD" rerun && ok "forward reran cleanly" || bad "rerun failed: $(cat "$OUT/apply-rerun.log")"
defacl "$DB" | diff -q - "$OUT/defacl_after.txt" >/dev/null && ok "RERUN: default ACL unchanged" || bad "rerun changed defaults"
mk_pg_table "$DB" t_rerun; [ "$(tbl_facts "$DB" t_rerun)" = "$CLOSED" ] && ok "RERUN: new table still closed" || bad "rerun table"

echo "== 3. ROLLBACK"
apply_pg "$DB" "$RBK" rollback && ok "rollback applied as postgres" || bad "rollback failed: $(cat "$OUT/apply-rollback.log")"
defacl "$DB" | diff - "$OUT/defacl0.txt" >/dev/null && ok "ROLLBACK: pg_default_acl identical to BEFORE ($(wc -l < "$OUT/defacl0.txt") rows)" || bad "ROLLBACK default ACL differs"
mk_pg_table "$DB" t_rb; [ "$(tbl_facts "$DB" t_rb)" = "$OPEN" ] && ok "ROLLBACK: a table created after it gets client TRUNCATE again" || bad "rollback table"
apply_pg "$DB" "$RBK" rollback2 && defacl "$DB" | diff -q - "$OUT/defacl0.txt" >/dev/null && ok "rollback run twice: still identical" || bad "second rollback"

echo "== 4. REAPPLY"
apply_pg "$DB" "$FWD" reapply && defacl "$DB" | diff -q - "$OUT/defacl_after.txt" >/dev/null && ok "REAPPLY: default ACL = AFTER" || bad "reapply"
mk_pg_table "$DB" t_re; [ "$(tbl_facts "$DB" t_re)" = "$CLOSED" ] && ok "REAPPLY: new table closed" || bad "reapply table"

echo "== 5. MUTANTS"
killed=0; total=0
NOPOST='/^DO \$post\$/,/^\$post\$;/d'
mutant() { # name, sed expr on the forward; killed if it fails to apply, or a new table is not exactly CLOSED, or defaults drift elsewhere
  local name="$1" expr="$2"; total=$((total+1))
  sed -E "$expr" "$FWD" > "$OUT/mut_$name.sql"
  cmp -s "$OUT/mut_$name.sql" "$FWD" && { bad "mutant $name: sed changed nothing"; return; }
  fresh "${DB}_m"
  if ! apply_pg "${DB}_m" "$OUT/mut_$name.sql" "m_$name"; then killed=$((killed+1)); echo "  killed (apply refused: $(grep -o 'ERROR:.*' "$OUT/apply-m_$name.log" | head -1 | cut -c1-90)) $name"; return; fi
  mk_pg_table "${DB}_m" t_m
  local f; f=$(tbl_facts "${DB}_m" t_m)
  local other; other=$(defacl "${DB}_m" | grep -v '^postgres|public|r|' | diff - <(grep -v '^postgres|public|r|' "$OUT/defacl0.txt") | grep -c '^[<>]')
  if [ "$f" = "$CLOSED" ] && [ "$other" = 0 ]; then bad "mutant SURVIVED: $name"; else killed=$((killed+1)); echo "  killed (probe: $(echo "$f" | head -1); other default rows changed=$other) $name"; fi
}
mutant anon_only          "s/REVOKE TRUNCATE ON TABLES FROM anon, authenticated/REVOKE TRUNCATE ON TABLES FROM anon/; $NOPOST"
mutant authenticated_only "s/REVOKE TRUNCATE ON TABLES FROM anon, authenticated/REVOKE TRUNCATE ON TABLES FROM authenticated/; $NOPOST"
mutant revoke_all         "s/REVOKE TRUNCATE ON TABLES/REVOKE ALL ON TABLES/; $NOPOST"
mutant also_service_role  "s/FROM anon, authenticated;/FROM anon, authenticated, service_role;/; $NOPOST"
mutant no_schema_global   "s/FOR ROLE postgres IN SCHEMA public REVOKE/FOR ROLE postgres REVOKE/; $NOPOST"
mutant sequences          "s/REVOKE TRUNCATE ON TABLES/REVOKE UPDATE ON SEQUENCES/; $NOPOST"
mutant also_sequences     "s/^(ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE ON TABLES FROM anon, authenticated;)/\1 ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE UPDATE ON SEQUENCES FROM anon, authenticated;/; $NOPOST"
mutant for_supabase_admin "s/FOR ROLE postgres IN SCHEMA public REVOKE/FOR ROLE supabase_admin IN SCHEMA public REVOKE/; $NOPOST"
mutant grant_option_only  "s/REVOKE TRUNCATE ON TABLES/REVOKE GRANT OPTION FOR TRUNCATE ON TABLES/; $NOPOST"
# the forward's own assertions as a kill layer
mutant assert_anon_only   "s/REVOKE TRUNCATE ON TABLES FROM anon, authenticated/REVOKE TRUNCATE ON TABLES FROM anon/"
mutant assert_revoke_all  "s/REVOKE TRUNCATE ON TABLES/REVOKE ALL ON TABLES/"
mutant assert_service     "s/FROM anon, authenticated;/FROM anon, authenticated, service_role;/"
rb_mutant() {
  local name="$1" expr="$2"; total=$((total+1))
  sed -E "$expr" "$RBK" > "$OUT/rbm_$name.sql"
  cmp -s "$OUT/rbm_$name.sql" "$RBK" && { bad "rb mutant $name: sed changed nothing"; return; }
  fresh "${DB}_m"; apply_pg "${DB}_m" "$FWD" "rbm_f_$name" || { bad "rb mutant $name: forward failed"; return; }
  if ! apply_pg "${DB}_m" "$OUT/rbm_$name.sql" "rbm_$name"; then killed=$((killed+1)); echo "  killed (rollback refused) rb_$name"; return; fi
  if defacl "${DB}_m" | diff -q - "$OUT/defacl0.txt" >/dev/null; then bad "rollback mutant SURVIVED: $name"; else killed=$((killed+1)); echo "  killed (pg_default_acl differs from BEFORE) rb_$name"; fi
}
# (GRANT ALL ON TABLES TO anon, authenticated is an EQUIVALENT rollback here, not a defect: the pre-forward entries already hold ALL.)
rb_mutant to_public        "s/TO anon, authenticated;/TO PUBLIC;/"
rb_mutant wrong_owner_role "s/FOR ROLE postgres IN SCHEMA public GRANT/IN SCHEMA public GRANT/; s/^BEGIN;/BEGIN; SET LOCAL ROLE anon;/"
rb_mutant anon_only        "s/TO anon, authenticated;/TO anon;/"
rb_mutant with_grant_opt   "s/TO anon, authenticated;/TO anon, authenticated WITH GRANT OPTION;/"
rb_mutant no_schema        "s/FOR ROLE postgres IN SCHEMA public GRANT/FOR ROLE postgres GRANT/"
rb_mutant also_service     "s/TO anon, authenticated;/TO anon, authenticated, service_role WITH GRANT OPTION;/"
[ "$killed" = "$total" ] && ok "mutants killed $killed/$total" || bad "mutants killed $killed/$total"

echo "== 6. CI GATE vs REAL POSTGRES (today's defaults, i.e. what a supabase_admin-owned or pre-fix table gets)"
agree=0; n=0
for fx in scripts/new-table-truncate-revoke-fixtures/*.sql; do
  n=$((n+1)); name=$(basename "$fx")
  det=$(python3 scripts/new-table-truncate-revoke-check.py --check-file "$fx" >/dev/null 2>&1 && echo PASS || echo FAIL)
  fresh "${DB}_fx"
  $SU -d "${DB}_fx" -c "create schema private authorization postgres" >/dev/null
  $PG -d "${DB}_fx" -c "create table public.gh3256_f_archive (id int)" >/dev/null
  before=$($SU -d "${DB}_fx" -c "select string_agg(oid::text, ',') from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p')")
  if ! $PG -d "${DB}_fx" -v ON_ERROR_STOP=1 -f "$fx" > "$OUT/fx_$name.log" 2>&1; then bad "fixture $name does not run on Postgres: $(grep -o 'ERROR:.*' "$OUT/fx_$name.log" | head -1)"; continue; fi
  open=$($SU -d "${DB}_fx" -c "select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and c.oid::text <> all(string_to_array('${before:-0}', ',')) and (has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))")
  pgv=$([ "$open" = 0 ] && echo PASS || echo FAIL)
  if [ "$det" = "$pgv" ]; then agree=$((agree+1)); echo "  agree  $name detector=$det postgres=$pgv"
  elif [ "$name" = "new_table_default_privs_not_enough_bad.sql" ] && [ "$det" = FAIL ] && [ "$pgv" = PASS ]; then
    agree=$((agree+1)); echo "  agree* $name detector=FAIL postgres=PASS (conservative by design: a default-privilege change is role-specific and does not cover supabase_admin)"
  else echo "  DISAGREE $name detector=$det postgres=$pgv"; fi
done
[ "$agree" = "$n" ] && ok "CI gate verdict matches real Postgres on $agree/$n fixtures" || bad "CI gate disagrees with Postgres on $((n-agree))/$n fixtures"

for x in "$DB" "${DB}_m" "${DB}_fx"; do $SU -d postgres -c "DROP DATABASE IF EXISTS $x" >/dev/null 2>&1; done
echo "outputs: $OUT"
[ "$rc" = 0 ] && echo "GH3256_PROOF: ALL PASS" || { echo "GH3256_PROOF: FAIL"; exit 1; }
