#!/usr/bin/env bash
# gh-3321: run the no-fee-states proof on a THROWAWAY Postgres 16. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3321_no_fee_states_proof_run.sh [outdir]
# Base: the gh3330 throwaway chain (schema + live register_partner + gh3239 forward + gh3245 tables + audited body + gh3245 forward + trigger), a claims.property_state column,
# then the gh3330 forward (PR #3337) to reach the body this file restates (md5 OLD below). Phases: 1-BASELINE -> 2-AFTER (forward) -> re-run forward -> 3-ROLLBACK (twice) -> 4-REAPPLIED.
# MUTANTS (separate databases): five one-line mutants of the forward, each killed by a named check; a forward run against any other body must refuse.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
RP=supabase/migrations/20260927235229_gh2154_register_partner_rate_limit_fix.sql
ARC=supabase/migrations/20261015205902_gh2519_quotes_server_set_fee.sql
FWD=$D/gh3321_no_fee_states.sql; RB=$D/gh3321_no_fee_states_rollback.sql; PRE=$D/gh3321_no_fee_states_pre-flight.md
OLD=50fa6642f7ca542b3b96248a01df8e4d; NEW=aa066bb3c0e378f425939824a7caa955; GH3245=2eba9b9601c731cb20f45ef5a18c742b
DB=gh3321_proof; rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
sed -n '318,622p' "$RP" > "$OUT/register_partner_live.sql"
sed -n '399,658p' "$ARC" > "$OUT/apply_referral_commission_audited.sql"
head -1 "$OUT/register_partner_live.sql" | grep -q '^CREATE OR REPLACE FUNCTION public.register_partner(' || { echo "register_partner block moved in $RP"; exit 2; }
head -1 "$OUT/apply_referral_commission_audited.sql" | grep -q '^CREATE OR REPLACE FUNCTION public.apply_referral_commission()' || { echo "apply_referral_commission block moved in $ARC"; exit 2; }
mkdb() {  # $1 db name, $2 = "gh3330" (the gh3330 body applied: what production runs after #3337) or "gh3245" (the older body, for the negative control)
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1 || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3239_throwaway_schema.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$OUT/register_partner_live.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$D/gh3239_partner_agreement_v4.sql" >/dev/null 2>&1 || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3245_throwaway_schema.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -c "ALTER TABLE public.claims ADD COLUMN property_state text" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$OUT/apply_referral_commission_audited.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$D/gh3245_customer_fee_v4_gate.sql" >/dev/null 2>&1 || exit 2
  if [ "$2" = gh3330 ]; then psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$D/gh3330_recruiter_v4_gate.sql" >/dev/null 2>&1 || exit 2; fi
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3245_throwaway_trigger.sql" >/dev/null || exit 2
}
# pre-flight queries A, B, C, W2: the fenced sql block under each heading, run verbatim as CREATE TEMP TABLE <t> AS <q>
python3 - "$PRE" "$OUT" <<'PY' || { echo "pre-flight query blocks not found"; exit 2; }
import re,sys
t0=open(sys.argv[1]).read()
for head,fn,tbl in (("## Query A","a_rows","a_rows"),("## Query B","b_rows","b_rows"),("## Query C","c_rows","c_rows"),("## Query W2","w_rows","w_rows")):
    t=t0[t0.index(head):]; q=re.search(r"```sql\n(.*?)```",t,re.S).group(1).strip().rstrip(";")
    open(sys.argv[2]+"/"+fn+".sql","w").write("CREATE TEMP TABLE "+tbl+" AS "+q+";\n")
