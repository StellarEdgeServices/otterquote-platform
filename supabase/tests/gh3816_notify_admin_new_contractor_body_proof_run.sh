#!/usr/bin/env bash
# gh-3816: run the notify_admin_new_contractor proof on a THROWAWAY Postgres (stub pg_net and Vault live inside the proof's transaction). Never point this at production.
# Usage: PGHOST=... PGUSER=postgres bash supabase/tests/gh3816_notify_admin_new_contractor_body_proof_run.sh [outdir]
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"; DB=gh3816_proof; rc=0
F=supabase/migrations_drafts/gh3816_notify_admin_new_contractor_body.sql
R=supabase/migrations_rollbacks/gh3816_notify_admin_new_contractor_body_rollback.sql
EF="${EF_PATH:-supabase/functions/notify-admin-new-contractor/index.ts}"
# D0 static checks: only CREATE OR REPLACE FUNCTION in both files (no destructive DDL/DML outside the function bodies)
for f in "$F" "$R"; do
  if grep -v '^\s*--' "$f" | grep -Eiq '\b(DROP|TRUNCATE|ALTER|DELETE\s+FROM|GRANT|REVOKE)\b'; then echo "EXPECT FAIL: $f contains DROP/TRUNCATE/ALTER/DELETE/GRANT/REVOKE"; rc=1; fi
  [ "$(grep -c 'CREATE OR REPLACE FUNCTION' "$f")" = 1 ] || { echo "EXPECT FAIL: $f must have exactly one CREATE OR REPLACE FUNCTION"; rc=1; }
done
# The Edge Function must read only contractor_id from the body (the proof's B3 asserts the body is exactly that one key)
FIELDS="$(grep -o 'body?\.[a-z_]*' "$EF" | sort -u | tr '\n' ' ')"
echo "EF body fields read: $FIELDS"
[ "$FIELDS" = "body?.contractor_id " ] || { echo "EXPECT FAIL: Edge Function reads other body fields than contractor_id"; rc=1; }
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" || exit 2
psql -q -At -d "$DB" -f supabase/tests/gh3816_notify_admin_new_contractor_body_proof.sql > "$OUT/proof.txt" 2> "$OUT/proof.err"
cat "$OUT/proof.txt" "$OUT/proof.err"
grep -q '^FAILING=0 of' "$OUT/proof.txt" || { echo "EXPECT FAIL: proof has failing rows"; rc=1; }
echo "RUNNER rc=$rc"; exit $rc
