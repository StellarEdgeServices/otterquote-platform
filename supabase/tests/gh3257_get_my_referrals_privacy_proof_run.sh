#!/usr/bin/env bash
# gh-3257: run the get_my_referrals() privacy proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3257_get_my_referrals_privacy_proof_run.sh [--mutations] [outdir]
# The connecting role must be a superuser (the scratch setup creates roles). Verified on PostgreSQL 16.15.
# Each fresh database = the gh3241 scratch setup + the gh3217a live body (md5 = production today) + the gh3241 forward
# (PR #3255): the state this migration is applied on. Its prosrc md5 is the pre-flight guard (GH3241_MD5 below).
# Phases: 0-BEFORE (gh3241 body: the proof must FAIL on P1/J1 and PASS the opted-in control P5 and the fee C1)
#   -> 1-AFTER (forward: PROOF-OK) -> 2-RERUN (forward again: PROOF-OK) -> 3-ROLLBACK (catalog identical to the pre-forward
#   snapshot, prosrc md5 equals GH3241_MD5, proof FAILs again) -> 4-REAPPLIED (PROOF-OK, prosrc md5 equals GH3257_MD5).
# --mutations: each mutant is the forward file with one deliberate defect, applied to its own fresh database; every mutant
# must apply cleanly and then FAIL the proof. A surviving mutant fails the run.
set -uo pipefail
cd "$(dirname "$0")/../.."
MUT=0
if [ "${1:-}" = "--mutations" ]; then MUT=1; shift; fi
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
LIVE="$D/gh3217a_get_my_referrals.sql"; BASE="$D/gh3241_get_my_referrals_opt_out.sql"
FWD="$D/gh3257_get_my_referrals_privacy.sql"; RBK="$D/gh3257_get_my_referrals_privacy_rollback.sql"
SETUP="$T/gh3241_get_my_referrals_opt_out_scratch_setup.sql"; PROOF="$T/gh3257_get_my_referrals_privacy_proof.sql"
LIVE_MD5=e63684bf6ce7d5b2da454ee00b31a9e9
GH3241_MD5=358ef8ae03a472b546d6ffa7e791d263
GH3257_MD5=825528f4db6b5ba46b7936adf0149df7
DB=gh3257_proof; rc=0
NCHECKS=19
fail() { echo "EXPECT FAIL: $*"; rc=1; }
fresh() {
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1 || exit 2
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$SETUP" >/dev/null || exit 2
  psql -q -1 -d "$1" -v ON_ERROR_STOP=1 -f "$LIVE" >/dev/null || exit 2
  psql -q -1 -d "$1" -v ON_ERROR_STOP=1 -f "$BASE" >/dev/null || exit 2
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

# the live body is production's today; gh3241 on top of it is the pre-flight's expected starting body
psql -q -d postgres -c "DROP DATABASE IF EXISTS ${DB}_live" -c "CREATE DATABASE ${DB}_live" >/dev/null 2>&1 || exit 2
psql -q -d "${DB}_live" -v ON_ERROR_STOP=1 -f "$SETUP" >/dev/null && psql -q -1 -d "${DB}_live" -v ON_ERROR_STOP=1 -f "$LIVE" >/dev/null || exit 2
[ "$(prosrc_md5 "${DB}_live")" = "$LIVE_MD5" ] && echo "== gh3217a prosrc md5 equals production today ($LIVE_MD5)" || fail "gh3217a prosrc md5 differs from production"
psql -q -d postgres -c "DROP DATABASE IF EXISTS ${DB}_live" >/dev/null

fresh "$DB"
[ "$(prosrc_md5 "$DB")" = "$GH3241_MD5" ] && echo "== baseline (gh3241) prosrc md5 equals the pre-flight guard ($GH3241_MD5)" || fail "baseline gh3241 prosrc md5 $(prosrc_md5 "$DB") differs from the pre-flight guard"
snapshot "$DB" > "$OUT/0-SNAPSHOT.txt" || exit 2
proof "$DB" 0-BEFORE
failed "$OUT/0-BEFORE.txt" && grep -q '^FAIL P1 ' "$OUT/0-BEFORE.txt" && grep -q '^FAIL J1 ' "$OUT/0-BEFORE.txt" \
  && ! grep -qE '^FAIL (P5|C1|C2|C3|N2) ' "$OUT/0-BEFORE.txt" \
  || fail "BEFORE must FAIL on P1 and J1 and pass the opted-in control P5/N2 and the fee checks C1-C3 (negative control)"
apply "$DB" "$FWD" || fail "forward failed: $(grep -m1 ERROR "$OUT/apply.log")"
proof "$DB" 1-AFTER
passed "$OUT/1-AFTER.txt" || fail "AFTER must be PROOF-OK"
[ "$(prosrc_md5 "$DB")" = "$GH3257_MD5" ] && echo "== 1-AFTER prosrc md5 equals the post-apply guard ($GH3257_MD5)" || fail "after-forward prosrc md5 $(prosrc_md5 "$DB") differs from GH3257_MD5"
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
[ "$(prosrc_md5 "$DB")" = "$GH3241_MD5" ] && echo "== 3-ROLLBACK prosrc md5 equals the gh3241 body ($GH3241_MD5)" || fail "rollback prosrc md5 differs from gh3241"
proof "$DB" 3-ROLLBACK-proof
failed "$OUT/3-ROLLBACK-proof.txt" || fail "after rollback the proof must FAIL again"
apply "$DB" "$FWD" || fail "forward after rollback failed"
proof "$DB" 4-REAPPLIED
passed "$OUT/4-REAPPLIED.txt" || fail "REAPPLIED must be PROOF-OK"
[ "$(prosrc_md5 "$DB")" = "$GH3257_MD5" ] || fail "reapplied prosrc md5 differs from GH3257_MD5"
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null

if [ "$MUT" = 1 ]; then
  MUTANTS=(
    "status-not-nulled|need(s, 'CASE WHEN o.opted_out THEN NULL ELSE r.status END AS status', 'r.status')"
    "status-nulled-for-every-row|need(s, 'CASE WHEN o.opted_out THEN NULL ELSE r.status END AS status', 'NULL::text AS status')"
    "job-value-kept|need(s, 'NULL::numeric AS job_value', 'r.job_value')"
    "job-value-nulled-only-when-opted-out|need(s, 'NULL::numeric AS job_value', 'CASE WHEN o.opted_out THEN NULL ELSE r.job_value END AS job_value')"
    "fee-nulled-when-opted-out|need(s, '    r.commission_amount,\n', '    CASE WHEN o.opted_out THEN NULL ELSE r.commission_amount END,\n')"
    "paid-at-nulled-when-opted-out|need(s, '    r.commission_paid_at,\n', '    CASE WHEN o.opted_out THEN NULL ELSE r.commission_paid_at END,\n')"
    "recruit-fee-nulled-when-opted-out|need(s, '    r.recruit_commission_amount,\n', '    CASE WHEN o.opted_out THEN NULL ELSE r.recruit_commission_amount END,\n')"
    "row-dropped|need(s, '    SELECT ra.id FROM public.referral_agents ra WHERE ra.user_id = auth.uid()\n  )', '    SELECT ra.id FROM public.referral_agents ra WHERE ra.user_id = auth.uid()\n  ) AND NOT o.opted_out')"
    "opted-out-name-restored|need(s, 'CASE WHEN o.opted_out THEN NULL ELSE m.display_name END AS display_name', 'm.display_name')"
    "referrals-claim-id-link-ignored|need(s, '      OR EXISTS (SELECT 1 FROM public.claims c WHERE c.id = r.claim_id AND c.referrer_updates_opt_out IS TRUE)\n', '')"
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
    MDB="gh3257_mut_$(echo "$name" | tr '-' '_')"
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
