#!/usr/bin/env bash
# gh-3259 proof runner. THROWAWAY POSTGRES ONLY -- never point this at production.
# Usage (repo root): PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3259_referrals_column_revoke_proof_run.sh [outdir]
# The connecting role must be a superuser (the scratch setup creates roles). Verified on PostgreSQL 16.15.
# Phases:
#   0 BEFORE    setup (live shape + live grants) + gh3217a (prosrc md5 = production's): a partner session READS job_value/status
#               (negative control: the defect is real on the model).
#   1 GATE      forward WITHOUT the operator statement: refuses, catalog unchanged.
#   2 AFTER     forward (with the gate statement): partner gets 42501 on job_value/status; allowed columns, RLS, get_my_referrals(),
#               admin_list_referrals(), service_role unchanged.
#   3 RERUN     forward again: same as AFTER.
#   4 ROLLBACK  rollback: catalog identical to the phase-0 snapshot, probe output identical to BEFORE; rollback run twice is safe.
#   5 REAPPLY   forward after rollback: same as AFTER.
#   6 GH3257    (when the #3255/#3258 drafts are reachable) the same revoke on top of the gh3241 + gh3257 get_my_referrals() bodies:
#               the RPC still answers (it is SECURITY DEFINER), with job_value NULL and status NULL for an opted-out row.
#   7 MUTANTS   each mutant forward/rollback carries one deliberate defect, applies cleanly, and must FAIL a check.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests
LIVE="$D/gh3217a_get_my_referrals.sql"
FWD="$D/gh3259_referrals_revoke_status_job_value.sql"; RBK="$D/gh3259_referrals_revoke_status_job_value_rollback.sql"
SETUP="$T/gh3259_referrals_column_revoke_scratch_setup.sql"; PROBE="$T/gh3259_referrals_column_revoke_probe.sql"
LIVE_MD5=e63684bf6ce7d5b2da454ee00b31a9e9
DB=gh3259_proof; rc=0
export PGOPTIONS='-c client_min_messages=warning'
ok()   { echo "CHECK PASS: $*"; }
bad()  { echo "CHECK FAIL: $*"; rc=1; }

fresh() {
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null 2>&1 || { echo "cannot create $1"; exit 2; }
  psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$SETUP" >/dev/null || { echo "setup failed on $1"; exit 2; }
  psql -q -1 -d "$1" -v ON_ERROR_STOP=1 -f "$LIVE" >/dev/null || { echo "gh3217a failed on $1"; exit 2; }
}
gated() { # wrap a forward file with the operator gate statement
  { printf "BEGIN;\nSET LOCAL gh3259.frontend_published = 'yes';\n"; grep -v -E '^\s*(BEGIN|COMMIT);\s*$' "$1"; echo "COMMIT;"; } > "$2"
}
apply() { psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$2" > "$OUT/apply-$3.log" 2>&1; }
probe() { psql -q -At -d "$1" -v ON_ERROR_STOP=1 -f "$PROBE" > "$OUT/$2.txt" 2>&1 || { echo "probe errored ($2)"; cat "$OUT/$2.txt"; rc=1; }; }
snapshot() {
  psql -q -At -d "$1" -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'rel|' || c.oid::regclass::text || '|' || coalesce(c.relacl::text, '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','auth') AND c.relkind IN ('r','v') ORDER BY 1;
SELECT 'col|' || a.attrelid::regclass::text || '.' || a.attname || '|' || a.attacl::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND a.attacl IS NOT NULL ORDER BY 1;
SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, '') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public','auth') ORDER BY 1;
SELECT 'pol|' || polrelid::regclass::text || '|' || polname || '|' || polcmd::text || '|' || coalesce(pg_get_expr(polqual, polrelid), '') FROM pg_policy ORDER BY 1;
SQL
}

