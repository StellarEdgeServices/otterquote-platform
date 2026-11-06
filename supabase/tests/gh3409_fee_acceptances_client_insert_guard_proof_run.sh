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

# ---- the HTML form's insert shape (static): no .single(); a form that brings it back must fail this check ----
node "$T/gh3409_form_shape_check.mjs" contractor-bid-form.html || fail "contractor-bid-form.html fee_acceptances insert asks for a single row"
python3 - "$OUT" <<'PY'
import sys
s=open('contractor-bid-form.html').read(); o=sys.argv[1]
M={
 'form-with-single': ("user_agent: _userAgent,\n              }).select('id');", "user_agent: _userAgent,\n              }).select('id').single();"),
 'form-with-unknown-ip': ("ip_address: (_contractorIP && _contractorIP !== 'unknown') ? _contractorIP : null,", "ip_address: _contractorIP,"),
 'form-without-diverted-report': ("Sentry.captureMessage('[D-215] Fee acceptance diverted to quarantine'", "console.log('[D-215] Fee acceptance diverted to quarantine'"),
}
for k,(a,b) in M.items():
    assert s.count(a)==1,k; open(f"{o}/{k}.html","w").write(s.replace(a,b))
PY
for m in form-with-single form-with-unknown-ip form-without-diverted-report; do
  if node "$T/gh3409_form_shape_check.mjs" "$OUT/$m.html" >/dev/null; then fail "form mutant $m SURVIVED"; else echo "FORMSHAPE mutant $m: killed"; fi
done

