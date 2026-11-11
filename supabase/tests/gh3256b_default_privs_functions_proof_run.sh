#!/usr/bin/env bash
# gh-3256b proof runner. THROWAWAY POSTGRES ONLY -- never point this at production.
# Needs a throwaway cluster whose bootstrap superuser is named supabase_admin (initdb -U supabase_admin), as in gh3256_default_privs_proof_run.sh.
# Usage (repo root): PGHOST=... PGPORT=... bash supabase/tests/gh3256b_default_privs_functions_proof_run.sh [outdir]
# Phases: C capability / S why the global PUBLIC statement exists / 0 BEFORE (negative control) / 1 AFTER / 2 RERUN / 3 ROLLBACK / 4 REAPPLY / 5 MUTANTS
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
FWD="$D/gh3256b_default_privs_no_anon_execute.sql"; RBK="$D/gh3256b_default_privs_no_anon_execute_rollback.sql"
SETUP="$T/gh3256_default_privs_scratch_setup.sql"
DB=gh3256b_proof; rc=0
export PGOPTIONS='-c client_min_messages=warning'
SU="psql -X -q -At -U supabase_admin"; PG="psql -X -q -At -U postgres"
ok()  { echo "CHECK PASS: $*"; }
bad() { echo "CHECK FAIL: $*"; rc=1; }
fresh() {
  $SU -d postgres -c "DROP DATABASE IF EXISTS $1" >/dev/null 2>&1
  $SU -d postgres -v ON_ERROR_STOP=1 -f "$SETUP" >/dev/null 2>&1 || true
  $SU -d postgres -c "CREATE DATABASE $1 OWNER postgres" >/dev/null || { echo "cannot create $1"; exit 2; }
  $SU -d "$1" -v ON_ERROR_STOP=1 -f "$SETUP" >/dev/null || { echo "setup failed on $1"; exit 2; }
}
defacl() { $SU -d "$1" -c "select defaclrole::regrole || '|' || coalesce(nullif(defaclnamespace::regnamespace::text,'-'),'*') || '|' || defaclobjtype::text || '|' || defaclacl::text from pg_default_acl order by 1"; }
mk_pg_fn() { $PG -d "$1" -v ON_ERROR_STOP=1 -c "create function public.$2() returns int language sql as 'select 1'" >/dev/null; }
mk_sa_fn() { $SU -d "$1" -v ON_ERROR_STOP=1 -c "create function public.$2() returns int language sql as 'select 1'" >/dev/null; }
# call as <role>: prints OK or permission denied
callas() { local r; r=$($PG -d "$1" -c "begin; set local role $2; select public.$3(); rollback;" 2>&1); if echo "$r" | grep -q 'permission denied'; then echo "denied"; elif echo "$r" | grep -q '^1$'; then echo "ok"; else echo "other:$r"; fi; }
# fn_facts <db> <fn>: result of a real call as anon / authenticated / service_role
fn_facts() { echo "anon=$(callas "$1" anon "$2") authenticated=$(callas "$1" authenticated "$2") service_role=$(callas "$1" service_role "$2")"; }
apply_pg() { $PG -d "$1" -v ON_ERROR_STOP=1 -f "$2" > "$OUT/apply-$3.log" 2>&1; }
OPEN="anon=ok authenticated=ok service_role=ok"
CLOSED="anon=denied authenticated=ok service_role=ok"

echo "== C. CAPABILITY (supabase_admin's function defaults are out of reach)"
fresh "$DB"
E=$($PG -d "$DB" -c "begin; alter default privileges for role supabase_admin in schema public revoke execute on functions from anon; rollback;" 2>&1)
echo "$E" | grep -q "permission denied" && ok "postgres cannot alter supabase_admin's defaults: $(echo "$E" | grep -o 'ERROR:.*' | head -1)" || bad "postgres altered supabase_admin's defaults: $E"
defacl "$DB" > "$OUT/defacl0.txt"

echo "== S. a schema-scoped REVOKE ... FROM PUBLIC does not remove PUBLIC's built-in EXECUTE (why statement 2 is global)"
fresh "${DB}_s"
$PG -d "${DB}_s" -c "alter default privileges for role postgres in schema public revoke execute on functions from anon, public" >/dev/null
mk_pg_fn "${DB}_s" f_s; X=$(fn_facts "${DB}_s" f_s)
[ "$X" = "anon=ok authenticated=ok service_role=ok" ] && ok "schema-scoped revoke of anon+PUBLIC: anon STILL executes a new function (via built-in PUBLIC) -> statement 2 is needed" || bad "schema-scoped probe: $X"