# expected probe results
declare -A BEFORE=(
  ["J1 partnerA select job_value"]="18450.00,null"
  ["S1 partnerA select status"]="job_completed,registered"
  ["S2 partnerA filter on status (PostgREST ?status=eq.)"]="1"
  ["J2 partnerA old dashboard loadStats select"]="2"
  ["H1 homeowner select job_value"]="0"
  ["G1 closes-on has_column_privilege(authenticated, job_value)"]="true"
  ["G2 has_column_privilege(authenticated, status)"]="true"
)
declare -A AFTER=(
  ["J1 partnerA select job_value"]="ERR 42501"
  ["S1 partnerA select status"]="ERR 42501"
  ["S2 partnerA filter on status (PostgREST ?status=eq.)"]="ERR 42501"
  ["J2 partnerA old dashboard loadStats select"]="ERR 42501"
  ["H1 homeowner select job_value"]="ERR 42501"
  ["G1 closes-on has_column_privilege(authenticated, job_value)"]="false"
  ["G2 has_column_privilege(authenticated, status)"]="false"
)
# unchanged in every phase (the controls)
declare -A SAME=(
  ["K1 partnerA allowed columns"]="2 rows, fee 200.00"
  ["K2 partnerA recruit earnings read"]="50.00"
  ["K3 partnerA cannot see partnerB rows (RLS)"]="0"
  ["F1 partnerA get_my_referrals() status,job_value"]="job_completed:18450.00,registered:null"
  ["F2 partnerB get_my_referrals() count"]="1"
  ["N1 anon select job_value"]="ERR 42501"
  ["R1 service_role select job_value,status"]="job_completed:18450.00,registered:null,contract_signed:9100.00"
  ["D1 admin_list_referrals() job_value (SECURITY DEFINER)"]="9100.00,18450.00,null"
  ["G3 authenticated UPDATE/DELETE privileges unchanged"]="true,true,false"
)
got() { grep -F "PROBE $2 => " "$1" | head -1 | sed "s/^PROBE .* => //"; }
# check_phase <file> <label> <name of assoc array> [quiet]: returns number of mismatches
check_phase() {
  local f="$1" label="$2" quiet="${4:-}" miss=0 k want have
  local -n EXP="$3"
  for k in "${!EXP[@]}" "${!SAME[@]}"; do
    if [[ -v EXP[$k] ]]; then want="${EXP[$k]}"; else want="${SAME[$k]}"; fi
    have="$(got "$f" "$k")"
    if [ "$have" = "$want" ]; then [ -z "$quiet" ] && echo "  ok   [$label] $k => $have"
    else miss=$((miss+1)); [ -z "$quiet" ] && echo "  MISS [$label] $k => '$have' (want '$want')"; fi
  done
  return $miss
}

echo "== 0. BEFORE (negative control: the defect exists on the live-shaped model)"
fresh "$DB"
M=$(psql -At -d "$DB" -c "select md5(prosrc) from pg_proc where oid='public.get_my_referrals()'::regprocedure")
[ "$M" = "$LIVE_MD5" ] && ok "gh3217a body md5 = production's ($M)" || bad "gh3217a md5 $M != $LIVE_MD5"
snapshot "$DB" > "$OUT/snap0.txt"
probe "$DB" before
if check_phase "$OUT/before.txt" BEFORE BEFORE; then ok "BEFORE: partner JWT reads job_value and status directly (today's success)"; else bad "BEFORE expectations"; fi

echo "== 1. GATE (forward without the operator statement refuses and changes nothing)"
if apply "$DB" "$FWD" gate; then bad "forward ran without the gate statement"; else
  grep -q P0A92 "$OUT/apply-gate.log" || grep -q 'gh3259: refused' "$OUT/apply-gate.log" && ok "gate refused: $(grep -o 'gh3259: refused[^.]*' "$OUT/apply-gate.log" | head -1)" || bad "forward failed for another reason: $(head -3 "$OUT/apply-gate.log")"
fi
snapshot "$DB" | diff -q - "$OUT/snap0.txt" >/dev/null && ok "catalog unchanged after the refused run" || bad "refused run changed the catalog"

gated "$FWD" "$OUT/fwd_gated.sql"
echo "== 2. AFTER"
apply "$DB" "$OUT/fwd_gated.sql" after && ok "forward applied" || { bad "forward failed: $(cat "$OUT/apply-after.log")"; }
probe "$DB" after
if check_phase "$OUT/after.txt" AFTER AFTER; then ok "AFTER: partner JWT gets 42501 on job_value/status; controls unchanged"; else bad "AFTER expectations"; fi
snapshot "$DB" > "$OUT/snap_after.txt"

echo "== 3. RERUN"
apply "$DB" "$OUT/fwd_gated.sql" rerun && ok "forward reran cleanly" || bad "rerun failed: $(cat "$OUT/apply-rerun.log")"
probe "$DB" rerun
check_phase "$OUT/rerun.txt" RERUN AFTER q && ok "RERUN: same as AFTER" || bad "RERUN expectations"
snapshot "$DB" | diff -q - "$OUT/snap_after.txt" >/dev/null && ok "RERUN catalog = AFTER catalog" || bad "rerun changed the catalog"

