#!/usr/bin/env bash
# gh-2559 / D-390 proof runner. THROWAWAY POSTGRES ONLY. Usage (repo root): PGHOST=... PGPORT=... PGUSER=... bash supabase/tests/gh2559_d390_redact_proof_run.sh
set -u
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
APPLIED=supabase/migrations/20261008231303_gh2559_bidder_claims_view.sql
grep -v -E '^\s*(BEGIN|COMMIT);\s*$' "$APPLIED" > "$W/applied_view.sql"
export PGOPTIONS='-c client_min_messages=warning'
echo "== static parity (regex copy, view diff, rollback restores the applied view) =="
python3 tests/gh2559-d390-regex-parity.py || exit 1
echo "== A. full proof =="
psql -d postgres -qc "DROP DATABASE IF EXISTS d390a" -c "CREATE DATABASE d390a" || exit 1
sed "s#\\\\i /tmp/d390_applied_view.sql#\\\\i $W/applied_view.sql#" supabase/tests/gh2559_d390_redact_proof_model.sql > "$W/model.sql"
sed "s#supabase/tests/gh2559_d390_redact_proof_model.sql#$W/model.sql#" supabase/tests/gh2559_d390_redact_proof.sql > "$W/proof.sql"
psql -d d390a -v ON_ERROR_STOP=1 -P pager=off -f "$W/proof.sql"; RC_A=$?
echo "PROOF_A_EXIT=$RC_A"
echo "== B. gate negative control: forward file on a schema WITHOUT PR #2777 (claims.contractor_released_at missing) must refuse and change nothing =="
psql -d postgres -qc "DROP DATABASE IF EXISTS d390b" -c "CREATE DATABASE d390b" || exit 1
psql -d d390b -q -v ON_ERROR_STOP=1 -f "$W/model.sql" >/dev/null || exit 1
psql -d d390b -qc "ALTER TABLE public.claims RENAME COLUMN contractor_released_at TO contractor_released_at_gone" || exit 1
OUT=$(psql -d d390b -v ON_ERROR_STOP=1 -f supabase/migrations_drafts/gh2559_d390_redact_contact_until_fee.sql 2>&1); RC_B=$?
echo "$OUT" | grep -E "ERROR|gate" | head -3
echo "GATE_EXIT=$RC_B (non-zero expected)"
LEFT=$(psql -d d390b -Atc "SELECT (to_regprocedure('public.d390_redact_contact(text)') IS NOT NULL)::int + (to_regclass('public.contractor_thread_messages') IS NOT NULL)::int + (SELECT count(*) FROM pg_policies WHERE policyname='d390_homeowner_text_prefee')::int + (pg_get_viewdef('public.bidder_claim_summary'::regclass) LIKE '%d390%')::int")
echo "OBJECTS_LEFT_AFTER_REFUSED_APPLY=$LEFT (0 expected)"
[ "$RC_A" = 0 ] && [ "$RC_B" != 0 ] && [ "$LEFT" = 0 ] && echo "D390_PROOF: ALL PASS" || { echo "D390_PROOF: FAIL"; exit 1; }
