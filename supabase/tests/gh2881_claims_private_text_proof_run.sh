#!/usr/bin/env bash
# gh-2881 proof runner. THROWAWAY POSTGRES ONLY. Usage (repo root): PGHOST=... PGPORT=... PGUSER=... bash supabase/tests/gh2881_claims_private_text_proof_run.sh
set -u
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
STEP1=supabase/migrations_drafts/gh2881_claim_private_text_rpc.sql
FWD=supabase/migrations_drafts/gh2881_claims_private_text_column_grants.sql
RB=supabase/migrations_drafts/gh2881_claims_private_text_column_grants_rollback.sql
RB1=supabase/migrations_drafts/gh2881_claim_private_text_rpc_rollback.sql
MODEL=supabase/tests/gh2881_claims_private_text_model.sql
PROOF=supabase/tests/gh2881_claims_private_text_proof.sql
export PGOPTIONS='-c client_min_messages=notice'
# the proof applies step 1 (RPC) and step 3 (gated revoke) back to back inside its rolled-back block; BEGIN/COMMIT lines are stripped
cat "$STEP1" "$FWD" | grep -v -E '^\s*(BEGIN|COMMIT);\s*$' > "$W/fwd_nobegin.sql"
fail=0
mk() { psql -d postgres -qAt -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null && psql -d "$1" -q -v ON_ERROR_STOP=1 -f "$MODEL" >/dev/null; }

echo "== A. BEFORE / AFTER proof (rolled back) =="
mk g2881a || exit 1
psql -d g2881a -v ON_ERROR_STOP=1 -v fwd="$W/fwd_nobegin.sql" -f "$PROOF" 2>&1 | sed -e 's/^psql:[^ ]* NOTICE:  //' -e 's/^NOTICE:  //' | tee "$W/a.out"
chk() { # name, pattern, file
  if grep -qE "$2" "$3"; then echo "CHECK PASS: $1"; else echo "CHECK FAIL: $1   (wanted /$2/)"; fail=1; fi; }
chk "NEGATIVE CONTROL: BEFORE, selected contractor reads the raw note"        'PROOF\[BEFORE\] selected contractor, direct read of the 3 columns +selected => READ OK: .*PROBE call 317-555-0142' "$W/a.out"
chk "NEGATIVE CONTROL: BEFORE, non-selected bidder reads the raw note"        'PROOF\[BEFORE\] non-selected bidder, direct read of the 3 columns +bidder => READ OK: .*PROBE call 317-555-0142' "$W/a.out"
chk "AFTER, selected contractor refused (42501)"                               'PROOF\[AFTER\] selected contractor, direct read of the 3 columns +selected => REFUSED sqlstate=42501' "$W/a.out"
chk "AFTER, non-selected bidder refused (42501)"                               'PROOF\[AFTER\] non-selected bidder, direct read of the 3 columns +bidder => REFUSED sqlstate=42501' "$W/a.out"
chk "AFTER, project_confirmation alone refused"                                'PROOF\[AFTER\] selected contractor, project_confirmation only +selected-pc => REFUSED sqlstate=42501' "$W/a.out"
chk "AFTER, select * refused (documented consequence)"                         'PROOF\[AFTER\] selected contractor, select \* \(all columns\) +selected-star => REFUSED sqlstate=42501' "$W/a.out"
chk "AFTER, the other columns the contractor pages read still work"            'PROOF\[AFTER\] selected contractor, the other columns the pages read +selected-cols => READ OK: .*12 Elm St' "$W/a.out"
chk "AFTER, homeowner reads her other columns"                                 'PROOF\[AFTER\] homeowner, other columns +owner-cols => READ OK' "$W/a.out"
chk "AFTER, homeowner direct read of the note is refused (documented change)"  'PROOF\[AFTER\] homeowner, direct read of homeowner_notes +owner => REFUSED sqlstate=42501' "$W/a.out"
chk "AFTER, homeowner reads her note through claim_private_text()"             'PROOF\[AFTER\] homeowner, claim_private_text\(\) +owner-rpc => READ OK: .*PROBE call 317-555-0142' "$W/a.out"
chk "AFTER, selected contractor gets no row from claim_private_text()"         'PROOF\[AFTER\] selected contractor, claim_private_text\(\) +sel-rpc => READ OK: \(no rows\)' "$W/a.out"
chk "AFTER, non-selected bidder gets no row from claim_private_text()"         'PROOF\[AFTER\] non-selected bidder, claim_private_text\(\) +bid-rpc => READ OK: \(no rows\)' "$W/a.out"
chk "AFTER, non-bidder gets no row from claim_private_text()"                  'PROOF\[AFTER\] non-bidder contractor, claim_private_text\(\) +non-rpc => READ OK: \(no rows\)' "$W/a.out"
chk "AFTER, an admin reads through claim_private_text()"                       'PROOF\[AFTER\] admin, claim_private_text\(\) +admin-rpc => READ OK: .*PROBE call' "$W/a.out"
chk "AFTER, anon refused on the RPC (no EXECUTE)"                              'PROOF\[AFTER\] anon, claim_private_text\(\) +anon-rpc => REFUSED sqlstate=42501' "$W/a.out"
chk "AFTER, service_role still reads the columns"                              'PROOF\[AFTER\] service_role, read of the 3 columns +service => READ OK: .*PROBE call' "$W/a.out"
chk "AFTER, the homeowner's write path (UPDATE ... RETURNING id) still works"  'PROOF\[AFTER\] homeowner, UPDATE homeowner_notes \(write path\) +owner-write => READ OK: d0000000' "$W/a.out"
chk "AFTER, INSERT/UPDATE privileges unchanged"                                'ACL check: authenticated INSERT/UPDATE on claims unchanged: insert=t update=t' "$W/a.out"
chk "proof rolled back"                                                        'PROOF: rolled back' "$W/a.out"
LEFT=$(psql -d g2881a -Atc "SELECT (to_regprocedure('public.claim_private_text(uuid)') IS NOT NULL)::int + has_column_privilege('authenticated','public.claims','homeowner_notes','SELECT')::int - 1")
[ "$LEFT" = "0" ] && echo "CHECK PASS: after ROLLBACK the database is as before (no function, authenticated can read the column again)" || { echo "CHECK FAIL: proof left state behind ($LEFT)"; fail=1; }