echo "== 4. ROLLBACK"
apply "$DB" "$RBK" rollback && ok "rollback applied" || bad "rollback failed: $(cat "$OUT/apply-rollback.log")"
snapshot "$DB" > "$OUT/snap_rb.txt"
diff "$OUT/snap0.txt" "$OUT/snap_rb.txt" > "$OUT/snap_rb.diff" && ok "ROLLBACK catalog identical to the BEFORE snapshot ($(wc -l < "$OUT/snap0.txt") lines)" || { bad "ROLLBACK catalog differs"; cat "$OUT/snap_rb.diff"; }
probe "$DB" rollback
diff -q "$OUT/before.txt" "$OUT/rollback.txt" >/dev/null && ok "ROLLBACK probe output identical to BEFORE" || bad "ROLLBACK probe differs from BEFORE"
apply "$DB" "$RBK" rollback2 && snapshot "$DB" | diff -q - "$OUT/snap0.txt" >/dev/null && ok "rollback run twice: still identical" || bad "second rollback run"

echo "== 5. REAPPLY"
apply "$DB" "$OUT/fwd_gated.sql" reapply && ok "forward re-applied" || bad "reapply failed"
probe "$DB" reapply
check_phase "$OUT/reapply.txt" REAPPLY AFTER q && ok "REAPPLY: same as AFTER" || bad "REAPPLY expectations"

echo "== 6. GH3257 (revoke on top of the #3255 + #3258 get_my_referrals() bodies)"
S41=""; S57=""
for ref in "" "refs/remotes/pr/3258" "refs/remotes/origin/gh-3257-dashboard-privacy"; do
  if [ -z "$ref" ]; then
    [ -f "$D/gh3241_get_my_referrals_opt_out.sql" ] && [ -f "$D/gh3257_get_my_referrals_privacy.sql" ] && { S41="$D/gh3241_get_my_referrals_opt_out.sql"; S57="$D/gh3257_get_my_referrals_privacy.sql"; break; }
  elif git cat-file -e "$ref:$D/gh3257_get_my_referrals_privacy.sql" 2>/dev/null; then
    git show "$ref:$D/gh3241_get_my_referrals_opt_out.sql" > "$OUT/gh3241.sql"; git show "$ref:$D/gh3257_get_my_referrals_privacy.sql" > "$OUT/gh3257.sql"
    S41="$OUT/gh3241.sql"; S57="$OUT/gh3257.sql"; echo "  (gh3241/gh3257 drafts read from $ref)"; break
  fi
done
if [ -z "$S57" ]; then echo "SKIP: gh3241/gh3257 drafts not reachable (main does not carry them yet, no PR ref fetched)"; else
  fresh "${DB}_57"
  psql -q -1 -d "${DB}_57" -v ON_ERROR_STOP=1 -f "$S41" >/dev/null && psql -q -1 -d "${DB}_57" -v ON_ERROR_STOP=1 -f "$S57" >/dev/null || bad "gh3241/gh3257 bodies did not apply"
  # the homeowner on c...002 declined updates on a linked claim
  psql -q -d "${DB}_57" -c "insert into public.claims(referral_id, referrer_updates_opt_out) values ('c3259000-0000-4000-8000-000000000002', true)" >/dev/null
  probe "${DB}_57" gh3257_before
  apply "${DB}_57" "$OUT/fwd_gated.sql" gh3257 && ok "forward applied on top of gh3257" || bad "forward failed on gh3257: $(cat "$OUT/apply-gh3257.log")"
  probe "${DB}_57" gh3257_after
  B=$(got "$OUT/gh3257_before.txt" "F1 partnerA get_my_referrals() status,job_value"); A=$(got "$OUT/gh3257_after.txt" "F1 partnerA get_my_referrals() status,job_value")
  [ "$A" = "job_completed:null,null:null" ] && [ "$A" = "$B" ] && ok "gh3257 get_my_referrals() unchanged by the revoke: '$A' (job_value NULL, opted-out status NULL)" || bad "gh3257 RPC before='$B' after='$A'"
  [ "$(got "$OUT/gh3257_before.txt" "J1 partnerA select job_value")" = "18450.00,null" ] && ok "gh3257 alone still leaves the direct read open (job_value 18450.00): the gap #3259 names" || bad "gh3257 before J1"
  [ "$(got "$OUT/gh3257_after.txt" "J1 partnerA select job_value")" = "ERR 42501" ] && [ "$(got "$OUT/gh3257_after.txt" "S1 partnerA select status")" = "ERR 42501" ] && ok "gh3257 + gh3259: direct job_value/status read refused (42501)" || bad "gh3257 after J1/S1"
fi

