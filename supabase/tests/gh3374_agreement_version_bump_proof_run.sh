#!/usr/bin/env bash
# gh-3374: run the agreement-version-bump proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGUSER=postgres bash supabase/tests/gh3374_agreement_version_bump_proof_run.sh [outdir]
# Fresh database = gh3073_throwaway_schema.sql (gh-2995 forward) + gh-3073 forward, then the proof (which runs the gh-3374 forward and rollback files itself).
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"; DB=gh3374_proof; rc=0
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f supabase/tests/gh3073_throwaway_schema.sql >/dev/null || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f supabase/migrations_drafts/gh3073_agreement_version_stamp.sql >/dev/null || { echo "gh3073 forward failed"; exit 2; }
psql -q -At -d "$DB" -f supabase/tests/gh3374_agreement_version_bump_proof.sql > "$OUT/proof.txt" 2> "$OUT/proof.err"
cat "$OUT/proof.txt" "$OUT/proof.err"
grep -q '^FAILING=0 of' "$OUT/proof.txt" || { echo "EXPECT FAIL: proof has failing rows"; rc=1; }
echo "RUNNER rc=$rc"; exit $rc
