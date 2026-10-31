#!/usr/bin/env bash
# gh-3073: run the agreement_version proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3073_agreement_version_proof_run.sh [outdir]
# Phases in one fresh database: 1-BASELINE (gh-2995 accept_cpa: negative control, agreement_version stays NULL) -> 2-AFTER (forward applied)
# -> 3-ROLLBACK (rollback applied: must look like BASELINE again) -> 4-REAPPLIED (forward re-applied cleanly).
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
DB=gh3073_proof; rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh3073_throwaway_schema.sql" >/dev/null || exit 2
pass() { psql -q -At -d "$DB" -f "$T/gh3073_agreement_version_proof.sql" > "$OUT/$1.txt" 2> "$OUT/$1.err"; echo "== $1"; cat "$OUT/$1.txt"; cat "$OUT/$1.err"; }
pass 1-BASELINE
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3073_agreement_version_stamp.sql" >/dev/null || fail "forward failed"
pass 2-AFTER
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3073_agreement_version_stamp.sql" >/dev/null || fail "forward not idempotent"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB/gh3073_agreement_version_stamp_rollback.sql" >/dev/null || fail "rollback failed"
pass 3-ROLLBACK
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3073_agreement_version_stamp.sql" >/dev/null || fail "forward after rollback failed"
pass 4-REAPPLIED
grep -q '^FAILING=0 of' "$OUT/1-BASELINE.txt" || fail "BASELINE must have 0 failing rows (each row's expectation is phase-aware)"
grep -q '^FAILING=0 of' "$OUT/2-AFTER.txt" || fail "AFTER must have 0 failing rows"
grep -q '^FAILING=0 of' "$OUT/3-ROLLBACK.txt" || fail "ROLLBACK phase must match BASELINE expectations"
grep -q '^FAILING=0 of' "$OUT/4-REAPPLIED.txt" || fail "REAPPLIED must have 0 failing rows"
diff <(grep -v '^fixed=' "$OUT/1-BASELINE.txt" | cut -d'|' -f1-5) <(grep -v '^fixed=' "$OUT/3-ROLLBACK.txt" | cut -d'|' -f1-5) >/dev/null || fail "ROLLBACK phase differs from BASELINE"
echo "RUNNER rc=$rc"; exit $rc
