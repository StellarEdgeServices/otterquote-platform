#!/usr/bin/env bash
# gh-3239: run the Partner Agreement v4 proof on a THROWAWAY Postgres 16. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3239_partner_agreement_v4_proof_run.sh [outdir]
# Phases in one fresh database: 1-BASELINE (production shape: register_partner as filed, no gh3239 objects) -> 2-AFTER (forward applied)
# -> forward re-run (idempotent) -> 3-ROLLBACK (must match BASELINE, register_partner md5 back to the audited body) -> 4-REAPPLIED.
# Negative control (separate database): a drifted register_partner body makes the forward abort and leaves nothing behind.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
RP=supabase/migrations/20260927235229_gh2154_register_partner_rate_limit_fix.sql
DB=gh3239_proof; rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
sed -n '318,622p' "$RP" > "$OUT/register_partner_live.sql"
head -1 "$OUT/register_partner_live.sql" | grep -q '^CREATE OR REPLACE FUNCTION public.register_partner(' || { echo "register_partner block moved in $RP"; exit 2; }
mkdb() {
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3239_throwaway_schema.sql" >/dev/null || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$OUT/register_partner_live.sql" >/dev/null || exit 2
}
mkdb "$DB"
# only the check lines are kept (set_config() echoes are noise with per-run uuids and timestamps)
pass() { psql -q -At -d "$DB" -f "$T/gh3239_partner_agreement_v4_proof.sql" 2> "$OUT/$1.err" | grep -E '[|](PASS|FAIL)$|^FAILING=' > "$OUT/$1.txt"; echo "== $1"; cat "$OUT/$1.txt"; grep -v '^$' "$OUT/$1.err" | grep -v 'NOTICE' || true; }
pass 1-BASELINE
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3239_partner_agreement_v4.sql" >/dev/null || fail "forward failed"
pass 2-AFTER
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3239_partner_agreement_v4.sql" >/dev/null || fail "forward not idempotent"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3239_partner_agreement_v4_rollback.sql" >/dev/null || fail "rollback failed"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3239_partner_agreement_v4_rollback.sql" >/dev/null || fail "rollback not idempotent"
pass 3-ROLLBACK
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3239_partner_agreement_v4.sql" >/dev/null || fail "forward after rollback failed"
pass 4-REAPPLIED
for ph in 1-BASELINE 2-AFTER 3-ROLLBACK 4-REAPPLIED; do
  grep -q '^FAILING=0 of 23$' "$OUT/$ph.txt" || fail "$ph must report FAILING=0 of the full check list"
done
grep -q '|before|' "$OUT/1-BASELINE.txt" && grep -q '|after|' "$OUT/2-AFTER.txt" || fail "phase detection"
diff "$OUT/1-BASELINE.txt" "$OUT/3-ROLLBACK.txt" >/dev/null || fail "ROLLBACK differs from BASELINE"
diff "$OUT/2-AFTER.txt" "$OUT/4-REAPPLIED.txt" >/dev/null || fail "REAPPLIED differs from AFTER"
# negative control: the md5 guard refuses a drifted register_partner and the transaction leaves no gh3239 object
NC=gh3239_proof_nc; mkdb "$NC"
psql -q -d "$NC" -v ON_ERROR_STOP=1 -c "DO \$x\$ BEGIN EXECUTE replace(pg_get_functiondef('public.register_partner(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text,text,text,boolean,text,text,text,text)'::regprocedure), 'rate_limited: %', 'rate-limited: %'); END \$x\$;" >/dev/null || exit 2
if psql -q -d "$NC" -v ON_ERROR_STOP=1 -f "$D/gh3239_partner_agreement_v4.sql" > "$OUT/nc.txt" 2>&1; then
  fail "NEGATIVE CONTROL: forward applied over a drifted register_partner"
else
  grep -q 'register_partner() body drifted' "$OUT/nc.txt" || fail "NEGATIVE CONTROL: forward failed for the wrong reason: $(cat "$OUT/nc.txt")"
  left=$(psql -At -d "$NC" -c "SELECT count(*) FROM pg_proc WHERE proname IN ('accept_partner_agreement_v4','partner_v4_accepted_at','partner_agreement_current_version','referral_agents_guard_agreement_columns')")
  [ "$left" = "0" ] || fail "NEGATIVE CONTROL: forward left $left objects behind"
  echo "== NEGATIVE CONTROL: forward refused a drifted register_partner and left nothing behind (OK)"
fi
psql -q -d postgres -c "DROP DATABASE IF EXISTS $NC" >/dev/null
echo "RUNNER rc=$rc"; exit $rc
