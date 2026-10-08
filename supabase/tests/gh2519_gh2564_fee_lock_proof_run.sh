#!/usr/bin/env bash
# gh-2519 / gh-2564: run the fee-and-lock proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh2519_gh2564_fee_lock_proof_run.sh [outdir]
#   (any scratch server where PGUSER is a superuser named postgres; e.g. `pip install pgserver` in a venv,
#    or a local `initdb -U postgres`). It creates and drops the database gh2519_fee_lock_proof.
# Five passes of supabase/tests/gh2519_gh2564_fee_lock_proof.sql in one database:
#   1 TODAY            production's schema as read on 2026-10-08 (the failing controls)
#   2 AFTER-gh2519     + supabase/migrations_drafts/gh2519_quotes_server_set_fee.sql
#   3 AFTER-both       + supabase/migrations_drafts/gh2564_quotes_selected_price_lock.sql
#   4 ROLLBACK-gh2564  + its rollback   (must print exactly what pass 2 printed)
#   5 ROLLBACK-gh2519  + its rollback   (must print exactly what pass 1 printed)
# Exit 0 only if passes 4 and 5 match, every pass ends with NOWRITE ... unchanged=t, and the EXPECTATION lines hold
# (accept_bid() refuses a second selected bid, X1c; the terms of a selected bid are locked, T1-T7).
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; DB=gh2519_fee_lock_proof; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2519_gh2564_throwaway_schema.sql" >/dev/null
pass() { psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2519_gh2564_fee_lock_proof.sql" > "$OUT/$1.txt"; echo "== $1"; cat "$OUT/$1.txt"; }
apply() { psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }
pass 1-TODAY
apply "$D/gh2519_quotes_server_set_fee.sql";                 pass 2-AFTER-gh2519
apply "$D/gh2564_quotes_selected_price_lock.sql";            pass 3-AFTER-both
apply "$RB/gh2564_quotes_selected_price_lock_rollback.sql";  pass 4-ROLLBACK-gh2564
apply "$RB/gh2519_quotes_server_set_fee_rollback.sql";       pass 5-ROLLBACK-gh2519
rc=0
diff -q "$OUT/2-AFTER-gh2519.txt" "$OUT/4-ROLLBACK-gh2564.txt" >/dev/null && echo "ROLLBACK gh2564: output identical to AFTER-gh2519" || { echo "ROLLBACK gh2564: OUTPUT DIFFERS"; rc=1; }
diff -q "$OUT/1-TODAY.txt" "$OUT/5-ROLLBACK-gh2519.txt" >/dev/null && echo "ROLLBACK gh2519: output identical to TODAY" || { echo "ROLLBACK gh2519: OUTPUT DIFFERS"; rc=1; }
for f in "$OUT"/[1-5]-*.txt; do grep -q '^NOWRITE .* unchanged=t$' "$f" || { echo "NOWRITE failed in $f"; rc=1; }; done
# Expectations that make the proof fail on a head that lacks a rule (review 6050036561 B1, D-381): a line is read by its id.
line() { grep -m1 "^$2 " "$OUT/$1.txt" || true; }
expect() { # <pass> <line id> <ACCEPTED|REJECTED 42501>: the line must carry that outcome
  line "$1" "$2" | grep -q ": .*$3" && return 0; echo "EXPECTATION FAILED in $1: $2 should read '$3'"; rc=1; }
for pn in 1-TODAY 5-ROLLBACK-gh2519; do expect "$pn" X1c "rows=1 ACCEPTED"; done          # failing control: accept_bid() lets a second bid in
for pn in 2-AFTER-gh2519 3-AFTER-both 4-ROLLBACK-gh2564; do expect "$pn" X1c "REJECTED 42501"; expect "$pn" X2 "rows=1 ACCEPTED"; done
for t in T1 T2 T3 T4 T5 T6 T7; do
  for pn in 1-TODAY 2-AFTER-gh2519 4-ROLLBACK-gh2564 5-ROLLBACK-gh2519; do expect "$pn" "$t" "rows=1 ACCEPTED"; done  # failing control: terms of a selected bid are free
  expect 3-AFTER-both "$t" "REJECTED 42501"
done
for pn in 1-TODAY 2-AFTER-gh2519 3-AFTER-both; do for t in T0 T8 T9; do expect "$pn" "$t" "rows=1 ACCEPTED"; done; done
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB"
echo "outputs in $OUT"; exit $rc