echo "== 0. BEFORE (negative control)"
mk_pg_fn "$DB" f_before
B=$(fn_facts "$DB" f_before); [ "$B" = "$OPEN" ] && ok "BEFORE: new postgres function -> a real call as anon succeeds" || bad "BEFORE facts: $B"
$PG -d "$DB" -c "select proacl::text from pg_proc where proname='f_before'" | grep -q '^{=X/postgres,' && ok "BEFORE: proacl carries PUBLIC (=X) and anon" || bad "BEFORE proacl"
mk_pg_fn "$DB" t_tbl_probe >/dev/null 2>&1 || true
$PG -d "$DB" -c "create table public.tb_before (id int)" >/dev/null
TB0=$($SU -d "$DB" -c "select has_table_privilege('anon','public.tb_before','SELECT,INSERT,UPDATE,DELETE'), has_table_privilege('authenticated','public.tb_before','SELECT,INSERT,UPDATE,DELETE'), has_table_privilege('service_role','public.tb_before','SELECT,INSERT,UPDATE,DELETE')")

echo "== 1. AFTER"
apply_pg "$DB" "$FWD" after && ok "forward applied as postgres" || bad "forward failed: $(cat "$OUT/apply-after.log")"
defacl "$DB" > "$OUT/defacl_after.txt"; diff "$OUT/defacl0.txt" "$OUT/defacl_after.txt" | grep '^[<>]' | sed 's/^/  /'
mk_pg_fn "$DB" f_after
A=$(fn_facts "$DB" f_after); [ "$A" = "$CLOSED" ] && ok "AFTER: new function -> anon call denied (42501); authenticated and service_role calls succeed" || bad "AFTER facts: $A"
$PG -d "$DB" -c "select proacl::text from pg_proc where proname='f_after'" | grep -q '^{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$' && ok "AFTER: proacl = owner + authenticated + service_role only (no PUBLIC, no anon)" || bad "AFTER proacl"
[ "$(callas "$DB" postgres f_after)" = ok ] && ok "AFTER: owner postgres still executes it" || bad "owner call"
$PG -d "$DB" -c "grant execute on function public.f_after() to anon" >/dev/null; [ "$(callas "$DB" anon f_after)" = ok ] && ok "AFTER: an explicit GRANT EXECUTE TO anon still works (the pattern for intentionally public RPCs)" || bad "explicit grant"
[ "$(fn_facts "$DB" f_before)" = "$OPEN" ] && ok "AFTER: the function created BEFORE is untouched (existing functions are out of scope)" || bad "existing function changed"
$PG -d "$DB" -c "create table public.tb_after (id int)" >/dev/null
TB1=$($SU -d "$DB" -c "select has_table_privilege('anon','public.tb_after','SELECT,INSERT,UPDATE,DELETE'), has_table_privilege('authenticated','public.tb_after','SELECT,INSERT,UPDATE,DELETE'), has_table_privilege('service_role','public.tb_after','SELECT,INSERT,UPDATE,DELETE')")
[ "$TB0" = "$TB1" ] && ok "AFTER: table defaults untouched (anon/authenticated/service_role table privileges for a new table identical to BEFORE: $TB1)" || bad "table defaults changed $TB0 vs $TB1"
$PG -d "$DB" -c "create table public.tseq (id serial)" >/dev/null && ok "AFTER: serial/sequence creation still works as postgres" || bad "sequence"
mk_sa_fn "$DB" f_sa_after; [ "$(callas "$DB" anon f_sa_after)" = ok ] && ok "AFTER: a function created as supabase_admin still gets anon EXECUTE (documented gap, out of reach)" || bad "supabase_admin function"
$PG -d "$DB" -c "create schema other_s" >/dev/null; $PG -d "$DB" -c "create function other_s.f_o() returns int language sql as 'select 1'" >/dev/null
$PG -d "$DB" -c "select proacl::text from pg_proc where proname='f_o'" | grep -q '^{postgres=X/postgres}$' && ok "AFTER (note): global statement 2 also applies to postgres-created functions in other schemas" || bad "other schema acl"

echo "== 2. RERUN"
apply_pg "$DB" "$FWD" rerun && ok "forward reran cleanly" || bad "rerun failed: $(cat "$OUT/apply-rerun.log")"
defacl "$DB" | diff -q - "$OUT/defacl_after.txt" >/dev/null && ok "RERUN: default ACL unchanged" || bad "rerun changed defaults"

echo "== 3. ROLLBACK"
apply_pg "$DB" "$RBK" rollback && ok "rollback applied as postgres" || bad "rollback failed: $(cat "$OUT/apply-rollback.log")"
defacl "$DB" | diff - "$OUT/defacl0.txt" >/dev/null && ok "ROLLBACK: pg_default_acl identical to BEFORE ($(wc -l < "$OUT/defacl0.txt") rows)" || { bad "ROLLBACK default ACL differs"; defacl "$DB" | diff - "$OUT/defacl0.txt"; }
mk_pg_fn "$DB" f_rb; [ "$(fn_facts "$DB" f_rb)" = "$OPEN" ] && ok "ROLLBACK: a function created after it is anon-callable again" || bad "rollback fn"
apply_pg "$DB" "$RBK" rollback2 && defacl "$DB" | diff -q - "$OUT/defacl0.txt" >/dev/null && ok "rollback run twice: still identical" || bad "second rollback"

