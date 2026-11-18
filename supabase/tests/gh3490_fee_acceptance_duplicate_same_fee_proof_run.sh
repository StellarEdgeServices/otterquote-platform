#!/usr/bin/env bash
# gh-3490: run the duplicate_bid (same bid AND same fee) proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3490_fee_acceptance_duplicate_same_fee_proof_run.sh [outdir]
# Needs: psql, node, python3, a superuser connection to a scratch server.
# Base state = today's production: gh3409_throwaway_schema.sql + the gh3409 forward file (ledger 20261106215945) + the gh3750 forward file (ledger 20261116152010): guard body md5 4649287a (re-rendered under #3766).
# Phases (one database):
#   1-BEFORE    gh3409+gh3750 guard (4649287a): D3/D5/D7d (a changed bid's new fee) are QUARANTINED (negative control), D2 same fee quarantined
#   2-AFTER     gh3490 forward applied: changed bid's new fee RECORDED, same fee still duplicate, mismatched fee still diverted by the fee check
#   3-ROLLBACK  gh3490 rollback: behaves as BEFORE (guard body md5 back to 4649287a)
#   4-REAPPLY   forward again: behaves as AFTER
#   PRE         the forward refuses a live body that is not the gh3750 body (4649287a), incl. the pre-gh3750 body 1142fe98 (nothing committed; #3766 negative control); the rollback refuses an unknown body
#   N1..N5      mutants of the forward file: each must apply cleanly and then FAIL the AFTER expectations
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
BASE="$D/gh3409_fee_acceptances_client_insert_guard.sql"; BASE2="$D/gh3750_fee_acceptance_duplicate_ignores_rescinded.sql"   # #3766: production base is gh3409 THEN gh3750 (guard body 4649287a)
FWD="$D/gh3490_fee_acceptance_duplicate_same_fee.sql"; RBK="$D/gh3490_fee_acceptance_duplicate_same_fee_rollback.sql"; PROOF="$T/gh3490_fee_acceptance_duplicate_same_fee_proof.sql"
rc=0; fail() { echo "EXPECT FAIL: $*"; rc=1; }
node "$T/gh3490_render_texts.mjs" . > "$OUT/texts.psql" || { echo "could not render the form texts"; exit 2; }
tail -1 "$OUT/texts.psql"
newdb() { psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3409_throwaway_schema.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$BASE" >/dev/null 2>&1 || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$BASE2" >/dev/null 2>&1 || exit 2; }
runproof() { # db phase label
  psql -q -At -d "$1" -v phase="$2" -f "$OUT/texts.psql" -f "$PROOF" > "$OUT/$3.txt" 2> "$OUT/$3.err"; echo "== $3"; cat "$OUT/$3.txt"; grep -v 'gh-3409 fee acceptance quarantined' "$OUT/$3.err"
  grep -q '^FAILING=' "$OUT/$3.txt" || echo "FAILING=? (proof did not finish)"; }
