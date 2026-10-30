#!/usr/bin/env bash
# gh-3245: run the customer-fee v4 gate proof on a THROWAWAY Postgres 16. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3245_customer_fee_v4_gate_proof_run.sh [outdir]
# Base: the gh3239 throwaway chain (schema + live register_partner + gh3239 forward, which provides partner_v4_accepted_at()),
# then the gh3245 tables, the live apply_referral_commission() extracted from its filed migration, and production's trigger.
# Phases: 1-BASELINE -> 2-AFTER (forward) -> re-run forward -> 3-ROLLBACK (twice) -> 4-REAPPLIED.
# MUTANTS (separate databases): four one-line mutants of the forward, each killed by a named check; and a forward run without
# gh3239 applied must refuse.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
RP=supabase/migrations/20260927235229_gh2154_register_partner_rate_limit_fix.sql
ARC=supabase/migrations/20261015205902_gh2519_quotes_server_set_fee.sql
FWD=$D/gh3245_customer_fee_v4_gate.sql; RB=$D/gh3245_customer_fee_v4_gate_rollback.sql
DB=gh3245_proof; rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
sed -n '318,622p' "$RP" > "$OUT/register_partner_live.sql"
sed -n '399,658p' "$ARC" > "$OUT/apply_referral_commission_live.sql"
head -1 "$OUT/register_partner_live.sql" | grep -q '^CREATE OR REPLACE FUNCTION public.register_partner(' || { echo "register_partner block moved in $RP"; exit 2; }
head -1 "$OUT/apply_referral_commission_live.sql" | grep -q '^CREATE OR REPLACE FUNCTION public.apply_referral_commission()' || { echo "apply_referral_commission block moved in $ARC"; exit 2; }
mkdb() {  # $1 db name, $2 = "with3239" or "no3239"
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1 || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3239_throwaway_schema.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$OUT/register_partner_live.sql" >/dev/null || exit 2
  if [ "$2" = with3239 ]; then psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$D/gh3239_partner_agreement_v4.sql" >/dev/null 2>&1 || exit 2; fi
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3245_throwaway_schema.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$OUT/apply_referral_commission_live.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3245_throwaway_trigger.sql" >/dev/null || exit 2
}
pass() { psql -q -At -d "$2" -f "$T/gh3245_customer_fee_v4_gate_proof.sql" 2> "$OUT/$1.err" | grep -E '[|](PASS|FAIL)$|^FAILING=' > "$OUT/$1.txt"; echo "== $1"; cat "$OUT/$1.txt"; grep -v '^$' "$OUT/$1.err" | grep -v 'NOTICE' || true; }
mkdb "$DB" with3239
pass 1-BASELINE "$DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>&1 || fail "forward failed"
pass 2-AFTER "$DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>&1 || fail "forward not idempotent"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB" > "$OUT/rollback.txt" 2>&1 || fail "rollback failed"
grep -q 'NOTICE:  gh3245 rollback: deleting platform_settings.partner_agreement_v4_published_at = "20' "$OUT/rollback.txt" || fail "rollback did not print the cutoff value before deleting it: $(cat "$OUT/rollback.txt")"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB" >/dev/null 2>&1 || fail "rollback not idempotent"
left=$(psql -At -d "$DB" -c "SELECT count(*) FROM public.platform_settings WHERE key = 'partner_agreement_v4_published_at'")
[ "$left" = "0" ] || fail "rollback left the cutoff setting behind"
pass 3-ROLLBACK "$DB"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>&1 || fail "forward after rollback failed"
seeded=$(psql -At -d "$DB" -c "SELECT (value #>> '{}')::timestamptz > now() - interval '1 hour' FROM public.platform_settings WHERE key = 'partner_agreement_v4_published_at'")
[ "$seeded" = "t" ] || fail "forward did not seed partner_agreement_v4_published_at with the apply time"
pass 4-REAPPLIED "$DB"
for ph in 1-BASELINE 2-AFTER 3-ROLLBACK 4-REAPPLIED; do grep -q '^FAILING=0 of 15$' "$OUT/$ph.txt" || fail "$ph must report FAILING=0 of 15"; done
grep -q '|before|' "$OUT/1-BASELINE.txt" && grep -q '|after|' "$OUT/2-AFTER.txt" || fail "phase detection"
diff "$OUT/1-BASELINE.txt" "$OUT/3-ROLLBACK.txt" >/dev/null || fail "ROLLBACK differs from BASELINE"
diff "$OUT/2-AFTER.txt" "$OUT/4-REAPPLIED.txt" >/dev/null || fail "REAPPLIED differs from AFTER"
# MUTANTS: each is the forward with one change; each must be killed by the named check (and only applies on a fresh database)
run_mutant() {  # $1 name, $2 sed expression, $3 the check that must FAIL (line prefix)
  local M="$OUT/mutant_$1.sql" MDB="gh3245_mut_$1"
  sed "$2" "$FWD" > "$M"
  cmp -s "$M" "$FWD" && { fail "MUTANT $1: sed changed nothing"; return; }
  mkdb "$MDB" with3239
  psql -q -d "$MDB" -v ON_ERROR_STOP=1 -f "$M" >/dev/null 2>&1 || { fail "MUTANT $1: forward did not apply"; return; }
  pass "M-$1" "$MDB" >/dev/null
  if grep -q "^$3.*|FAIL\$" "$OUT/M-$1.txt"; then echo "== MUTANT $1 killed by check ${3%% *} (OK)"; else fail "MUTANT $1 survived check ${3%% *}"; cat "$OUT/M-$1.txt"; fi
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $MDB" >/dev/null 2>&1
}
run_mutant click_time  's/IF v_v4_at IS NULL OR v_v4_at > NEW.created_at THEN/IF v_v4_at IS NULL OR v_v4_at > v_referral.created_at THEN/' 'D accepted'
run_mutant no_timing   's/IF v_v4_at IS NULL OR v_v4_at > NEW.created_at THEN/IF v_v4_at IS NULL THEN/' 'D2 accepted'
run_mutant strict_cut  's/ELSIF v_referral.created_at >= v_v4_cutoff THEN/ELSIF v_referral.created_at > v_v4_cutoff THEN/' 'K click'
run_mutant email_open  "s/IF v_referrer.agent_type IS DISTINCT FROM 'home_inspector' AND NOT v_v4_gated THEN   -- gh-3245: no fee, no fee email/IF v_referrer.agent_type IS DISTINCT FROM 'home_inspector' THEN/" 'B3 fee email'
# MUTANT 2: forward without gh3239 applied refuses and leaves the body and settings untouched
NDB=gh3245_proof_no3239; mkdb "$NDB" no3239
if psql -q -d "$NDB" -v ON_ERROR_STOP=1 -f "$FWD" > "$OUT/no3239.txt" 2>&1; then fail "forward applied without partner_v4_accepted_at()";
else grep -q 'apply gh3239_partner_agreement_v4 first' "$OUT/no3239.txt" || fail "forward without gh3239 failed for the wrong reason: $(cat "$OUT/no3239.txt")"
  md=$(psql -At -d "$NDB" -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure")
  [ "$md" = "7f7d0419c59b9853d4082a713258ddd6" ] && echo "== NEGATIVE CONTROL: forward refused without gh3239, body untouched (OK)" || fail "forward without gh3239 changed the body"; fi
for x in "$NDB"; do psql -q -d postgres -c "DROP DATABASE IF EXISTS $x" >/dev/null 2>&1; done
echo "RUNNER rc=$rc"; exit $rc
