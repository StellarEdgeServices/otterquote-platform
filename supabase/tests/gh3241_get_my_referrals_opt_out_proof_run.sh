#!/usr/bin/env bash
# gh-3241: run the get_my_referrals() opt-out proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3241_get_my_referrals_opt_out_proof_run.sh [--mutations] [outdir]
# The connecting role must be a superuser (the scratch setup creates roles). Verified on PostgreSQL 16.15.
# Each fresh database = scratch setup + the LIVE function (gh3217a_get_my_referrals.sql, byte-identical to production).
# Phases: 0-BEFORE (live function: the proof must FAIL, the negative control) -> 1-AFTER (forward: PROOF-OK)
#   -> 2-RERUN (forward again: PROOF-OK) -> 3-ROLLBACK (catalog identical to the pre-forward snapshot, prosrc md5 equals
#   production's e63684bf6ce7d5b2da454ee00b31a9e9, proof FAILs again) -> 4-REAPPLIED (PROOF-OK).
# --mutations: each mutant is the forward file with one deliberate defect, applied to its own fresh database; every mutant
# must apply cleanly and then FAIL the proof. A surviving mutant fails the run.
set -uo pipefail
cd "$(dirname "$0")/../.."
MUT=0
if [ "${1:-}" = "--mutations" ]; then MUT=1; shift; fi
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
LIVE="$D/gh3217a_get_my_referrals.sql"
FWD="$D/gh3241_get_my_referrals_opt_out.sql"; RBK="$D/gh3241_get_my_referrals_opt_out_rollback.sql"
SETUP="$T/gh3241_get_my_referrals_opt_out_scratch_setup.sql"; PROOF="$T/gh3241_get_my_referrals_opt_out_proof.sql"
LIVE_MD5=e63684bf6ce7d5b2da454ee00b31a9e9
DB=gh3241_proof; rc=0
NCHECKS=12
fail() { echo "EXPECT FAIL: $*"; rc=1; }
fresh() {
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1 || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$SETUP" >/dev/null || exit 2
  psql -q -1 -d "$1" -v ON_ERROR_STOP=1 -f "$LIVE" >/dev/null || exit 2
}
proof() {
  psql -q -At -1 -d "$1" -f "$PROOF" > "$OUT/$2.txt" 2>&1
  echo "== $2"; grep -E 'PROOF-(OK|FAIL)|^FAIL ' "$OUT/$2.txt" | sed 's/^psql:[^ ]* //'
}
passed() { grep -q "PROOF-OK all $NCHECKS checks passed" "$1"; }
failed() { grep -q "PROOF-FAIL" "$1"; }
apply() { psql -q -1 -d "$1" -v ON_ERROR_STOP=1 -f "$2" > "$OUT/apply.log" 2>&1; }
prosrc_md5() { psql -q -At -d "$1" -c "select md5(prosrc) from pg_proc where oid = 'public.get_my_referrals()'::regprocedure"; }
snapshot() {
  psql -q -At -d "$1" -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, '') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'auth') ORDER BY 1;
SELECT 'rel|' || c.oid::regclass::text || '|' || coalesce(c.relacl::text, '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'auth') AND c.relkind IN ('r', 'v') ORDER BY 1;
SELECT 'col|' || a.attrelid::regclass::text || '.' || a.attname || '|' || a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND a.attacl IS NOT NULL ORDER BY 1;
SQL
}

fresh "$DB"
[ "$(prosrc_md5 "$DB")" = "$LIVE_MD5" ] && echo "== baseline prosrc md5 equals production ($LIVE_MD5)" || fail "baseline (gh3217a) prosrc md5 differs from production"
snapshot "$DB" > "$OUT/0-SNAPSHOT.txt" || exit 2
proof "$DB" 0-BEFORE
failed "$OUT/0-BEFORE.txt" && grep -q '^FAIL O1 ' "$OUT/0-BEFORE.txt" && ! grep -q '^FAIL O3 ' "$OUT/0-BEFORE.txt" \
  || fail "BEFORE must FAIL on O1 and pass O3 (negative control)"
apply "$DB" "$FWD" || fail "forward failed: $(grep -m1 ERROR "$OUT/apply.log")"
proof "$DB" 1-AFTER
passed "$OUT/1-AFTER.txt" || fail "AFTER must be PROOF-OK"
apply "$DB" "$FWD" || fail "forward not re-runnable"
proof "$DB" 2-RERUN
passed "$OUT/2-RERUN.txt" || fail "RERUN must be PROOF-OK"
apply "$DB" "$RBK" || fail "rollback failed"
snapshot "$DB" > "$OUT/3-ROLLBACK.txt"
if diff "$OUT/0-SNAPSHOT.txt" "$OUT/3-ROLLBACK.txt" > "$OUT/3-ROLLBACK.diff"; then
  echo "== 3-ROLLBACK catalog identical to 0-SNAPSHOT ($(wc -l < "$OUT/0-SNAPSHOT.txt") lines)"
