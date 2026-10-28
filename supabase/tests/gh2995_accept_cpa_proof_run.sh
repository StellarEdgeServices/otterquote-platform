#!/usr/bin/env bash
# gh-2995: run the accept_cpa proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh2995_accept_cpa_proof_run.sh [outdir]
# Phases in one fresh database: 1-TODAY (forward not applied: controls show the defect) -> 2-AFTER (forward applied) ->
# 3-ROLLBACK (rollback applied: must look like TODAY again; forward re-applied cleanly afterwards).
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
DB=gh2995_proof; rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2995_throwaway_schema.sql" >/dev/null || exit 2
pass() { psql -q -At -d "$DB" -f "$T/gh2995_accept_cpa_proof.sql" > "$OUT/$1.txt" 2> "$OUT/$1.err"; echo "== $1"; cat "$OUT/$1.txt"; cat "$OUT/$1.err"; }
pass 1-TODAY
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh2995_accept_cpa_append_only.sql" >/dev/null || fail "forward failed"
pass 2-AFTER
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh2995_accept_cpa_append_only.sql" >/dev/null || fail "forward not idempotent"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB/gh2995_accept_cpa_append_only_rollback.sql" >/dev/null || fail "rollback failed"
pass 3-ROLLBACK
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh2995_accept_cpa_append_only.sql" >/dev/null || fail "forward after rollback failed"
pass 4-REAPPLIED
grep -q '^FAILING=0 of' "$OUT/1-TODAY.txt" || fail "TODAY must have 0 failing rows (each row's expectation is phase-aware)"
grep -q '^FAILING=0 of' "$OUT/2-AFTER.txt" || fail "AFTER must have 0 failing rows"
grep -q '^FAILING=0 of' "$OUT/3-ROLLBACK.txt" || fail "ROLLBACK phase must match TODAY expectations"
grep -q '^FAILING=0 of' "$OUT/4-REAPPLIED.txt" || fail "REAPPLIED must have 0 failing rows"
diff <(grep -v '^fixed=' "$OUT/1-TODAY.txt" | cut -d'|' -f1-5) <(grep -v '^fixed=' "$OUT/3-ROLLBACK.txt" | cut -d'|' -f1-5) >/dev/null || fail "ROLLBACK phase differs from TODAY"
echo "RUNNER rc=$rc"; exit $rc
