#!/usr/bin/env bash
# gh-2626: run the claims award-columns guard proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh2626_claims_award_columns_guard_proof_run.sh [outdir]
# Six passes of supabase/tests/gh2626_claims_award_columns_guard_proof.sql in one database:
#   1 TODAY              production's schema as read 2026-10-08 (the failing controls)
#   2 GUARD-ONLY         + supabase/migrations/20261015205851_gh2626_claims_award_columns_guard.sql (without #2623; it also re-creates accept_bid() and quotes_guard_homeowner_columns())
#   3 ROLLBACK-GUARD     + its rollback           (must equal pass 1)
#   4 WITH-2623          + supabase/migrations_drafts/gh2620_claims_payment_guard_security_definer.sql (PR #2623)
#   5 WITH-2623-AND-GUARD+ the gh2626 forward file
#   6 ROLLBACK-GUARD     + its rollback           (must equal pass 4)
# Passes 1/4 show the F1 (accept_bid), F2 (revive a quote) and B1/B2 (Z2, Z3, Z6) paths ACCEPTED; passes 2/5 show them REJECTED.
# Exit 0 only if passes 3 and 6 match 1 and 4, and the EXPECT lines hold.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; DB=gh2626_award_guard_proof; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
G="supabase/migrations/20261015205851_gh2626_claims_award_columns_guard.sql"; GR="$RB/gh2626_claims_award_columns_guard_rollback.sql"; P="$D/gh2620_claims_payment_guard_security_definer.sql"
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2519_gh2564_throwaway_schema.sql" >/dev/null
pass() { psql -q -At -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2626_claims_award_columns_guard_proof.sql" | sed '/^$/d' > "$OUT/$1.txt"; echo "== $1"; cat "$OUT/$1.txt"; }
apply() { psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }
rc=0
has() { grep -q "$2" "$OUT/$1.txt" || { echo "EXPECT FAIL [$1]: $2"; rc=1; }; }
pass 1-TODAY
apply "$G";  pass 2-GUARD-ONLY
apply "$GR"; pass 3-ROLLBACK-GUARD
apply "$P";  pass 4-WITH-2623
apply "$G";  pass 5-WITH-2623-AND-GUARD
apply "$GR"; pass 6-ROLLBACK-GUARD
# before: the direct writes succeed (D1 on today's schema; D2/D3 once #2623 removes the accidental block)
has 1-TODAY '^D1 .*ACCEPTED'
has 4-WITH-2623 '^D1 .*ACCEPTED'; has 4-WITH-2623 '^D2 .*ACCEPTED'; has 4-WITH-2623 '^D3 .*ACCEPTED'
# after: every D line refused, with and without #2623
for k in D1 D2 D3 D4 D5 D6 D7 D8; do has 2-GUARD-ONLY "^$k .*REJECTED 42501"; has 5-WITH-2623-AND-GUARD "^$k .*REJECTED 42501"; done
# the app's own award still succeeds
has 2-GUARD-ONLY '^R3 .*ACCEPTED'; has 5-WITH-2623-AND-GUARD '^R1 .*ACCEPTED'; has 5-WITH-2623-AND-GUARD '^R3 .*ACCEPTED'
has 5-WITH-2623-AND-GUARD '^R5 .*ACCEPTED'; has 5-WITH-2623-AND-GUARD '^R4 .*ACCEPTED'; has 5-WITH-2623-AND-GUARD '^R6 .*claim ACCEPTED | winning quote ACCEPTED | decline others (submitted only) ACCEPTED'
# B4 (DECIDED 6156405895): R6 now has a sibling expired and a sibling draft quote; the filtered statement leaves them untouched and declines the submitted one
has 5-WITH-2623-AND-GUARD '^R6 .*qA=selected,qC=declined,qD=draft,qE=expired'  # (R6 is asserted with #2623 only: without it the payment guard refuses the claim write for today's schema, as for R1)
# negative control: the old unfiltered statement is ACCEPTED without the guard and REJECTED 42501 with it
has 4-WITH-2623 '^R6b .*unfiltered decline-others ACCEPTED'; has 1-TODAY '^R6b .*unfiltered decline-others ACCEPTED'
has 5-WITH-2623-AND-GUARD '^R6b .*unfiltered decline-others REJECTED 42501'; has 2-GUARD-ONLY '^R6b .*unfiltered decline-others REJECTED 42501'
has 5-WITH-2623-AND-GUARD '^R2 .*REJECTED P0001'
has 5-WITH-2623-AND-GUARD '^S1 .*ACCEPTED'; has 5-WITH-2623-AND-GUARD '^A1 .*ACCEPTED'; has 5-WITH-2623-AND-GUARD '^X1 .*(no row)'
# review 6155135164: F1 (W1 to W4, accept_bid) and F2 (V1 to V4, revive then award) ACCEPTED before, REJECTED after
for k in W1 W2 W3 W4; do has 1-TODAY "^$k .*ACCEPTED"; has 4-WITH-2623 "^$k .*ACCEPTED"; has 2-GUARD-ONLY "^$k .*REJECTED P0001"; has 5-WITH-2623-AND-GUARD "^$k .*REJECTED P0001"; done
for k in V1 V2 V3 V4; do has 1-TODAY "^$k [^:]*: rows=1 ACCEPTED ; then"; has 4-WITH-2623 "^$k .*ACCEPTED.*; then rows=1 ACCEPTED"; has 2-GUARD-ONLY "^$k .*REJECTED 42501.*; then REJECTED 42501"; has 5-WITH-2623-AND-GUARD "^$k .*REJECTED 42501.*; then REJECTED 42501"; done
# review 6155821752: B1 (Z2 accept_bid, Z3 direct write) and B2 (Z6 draft relabelled declined, then accepted) ACCEPTED before, REJECTED after
has 1-TODAY "^Z2 .*ACCEPTED"; has 4-WITH-2623 "^Z2 .*ACCEPTED"; has 4-WITH-2623 "^Z3 .*ACCEPTED"  # Z3 is a direct write: today the payment guard (gh-2620) blocks it by accident, so ACCEPTED only once #2623 is applied (as D2/D3)
has 2-GUARD-ONLY '^Z2 .*REJECTED P0001'; has 5-WITH-2623-AND-GUARD '^Z2 .*REJECTED P0001'
has 2-GUARD-ONLY '^Z3 .*REJECTED 42501'; has 5-WITH-2623-AND-GUARD '^Z3 .*REJECTED 42501'
has 1-TODAY '^Z6 [^:]*: rows=1 ACCEPTED ; then rows=1 ACCEPTED'; has 4-WITH-2623 '^Z6 [^:]*: rows=1 ACCEPTED ; then rows=1 ACCEPTED'
has 2-GUARD-ONLY '^Z6 .*REJECTED 42501.*; then REJECTED P0001'; has 5-WITH-2623-AND-GUARD '^Z6 .*REJECTED 42501.*; then REJECTED P0001'
# review 6157765833: B1b (Y1 relabel selected -> declined then accept_bid, Y2 then direct award) ACCEPTED before, REJECTED after
has 1-TODAY '^Y1 [^:]*: rows=1 ACCEPTED ; then rows=1 ACCEPTED'; has 4-WITH-2623 '^Y1 [^:]*: rows=1 ACCEPTED ; then rows=1 ACCEPTED'
has 2-GUARD-ONLY '^Y1 .*REJECTED 42501.*; then REJECTED P0001'; has 5-WITH-2623-AND-GUARD '^Y1 .*REJECTED 42501.*; then REJECTED P0001'
has 4-WITH-2623 '^Y2 [^:]*: rows=1 ACCEPTED ; then rows=1 ACCEPTED'
has 2-GUARD-ONLY '^Y2 .*REJECTED 42501.*; then REJECTED 42501'; has 5-WITH-2623-AND-GUARD '^Y2 .*REJECTED 42501.*; then REJECTED 42501'
# the app's own paths and the contractor/service_role quote writes still succeed after
for k in R7 Q1 S2 R8; do has 2-GUARD-ONLY "^$k .*ACCEPTED"; has 5-WITH-2623-AND-GUARD "^$k .*ACCEPTED"; done
diff <(sed '/^GUARD /d' "$OUT/1-TODAY.txt") <(sed '/^GUARD /d' "$OUT/3-ROLLBACK-GUARD.txt") >/dev/null && echo "pass 3 matches pass 1 (GUARD line excluded)" || { echo "pass 3 differs from pass 1"; rc=1; }
diff <(sed '/^GUARD /d' "$OUT/4-WITH-2623.txt") <(sed '/^GUARD /d' "$OUT/6-ROLLBACK-GUARD.txt") >/dev/null && echo "pass 6 matches pass 4 (GUARD line excluded)" || { echo "pass 6 differs from pass 4"; rc=1; }
echo "EXIT=$rc"; exit $rc
