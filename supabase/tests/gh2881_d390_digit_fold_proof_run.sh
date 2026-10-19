#!/usr/bin/env bash
# gh-2881 digit-fold proof runner. THROWAWAY POSTGRES ONLY. Usage (repo root): PGHOST=... PGPORT=... PGUSER=... bash supabase/tests/gh2881_d390_digit_fold_proof_run.sh
set -u
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
APPLIED=supabase/migrations/20261008231303_gh2559_bidder_claims_view.sql
grep -v -E '^\s*(BEGIN|COMMIT);\s*$' "$APPLIED" > "$W/applied_view.sql"
export PGOPTIONS='-c client_min_messages=warning'
echo "== static parity (the fold migration is #2880's statements with ONE clause extended; rollback verbatim) =="
python3 tests/gh2881-d390-digit-fold-parity.py || exit 1
echo "== proof (A before / B after / C rollback) =="
psql -d postgres -qc "DROP DATABASE IF EXISTS g2881d" -c "CREATE DATABASE g2881d" || exit 1
sed "s#\\\\i /tmp/d390_applied_view.sql#\\\\i $W/applied_view.sql#" supabase/tests/gh2559_d390_redact_proof_model.sql > "$W/model.sql"
sed "s#supabase/tests/gh2559_d390_redact_proof_model.sql#$W/model.sql#" supabase/tests/gh2881_d390_digit_fold_proof.sql > "$W/proof.sql"
psql -d g2881d -v ON_ERROR_STOP=1 -P pager=off -f "$W/proof.sql" 2>&1 | tee "$W/out.txt" | grep -vE "^psql:.*(NOTICE|WARNING)"
RC=${PIPESTATUS[0]}
echo "PROOF_EXIT=$RC"
[ "$RC" = 0 ] && grep -q "failures=0" "$W/out.txt" && echo "GH2881_D390_DIGIT_FOLD: ALL PASS" || { echo "GH2881_D390_DIGIT_FOLD: FAIL"; exit 1; }
