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
# (accept_bid() refuses a second LIVE selected bid, X1c; a claim after switch-contractor or rescind-bid can be awarded
# again, W3 W4 RB2, and the live selected bid still blocks, RB3; the partial unique index, N1; the terms of a selected bid
# are locked, T1-T7) and the two apply gates of the gh2564 draft hold (it raises without gh2519, and while rescind-bid's
# bid_status value is refused by quotes_bid_status_check), and the two order guards hold (the gh2519 rollback and a re-apply of the gh2519
# draft refuse while the gh2564 lock is applied). Pass 3 applies a copy of the gh2564 draft whose one constant
# c_rescind_bid_writes is set to 'cancelled', the value a repaired rescind-bid would write: the draft itself is untouched.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; DB=gh2519_fee_lock_proof; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2519_gh2564_throwaway_schema.sql" >/dev/null
pass() { psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2519_gh2564_fee_lock_proof.sql" > "$OUT/$1.txt"; echo "== $1"; cat "$OUT/$1.txt"; }
apply() { psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }
gate() { # <label> <file> <message that the apply must raise>: the file must fail, and say why
  if psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$2" >/dev/null 2>"$OUT/gate.err"; then echo "GATE $1: the draft APPLIED, it should have raised"; rc=1
  elif grep -q "$3" "$OUT/gate.err"; then echo "GATE $1: raised as designed ($3)"
  else echo "GATE $1: failed with another message"; cat "$OUT/gate.err"; rc=1; fi; }
rc=0
pass 1-TODAY
gate "gh2564 without gh2519" "$D/gh2564_quotes_selected_price_lock.sql" "quotes_platform_fee_for(uuid, uuid) does not exist"
apply "$D/gh2519_quotes_server_set_fee.sql";                 pass 2-AFTER-gh2519
gate "gh2564 while rescind-bid is refused by quotes_bid_status_check" "$D/gh2564_quotes_selected_price_lock.sql" "rescind-bid writes bid_status 'rescinded'"
sed "s/c_rescind_bid_writes CONSTANT text := 'rescinded'/c_rescind_bid_writes CONSTANT text := 'cancelled'/" "$D/gh2564_quotes_selected_price_lock.sql" > "$OUT/gh2564_with_cancelled.sql"
cmp -s "$OUT/gh2564_with_cancelled.sql" "$D/gh2564_quotes_selected_price_lock.sql" && { echo "runner: the gh2564 constant was not found to replace"; rc=1; }
apply "$OUT/gh2564_with_cancelled.sql";                      pass 3-AFTER-both
# order hazards (review 6051777895 finding 7): with the gh2564 lock applied, both the gh2519 rollback and a re-apply of the gh2519 draft
# would silently remove it; each must refuse and change nothing (pass 4 below, which must still equal pass 2, proves nothing changed).
gate "gh2519 rollback while gh2564 is applied" "$RB/gh2519_quotes_server_set_fee_rollback.sql" "gh-2564 (the selected-bid price lock, D-369) is applied"
gate "gh2519 draft re-applied while gh2564 is applied" "$D/gh2519_quotes_server_set_fee.sql" "gh-2564 (the selected-bid price lock, D-369) is applied"
apply "$RB/gh2564_quotes_selected_price_lock_rollback.sql";  pass 4-ROLLBACK-gh2564
apply "$RB/gh2519_quotes_server_set_fee_rollback.sql";       pass 5-ROLLBACK-gh2519
diff -q "$OUT/2-AFTER-gh2519.txt" "$OUT/4-ROLLBACK-gh2564.txt" >/dev/null && echo "ROLLBACK gh2564: output identical to AFTER-gh2519" || { echo "ROLLBACK gh2564: OUTPUT DIFFERS"; rc=1; }
diff -q "$OUT/1-TODAY.txt" "$OUT/5-ROLLBACK-gh2519.txt" >/dev/null && echo "ROLLBACK gh2519: output identical to TODAY" || { echo "ROLLBACK gh2519: OUTPUT DIFFERS"; rc=1; }
for f in "$OUT"/[1-5]-*.txt; do grep -q '^NOWRITE .* unchanged=t$' "$f" || { echo "NOWRITE failed in $f"; rc=1; }; done
# The pass outputs are deterministic (the NOWRITE line prints only unchanged=t, not the run-dependent row hashes), so these md5s
# are the same on every run of this head; a different value means the proof text or the drafts changed.
for f in "$OUT"/[1-5]-*.txt; do echo "md5 $(basename "$f" .txt) $(md5sum < "$f" | cut -c1-8)"; done
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
has() { # <pass> <line id> <fixed text the line must contain>
  line "$1" "$2" | grep -qF -- "$3" && return 0; echo "EXPECTATION FAILED in $1: $2 should contain '$3'"; rc=1; }
OLD="1-TODAY 5-ROLLBACK-gh2519"; NEW="2-AFTER-gh2519 3-AFTER-both 4-ROLLBACK-gh2564"
# the two exits (re-review 6051423781 finding 1)
for pn in $OLD $NEW; do
  has $pn W1 "REJECTED 23514"; has $pn W2 "rows=1 ACCEPTED"; has $pn RB1 "REJECTED 23514"
  has $pn W3 "rows=1 ACCEPTED"; has $pn W4 "rows=1 ACCEPTED / rows=1 ACCEPTED"
  has $pn RB2 "rows=1 ACCEPTED / rows=1 ACCEPTED / rows=1 ACCEPTED"; has $pn RB2 "selected AND active=1"
  has $pn N2 "rows=1 ACCEPTED / rows=1 ACCEPTED / rows=1 ACCEPTED"; has $pn N2 "selected AND active=1"
done
# P1 and P2 (re-review 6051423781 finding 1, blocking): after a re-award the claim has exactly ONE row with status = 'selected',
# whatever its bid_status, because production's signing, charge and completion code reads the winner as status = 'selected' alone.
# Failing controls: today's schema, the schema after the rollback, and the previous head (94d01006) end with 2.
for pn in $NEW; do
  has $pn RP1 "rows=1 ACCEPTED"; has $pn RP1 "selected bids (any bid_status)=1"; has $pn RP1 "status=selected rows=1"; has $pn RP1 "qw=declined/expired ql=selected/active"
  has $pn RP2 "rows=1 ACCEPTED / rows=1 ACCEPTED / rows=1 ACCEPTED"; has $pn RP2 "selected bids (any bid_status)=1"; has $pn RP2 "status=selected rows=1"
done
for pn in $OLD; do has $pn RP1 "status=selected rows=2"; has $pn RP2 "status=selected rows=2"; done
for pn in $OLD; do   # failing controls: today two selected bids stand
  has $pn W3 "selected AND active=2"; has $pn W4 "selected AND active=2";
  has $pn RB3 "selected AND active=2"; has $pn N1 "rows=1 ACCEPTED / rows=1 ACCEPTED"; has $pn X2b "status=awarded"
done
for pn in $NEW; do
  has $pn W3 "selected AND active=1"; has $pn W3 "qw=declined ql=selected"; has $pn W4 "selected AND active=1"
  has $pn RB3 "REJECTED 42501"; has $pn RB3 "selected AND active=1"
  has $pn N1 "REJECTED 23505"; has $pn N1 "selected AND active=1"
  has $pn X2b "status=contract_signed"
done
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB"
echo "outputs in $OUT"; exit $rc
