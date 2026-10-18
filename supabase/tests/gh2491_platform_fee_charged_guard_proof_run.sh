#!/usr/bin/env bash
# gh-2491: run the platform_fee_charged guard proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh2491_platform_fee_charged_guard_proof_run.sh [outdir]
# Three passes of supabase/tests/gh2491_platform_fee_charged_guard_proof.sql in one database:
#   1 TODAY     production's schema as read 2026-10-08 (the failing controls)
#   2 AFTER     + supabase/migrations/20261015205709_gh2491_claims_platform_fee_charged_guard.sql
#   3 ROLLBACK  + its rollback (must print exactly what pass 1 printed)
# Exit 0 only if pass 3 equals pass 1 and pass 2 shows the expected verdicts.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; DB=gh2491_fee_guard_proof; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2519_gh2564_throwaway_schema.sql" >/dev/null
pass() { psql -q -At -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2491_platform_fee_charged_guard_proof.sql" > "$OUT/$1.txt"; echo "== $1"; cat "$OUT/$1.txt"; }
apply() { psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }
rc=0
pass 1-TODAY
apply "supabase/migrations/20261015205709_gh2491_claims_platform_fee_charged_guard.sql"; pass 2-AFTER
apply "$RB/gh2491_claims_platform_fee_charged_guard_rollback.sql"; pass 3-ROLLBACK
# verdict lines
grep -q '^U1 .*ACCEPTED' "$OUT/1-TODAY.txt" || { echo "EXPECT FAIL: U1 must be ACCEPTED today"; rc=1; }
grep -q '^U1 .*REJECTED 42501' "$OUT/2-AFTER.txt" || { echo "EXPECT FAIL: U1 must be REJECTED after"; rc=1; }
grep -q '^I1 .*REJECTED 42501' "$OUT/2-AFTER.txt" || { echo "EXPECT FAIL: I1 must be REJECTED after"; rc=1; }
for k in U3 U4 S1 A1 I2 I3 I4; do grep -q "^$k .*ACCEPTED" "$OUT/2-AFTER.txt" || { echo "EXPECT FAIL: $k must be ACCEPTED after"; rc=1; }; done
# pass 3 must equal pass 1 except the guard-present line
diff <(sed '/^GUARD /d' "$OUT/1-TODAY.txt") <(sed '/^GUARD /d' "$OUT/3-ROLLBACK.txt") >/dev/null && echo "ROLLBACK matches TODAY (guard line excluded)" || { echo "ROLLBACK differs from TODAY"; rc=1; }
echo "EXIT=$rc"; exit $rc
