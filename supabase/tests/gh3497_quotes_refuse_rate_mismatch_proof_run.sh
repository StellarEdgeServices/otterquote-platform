#!/usr/bin/env bash
# gh-3497 part 2: before/after proof of supabase/migrations_drafts/gh3497_quotes_refuse_rate_mismatch.sql on a THROWAWAY Postgres 16. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3497_quotes_refuse_rate_mismatch_proof_run.sh [outdir]
# (NOTE: *.sh is in .gitignore; committed with `git add -f` like the gh2519/gh2564/gh2803 runners.)
# Schema: gh2519_gh2564_throwaway_schema.sql, then main's gh2626 -> gh2519 -> gh2564. Passes of the proof:
#   P1 BEFORE (no trigger: the hole)   P2 AFTER (trigger applied)   P3 after its rollback (must equal P1)   P4 re-applied (must equal P2)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"; DB=gh3497_rate_proof
M=supabase/migrations; D=supabase/migrations_drafts; T=supabase/tests
rc=0
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
apply() { psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }
apply "$T/gh2519_gh2564_throwaway_schema.sql"
apply "$M/20261015205851_gh2626_claims_award_columns_guard.sql"; apply "$M/20261015205902_gh2519_quotes_server_set_fee.sql"; apply "$M/20261018195342_gh2564_quotes_selected_price_lock.sql"
GUARD0=$(psql -q -At -d "$DB" -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.quotes_guard_homeowner_columns()'::regprocedure")
pass() { psql -q -At -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh3497_quotes_refuse_rate_mismatch_proof.sql" | sed '/^$/d' > "$OUT/$1.txt"; echo "== $1"; cat "$OUT/$1.txt"; }
has() { grep -m1 "^$2 " "$OUT/$1.txt" | grep -qF -- "$3" && return 0; echo "EXPECTATION FAILED in $1: $2 should contain '$3'"; rc=1; }
pass P1_BEFORE
apply "$D/gh3497_quotes_refuse_rate_mismatch.sql"; pass P2_AFTER
GUARD1=$(psql -q -At -d "$DB" -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.quotes_guard_homeowner_columns()'::regprocedure")
[ "$GUARD0" = "$GUARD1" ] && echo "guard body md5 unchanged by the migration ($GUARD0)" || { echo "GUARD BODY CHANGED"; rc=1; }
apply "$D/gh3497_quotes_refuse_rate_mismatch_rollback.sql"; pass P3_ROLLBACK
apply "$D/gh3497_quotes_refuse_rate_mismatch.sql"; pass P4_REAPPLY
# the hole (B1): before the trigger the form's 5.00 is silently replaced by 7.50 and $1,875.00 is stored; after, it is refused and no row exists
has P1_BEFORE B1 "ACCEPTED stored rate=7.50 fee_percentage=7.50 fee_amount=1875.00 | quote rows for this bid: 1"
has P2_AFTER  B1 "REJECTED P0001 quotes: fee_rate_mismatch: the fee rate shown with this bid is 5.00 percent but the configured rate is 7.50 percent"
has P2_AFTER  B1 "quote rows for this bid: 0"
# every other line is the same before and after, except the lower/higher displayed rate lines that are the same hole
for s in P1_BEFORE P2_AFTER; do
  has $s A1 "ACCEPTED stored rate=5.00 fee_percentage=5.00 fee_amount=1250.00"
  has $s A2 "ACCEPTED stored rate=5.00 fee_percentage=5.00 fee_amount=1250.00"
  has $s A3 "ACCEPTED stored rate=5.00 fee_percentage=5.00 fee_amount=1250.00"
  has $s B2 "ACCEPTED stored rate=7.50 fee_percentage=7.50 fee_amount=1875.00"
  has $s B4 "ACCEPTED stored rate=7.50 fee_percentage=7.50 fee_amount=1875.00"
  has $s B5 "ACCEPTED stored rate=7.50"
  has $s B6 "ACCEPTED stored rate=5.00"
  has $s B7 "ACCEPTED"
  has $s B8 "REJECTED"
  has $s B9 "REJECTED 42501 quotes: a bid can only be created by the contractor it names (gh-2479)"
  has $s D1 "REJECTED P0001 quotes: no platform fee is configured for this bid, so it cannot be saved (gh-2519)"
  has $s D2 "ACCEPTED"
done
has P1_BEFORE A4 "ACCEPTED stored rate=5.00"; has P2_AFTER A4 "REJECTED P0001 quotes: fee_rate_mismatch: the fee rate shown with this bid is 4.00 percent"
has P1_BEFORE B3 "ACCEPTED stored rate=7.50"; has P2_AFTER B3 "REJECTED P0001 quotes: fee_rate_mismatch: the fee rate shown with this bid is 9.00 percent"
has P2_AFTER B3 "quote rows for this bid: 0"; has P2_AFTER A4 "quote rows for this bid: 0"
# control: renamed to fire after the guard, the check cannot see the displayed rate and the hole is open
has P2_AFTER C1 "ACCEPTED stored rate=7.50 fee_percentage=7.50 fee_amount=1875.00"
grep -m1 "^TRIGGER " "$OUT/P2_AFTER.txt" | grep -qF "quotes_check_displayed_fee_rate > " || { echo "EXPECTATION FAILED: check trigger is not first in P2_AFTER"; rc=1; }
grep -m1 "^TRIGGER " "$OUT/P2_AFTER.txt" | grep -E -q "quotes_check_displayed_fee_rate > .*quotes_guard_homeowner_columns" || { echo "EXPECTATION FAILED: check trigger does not fire before the guard"; rc=1; }
diff "$OUT/P1_BEFORE.txt" "$OUT/P3_ROLLBACK.txt" >/dev/null && echo "P3_ROLLBACK equals P1_BEFORE" || { echo "P3 DIFFERS from P1"; rc=1; }
diff "$OUT/P2_AFTER.txt" "$OUT/P4_REAPPLY.txt" >/dev/null && echo "P4_REAPPLY equals P2_AFTER" || { echo "P4 DIFFERS from P2"; rc=1; }
echo "EXIT $rc"; exit $rc