failing() { grep -m1 '^FAILING=' "$OUT/$1.txt" | sed 's/FAILING=\([0-9]*\) .*/\1/'; }
apply() { psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$2" >/dev/null; }
md5of() { psql -q -At -d "$1" -c "SELECT left(md5(prosrc),8) FROM pg_proc WHERE oid='public.fee_acceptances_guard_client_insert()'::regprocedure"; }

DB=gh3490_proof
newdb $DB
echo "base guard body md5 prefix: $(md5of $DB) (production 2026-11-18: 4649287a)"
runproof $DB before 1-BEFORE
apply $DB "$FWD" || fail "forward failed"
runproof $DB after 2-AFTER
apply $DB "$RBK" || fail "rollback failed"
apply $DB "$RBK" || fail "rollback not idempotent"
echo "after rollback: guard body md5 prefix $(md5of $DB)"
runproof $DB rollback 3-ROLLBACK
apply $DB "$FWD" || fail "forward after rollback failed"
runproof $DB after 4-REAPPLY
for p in 1-BEFORE 2-AFTER 3-ROLLBACK 4-REAPPLY; do [ "$(failing $p)" = 0 ] || fail "$p has failing rows"; done
# whole-function compare: forward-then-rollback leaves pg_get_functiondef exactly as the base
PD=gh3490_defcmp; newdb $PD; a=$(psql -q -At -d $PD -c "SELECT md5(pg_get_functiondef('public.fee_acceptances_guard_client_insert'::regproc))")
apply $PD "$FWD"; apply $PD "$RBK"; b=$(psql -q -At -d $PD -c "SELECT md5(pg_get_functiondef('public.fee_acceptances_guard_client_insert'::regproc))")
[ "$a" = "$b" ] && echo "ROUNDTRIP pg_get_functiondef identical after forward+rollback (md5 prefix ${a:0:8})" || fail "forward+rollback changed pg_get_functiondef"

# ---- pre-apply check: the forward refuses a body that is not the gh3750 body ----
psql -q -d $PD -c "CREATE OR REPLACE FUNCTION public.fee_acceptances_guard_client_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS \$x\$ BEGIN RETURN NEW; END \$x\$" >/dev/null
if apply $PD "$FWD" 2>"$OUT/pre.err"; then fail "forward ran over an unknown body"; else echo "PRE forward over an unknown body: refused ($(grep -m1 -o 'gh3490: the live guard body[^;]*' "$OUT/pre.err"))"; fi
echo "PRE nothing committed: guard body md5 prefix $(md5of $PD) (the planted body, not daf3fc71)"
if apply $PD "$RBK" 2>"$OUT/pre-rb.err"; then fail "rollback ran over an unknown body"; else echo "PRE rollback over an unknown body: refused"; fi
psql -q -d postgres -c "DROP DATABASE $PD" >/dev/null
# #3766 negative control: put the pre-gh3750 body (1142fe98) back with the gh3750 rollback; the re-rendered forward must refuse it, nothing committed
PX=gh3490_oldbody; newdb $PX; apply $PX "$D/gh3750_fee_acceptance_duplicate_ignores_rescinded_rollback.sql" || fail "gh3750 rollback did not apply on the base"
echo "PRE-2 planted pre-gh3750 body md5 prefix: $(md5of $PX) (expect 1142fe98)"
if apply $PX "$FWD" 2>"$OUT/pre2.err"; then fail "forward ran over the pre-gh3750 (1142fe98) body"; else echo "PRE-2 forward over the 1142fe98 body: refused ($(grep -m1 -o 'gh3490: the live guard body[^;]*' "$OUT/pre2.err"))"; fi
echo "PRE-2 nothing committed: guard body md5 prefix $(md5of $PX)"
psql -q -d postgres -c "DROP DATABASE $PX" >/dev/null

# ---- mutants: each must change the file once, apply cleanly, then FAIL the AFTER expectations ----
mkdir -p "$OUT/mut"
python3 - "$FWD" "$OUT/mut" <<'PY'
import sys, re
src=open(sys.argv[1]).read(); out=sys.argv[2]
BODY="\n  IF EXISTS (SELECT 1 FROM public.fee_acceptances d WHERE d.bid_id = NEW.bid_id AND d.rescinded_at IS NULL "
RULE=BODY+"AND (v_amt IS NULL OR abs(d.fee_amount - v_amt) <= 0.01)) THEN"   # the body line, not the header comment that quotes it
M={
 'N1_compare_browser_fee_column': (RULE, BODY+"AND (v_amt IS NULL OR abs(d.fee_amount - NEW.fee_amount) <= 0.01)) THEN"),
 'N2_no_fee_condition': (RULE, BODY.rstrip()+") THEN"),
 'N3_no_duplicate_rule_at_all': (RULE, "\n  IF false AND EXISTS (SELECT 1 FROM public.fee_acceptances d WHERE d.bid_id = NEW.bid_id AND (v_amt IS NULL OR abs(d.fee_amount - v_amt) <= 0.01)) THEN"),
 'N4_tolerance_zero': (RULE, BODY+"AND (v_amt IS NULL OR abs(d.fee_amount - v_amt) = 0)) THEN"),
 'N5_tolerance_five_cents': (RULE, BODY+"AND (v_amt IS NULL OR abs(d.fee_amount - v_amt) <= 0.05)) THEN"),
 'N6_fee_check_dropped': ("    v_chk := public.fee_acceptance_text_check(NEW.fee_text_displayed, v_pct, v_amt, q.total_price);\n    IF v_chk <> 'ok' THEN", "    v_chk := 'ok';\n    IF v_chk <> 'ok' THEN"),
}
# mutate only the new function body (the file also carries the gh3409 body as the pre-apply md5 literal, and quotes the rule in its header)
head, sep, body = src.partition("AS $guard$")
assert sep
for k,(a,b) in M.items():
    if body.count(a)!=1: print("MUTANT EDIT NOT UNIQUE/PRESENT:",k,body.count(a)); sys.exit(5)
    m=head+sep+body.replace(a,b)
    # the closing md5 guard pins the shipped body; a mutant must still apply, so its post-check is relaxed (the mutation is the point)
    m=m.replace("IF left(md5(live), 8) <> 'daf3fc71' THEN", "IF false THEN")
    open(f"{out}/{k}.sql","w").write(m)
PY
gen=$?; [ $gen = 0 ] || fail "mutant generation failed"
killed=0; total=0
for m in "$OUT"/mut/N*.sql; do
  [ -e "$m" ] || break
  n=$(basename "$m" .sql); total=$((total+1)); MD=gh3490_$(echo "$n" | cut -c1-2 | tr 'N' 'n')
  newdb $MD
  if ! apply $MD "$m" 2>"$OUT/mut/$n.err"; then fail "$n does not apply: $(head -1 "$OUT/mut/$n.err")"; continue; fi
  psql -q -At -d $MD -v phase=after -f "$OUT/texts.psql" -f "$PROOF" > "$OUT/mut/$n.txt" 2>"$OUT/mut/$n.perr"
  # S1 (the body md5) differs for every mutant by construction, so it does not count as a kill; a behaviour row must fail
  f=$(grep '|FAIL$' "$OUT/mut/$n.txt" | grep -vc '|S1 guard body md5 prefix|'); if [ -n "$f" ] && [ "$f" -gt 0 ] 2>/dev/null; then killed=$((killed+1)); echo "MUTANT $n: FAILS the proof ($f behaviour rows failing): $(grep '|FAIL$' "$OUT/mut/$n.txt" | grep -v '|S1 guard' | cut -d'|' -f3 | cut -c1-40 | tr '\n' ';')"; else fail "MUTANT $n SURVIVED"; fi
  psql -q -d postgres -c "DROP DATABASE $MD" >/dev/null
done
echo "MUTANTS killed: $killed of $total"; [ "$killed" = "$total" ] || fail "not every mutant was killed"
echo "RUNNER rc=$rc"; exit $rc
