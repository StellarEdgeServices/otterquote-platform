#!/usr/bin/env bash
# gh-3330: run the recruiter-v4 gate proof on a THROWAWAY Postgres 16. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3330_recruiter_v4_gate_proof_run.sh [outdir]
# Base: the gh3239 throwaway chain (schema + live register_partner + gh3239 forward, which provides partner_v4_accepted_at()), the gh3245
# tables, the audited apply_referral_commission() from its filed migration, then the gh3245 forward (draft) to reach the PRODUCTION body
# (md5 OLD below, read from the live function 2026-11-02), and production's trigger.
# Phases: 1-BASELINE -> 2-AFTER (forward) -> re-run forward -> 3-ROLLBACK (twice) -> 4-REAPPLIED.
# MUTANTS (separate databases): three one-line mutants of the forward, each killed by a named check; and a forward run against a body
# that is not the production body must refuse.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; AM=supabase/migrations_applied_manually; T=supabase/tests
RP=supabase/migrations/20260927235229_gh2154_register_partner_rate_limit_fix.sql
ARC=supabase/migrations/20261015205902_gh2519_quotes_server_set_fee.sql
FWD=$D/gh3330_recruiter_v4_gate.sql; RB=$D/gh3330_recruiter_v4_gate_rollback.sql
OLD=2eba9b9601c731cb20f45ef5a18c742b; NEW=50fa6642f7ca542b3b96248a01df8e4d
DB=gh3330_proof; rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
sed -n '318,622p' "$RP" > "$OUT/register_partner_live.sql"
sed -n '399,658p' "$ARC" > "$OUT/apply_referral_commission_audited.sql"
head -1 "$OUT/register_partner_live.sql" | grep -q '^CREATE OR REPLACE FUNCTION public.register_partner(' || { echo "register_partner block moved in $RP"; exit 2; }
head -1 "$OUT/apply_referral_commission_audited.sql" | grep -q '^CREATE OR REPLACE FUNCTION public.apply_referral_commission()' || { echo "apply_referral_commission block moved in $ARC"; exit 2; }
mkdb() {  # $1 db name, $2 = "live" (gh3245 applied: the production body) or "audited" (the older body, no gh3245)
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1 || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3239_throwaway_schema.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$OUT/register_partner_live.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$AM/20261030165458_gh3239_partner_agreement_v4.sql" >/dev/null 2>&1 || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3245_throwaway_schema.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$OUT/apply_referral_commission_audited.sql" >/dev/null || exit 2
  if [ "$2" = live ]; then psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$AM/20261030165750_gh3245_customer_fee_v4_gate.sql" >/dev/null 2>&1 || exit 2; fi
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3245_throwaway_trigger.sql" >/dev/null || exit 2
}
# query W: the fenced sql block under "## Query W" in the pre-flight, run verbatim as CREATE TEMP TABLE w_rows AS <W>
python3 - "$D/gh3330_recruiter_v4_gate_pre-flight.md" "$OUT/w_rows.sql" <<'PY' || { echo "query W block not found in the pre-flight"; exit 2; }
import re,sys
t=open(sys.argv[1]).read(); t=t[t.index("## Query W"):]
m=re.search(r"```sql\n(.*?)```",t,re.S); q=m.group(1).strip().rstrip(";")
open(sys.argv[2],"w").write("CREATE TEMP TABLE w_rows AS "+q+";\n")
PY
# count E: the fenced sql block under "## Pre-apply count E", run verbatim as CREATE TEMP TABLE e_rows AS <E>
python3 - "$D/gh3330_recruiter_v4_gate_pre-flight.md" "$OUT/e_rows.sql" <<'PY' || { echo "count E block not found in the pre-flight"; exit 2; }
import re,sys
t=open(sys.argv[1]).read(); t=t[t.index("## Pre-apply count E"):]
m=re.search(r"```sql\n(.*?)```",t,re.S); q=m.group(1).strip().rstrip(";")
open(sys.argv[2],"w").write("CREATE TEMP TABLE e_rows AS "+q+";\n")
PY
pass() { psql -q -At -v wfile="$OUT/w_rows.sql" -v efile="$OUT/e_rows.sql" -d "$2" -f "$T/gh3330_recruiter_v4_gate_proof.sql" 2> "$OUT/$1.err" | grep -E '[|](PASS|FAIL)$|^FAILING=' > "$OUT/$1.txt"; echo "== $1"; cat "$OUT/$1.txt"; grep -v '^$' "$OUT/$1.err" | grep -v 'NOTICE' || true; }
# withhold RAISE LOG assertion: re-run the proof transaction with client_min_messages=log and count the gh-3330 WITHHELD lines.
# $1 db, $2 label, $3 expected count (the five withheld cases: n, c, l1, p, bi), $4 "named" = recruiter a3's line must be among them
logcheck() {
  PGOPTIONS='-c client_min_messages=log' psql -q -At -v wfile="$OUT/w_rows.sql" -v efile="$OUT/e_rows.sql" -d "$1" -f "$T/gh3330_recruiter_v4_gate_proof.sql" >/dev/null 2> "$OUT/log-$2.err"
  local n; n=$(grep -c 'apply_referral_commission: gh-3330 recruiter .* WITHHELD' "$OUT/log-$2.err")
  [ "$n" = "$3" ] || { fail "LOG $2: expected $3 withhold log lines, got $n"; return 1; }
  if [ "$4" = named ]; then grep -q 'gh-3330 recruiter dddddddd-0000-0000-0000-0000000000a3 has not accepted Partner Agreement v4' "$OUT/log-$2.err" || { fail "LOG $2: no withhold line for recruiter a3"; return 1; }; fi
  return 0
}
mkdb "$DB" live
md=$(psql -At -d "$DB" -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure")
[ "$md" = "$OLD" ] || fail "throwaway base body md5 $md is not the production body $OLD"
pass 1-BASELINE "$DB"
logcheck "$DB" baseline 0 none && echo "== LOG BASELINE: no withhold lines (OK)"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>&1 || fail "forward failed"
pass 2-AFTER "$DB"
logcheck "$DB" after 5 named && echo "== LOG AFTER: 5 withhold lines, recruiter a3 named (OK)"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>&1 || fail "forward not idempotent"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB" > "$OUT/rollback.txt" 2>&1 || fail "rollback failed"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB" >/dev/null 2>&1 || fail "rollback not idempotent"
pass 3-ROLLBACK "$DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>&1 || fail "forward after rollback failed"
pass 4-REAPPLIED "$DB"
for ph in 1-BASELINE 2-AFTER 3-ROLLBACK 4-REAPPLIED; do grep -q '^FAILING=0 of 17$' "$OUT/$ph.txt" || fail "$ph must report FAILING=0 of 17"; done
grep -q '|before|' "$OUT/1-BASELINE.txt" && grep -q '|after|' "$OUT/2-AFTER.txt" || fail "phase detection"
diff "$OUT/1-BASELINE.txt" "$OUT/3-ROLLBACK.txt" >/dev/null || fail "ROLLBACK differs from BASELINE"
diff "$OUT/2-AFTER.txt" "$OUT/4-REAPPLIED.txt" >/dev/null || fail "REAPPLIED differs from AFTER"
# the proof must discriminate: the same checks must differ between BASELINE and AFTER (else it proves nothing)
[ "$(diff "$OUT/1-BASELINE.txt" "$OUT/2-AFTER.txt" | grep -c '^>')" -ge 5 ] || fail "BASELINE and AFTER barely differ: the proof does not discriminate"
# MUTANTS: each is the forward with one change; each must be killed by the named check
run_mutant() {  # $1 name, $2 sed expression, $3 the check that must FAIL (line prefix)
  local M="$OUT/mutant_$1.sql" MDB="gh3330_mut_$1"
  sed "$2" "$FWD" > "$M"
  cmp -s "$M" "$FWD" && { fail "MUTANT $1: sed changed nothing"; return; }
  # the mutant changes the body, so its md5 differs from NEW: relax only the forward's own post-check for the mutant run
  sed -i "/body check failed after CREATE OR REPLACE/d" "$M"
  mkdb "$MDB" live
  psql -q -d "$MDB" -v ON_ERROR_STOP=0 -f "$M" >/dev/null 2>&1
  pass "M-$1" "$MDB" >/dev/null
  if grep -q "^$3.*|FAIL\$" "$OUT/M-$1.txt"; then echo "== MUTANT $1 killed by check ${3%% *} (OK)"; else fail "MUTANT $1 survived check ${3%% *}"; cat "$OUT/M-$1.txt"; fi
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $MDB" >/dev/null 2>&1
}
# MUTANT no_log: the RAISE LOG deleted. The proof checks still pass (the money is the same); only the log assertion can kill it.
{ M="$OUT/mutant_no_log.sql"; sed '/gh-3330 recruiter % has not accepted/,/v_recruiter.id, v_referral.id, v_referrer.id;/c\      NULL;' "$FWD" | sed "/body check failed after CREATE OR REPLACE/d" > "$M"
  cmp -s "$M" "$FWD" && fail "MUTANT no_log: sed changed nothing"
  mkdb gh3330_mut_no_log live; prev_rc=$rc; psql -q -d gh3330_mut_no_log -v ON_ERROR_STOP=0 -f "$M" >/dev/null 2>&1
  if logcheck gh3330_mut_no_log nolog 5 named >/dev/null; then fail "MUTANT no_log survived the log assertion"; else rc=$prev_rc; echo "== MUTANT no_log killed by the withhold log assertion (OK)"; fi
  psql -q -d postgres -c "DROP DATABASE IF EXISTS gh3330_mut_no_log" >/dev/null 2>&1; }
run_mutant no_gate     's/AND public.partner_v4_accepted_at(v_recruiter.id) IS NULL THEN/AND false THEN/' 'C recruiter never accepted'
run_mutant inverted    's/AND public.partner_v4_accepted_at(v_recruiter.id) IS NULL THEN/AND public.partner_v4_accepted_at(v_recruiter.id) IS NOT NULL THEN/' 'A recruiter holds v4'
run_mutant referrer_v4 's/AND public.partner_v4_accepted_at(v_recruiter.id) IS NULL THEN/AND public.partner_v4_accepted_at(v_referrer.id) IS NULL THEN/' 'A recruiter holds v4'
# NEGATIVE CONTROL: against the older (pre-gh3245) body the forward refuses and leaves the body untouched
NDB=gh3330_proof_old; mkdb "$NDB" audited
if psql -q -d "$NDB" -v ON_ERROR_STOP=1 -f "$FWD" > "$OUT/oldbody.txt" 2>&1; then fail "forward applied over a body that is not the production body";
else grep -q 'body drifted' "$OUT/oldbody.txt" || fail "forward over the old body failed for the wrong reason: $(cat "$OUT/oldbody.txt")"
  md=$(psql -At -d "$NDB" -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure")
  [ "$md" = "7f7d0419c59b9853d4082a713258ddd6" ] && echo "== NEGATIVE CONTROL: forward refused over the older body, body untouched (OK)" || fail "forward over the old body changed it"; fi
psql -q -d postgres -c "DROP DATABASE IF EXISTS $NDB" >/dev/null 2>&1
echo "RUNNER rc=$rc"; exit $rc
