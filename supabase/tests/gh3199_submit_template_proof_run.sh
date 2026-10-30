#!/usr/bin/env bash
# Runs gh3199_submit_template_proof.sql on a throwaway local Postgres cluster.
#   bash gh3199_submit_template_proof_run.sh               real migration; exit 0 only on PROOF-OK
#   bash gh3199_submit_template_proof_run.sh --mutations   real file must PASS, each mutation of it must FAIL; exit 0 only then
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
DIR="$(mktemp -d)"; PORT="${PGPORT_PROOF:-55432}"
MIG_REL="supabase/migrations_drafts/gh3199_submit_template_for_admin_review.sql"
cleanup() { "$BIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1; rm -rf "$DIR"; }
trap cleanup EXIT
chmod 755 "$DIR"
RUNAS=""; if [ "$(id -u)" = 0 ]; then chown -R postgres "$DIR" 2>/dev/null; RUNAS="su postgres -s /bin/bash -c"; fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "$*"; else bash -c "$*"; fi; }
run "$BIN/initdb -D $DIR/data -A trust >/dev/null" || exit 2
run "$BIN/pg_ctl -D $DIR/data -o '-c listen_addresses= -p $PORT -k $DIR' -l $DIR/log -w start >/dev/null" || { cat "$DIR/log"; exit 2; }
run "$BIN/createdb -h $DIR -p $PORT scratch" || exit 2
cd "$ROOT"
# prove MIG (path relative to ROOT or absolute); output kept in $DIR/last.out; returns 0 only on PROOF-OK and no PROOF-FAIL
prove() {
  local out
  out="$(run "cd $ROOT && $BIN/psql -h $DIR -p $PORT -v ON_ERROR_STOP=1 -v mig=$1 -X -f supabase/tests/gh3199_submit_template_proof.sql scratch" 2>&1)"
  echo "$out" > "$DIR/last.out"
  echo "$out" | grep -q "PROOF-OK" && ! echo "$out" | grep -q "PROOF-FAIL"
}
fresh() { run "$BIN/dropdb -h $DIR -p $PORT --if-exists scratch && $BIN/createdb -h $DIR -p $PORT scratch" || exit 2; }

if [ "${1:-}" != "--mutations" ]; then
  prove "$MIG_REL"; rc=$?; cat "$DIR/last.out"; exit $rc
fi

status=0
prove "$MIG_REL"; rc=$?
if [ $rc -eq 0 ]; then echo "REAL FILE: proof PASSES (expected PASS)"; else echo "REAL FILE: proof FAILS (expected PASS)"; status=1; fi
grep -E "PROOF-OK|PROOF-FAIL|ERROR" "$DIR/last.out" | head -2 | sed 's/^/    /'
mutate() { # name, sed expression
  local name="$1" expr="$2" f="$DIR/mut_$1.sql"
  sed "$expr" "$ROOT/$MIG_REL" > "$f"; chmod 644 "$f"
  if cmp -s "$f" "$ROOT/$MIG_REL"; then echo "MUTATION $name: sed changed nothing, mutation invalid"; status=1; return; fi
  fresh
  prove "$f"; rc=$?
  if [ $rc -eq 0 ]; then echo "MUTATION $name: proof still PASSES (BAD, mutation survived)"; status=1
  else echo "MUTATION $name: proof FAILS (expected FAIL)"; grep -E "\| FAIL *$|PROOF-FAIL" "$DIR/last.out" | sed 's/^/    /' | head -6; fi
}
mutate a_delete_current_user_test "/AND current_user NOT IN/d"
mutate b_flag_test_replaced_with_true "s/coalesce(current_setting('oq.template_submit', true), '') = 'on'/true/"
exit $status
