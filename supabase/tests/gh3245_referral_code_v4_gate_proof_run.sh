#!/usr/bin/env bash
# gh-3245 referral-code gate: run the proof on a THROWAWAY Postgres 16. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3245_referral_code_v4_gate_proof_run.sh [outdir]
# Base: the gh3239 throwaway chain (schema + live register_partner + gh3239 forward, which provides partner_v4_accepted_at() and
# accept_partner_agreement_v4()), a profiles stub, and the live get_or_create_customer_referral_code() extracted from the baseline migration.
# Phases: 1-BASELINE -> 2-AFTER (forward) -> re-run forward -> 3-ROLLBACK (twice) -> 4-REAPPLIED.
# MUTANTS (separate databases): three one-line mutants of the forward, each killed by a named check; and a forward run without gh3239 must refuse.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
RP=supabase/migrations/20260927235229_gh2154_register_partner_rate_limit_fix.sql
BASE=supabase/migrations/20260101000000_v000_baseline_schema.sql
FWD=$D/gh3245_referral_code_v4_gate.sql; RB=$D/gh3245_referral_code_v4_gate_rollback.sql
DB=gh3245rc_proof; rc=0
LIVE_MD5=654640a4f472d8fce2e46f6a539eba8e
fail() { echo "EXPECT FAIL: $*"; rc=1; }
sed -n '318,622p' "$RP" > "$OUT/register_partner_live.sql"
sed -n '1971,2071p' "$BASE" > "$OUT/get_or_create_live.sql"
head -1 "$OUT/register_partner_live.sql" | grep -q '^CREATE OR REPLACE FUNCTION public.register_partner(' || { echo "register_partner block moved in $RP"; exit 2; }
head -1 "$OUT/get_or_create_live.sql" | grep -q '^CREATE OR REPLACE FUNCTION public.get_or_create_customer_referral_code()' || { echo "get_or_create block moved in $BASE"; exit 2; }
mkdb() {  # $1 db name, $2 = "with3239" or "no3239"
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1 || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3239_throwaway_schema.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$OUT/register_partner_live.sql" >/dev/null || exit 2
  if [ "$2" = with3239 ]; then psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$D/gh3239_partner_agreement_v4.sql" >/dev/null 2>&1 || exit 2; fi
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$OUT/get_or_create_live.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3245_referral_code_throwaway_schema.sql" >/dev/null || exit 2
}
md5of() { psql -At -d "$1" -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_or_create_customer_referral_code()'::regprocedure"; }
pass() { psql -q -At -d "$2" -f "$T/gh3245_referral_code_v4_gate_proof.sql" 2> "$OUT/$1.err" | grep -E '[|](PASS|FAIL)$|^FAILING=' > "$OUT/$1.txt"; echo "== $1"; cat "$OUT/$1.txt"; grep -v '^$' "$OUT/$1.err" | grep -v 'NOTICE' || true; }
mkdb "$DB" with3239
[ "$(md5of "$DB")" = "$LIVE_MD5" ] || fail "baseline body md5 is not the live md5 $LIVE_MD5"
pass 1-BASELINE "$DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>&1 || fail "forward failed"
NEW_MD5=$(md5of "$DB")
grep -q "$NEW_MD5" "$FWD" && grep -q "$NEW_MD5" "$RB" || fail "forward body md5 $NEW_MD5 is not the one named in the forward guard and the rollback guard"
pass 2-AFTER "$DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>&1 || fail "forward not idempotent"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB" >/dev/null 2>&1 || fail "rollback failed"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB" >/dev/null 2>&1 || fail "rollback not idempotent"
[ "$(md5of "$DB")" = "$LIVE_MD5" ] || fail "rollback did not restore the live body md5"
pass 3-ROLLBACK "$DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>&1 || fail "forward after rollback failed"
pass 4-REAPPLIED "$DB"
for ph in 1-BASELINE 2-AFTER 3-ROLLBACK 4-REAPPLIED; do grep -q '^FAILING=0 of 9$' "$OUT/$ph.txt" || fail "$ph must report FAILING=0 of 9"; done
grep -q '|before|' "$OUT/1-BASELINE.txt" && grep -q '|after|' "$OUT/2-AFTER.txt" || fail "phase detection"
diff "$OUT/1-BASELINE.txt" "$OUT/3-ROLLBACK.txt" >/dev/null || fail "ROLLBACK differs from BASELINE"
diff "$OUT/2-AFTER.txt" "$OUT/4-REAPPLIED.txt" >/dev/null || fail "REAPPLIED differs from AFTER"
# the catalog row (security, config, owner) must be unchanged by the forward: compare BASELINE-state vs AFTER-state attributes
ATTR="SELECT prosecdef, proconfig, proowner::regrole, pronargs, prorettype::regtype, proacl FROM pg_proc WHERE oid = 'public.get_or_create_customer_referral_code()'::regprocedure"
psql -At -d "$DB" -c "$ATTR" > "$OUT/attr_after.txt"
# MUTANTS: each is the forward with one change; each must be killed by the named check
run_mutant() {  # $1 name, $2 python replace spec "old=>new=>count(1|2)", $3 the check that must FAIL (line prefix)
  local M="$OUT/mutant_$1.sql" MDB="gh3245rc_mut_$1"
  python3 - "$FWD" "$M" "$2" <<'PY'
import sys
src=open(sys.argv[1]).read(); old,new,which=sys.argv[3].split("=>")
parts=src.split(old)
if len(parts)<3: sys.exit("expected two occurrences")
if which=="1": out=parts[0]+new+old.join(parts[1:])
elif which=="2": out=old.join(parts[:-1])+new+parts[-1]
else: out=new.join(parts)
open(sys.argv[2],"w").write(out)
PY
  cmp -s "$M" "$FWD" && { fail "MUTANT $1: change did nothing"; return; }
  mkdb "$MDB" with3239
  # a mutant body has a different md5 from the forward's; the forward guard only checks the pre-state, so it applies
  psql -q -d "$MDB" -v ON_ERROR_STOP=1 -f "$M" >/dev/null 2>&1 || { fail "MUTANT $1: forward did not apply"; return; }
  pass "M-$1" "$MDB" >/dev/null
  if grep -q "^$3.*|FAIL\$" "$OUT/M-$1.txt"; then echo "== MUTANT $1 killed by check ${3%% *} (OK)"; else fail "MUTANT $1 survived check ${3%% *}"; cat "$OUT/M-$1.txt"; fi
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $MDB" >/dev/null 2>&1
}
run_mutant existing_row_open  "IF public.partner_v4_accepted_at(v_row.id) IS NULL THEN=>IF false THEN=>1" 'B existing'
run_mutant create_path_open   "IF public.partner_v4_accepted_at(v_row.id) IS NULL THEN=>IF false THEN=>2" 'A brand-new'
run_mutant any_version        "IF public.partner_v4_accepted_at(v_row.id) IS NULL THEN=>IF v_row.partner_agreement_version IS NULL THEN=>0" 'D customer who accepted only v3'
# NEGATIVE CONTROL: the forward without gh3239 applied refuses and leaves the body untouched
NDB=gh3245rc_proof_no3239; mkdb "$NDB" no3239
if psql -q -d "$NDB" -v ON_ERROR_STOP=1 -f "$FWD" > "$OUT/no3239.txt" 2>&1; then fail "forward applied without partner_v4_accepted_at()";
else grep -q 'apply gh3239_partner_agreement_v4 first' "$OUT/no3239.txt" || fail "forward without gh3239 failed for the wrong reason: $(cat "$OUT/no3239.txt")"
  [ "$(md5of "$NDB")" = "$LIVE_MD5" ] && echo "== NEGATIVE CONTROL: forward refused without gh3239, body untouched (OK)" || fail "forward without gh3239 changed the body"; fi
for x in "$NDB" "$DB"; do psql -q -d postgres -c "DROP DATABASE IF EXISTS $x" >/dev/null 2>&1; done
echo "RUNNER rc=$rc"; exit $rc