echo "== 4. REAPPLY"
apply_pg "$DB" "$FWD" reapply && defacl "$DB" | diff -q - "$OUT/defacl_after.txt" >/dev/null && ok "REAPPLY: default ACL = AFTER" || bad "reapply"
mk_pg_fn "$DB" f_re; [ "$(fn_facts "$DB" f_re)" = "$CLOSED" ] && ok "REAPPLY: new function closed to anon" || bad "reapply fn"

echo "== 5. MUTANTS"
killed=0; total=0
NOPOST='/^DO \$post\$/,/^\$post\$;/d'
mutant() {
  local name="$1" expr="$2"; total=$((total+1))
  sed -E "$expr" "$FWD" > "$OUT/mut_$name.sql"
  cmp -s "$OUT/mut_$name.sql" "$FWD" && { bad "mutant $name: sed changed nothing"; return; }
  fresh "${DB}_m"
  if ! apply_pg "${DB}_m" "$OUT/mut_$name.sql" "m_$name"; then killed=$((killed+1)); echo "  killed (apply refused) $name"; return; fi
  mk_pg_fn "${DB}_m" f_m
  local f; f=$(fn_facts "${DB}_m" f_m)
  local other; other=$(defacl "${DB}_m" | grep -v '^postgres|[^|]*|f|' | diff - <(grep -v '^postgres|[^|]*|f|' "$OUT/defacl0.txt") | grep -c '^[<>]')
  if [ "$f" = "$CLOSED" ] && [ "$other" = 0 ]; then bad "mutant SURVIVED: $name"; else killed=$((killed+1)); echo "  killed (probe: $f; other default rows changed=$other) $name"; fi
}
mutant no_public_stmt   "/FOR ROLE postgres REVOKE EXECUTE/d; $NOPOST"
mutant no_anon_stmt     "/IN SCHEMA public REVOKE EXECUTE/d; $NOPOST"
mutant schema_scoped_public "s/FOR ROLE postgres REVOKE EXECUTE/FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE/; $NOPOST"
mutant also_authenticated "s/FROM anon;/FROM anon, authenticated;/; $NOPOST"
mutant also_service_role  "s/FROM anon;/FROM anon, service_role;/; $NOPOST"
# (REVOKE ALL ON FUNCTIONS FROM anon is an EQUIVALENT mutant here: EXECUTE is the only function privilege, so it is not tested.)
mutant tables_instead     "s/REVOKE EXECUTE ON FUNCTIONS FROM anon/REVOKE TRUNCATE ON TABLES FROM anon/; $NOPOST"
mutant for_supabase_admin "s/FOR ROLE postgres IN SCHEMA public REVOKE/FOR ROLE supabase_admin IN SCHEMA public REVOKE/; $NOPOST"
mutant assert_no_public   "/FOR ROLE postgres REVOKE EXECUTE/d"
mutant assert_authenticated "s/FROM anon;/FROM anon, authenticated;/"
rb_mutant() {
  local name="$1" expr="$2"; total=$((total+1))
  sed -E "$expr" "$RBK" > "$OUT/rbm_$name.sql"
  cmp -s "$OUT/rbm_$name.sql" "$RBK" && { bad "rb mutant $name: sed changed nothing"; return; }
  fresh "${DB}_m"; apply_pg "${DB}_m" "$FWD" "rbm_f_$name" || { bad "rb mutant $name: forward failed"; return; }
  if ! apply_pg "${DB}_m" "$OUT/rbm_$name.sql" "rbm_$name"; then killed=$((killed+1)); echo "  killed (rollback refused) rb_$name"; return; fi
  if defacl "${DB}_m" | diff -q - "$OUT/defacl0.txt" >/dev/null; then bad "rollback mutant SURVIVED: $name"; else killed=$((killed+1)); echo "  killed (pg_default_acl differs from BEFORE) rb_$name"; fi
}
rb_mutant no_public   "/FOR ROLE postgres GRANT EXECUTE/d"
rb_mutant no_anon     "/IN SCHEMA public GRANT EXECUTE/d"
rb_mutant with_grant  "s/TO anon;/TO anon WITH GRANT OPTION;/"
rb_mutant public_in_schema "s/FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC/FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC/"
[ "$killed" = "$total" ] && ok "mutants killed $killed/$total" || bad "mutants killed $killed/$total"

for x in "$DB" "${DB}_m" "${DB}_s"; do $SU -d postgres -c "DROP DATABASE IF EXISTS $x" >/dev/null 2>&1; done
echo "outputs: $OUT"
[ "$rc" = 0 ] && echo "GH3256B_PROOF: ALL PASS" || { echo "GH3256B_PROOF: FAIL"; exit 1; }
