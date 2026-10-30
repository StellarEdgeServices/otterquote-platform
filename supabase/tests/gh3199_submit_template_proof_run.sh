#!/usr/bin/env bash
# Runs gh3199_submit_template_proof.sql on a throwaway local Postgres cluster. Exit 0 only on the PROOF-OK abort.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
DIR="$(mktemp -d)"; PORT="${PGPORT_PROOF:-55432}"
cleanup() { "$BIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1; rm -rf "$DIR"; }
trap cleanup EXIT
RUNAS=""; if [ "$(id -u)" = 0 ]; then chown -R postgres "$DIR" 2>/dev/null; RUNAS="su postgres -s /bin/bash -c"; fi
run() { if [ -n "$RUNAS" ]; then $RUNAS "$*"; else bash -c "$*"; fi; }
run "$BIN/initdb -D $DIR/data -A trust >/dev/null" || exit 2
run "$BIN/pg_ctl -D $DIR/data -o '-c listen_addresses= -p $PORT -k $DIR' -l $DIR/log -w start >/dev/null" || { cat "$DIR/log"; exit 2; }
run "$BIN/createdb -h $DIR -p $PORT scratch" || exit 2
cd "$ROOT"
OUT="$(run "cd $ROOT && $BIN/psql -h $DIR -p $PORT -v ON_ERROR_STOP=1 -X -f supabase/tests/gh3199_submit_template_proof.sql scratch" 2>&1)"
echo "$OUT"
echo "$OUT" | grep -q "PROOF-OK" && ! echo "$OUT" | grep -q "PROOF-FAIL"
