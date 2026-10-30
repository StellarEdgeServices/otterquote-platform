#!/usr/bin/env bash
# gh-3240: run the client-TRUNCATE revoke proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3240_revoke_client_truncate_proof_run.sh [--mutations] [outdir]
# The connecting role must be a superuser (the scratch setup creates roles). Verified on PostgreSQL 16.15.
# Phases in one fresh database:
#   0-BEFORE (no forward: the proof must FAIL on C1-C5, the negative control) -> 1-AFTER (forward: PROOF-OK)
#   -> 2-RERUN (forward again: PROOF-OK, idempotent) -> 3-ROLLBACK (catalog identical to the pre-forward snapshot; proof FAILs again)
#   -> 4-REAPPLIED (forward again: PROOF-OK) -> 5-GUARD (a public table created with a client TRUNCATE grant after the draft:
#   the forward's guard must refuse and leave nothing changed).
# --mutations: each mutant is the forward file with one deliberate defect, applied to its own fresh database; every mutant must
# apply cleanly and then FAIL the proof. A surviving mutant fails the run.
set -uo pipefail
cd "$(dirname "$0")/../.."
MUT=0
if [ "${1:-}" = "--mutations" ]; then MUT=1; shift; fi
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
FWD="$D/gh3240_revoke_client_truncate.sql"; RBK="$D/gh3240_revoke_client_truncate_rollback.sql"
SETUP="$T/gh3240_revoke_client_truncate_scratch_setup.sql"; PROOF="$T/gh3240_revoke_client_truncate_proof.sql"
DB=gh3240_proof; rc=0
NCHECKS=10
fail() { echo "EXPECT FAIL: $*"; rc=1; }
fresh() {
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$SETUP" >/dev/null || exit 2
}
proof() {
  psql -q -At -1 -d "$1" -f "$PROOF" > "$OUT/$2.txt" 2>&1
  echo "== $2"; grep -E 'PROOF-(OK|FAIL)|^FAIL ' "$OUT/$2.txt" | sed 's/^psql:[^ ]* //'
}
passed() { grep -q "PROOF-OK all $NCHECKS checks passed" "$1"; }
failed() { grep -q "PROOF-FAIL" "$1"; }
apply() { psql -q -1 -d "$1" -v ON_ERROR_STOP=1 -f "$2" > "$OUT/apply.log" 2>&1; }
snapshot() {
  psql -q -At -d "$1" -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'rel|' || c.relname || '|' || c.relkind::text || '|' || coalesce(c.relacl::text, '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' ORDER BY 1;
SELECT 'col|' || a.attrelid::regclass::text || '.' || a.attname || '|' || a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND a.attacl IS NOT NULL ORDER BY 1;
SELECT 'defacl|' || defaclrole::regrole::text || '|' || defaclobjtype::text || '|' || defaclacl::text FROM pg_default_acl ORDER BY 1;
SQL
}

fresh "$DB"
snapshot "$DB" > "$OUT/0-SNAPSHOT.txt" || exit 2
proof "$DB" 0-BEFORE
failed "$OUT/0-BEFORE.txt" && grep -q '^FAIL C1 ' "$OUT/0-BEFORE.txt" && grep -q '^FAIL C3 ' "$OUT/0-BEFORE.txt" || fail "BEFORE must FAIL on C1/C3 (negative control)"
apply "$DB" "$FWD" || fail "forward failed: $(grep -m1 ERROR "$OUT/apply.log")"
proof "$DB" 1-AFTER
passed "$OUT/1-AFTER.txt" || fail "AFTER must be PROOF-OK"
apply "$DB" "$FWD" || fail "forward not re-runnable"
proof "$DB" 2-RERUN
passed "$OUT/2-RERUN.txt" || fail "RERUN must be PROOF-OK"
apply "$DB" "$RBK" || fail "rollback failed"
snapshot "$DB" > "$OUT/3-ROLLBACK.txt"
if diff "$OUT/0-SNAPSHOT.txt" "$OUT/3-ROLLBACK.txt" > "$OUT/3-ROLLBACK.diff"; then
  echo "== 3-ROLLBACK catalog identical to 0-SNAPSHOT ($(wc -l < "$OUT/0-SNAPSHOT.txt") lines)"
else
  cat "$OUT/3-ROLLBACK.diff"; fail "ROLLBACK catalog differs from the pre-forward snapshot"
fi
proof "$DB" 3-ROLLBACK-proof
failed "$OUT/3-ROLLBACK-proof.txt" || fail "after rollback the proof must FAIL again (grants restored)"
apply "$DB" "$FWD" || fail "forward after rollback failed"
proof "$DB" 4-REAPPLIED
passed "$OUT/4-REAPPLIED.txt" || fail "REAPPLIED must be PROOF-OK"
# 5-GUARD: a table the draft does not list, created with a client TRUNCATE grant, makes the forward refuse atomically
fresh "$DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -c "CREATE TABLE public.gh3240_late_table (id int); GRANT TRUNCATE ON public.gh3240_late_table TO authenticated;" >/dev/null
snapshot "$DB" > "$OUT/5-GUARD-before.txt"
if apply "$DB" "$FWD"; then fail "GUARD: forward applied although a listed-elsewhere table still grants TRUNCATE"
else
  grep -q 'gh3240: anon/authenticated still hold TRUNCATE on: gh3240_late_table' "$OUT/apply.log" || fail "GUARD: wrong refusal: $(grep -m1 ERROR "$OUT/apply.log")"
  snapshot "$DB" > "$OUT/5-GUARD-after.txt"
  diff -q "$OUT/5-GUARD-before.txt" "$OUT/5-GUARD-after.txt" >/dev/null && echo "== 5-GUARD refused (gh3240_late_table), nothing changed" || fail "GUARD: refusal left changes behind"
fi
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null

if [ "$MUT" = 1 ]; then
  # name|python expression on s (the forward file); every needle must occur. The guard is removed where it would refuse the
  # mutant at apply time, so that the PROOF (not the guard) is what must catch the defect.
  MUTANTS=(
    "referrals-not-listed|noguard(need(s, 'public.referrals, ', ''))"
    "anon-only|noguard(need(s, '  FROM anon, authenticated;', '  FROM anon;'))"
    "authenticated-only|noguard(need(s, '  FROM anon, authenticated;', '  FROM authenticated;'))"
    "revokes-delete-too|need(s, 'REVOKE TRUNCATE ON TABLE', 'REVOKE TRUNCATE, DELETE ON TABLE')"
    "revokes-from-service-role|need(s, '  FROM anon, authenticated;', '  FROM anon, authenticated, service_role;')"
    "revokes-all|need(s, 'REVOKE TRUNCATE ON TABLE', 'REVOKE ALL ON TABLE')"
  )
  killed=0; total=0
  for m in "${MUTANTS[@]}"; do
    name="${m%%|*}"; expr="${m#*|}"; total=$((total + 1))
    mf="$OUT/mutant-$name.sql"
    python3 -I -c "
import sys
def need(s, old, new):
    if old not in s: sys.exit('needle not found: ' + old)
    return s.replace(old, new, 1)
def noguard(s):
    i = s.index('DO \$guard\$')
    return s[:i]
s = open(sys.argv[1]).read()
open(sys.argv[2], 'w').write($expr)
" "$FWD" "$mf" || { fail "mutant $name: did not apply to the forward file"; continue; }
    MDB="gh3240_mut_$(echo "$name" | tr '-' '_')"
    fresh "$MDB"
    if ! apply "$MDB" "$mf"; then fail "mutant $name: the mutated forward did not apply"; continue; fi
    psql -q -At -1 -d "$MDB" -f "$PROOF" > "$OUT/mutant-$name.txt" 2>&1
    if failed "$OUT/mutant-$name.txt"; then
      killed=$((killed + 1)); echo "== mutant $name: KILLED ($(grep '^FAIL ' "$OUT/mutant-$name.txt" | cut -c6- | cut -d' ' -f1 | sort -u | tr '\n' ' '))"
    else
      fail "mutant $name SURVIVED the proof"
    fi
    psql -q -d postgres -c "DROP DATABASE IF EXISTS $MDB" >/dev/null
  done
  echo "MUTANTS killed=$killed of $total"
  [ "$killed" = "$total" ] || fail "not every mutant was killed"
fi
echo "RUNNER rc=$rc (outputs in $OUT)"; exit $rc
