#!/usr/bin/env bash
# gh-2785: run the profiles freeze proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh2785_profiles_freeze_proof_run.sh [outdir]
# Also: the delete + re-insert bypass (A1, negative control), forced INSERT (A2, I1-I5), DELETE policy dropped (A3), and the rollback restores it.
# One fresh database: TODAY (no guard; failing controls) -> AFTER (forward) -> ROLLBACK (must equal TODAY, GUARD line excluded).
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
DB=gh2785_proof; rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2785_profiles_throwaway_schema.sql" >/dev/null || exit 2
pass() { psql -q -At -d "$DB" -f "$T/gh2785_profiles_freeze_proof.sql" > "$OUT/$1.txt" 2> "$OUT/$1.err"; echo "== $1"; cat "$OUT/$1.txt"; grep -q 'undo: gh2785 proof rolled back' "$OUT/$1.err" || fail "$1: proof did not end in its RAISE undo"; }
pass 1-TODAY
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh2785_profiles_freeze_is_test_role_email.sql" >/dev/null || fail "forward failed"
pass 2-AFTER
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh2785_profiles_freeze_is_test_role_email.sql" >/dev/null || fail "forward not idempotent"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB/gh2785_profiles_freeze_is_test_role_email_rollback.sql" >/dev/null || fail "rollback failed"
pass 3-ROLLBACK
for k in U1 U2 U3; do grep -q "^$k .*ACCEPTED" "$OUT/1-TODAY.txt" || fail "$k must be ACCEPTED today"; done
grep -q '^U3 .*now role=contractor' "$OUT/1-TODAY.txt" || fail "U3 today must change role"
for k in U1 U2; do grep -q "^$k .*REJECTED 42501" "$OUT/2-AFTER.txt" || fail "$k must be REJECTED 42501 after"; done
grep -q '^U3 .*ACCEPTED.*now role=homeowner' "$OUT/2-AFTER.txt" || fail "U3 must be pinned to homeowner after"
grep -q '^U4 .*ACCEPTED.*name=Signup Name phone=317 role=homeowner' "$OUT/2-AFTER.txt" || fail "U4 other columns must land, role pinned"
grep -q '^U5 .*ACCEPTED.*name=Upsert Name role=contractor' "$OUT/2-AFTER.txt" || fail "U5 upsert: name lands, role pinned"
for k in U6 U7 S1 S2 D1; do grep -q "^$k .*ACCEPTED" "$OUT/2-AFTER.txt" || fail "$k must be ACCEPTED after"; done
grep -q '^S1 .*now true/svc@example.invalid/contractor' "$OUT/2-AFTER.txt" || fail "S1 service_role must change all three"
grep -q '^D1 .*now role=contractor' "$OUT/2-AFTER.txt" || fail "D1 definer sync must still flip role"
grep -q '^U8 .*(no row).*other is_test=false' "$OUT/2-AFTER.txt" || fail "U8 RLS"
grep -q '^A1 .*now true/forged@example.invalid/contractor' "$OUT/1-TODAY.txt" || fail "A1 delete+reinsert must succeed today (negative control)"
grep -q '^A3 .*row present=false' "$OUT/1-TODAY.txt" || fail "A3 delete must succeed today"
grep -q '^A1 .*REJECTED' "$OUT/2-AFTER.txt" && grep -q '^A1 .*now false/real@example.invalid/' "$OUT/2-AFTER.txt" || fail "A1 must fail after, row unchanged"
grep -q '^A2 .*ACCEPTED.*now false/real@example.invalid/homeowner' "$OUT/2-AFTER.txt" || fail "A2 forged insert must be forced to homeowner/false/JWT email"
grep -q '^A3 .*row present=true' "$OUT/2-AFTER.txt" || fail "A3 delete must be a no-op after"
grep -q '^I1 .*now false/real@example.invalid/homeowner/Dash Name' "$OUT/2-AFTER.txt" || fail "I1 dashboard insert"
grep -q '^I2 .*now true/agent@otterquote-internal.test/homeowner' "$OUT/2-AFTER.txt" || fail "I2 internal domain must still be is_test"
grep -q '^I3 .*now false/hnu@example.invalid/homeowner' "$OUT/2-AFTER.txt" || fail "I3 definer insert"
grep -q '^I4 .*now true/seed@example.invalid/contractor' "$OUT/2-AFTER.txt" || fail "I4 service_role insert"
grep -q '^I5 .*now contractor/Contractor Co' "$OUT/2-AFTER.txt" || fail "I5 contractor signup chain"
grep -q '^END .*: 0$' "$OUT/2-AFTER.txt" || fail "no forged value may remain after"
diff <(sed '/^GUARD /d' "$OUT/1-TODAY.txt") <(sed '/^GUARD /d' "$OUT/3-ROLLBACK.txt") >/dev/null && echo "ROLLBACK matches TODAY (GUARD line excluded)" || fail "ROLLBACK differs from TODAY"
[ $rc = 0 ] && echo "ALL CHECKS PASS" || echo "FAILURES"
exit $rc
