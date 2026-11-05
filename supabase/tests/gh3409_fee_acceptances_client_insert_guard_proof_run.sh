#!/usr/bin/env bash
# gh-3409: run the fee_acceptances client-insert-guard proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres [GH3320_REF=<git ref of PR #3406's head>] bash supabase/tests/gh3409_fee_acceptances_client_insert_guard_proof_run.sh [outdir]
# Needs: psql, node, python3, a superuser connection to a scratch server.
# Phases (one fresh database each, schema = gh3409_throwaway_schema.sql):
#   1-BEFORE   today's schema, no forward file: forged inserts must SUCCEED (negative control), real paths work
#   2-AFTER    forward file applied: forged inserts refused / neutralised, real paths still work
#   3-ROLLBACK forward then rollback: must behave as BEFORE
#   4-REAPPLY  forward run twice (idempotent): must behave as AFTER
#   M01..M16   mutants of the forward file: each must apply cleanly and then FAIL the AFTER expectations
#   C-A / C-B  PR #3406's forward file (gh-3320) applied before / after this one: AFTER expectations hold in both orders; rollbacks are independent
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
FWD="$D/gh3409_fee_acceptances_client_insert_guard.sql"; RBK="$RB/gh3409_fee_acceptances_client_insert_guard_rollback.sql"; PROOF="$T/gh3409_fee_acceptances_client_insert_guard_proof.sql"
rc=0; fail() { echo "EXPECT FAIL: $*"; rc=1; }
node "$T/gh3409_render_real_texts.mjs" . > "$OUT/texts.psql" || { echo "could not render the form texts"; exit 2; }
tail -1 "$OUT/texts.psql"
newdb() { psql -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null || exit 2; psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$T/gh3409_throwaway_schema.sql" >/dev/null || exit 2; }
runproof() { # db phase label
  psql -q -At -d "$1" -v phase="$2" -v composed="${COMPOSED:-0}" -f "$OUT/texts.psql" -f "$PROOF" > "$OUT/$3.txt" 2> "$OUT/$3.err"; echo "== $3"; cat "$OUT/$3.txt"; cat "$OUT/$3.err"
  grep -q '^FAILING=' "$OUT/$3.txt" || echo "FAILING=? (proof did not finish)"; }
failing() { grep -m1 '^FAILING=' "$OUT/$1.txt" | sed 's/FAILING=\([0-9]*\) .*/\1/'; }
apply() { psql -q -d "$1" -v ON_ERROR_STOP=1 -f "$2" >/dev/null; }
DB=gh3409_proof
newdb $DB
runproof $DB before 1-BEFORE
apply $DB "$FWD" || fail "forward failed"
runproof $DB after 2-AFTER
apply $DB "$FWD" || fail "forward not idempotent"
apply $DB "$RBK" || fail "rollback failed"
runproof $DB rollback 3-ROLLBACK
apply $DB "$FWD" || fail "forward after rollback failed"
apply $DB "$FWD" || fail "forward twice failed"
runproof $DB after 4-REAPPLY
for p in 1-BEFORE 2-AFTER 3-ROLLBACK 4-REAPPLY; do [ "$(failing $p)" = 0 ] || fail "$p has failing rows"; done
apply $DB "$RBK" || fail "rollback of the final state failed"
psql -q -At -d $DB -c "SELECT 'after final rollback: triggers=' || (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.fee_acceptances'::regclass AND NOT tgisinternal) || ' functions=' || (SELECT count(*) FROM pg_proc WHERE proname IN ('fee_acceptances_guard_client_insert','fee_acceptance_text_check','fee_acceptance_quarantine_add')) || ' quarantine_table_kept=' || (to_regclass('public.fee_acceptance_quarantine') IS NOT NULL)"

# ---- prerequisite refusal: the forward file must refuse to run without gh-2519's quotes_platform_fee_for ----
PD=gh3409_prereq; newdb $PD; psql -q -d $PD -c "DROP FUNCTION public.quotes_platform_fee_for(uuid,uuid)" >/dev/null
if psql -q -d $PD -v ON_ERROR_STOP=1 -f "$FWD" >/dev/null 2>"$OUT/prereq.err"; then fail "forward ran without gh-2519"; else echo "PREREQ without gh-2519: refused ($(grep -m1 -o 'gh3409: gh-2519[^;]*' "$OUT/prereq.err" | cut -c1-70)...)"; fi
psql -q -At -d $PD -c "SELECT 'PREREQ nothing committed: triggers=' || count(*) FROM pg_trigger WHERE tgrelid='public.fee_acceptances'::regclass AND NOT tgisinternal"

# ---- mutants: each edit must change the file, apply cleanly, and then FAIL the AFTER expectations ----
mkdir -p "$OUT/mut"
python3 - "$FWD" "$OUT/mut" <<'PY'
import sys
src=open(sys.argv[1]).read(); out=sys.argv[2]
DIG="(?:0|[1-9][0-9]{0,2}(?:,[0-9]{3})*)"
M={
 'M01_trigger_body_returns_immediately': ("BEGIN\n  -- Only client callers are bound.", "BEGIN\n  RETURN NEW;\n  -- Only client callers are bound."),
 'M02_no_own_bid_on_claim_match': ("WHERE x.id = NEW.bid_id AND x.contractor_id = NEW.contractor_id AND x.claim_id = NEW.claim_id;", "WHERE x.id = NEW.bid_id;"),
 'M03_no_text_check': ("v_chk := public.fee_acceptance_text_check(NEW.fee_text_displayed, v_pct, v_amt, q.total_price);", "v_chk := 'ok';"),
 'M04_created_at_client_chosen': ("  NEW.created_at        := now();\n", ""),
 'M05_no_one_acceptance_per_bid': ("IF EXISTS (SELECT 1 FROM public.fee_acceptances d", "IF false AND EXISTS (SELECT 1 FROM public.fee_acceptances d"),
 'M06_fee_not_overwritten': ("  NEW.fee_pct    := v_pct;\n  NEW.fee_basis  := COALESCE(q.platform_fee_basis, 'bid_amount');\n  NEW.fee_amount := v_amt;\n", ""),
 'M07_real_path_lost_react_wording_unrecognised': ("IF b IS NOT NULL THEN", "IF false THEN"),
 'M08_real_path_lost_net_rounding': ("<= 0.02", "= 0"),
 'M09_real_path_lost_service_role_bound': ("IF NOT (current_user IN ('anon', 'authenticated') AND COALESCE(auth.role(), '') <> 'service_role') THEN", "IF false THEN"),
 'M10_accepted_at_client_chosen': ("  IF NEW.accepted_at IS NULL OR NEW.accepted_at < now() - interval '15 minutes' OR NEW.accepted_at > now() + interval '5 minutes' THEN\n    NEW.accepted_at := now();\n  END IF;\n", ""),
 'M11_rescinded_at_client_chosen': ("  NEW.rescinded_at      := NULL;\n", ""),
 'M12_genuine_record_lost_mismatch_refused': ("    RAISE WARNING 'gh-3409 fee acceptance quarantined: bid % reasons %', NEW.bid_id, v_reasons;\n    RETURN NULL;", "    RAISE EXCEPTION 'refused' USING ERRCODE = '42501';"),
 'M13_genuine_record_lost_quarantine_writes_nothing': ("  INSERT INTO public.fee_acceptance_quarantine (reasons", "  IF true THEN RETURN; END IF;\n  INSERT INTO public.fee_acceptance_quarantine (reasons"),
 'M14_loose_number_pattern': ("ALL:"+DIG, "[0-9,]+"),
 'M15_late_bid_refused_again': ("  -- B / C. decide whether this is a true record of this bid", "  IF EXISTS (SELECT 1 FROM public.quotes z WHERE z.id = NEW.bid_id AND z.created_at < now() - interval '15 minutes') THEN RAISE EXCEPTION 'late' USING ERRCODE = '42501'; END IF;\n  -- B / C. decide whether this is a true record of this bid"),
 'M16_quarantine_writer_callable_by_client': ("IF pg_trigger_depth() < 1 THEN", "IF false THEN"),
}
for k,(a,b) in M.items():
    if a.startswith("ALL:"):
        a=a[4:]
        if src.count(a)<4: print("MUTANT EDIT NOT PRESENT:",k); sys.exit(5)
        open(f"{out}/{k}.sql","w").write(src.replace(a,b)); continue
    if src.count(a)!=1: print("MUTANT EDIT NOT UNIQUE/PRESENT:",k,src.count(a)); sys.exit(5)
    open(f"{out}/{k}.sql","w").write(src.replace(a,b))
PY
[ $? = 0 ] || fail "mutant generation failed"
killed=0; total=0
for m in "$OUT"/mut/M*.sql; do
  n=$(basename "$m" .sql); total=$((total+1)); MD=gh3409_$(echo "$n" | cut -c1-3 | tr 'M' 'm')
  newdb $MD
  if ! apply $MD "$m" 2>"$OUT/mut/$n.err"; then fail "$n does not apply: $(head -1 "$OUT/mut/$n.err")"; continue; fi
  psql -q -At -d $MD -v phase=after -v composed=0 -f "$OUT/texts.psql" -f "$PROOF" > "$OUT/mut/$n.txt" 2>"$OUT/mut/$n.perr"
  f=$(failing "mut/$n"); if [ -n "$f" ] && [ "$f" -gt 0 ] 2>/dev/null; then killed=$((killed+1)); echo "MUTANT $n: FAILS the proof ($f failing): $(grep '|FAIL$' "$OUT/mut/$n.txt" | cut -d'|' -f3 | cut -c1-48 | tr '\n' ';')"; else fail "MUTANT $n SURVIVED (proof still passes)"; fi
  psql -q -d postgres -c "DROP DATABASE $MD" >/dev/null
done
echo "MUTANTS killed: $killed of $total"; [ "$killed" = "$total" ] || fail "not every mutant was killed"

# ---- composition with PR #3406 (gh-3320): independent, either order ----
REF="${GH3320_REF:-origin/gh-3320-fee-acceptances-append-only}"
G=gh3320_fee_acceptances_append_only; X="$OUT/gh3320"; mkdir -p "$X"
if git show "$REF:$D/$G.sql" > "$X/fwd.sql" 2>/dev/null && git show "$REF:$RB/${G}_rollback.sql" > "$X/rbk.sql" 2>/dev/null; then
  echo "COMPOSITION with #3406 at $(git rev-parse --short "$REF")"
  for order in A B; do
    CD=gh3409_comp_$(echo $order | tr A-Z a-z); newdb $CD
    if [ $order = A ]; then apply $CD "$X/fwd.sql" || fail "C-$order: 3406 forward failed"; apply $CD "$FWD" || fail "C-$order: 3409 forward failed"
    else apply $CD "$FWD" || fail "C-$order: 3409 forward failed"; apply $CD "$X/fwd.sql" || fail "C-$order: 3406 forward failed"; fi
    COMPOSED=1 runproof $CD after C-$order-BOTH-APPLIED >/dev/null; echo "C-$order both applied: FAILING=$(failing C-$order-BOTH-APPLIED); $(psql -q -At -d $CD -c "SELECT 'authenticated UPDATE/DELETE=' || has_table_privilege('authenticated','public.fee_acceptances','UPDATE') || '/' || has_table_privilege('authenticated','public.fee_acceptances','DELETE') || ', triggers=' || (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.fee_acceptances'::regclass AND NOT tgisinternal) || ', policies=' || (SELECT count(*) FROM pg_policies WHERE tablename='fee_acceptances')")"
    [ "$(failing C-$order-BOTH-APPLIED)" = 0 ] || fail "C-$order AFTER expectations fail with both applied"
    apply $CD "$RBK" || fail "C-$order: 3409 rollback failed with 3406 applied"
    COMPOSED=1 runproof $CD rollback C-$order-ONLY3406 >/dev/null; echo "C-$order 3409 rolled back, 3406 still applied: FAILING=$(failing C-$order-ONLY3406); $(psql -q -At -d $CD -c "SELECT 'authenticated UPDATE/DELETE=' || has_table_privilege('authenticated','public.fee_acceptances','UPDATE') || '/' || has_table_privilege('authenticated','public.fee_acceptances','DELETE') || ', triggers=' || (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.fee_acceptances'::regclass AND NOT tgisinternal)")"
    [ "$(failing C-$order-ONLY3406)" = 0 ] || fail "C-$order BEFORE expectations fail after 3409 rollback"
  done
else echo "COMPOSITION SKIPPED: $REF not available in this clone"; fi
echo "RUNNER rc=$rc"; exit $rc