else
  cat "$OUT/3-ROLLBACK.diff"; fail "ROLLBACK catalog differs from the pre-forward snapshot"
fi
[ "$(prosrc_md5 "$DB")" = "$LIVE_MD5" ] && echo "== 3-ROLLBACK prosrc md5 equals production ($LIVE_MD5)" || fail "rollback prosrc md5 differs from production"
proof "$DB" 3-ROLLBACK-proof
failed "$OUT/3-ROLLBACK-proof.txt" || fail "after rollback the proof must FAIL again"
apply "$DB" "$FWD" || fail "forward after rollback failed"
proof "$DB" 4-REAPPLIED
passed "$OUT/4-REAPPLIED.txt" || fail "REAPPLIED must be PROOF-OK"
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null

if [ "$MUT" = 1 ]; then
  MUTANTS=(
    "opt-out-ignored|need(s, 'CASE WHEN o.opted_out THEN NULL ELSE m.display_name END AS display_name', 'm.display_name')"
    "status-nulled-too|need(s, '    r.status,\n', '    CASE WHEN o.opted_out THEN NULL ELSE r.status END,\n')"
    "row-dropped|need(s, '    SELECT ra.id FROM public.referral_agents ra WHERE ra.user_id = auth.uid()\n  )', '    SELECT ra.id FROM public.referral_agents ra WHERE ra.user_id = auth.uid()\n  ) AND NOT o.opted_out')"
    "referrals-claim-id-link-ignored|need(s, '      OR EXISTS (SELECT 1 FROM public.claims c WHERE c.id = r.claim_id AND c.referrer_updates_opt_out IS TRUE)\n', '')"
    "claims-referral-id-link-ignored|need(s, 'EXISTS (SELECT 1 FROM public.claims c WHERE c.referral_id = r.id AND c.referrer_updates_opt_out IS TRUE)\n      OR ', '')"
    "newest-claim-only|need(s, 'WHERE c.referral_id = r.id AND c.referrer_updates_opt_out IS TRUE)', 'WHERE c.id = (SELECT c2.id FROM public.claims c2 WHERE c2.referral_id = r.id ORDER BY c2.created_at DESC LIMIT 1) AND c.referrer_updates_opt_out IS TRUE)')"
    "metadata-ignored|need(s, \"\n      OR coalesce(r.metadata -> 'referrer_updates_opt_out' = 'true'::jsonb, false)\", '')"
    "null-treated-as-opt-out|s.replace('c.referrer_updates_opt_out IS TRUE', 'c.referrer_updates_opt_out IS NOT FALSE') if 'c.referrer_updates_opt_out IS TRUE' in s else sys.exit('needle')"
    "anon-granted|need(s, 'TO authenticated, service_role;', 'TO anon, authenticated, service_role;')"
  )
  killed=0; total=0
  for m in "${MUTANTS[@]}"; do
    name="${m%%|*}"; expr="${m#*|}"; total=$((total + 1))
    mf="$OUT/mutant-$name.sql"
    python3 -I -c "
import sys
def need(s, old, new):
    if old not in s: sys.exit('needle not found: ' + old)
    return s.replace(old, new, 1)
s = open(sys.argv[1]).read()
open(sys.argv[2], 'w').write($expr)
" "$FWD" "$mf" || { fail "mutant $name: did not apply to the forward file"; continue; }
    MDB="gh3241_mut_$(echo "$name" | tr '-' '_')"
    fresh "$MDB"
    if ! apply "$MDB" "$mf"; then fail "mutant $name: the mutated forward did not apply: $(grep -m1 ERROR "$OUT/apply.log")"; continue; fi
    psql -q -At -1 -d "$MDB" -f "$PROOF" > "$OUT/mutant-$name.txt" 2>&1
    if failed "$OUT/mutant-$name.txt"; then
      killed=$((killed + 1)); echo "== mutant $name: KILLED ($(grep '^FAIL ' "$OUT/mutant-$name.txt" | cut -c6- | cut -d' ' -f1 | sort -u | tr '\n' ' '))"
    else
      fail "mutant $name SURVIVED the proof"
    fi
    psql -q -d postgres -c "DROP DATABASE IF EXISTS $MDB" >/dev/null
  done
  echo "MUTANTS killed=$killed of $total"
  [ "$killed" = "$total" ] || fail "not every mutant was killed"
fi
echo "RUNNER rc=$rc (outputs in $OUT)"; exit $rc
