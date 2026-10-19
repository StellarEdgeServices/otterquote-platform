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
FAIL=0
echo "== guard refusals: the fold migration refuses when #2880 is absent, and when d390_redact_contact is not #2880's text; each leaves the database unchanged =="
FOLD=supabase/migrations_drafts/gh2881_d390_digit_fold.sql
snap() { psql -d "$1" -Atc "SELECT coalesce(md5(prosrc),'none') FROM (SELECT prosrc FROM pg_proc WHERE proname='d390_redact_contact' UNION ALL SELECT NULL LIMIT 1) x; SELECT md5(pg_get_viewdef('public.bidder_claim_summary'::regclass))"; }
# G1: the applied view only, #2880 NOT applied
psql -d postgres -qc "DROP DATABASE IF EXISTS g2881g1" -c "CREATE DATABASE g2881g1" >/dev/null && psql -d g2881g1 -q -v ON_ERROR_STOP=1 -f "$W/model.sql" >/dev/null || FAIL=1
B1=$(snap g2881g1); OUT=$(psql -d g2881g1 -v ON_ERROR_STOP=1 -f "$FOLD" 2>&1); R1=$?; A1=$(snap g2881g1)
if [ "$R1" != 0 ] && echo "$OUT" | grep -q "is not applied; apply it first" && [ "$B1" = "$A1" ]; then echo "CHECK PASS: G1 refuses without #2880 (rc=$R1), database unchanged"; else echo "CHECK FAIL: G1 (rc=$R1)"; FAIL=1; fi
# G2: #2880 applied, then d390_redact_contact replaced by a different body
psql -d postgres -qc "DROP DATABASE IF EXISTS g2881g2" -c "CREATE DATABASE g2881g2" >/dev/null && psql -d g2881g2 -q -v ON_ERROR_STOP=1 -f "$W/model.sql" >/dev/null && psql -d g2881g2 -q -v ON_ERROR_STOP=1 -f supabase/migrations_drafts/gh2559_d390_redact_contact_until_fee.sql >/dev/null 2>&1 || FAIL=1
psql -d g2881g2 -q -v ON_ERROR_STOP=1 -c "CREATE OR REPLACE FUNCTION public.d390_redact_contact(p_text text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS \$f\$ SELECT p_text \$f\$" >/dev/null || FAIL=1
B2=$(snap g2881g2); OUT=$(psql -d g2881g2 -v ON_ERROR_STOP=1 -f "$FOLD" 2>&1); R2=$?; A2=$(snap g2881g2)
if [ "$R2" != 0 ] && echo "$OUT" | grep -q "is not the text PR #2880 applied" && [ "$B2" = "$A2" ]; then echo "CHECK PASS: G2 refuses a function body that is not #2880's (rc=$R2), database unchanged"; else echo "CHECK FAIL: G2 (rc=$R2)"; FAIL=1; fi
[ "$FAIL" = 0 ] || { echo "GH2881_D390_DIGIT_FOLD: FAIL"; exit 1; }
[ "$RC" = 0 ] && grep -q "failures=0" "$W/out.txt" && echo "GH2881_D390_DIGIT_FOLD: ALL PASS" || { echo "GH2881_D390_DIGIT_FOLD: FAIL"; exit 1; }
