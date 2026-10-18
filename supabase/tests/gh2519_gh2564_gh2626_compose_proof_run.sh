#!/usr/bin/env bash
# gh-2519 / gh-2564 / gh-2626 composition proof (#2519 comment 6156383757: the precondition before the gh2519 and gh2564 drafts are applied;
# PR #2737, REVIEW 6162070214). Run on a THROWAWAY Postgres only; never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh2519_gh2564_gh2626_compose_proof_run.sh [outdir]
# (NOTE: *.sh is in .gitignore; this file is committed with `git add -f`, like gh2519_gh2564_fee_lock_proof_run.sh.)
# The schema is supabase/tests/gh2519_gh2564_throwaway_schema.sql. Three proofs are run unchanged at every state:
#   W = gh2626_claims_award_columns_guard_proof.sql   F = gh2519_gh2564_fee_lock_proof.sql   C = gh2519_gh2564_gh2626_compose_proof.sql
# ORDER A (the only apply order)  gh2626 -> gh2519 -> gh2564, then the rollbacks in reverse
#   A1 after gh2626   A2 after gh2519   A3 after gh2564   A4 after the gh2564 rollback (== A2)   A5 after gh2519_..._rollback_to_gh2626 (== A1)
# ORDER B (the wrong order)       gh2519 -> gh2564 -> gh2626
#   gh2626 and its rollback REFUSE (gates); B2 applies a copy of gh2626 with its order gate stripped (negative control only): the fee rule and the lock vanish.
# Exit 0 only if: both functions carry the gh-2626 marker after A2 and A3; the W pass after A2 and A3 equals the W pass after A1 apart from the
# one disclosed line Q1; the F pass shows the lock after A3 (T1-T7 REJECTED) and the fee rules after A2/A3; the C lines hold (C5 and C6: a
# switched-away bid retired by the gh-2519 clean-up is not re-awardable); A4 == A2 and A5 == A1; every order gate fires; and the stripped
# copy shows T1-T7 ACCEPTED, fee rate 0.00 (what the gates prevent).
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
G6="supabase/migrations/20261015205851_gh2626_claims_award_columns_guard.sql"; G19="supabase/migrations/20261015205902_gh2519_quotes_server_set_fee.sql"; G64="supabase/migrations/20261018195342_gh2564_quotes_selected_price_lock.sql"
R6="$RB/gh2626_claims_award_columns_guard_rollback.sql"
R19="$RB/gh2519_quotes_server_set_fee_rollback.sql"; R19b="$RB/gh2519_quotes_server_set_fee_rollback_to_gh2626.sql"; R64="$RB/gh2564_quotes_selected_price_lock_rollback.sql"
rc=0
fresh() { psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1"; psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh2519_gh2564_throwaway_schema.sql" >/dev/null; }
apply() { psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$2" >/dev/null; }
gate() { # <db> <label> <file> <message the apply must raise>
  if psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$3" >/dev/null 2>"$OUT/gate.err"; then echo "GATE $2: the file APPLIED, it should have raised"; rc=1
  elif grep -q "$4" "$OUT/gate.err"; then echo "GATE $2: raised as designed ($4)"; grep -m1 ERROR "$OUT/gate.err" | cut -c1-260
  else echo "GATE $2: failed with another message"; cat "$OUT/gate.err"; rc=1; fi; }
passes() { # <db> <label>
  psql -q -At -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh2626_claims_award_columns_guard_proof.sql" | sed '/^$/d' > "$OUT/$2-W.txt"
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh2519_gh2564_fee_lock_proof.sql" > "$OUT/$2-F.txt"
  psql -q -At -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh2519_gh2564_gh2626_compose_proof.sql" | sed '/^$/d' > "$OUT/$2-C.txt"
  echo "== $2"; grep -E '^GUARDS' "$OUT/$2-C.txt" | cut -c1-260; }
ln() { grep -m1 "^$2 " "$OUT/$1-$3.txt" || true; }       # <state> <id> <W|F|C>
has() { ln "$1" "$2" "$3" | grep -qF -- "$4" && return 0; echo "EXPECTATION FAILED in $1-$3: $2 should contain '$4'"; rc=1; }
same() { # <labelX> <labelY> <suffix>: two states must print the same lines
  diff <(sed -e '/^GUARD /d' -e '/^GUARDS /d' "$OUT/$1-$3.txt") <(sed -e '/^GUARD /d' -e '/^GUARDS /d' "$OUT/$2-$3.txt") >/dev/null && echo "$1-$3 equals $2-$3" || { echo "$1-$3 DIFFERS from $2-$3"; rc=1; }; }
DA=compose_order_a; DB=compose_order_b
echo "######## ORDER A: gh2626 -> gh2519 -> gh2564"
fresh $DA
apply $DA "$G6";  passes $DA A1
apply $DA "$G19"; passes $DA A2
apply $DA "$G64"; passes $DA A3
for s in A2 A3; do
  grep -q 'quotes guard carries gh-2626: true | accept_bid carries gh-2626: true' "$OUT/$s-C.txt" && echo "both functions carry gh-2626 after $s" || { echo "MARKER LOST after $s"; rc=1; }
  has $s Q1 W "REJECTED 42501 quotes: bid_status can only be changed by service_role or an admin (gh-2519)"      # disclosed: the gh-2519 allow-list also refuses the contractor's own bid_status write
  diff <(sed -e '/^GUARD /d' -e '/^Q1 /d' "$OUT/A1-W.txt") <(sed -e '/^GUARD /d' -e '/^Q1 /d' "$OUT/$s-W.txt") >"$OUT/$s-W.diff" && echo "W pass after $s equals W pass after A1 (gh2626's own proof, lines GUARD and Q1 excluded)" || { echo "W pass after $s DIFFERS from A1"; cat "$OUT/$s-W.diff"; rc=1; }
  has $s C1 C "rows=1 ACCEPTED -> qA=declined/superseded qC=selected/active"
  has $s C2 C "rows=1 ACCEPTED -> qA=declined/superseded qC=selected/active"
  has $s C3 C "rows=1 ACCEPTED -> qA=selected/active | claim status=contract_signed"
  has $s C4 C "REJECTED P0001 bid_not_awardable"
  has $s C5a C "qA=declined/superseded"; has $s C5 C "REJECTED P0001 bid_not_awardable"
  has $s C6a C "qA=declined/superseded"; has $s C6 C "REJECTED P0001 bid_not_awardable"
  has $s C7a C "REJECTED 42501 quotes: only a submitted, active bid can be selected"; has $s C7b C "REJECTED P0001 bid_not_awardable"
done
has A1 Q1 W "rows=1 ACCEPTED"; has A1 C5 C "REJECTED P0001 bid_not_awardable"      # gh2626 alone: the switched-away bid stays selected, refused
for t in T1 T2 T3 T4 T5 T6 T7; do has A2 $t F "rows=1 ACCEPTED"; has A3 $t F "REJECTED 42501"; done            # the lock appears with gh2564 only
for s in A2 A3; do has $s X1c F "REJECTED 42501"; has $s E4 F "REJECTED 42501"; has $s F2 F "REJECTED 42501"; has $s P1 F "REJECTED 42501"; has $s I2 F "rate=5.00"; has $s I5 F "REJECTED P0001"; done
has A1 I2 F "rate=0.00"      # negative control: with gh2626 alone a bid carrying platform_fee_pct=0 is stored at rate 0; the server-set fee (gh2519) is what changes it
for s in A1 A2 A3; do for k in D1 D2 D3 D4 D5 D6 D7 D8; do has $s $k W "REJECTED 42501"; done; done      # gh2626's claims guard stays in force
echo "-- order gates, with gh2626 + gh2519 + gh2564 applied"
gate $DA "gh2626 re-applied after gh2519/gh2564" "$G6" "gh2519 (public.quotes_platform_fee_for) is applied"
gate $DA "gh2626 rollback after gh2519/gh2564" "$R6" "gh2519 (public.quotes_platform_fee_for) is applied"
gate $DA "gh2519 rollback (pre-gh-2626 bodies) while gh2564 is applied" "$R19" "gh-2564 (the selected-bid price lock, D-369) is applied"
apply $DA "$R64"; passes $DA A4
gate $DA "gh2519 rollback (pre-gh-2626 bodies) while gh2626 is applied" "$R19" "gh2626_claims_award_columns_guard is applied"
apply $DA "$R19b"; passes $DA A5
same A2 A4 W; same A2 A4 F; same A2 A4 C
same A1 A5 W; same A1 A5 F; same A1 A5 C
echo "-- the correct order still applies clean after the full rollback (gh2626 gate silent: gh2519 is gone)"
apply $DA "$G19"; apply $DA "$G64"; passes $DA A6; same A3 A6 W; same A3 A6 F; same A3 A6 C
echo "######## ORDER B (wrong order): gh2519 -> gh2564, then gh2626 refuses"
fresh $DB
apply $DB "$G19"
gate $DB "gh2519 rollback_to_gh2626 while gh2626 is not applied" "$R19b" "gh2626_claims_award_columns_guard is not applied"
apply $DB "$G64"; passes $DB B1
gate $DB "gh2626 applied LAST" "$G6" "gh2519 (public.quotes_platform_fee_for) is applied"
sed '/^DO \$order\$/,/^\$order\$;/d' "$G6" > "$OUT/gh2626_gate_stripped.sql"
cmp -s "$OUT/gh2626_gate_stripped.sql" "$G6" && { echo "runner: the gh2626 order gate was not found to strip"; rc=1; }
apply $DB "$OUT/gh2626_gate_stripped.sql"; passes $DB B2
for t in T1 T2 T3 T4 T5 T6 T7; do has B1 $t F "REJECTED 42501"; has B2 $t F "rows=1 ACCEPTED"; done
has B2 Q1 W "rows=1 ACCEPTED"; has B1 I2 F "rate=5.00"; has B2 I2 F "rate=0.00"
echo "negative control (gate stripped, gh2626 applied last): T1-T7 read ACCEPTED (lock gone), I2 stores rate 0.00, Q1 accepted (gh-2519 rules gone); in the verified order they read REJECTED 42501 / 5.00"
for f in A1 A2 A3 A4 A5 A6 B1 B2; do echo "md5 $f W $(md5sum < "$OUT/$f-W.txt" | cut -c1-8) F $(md5sum < "$OUT/$f-F.txt" | cut -c1-8) C $(md5sum < "$OUT/$f-C.txt" | cut -c1-8)"; done
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DA" -c "DROP DATABASE IF EXISTS $DB"
echo "outputs in $OUT"; echo "EXIT=$rc"; exit $rc