echo "== B. gate negative control: the forward file WITHOUT the operator statement refuses and changes nothing =="
mk g2881b || exit 1
psql -d g2881b -q -v ON_ERROR_STOP=1 -f "$STEP1" >/dev/null
OUT=$(psql -d g2881b -v ON_ERROR_STOP=1 -f "$FWD" 2>&1); RC=$?
echo "$OUT" | grep -E "ERROR|refused" | head -2
LEFT=$(psql -d g2881b -Atc "SELECT (NOT has_column_privilege('authenticated','public.claims','homeowner_notes','SELECT'))::int")
[ "$RC" != 0 ] && [ "$LEFT" = 0 ] && echo "CHECK PASS: gate refused (rc=$RC), objects left=0" || { echo "CHECK FAIL: gate (rc=$RC left=$LEFT)"; fail=1; }

echo "== C. forward then ROLLBACK file: a contractor can read again, the function is gone =="
mk g2881c || exit 1
psql -d g2881c -q -v ON_ERROR_STOP=1 -f "$STEP1" >/dev/null || { echo "CHECK FAIL: step 1 did not apply"; fail=1; }
printf "BEGIN;\nSET LOCAL gh2881.pages_published = 'yes';\n" > "$W/c_fwd.sql"; grep -v -E '^\s*(BEGIN|COMMIT);\s*$' "$FWD" >> "$W/c_fwd.sql"; echo "COMMIT;" >> "$W/c_fwd.sql"
psql -d g2881c -q -v ON_ERROR_STOP=1 -f "$W/c_fwd.sql" >/dev/null || { echo "CHECK FAIL: forward did not apply on the model"; fail=1; }
MID=$(psql -d g2881c -Atc "SELECT has_column_privilege('authenticated','public.claims','homeowner_notes','SELECT')")
psql -d g2881c -q -v ON_ERROR_STOP=1 -f "$RB" >/dev/null || { echo "CHECK FAIL: rollback did not run"; fail=1; }
RPC_KEPT=$(psql -d g2881c -Atc "SELECT to_regprocedure('public.claim_private_text(uuid)') IS NOT NULL")
psql -d g2881c -q -v ON_ERROR_STOP=1 -f "$RB1" >/dev/null || { echo "CHECK FAIL: step 1 rollback"; fail=1; }
END=$(psql -d g2881c -Atc "SELECT has_column_privilege('authenticated','public.claims','homeowner_notes','SELECT') AND has_table_privilege('authenticated','public.claims','SELECT') AND to_regprocedure('public.claim_private_text(uuid)') IS NULL")
[ "$RPC_KEPT" = t ] && echo "CHECK PASS: the grants rollback keeps the RPC for the published pages" || { echo "CHECK FAIL: grants rollback dropped the RPC"; fail=1; }
psql -d g2881c -q -v ON_ERROR_STOP=1 -f "$RB" >/dev/null && echo "CHECK PASS: rollback is safe to run twice" || { echo "CHECK FAIL: second rollback run"; fail=1; }
[ "$MID" = f ] && [ "$END" = t ] && echo "CHECK PASS: forward closed the column (authenticated=$MID), rollback reopened it and removed the function ($END)" || { echo "CHECK FAIL: forward/rollback ($MID/$END)"; fail=1; }
[ "$fail" = 0 ] && echo "GH2881_PROOF: ALL PASS" || { echo "GH2881_PROOF: FAIL"; exit 1; }