PY
VARS=(-v wfile="$OUT/w_rows.sql" -v afile="$OUT/a_rows.sql" -v bfile="$OUT/b_rows.sql" -v cfile="$OUT/c_rows.sql")
pass() { psql -q -At "${VARS[@]}" -d "$2" -f "$T/gh3321_no_fee_states_proof.sql" 2> "$OUT/$1.err" | grep -E '[|](PASS|FAIL)$|^FAILING=' > "$OUT/$1.txt"; echo "== $1"; cat "$OUT/$1.txt"; grep -v '^$' "$OUT/$1.err" | grep -v 'NOTICE' || true; }
# exclusion RAISE LOG assertion: re-run the proof transaction with client_min_messages=log and count the gh-3321 lines.
# $1 db, $2 label, $3 expected count (OK, AR, KS, NE, MS, padded ok, inspector-in-OK, withheld-inspector-in-OK = 8), $4 "named" = the line for state OK must be among them
logcheck() {
  PGOPTIONS='-c client_min_messages=log' psql -q -At "${VARS[@]}" -d "$1" -f "$T/gh3321_no_fee_states_proof.sql" >/dev/null 2> "$OUT/log-$2.err"
  local n; n=$(grep -c 'apply_referral_commission: gh-3321 property_state .* is a no-partner-fee state' "$OUT/log-$2.err")
  [ "$n" = "$3" ] || { fail "LOG $2: expected $3 exclusion log lines, got $n"; return 1; }
  if [ "$4" = named ]; then grep -q 'gh-3321 property_state OK is a no-partner-fee state' "$OUT/log-$2.err" || { fail "LOG $2: no exclusion line for state OK"; return 1; }; fi
  return 0
}
mkdb "$DB" gh3330
md=$(psql -At -d "$DB" -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure")
[ "$md" = "$OLD" ] || fail "throwaway base body md5 $md is not the gh3330 body $OLD"
pass 1-BASELINE "$DB"
logcheck "$DB" baseline 0 none && echo "== LOG BASELINE: no exclusion lines (OK)"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>&1 || fail "forward failed"
pass 2-AFTER "$DB"
logcheck "$DB" after 8 named && echo "== LOG AFTER: 8 exclusion lines, state OK named (OK)"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>&1 || fail "forward not idempotent"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB" > "$OUT/rollback.txt" 2>&1 || fail "rollback failed"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB" >/dev/null 2>&1 || fail "rollback not idempotent"
pass 3-ROLLBACK "$DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>&1 || fail "forward after rollback failed"
pass 4-REAPPLIED "$DB"
for ph in 1-BASELINE 2-AFTER 3-ROLLBACK 4-REAPPLIED; do grep -q '^FAILING=0 of 20$' "$OUT/$ph.txt" || fail "$ph must report FAILING=0 of 20"; done
grep -q '|before|' "$OUT/1-BASELINE.txt" && grep -q '|after|' "$OUT/2-AFTER.txt" || fail "phase detection"
diff "$OUT/1-BASELINE.txt" "$OUT/3-ROLLBACK.txt" >/dev/null || fail "ROLLBACK differs from BASELINE"
diff "$OUT/2-AFTER.txt" "$OUT/4-REAPPLIED.txt" >/dev/null || fail "REAPPLIED differs from AFTER"
# the proof must discriminate: the same checks must differ between BASELINE and AFTER (else it proves nothing)
[ "$(diff "$OUT/1-BASELINE.txt" "$OUT/2-AFTER.txt" | grep -c '^>')" -ge 8 ] || fail "BASELINE and AFTER barely differ: the proof does not discriminate"
# MUTANTS: each is the forward with one change; each must be killed by the named check
run_mutant() {  # $1 name, $2 sed expression, $3 the check that must FAIL (line prefix)
  local M="$OUT/mutant_$1.sql" MDB="gh3321_mut_$1"
  sed "$2" "$FWD" > "$M"
  cmp -s "$M" "$FWD" && { fail "MUTANT $1: sed changed nothing"; return; }
  # the mutant changes the body, so its md5 differs from NEW: drop only the forward's own post-check for the mutant run
  sed -i "/body check failed after CREATE OR REPLACE/d" "$M"
  mkdb "$MDB" gh3330
  psql -q -d "$MDB" -v ON_ERROR_STOP=0 -f "$M" >/dev/null 2>&1
  pass "M-$1" "$MDB" >/dev/null
  if grep -q "^$3.*|FAIL\$" "$OUT/M-$1.txt"; then echo "== MUTANT $1 killed by check ${3%% *} (OK)"; else fail "MUTANT $1 survived check ${3%% *}"; cat "$OUT/M-$1.txt"; fi
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $MDB" >/dev/null 2>&1
}
run_mutant fee_branch   's/AND NOT v_v4_gated AND NOT v_state_excluded THEN   -- gh-3321: and not a no-fee state/AND NOT v_v4_gated THEN   -- gh-3321: and not a no-fee state/' 'A Oklahoma'
run_mutant bonus_branch 's/^     AND NOT v_state_excluded THEN  /     AND true THEN  /' 'A Oklahoma'
run_mutant blank_closed "s/v_state_excluded := COALESCE(upper(btrim(NEW.property_state)) IN/v_state_excluded := COALESCE(btrim(COALESCE(NEW.property_state, '')) = '' OR upper(btrim(NEW.property_state)) IN/" 'I blank state'
run_mutant null_closed  "s/v_state_excluded := COALESCE(upper(btrim(NEW.property_state)) IN (\(.*\)), false);/v_state_excluded := upper(btrim(NEW.property_state)) IN (\1);/" 'J NULL state'
run_mutant missing_ms   "s/'NE', 'MS'), false);/'NE'), false);/" 'E Mississippi'
# MUTANT no_log: the RAISE LOG deleted. Every money check still passes; only the log assertion can kill it.
{ M="$OUT/mutant_no_log.sql"; sed '/RAISE LOG .apply_referral_commission: gh-3321 property_state/,/NEW.property_state, v_referral.id, NEW.id;/c\      NULL;' "$FWD" | sed "/body check failed after CREATE OR REPLACE/d" > "$M"
  cmp -s "$M" "$FWD" && fail "MUTANT no_log: sed changed nothing"
  mkdb gh3321_mut_no_log gh3330; prev_rc=$rc; psql -q -d gh3321_mut_no_log -v ON_ERROR_STOP=0 -f "$M" >/dev/null 2>&1
  if logcheck gh3321_mut_no_log nolog 8 named >/dev/null; then fail "MUTANT no_log survived the log assertion"; else rc=$prev_rc; echo "== MUTANT no_log killed by the exclusion log assertion (OK)"; fi
  psql -q -d postgres -c "DROP DATABASE IF EXISTS gh3321_mut_no_log" >/dev/null 2>&1; }
# NEGATIVE CONTROL: against the older (gh3245) body the forward refuses and leaves the body untouched
NDB=gh3321_proof_old; mkdb "$NDB" gh3245
if psql -q -d "$NDB" -v ON_ERROR_STOP=1 -f "$FWD" > "$OUT/oldbody.txt" 2>&1; then fail "forward applied over a body that is not the gh3330 body";
else grep -q 'body drifted' "$OUT/oldbody.txt" || fail "forward over the old body failed for the wrong reason: $(cat "$OUT/oldbody.txt")"
  md=$(psql -At -d "$NDB" -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure")
  [ "$md" = "$GH3245" ] && echo "== NEGATIVE CONTROL: forward refused over the gh3245 body, body untouched (OK)" || fail "forward over the old body changed it"; fi
psql -q -d postgres -c "DROP DATABASE IF EXISTS $NDB" >/dev/null 2>&1
echo "RUNNER rc=$rc"; exit $rc