echo "== 7. MUTANTS (each must apply cleanly and then FAIL)"
killed=0; total=0
mutant() { # name, sed expression applied to the forward
  local name="$1" expr="$2" f="$OUT/mut_$1.sql"
  total=$((total+1))
  sed -E "$expr" "$FWD" > "$OUT/mut_src.sql"
  if cmp -s "$OUT/mut_src.sql" "$FWD"; then bad "mutant $name: sed changed nothing"; return; fi
  gated "$OUT/mut_src.sql" "$f"
  fresh "${DB}_m"
  if ! apply "${DB}_m" "$f" "m_$name"; then
    # a mutant the forward's own post-assertions refuse is killed by the file itself
    if grep -q P0A95 "$OUT/apply-m_$name.log" || grep -q 'gh3259:' "$OUT/apply-m_$name.log"; then killed=$((killed+1)); echo "  killed (by the forward's own assertion) $name"; else bad "mutant $name failed to apply for another reason: $(head -2 "$OUT/apply-m_$name.log")"; fi
    return
  fi
  probe "${DB}_m" "m_$name"
  if check_phase "$OUT/m_$name.txt" "m_$name" AFTER q; then bad "mutant SURVIVED: $name"; else killed=$((killed+1)); echo "  killed (by the probe) $name"; fi
}
# post-assertions disabled copy, so probe-level kills are visible too
NOPOST='/^DO \$post\$/,/^\$post\$;/d'
mutant only_job_value       "s/REVOKE SELECT \(status, job_value\)/REVOKE SELECT (job_value)/; $NOPOST"
mutant only_status          "s/REVOKE SELECT \(status, job_value\)/REVOKE SELECT (status)/; $NOPOST"
mutant anon_only            "s/(REVOKE SELECT \(status, job_value\) ON public.referrals FROM) anon, authenticated/\1 anon/; $NOPOST"
mutant table_level_revoke   "s/REVOKE SELECT \(status, job_value\) ON public.referrals/REVOKE SELECT ON public.referrals/; $NOPOST"
mutant also_commission      "s/REVOKE SELECT \(status, job_value\)/REVOKE SELECT (status, job_value, commission_amount)/; $NOPOST"
mutant also_recruit         "s/REVOKE SELECT \(status, job_value\)/REVOKE SELECT (status, job_value, recruit_commission_amount)/; $NOPOST"
mutant table_grant_after    "s/^(REVOKE SELECT \(status, job_value\) ON public.referrals FROM anon, authenticated;)/\1 GRANT SELECT ON public.referrals TO authenticated;/; $NOPOST"
mutant rpc_invoker          "s/^(REVOKE SELECT \(status, job_value\) ON public.referrals FROM anon, authenticated;)/\1 ALTER FUNCTION public.get_my_referrals() SECURITY INVOKER;/; s/IF NOT \(SELECT prosecdef/IF false AND NOT (SELECT prosecdef/; $NOPOST"
mutant noop_revoke_update   "s/REVOKE SELECT \(status, job_value\)/REVOKE UPDATE (status, job_value)/; $NOPOST"
# the forward's own assertions as a kill layer: the same defects with the assertions left in
mutant assert_only_job_value "s/REVOKE SELECT \(status, job_value\)/REVOKE SELECT (job_value)/"
mutant assert_also_commission "s/REVOKE SELECT \(status, job_value\)/REVOKE SELECT (status, job_value, commission_amount)/"
# rollback mutants: must leave a catalog that differs from the BEFORE snapshot
rb_mutant() {
  local name="$1" expr="$2"
  total=$((total+1))
  sed -E "$expr" "$RBK" | sed -E '/^DO \$post\$/,/^\$post\$;/d' > "$OUT/rbm_$name.sql"
  fresh "${DB}_m"; apply "${DB}_m" "$OUT/fwd_gated.sql" "rbm_f_$name" || { bad "rb mutant $name: forward failed"; return; }
  apply "${DB}_m" "$OUT/rbm_$name.sql" "rbm_$name" || { killed=$((killed+1)); echo "  killed (rollback errored) rb_$name"; return; }
  if snapshot "${DB}_m" | diff -q - "$OUT/snap0.txt" >/dev/null; then bad "rollback mutant SURVIVED: $name"; else killed=$((killed+1)); echo "  killed (catalog differs from BEFORE) rb_$name"; fi
}
rb_mutant table_level     "s/GRANT SELECT \(status, job_value\) ON public.referrals TO authenticated/GRANT SELECT ON public.referrals TO authenticated/"
rb_mutant only_job_value  "s/GRANT SELECT \(status, job_value\)/GRANT SELECT (job_value)/"
rb_mutant also_anon       "s/TO authenticated;/TO anon, authenticated;/"
rb_mutant with_grant_opt  "s/TO authenticated;/TO authenticated WITH GRANT OPTION;/"
[ "$killed" = "$total" ] && ok "mutants killed $killed/$total" || bad "mutants killed $killed/$total"

psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "DROP DATABASE IF EXISTS ${DB}_57" -c "DROP DATABASE IF EXISTS ${DB}_m" >/dev/null 2>&1
echo "outputs: $OUT"
[ "$rc" = 0 ] && echo "GH3259_PROOF: ALL PASS" || { echo "GH3259_PROOF: FAIL"; exit 1; }