# ---- the webhook's reading of the anchored row (Deno): the whole directory passes, and each broken link is caught ----
if command -v deno >/dev/null; then
  ( cd supabase/functions/stripe-webhook && deno test -A 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^(ok|FAILED) \|' ) | tee "$OUT/deno.txt"; grep -q ' 0 failed' "$OUT/deno.txt" || fail "stripe-webhook Deno tests fail"
  bash "$T/gh3409_webhook_mutants.sh" | tee "$OUT/webhook-mutants.txt"; grep -q 'killed: 14 of 14' "$OUT/webhook-mutants.txt" || fail "a webhook mutant survived"
else echo "Deno tests SKIPPED (deno not installed)"; fi

# ---- real PostgREST: the form's insert shapes against PostgREST itself (needs PGRST_BIN and SUPABASE_JS_DIR; a run without them says SKIPPED and does not count as proved) ----
if [ -n "${PGRST_BIN:-}" ] && [ -n "${SUPABASE_JS_DIR:-}" ]; then
  RD=gh3409_pgrst; newdb $RD; apply $RD "$FWD" || fail "forward failed for the PostgREST run"
  psql -q -At -d $RD -f "$T/gh3409_postgrest_seed.sql" | tail -1 > "$OUT/pgrst-seed.json"
  PGRST_PORT="${PGRST_PORT:-3409}"; PGRST_SECRET="gh3409-proof-secret-gh3409-proof-secret"
  PGRST_DB_URI="postgres://gh3409_authenticator:proof@${PGHOST:-127.0.0.1}:${PGPORT:-5432}/$RD" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$PGRST_SECRET" PGRST_SERVER_PORT=$PGRST_PORT PGRST_SERVER_HOST=127.0.0.1 PGRST_LOG_LEVEL=warn "$PGRST_BIN" > "$OUT/pgrst.log" 2>&1 &
  PGRST_PID=$!
  for i in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PGRST_PORT/" && break; sleep 0.5; done
  echo "PostgREST: $("$PGRST_BIN" --version) pid $PGRST_PID; supabase-js $(node -e "console.log(require('$SUPABASE_JS_DIR/node_modules/@supabase/supabase-js/package.json').version)")"
  node "$T/gh3409_postgrest_proof.mjs" "http://127.0.0.1:$PGRST_PORT" "$PGRST_SECRET" "$OUT/pgrst-seed.json" "$OUT/texts.psql" "$SUPABASE_JS_DIR" > "$OUT/pgrst-proof.txt" 2>"$OUT/pgrst-proof.err"; cat "$OUT/pgrst-proof.txt" "$OUT/pgrst-proof.err"
  grep -q '^PGRST_FAILING=0 ' "$OUT/pgrst-proof.txt" || fail "PostgREST proof has failing rows"
  kill $PGRST_PID 2>/dev/null; wait $PGRST_PID 2>/dev/null
else
  echo "PostgREST proof SKIPPED (set PGRST_BIN and SUPABASE_JS_DIR); the .single() claim is then NOT proved by this run"
fi

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
 'M12_genuine_record_lost_mismatch_refused': ("    RETURN NULL;\n  END IF;\n\n  NEW.created_at", "    RAISE EXCEPTION 'refused' USING ERRCODE = '42501';\n  END IF;\n\n  NEW.created_at"),
 'M13_genuine_record_lost_quarantine_writes_nothing': ("  INSERT INTO public.fee_acceptance_quarantine (reasons", "  IF true THEN RETURN; END IF;\n  INSERT INTO public.fee_acceptance_quarantine (reasons"),
 'M14_loose_number_pattern': ("ALL:"+DIG, "[0-9,]+"),
 'M15_late_bid_refused_again': ("  -- B / C. decide whether this is a true record of this bid", "  IF EXISTS (SELECT 1 FROM public.quotes z WHERE z.id = NEW.bid_id AND z.created_at < now() - interval '15 minutes') THEN RAISE EXCEPTION 'late' USING ERRCODE = '42501'; END IF;\n  -- B / C. decide whether this is a true record of this bid"),
 'M16_quarantine_writer_callable_by_client': ("IF pg_trigger_depth() < 1 THEN", "IF false THEN"),
 'M17_react_rate_unchecked': ("b[1]::numeric = round(p_pct, 2)", "true"),
 'M18_react_fee_unchecked': ("abs(replace(b[2], ',', '')::numeric - p_fee) <= 0.01", "true"),
 'M19_react_net_unchecked': ("(p_total IS NULL OR abs(replace(b[3], ',', '')::numeric - (p_total - p_fee)) <= 0.02)", "true"),
 'M20_react_repeated_figure_unchecked': ("    IF b[1] <> b[4] OR b[2] <> b[5] THEN RETURN 'text_not_form_wording'; END IF;\n", ""),
 'M21_html_rate_unchecked': (" AND a[2]::numeric = round(p_pct, 2)", ""),
 'M22_html_fee_tolerance_widened': ("abs(replace(a[1], ',', '')::numeric - p_fee) <= 0.01", "abs(replace(a[1], ',', '')::numeric - p_fee) <= 0.05"),
 'M23_html_fee_tolerance_zero': ("abs(replace(a[1], ',', '')::numeric - p_fee) <= 0.01", "abs(replace(a[1], ',', '')::numeric - p_fee) = 0"),
 'M24_rescission_reason_client_chosen': ("  NEW.rescission_reason := NULL;\n", ""),
 'M25_fee_basis_client_chosen': ("  NEW.fee_basis  := COALESCE(q.platform_fee_basis, 'bid_amount');\n", ""),
 'M26_accepted_at_future_allowed': (" OR NEW.accepted_at > now() + interval '5 minutes'", ""),
 'M27_quarantine_copy_not_as_sent': ("p_row.id, p_row.created_at, p_row.contractor_id", "gen_random_uuid(), now(), p_row.contractor_id"),
 'M28_quarantine_accepted_at_rewritten': ("p_row.fee_amount,\n          left(p_row.fee_text_displayed, 4000), length(p_row.fee_text_displayed), p_row.accepted_at,", "p_row.fee_amount,\n          left(p_row.fee_text_displayed, 4000), length(p_row.fee_text_displayed), now(),"),
 'M29_no_flood_cap': ("x.quarantined_at > now() - interval '1 hour') >= 25", "x.quarantined_at > now() - interval '1 hour') >= 1000000"),
 'M30_quarantine_text_uncapped': ("left(p_row.fee_text_displayed, 4000), length", "p_row.fee_text_displayed, length"),
 'M31_diversion_not_logged': ("    RAISE WARNING 'gh-3409 fee acceptance quarantined", "    PERFORM 'gh-3409 fee acceptance quarantined"),
 'M32_react_net_tolerance_widened': ("<= 0.02", "<= 100"),
 'M33_quarantine_user_agent_uncapped': ("left(p_row.user_agent, 500)", "p_row.user_agent"),
 'M34_service_role_keeps_update_delete_truncate': ("REVOKE ALL ON TABLE public.fee_acceptance_quarantine FROM PUBLIC, anon, authenticated, service_role;", "REVOKE ALL ON TABLE public.fee_acceptance_quarantine FROM PUBLIC, anon, authenticated;"),
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
  f=$(failing "mut/$n"); w=$(grep -c 'gh-3409 fee acceptance quarantined' "$OUT/mut/$n.perr"); if { [ -n "$f" ] && [ "$f" -gt 0 ] 2>/dev/null; } || [ "$w" = 0 ]; then killed=$((killed+1)); echo "MUTANT $n: FAILS the proof ($f failing, diversion log lines $w): $(grep '|FAIL$' "$OUT/mut/$n.txt" | cut -d'|' -f3 | cut -c1-48 | tr '\n' ';')"; else fail "MUTANT $n SURVIVED (proof still passes)"; fi
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
