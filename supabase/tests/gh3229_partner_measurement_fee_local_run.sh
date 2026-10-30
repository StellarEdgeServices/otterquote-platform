#!/usr/bin/env bash
# LOCAL throwaway Postgres 16 run of the gh-3229 (P18) proof. Never touches production.
# usage: gh3229_partner_measurement_fee_local_run.sh [before|after|rollback|mutant-inspector|mutant-minimum|mutant-rls|mutant-void|mutant-testmatch|mutant-payref|mutant-updatearm|mutant-month|mutant-utc|mutant-paidtrigger|mutant-deletetrigger|mutant-claimwindow]
#   before           : stub only (no migration) + the proof alone -> every row DIFF (negative control)
#   after            : the forward migration body spliced into the proof -> every row OK
#   rollback         : forward applied for real, then the rollback; prints leftovers (want 0) and the restored CHECK, then the proof alone (DIFF again)
#   mutant-inspector : after, but the D-333 check is disabled          -> the inspector rows must go DIFF
#   mutant-minimum   : after, but the $25 minimum check is disabled   -> the under-minimum and blocked rows must go DIFF
#   mutant-rls       : after, but the partner read policy is USING (true) -> the partner-isolation rows must go DIFF
#   mutant-void      : after, plus a trigger that voids the fee when rebate_paid_at is set (the removed behaviour) -> V1 must go DIFF
#   mutant-testmatch : after, but the stats exclude test rows for everyone (the old behaviour) -> only D10 goes DIFF (D6 is satisfied by the test partner's own test row)
#   mutant-payref    : after, but UNIQUE(payment_ref) is dropped            -> F4b must go DIFF (F4c also, its Z count includes the second fee)
#   mutant-updatearm : after, but the accrual trigger also fires on UPDATE  -> F4c must go DIFF
#   mutant-month     : after, but the current Eastern month may be batched  -> B3 (current month) must go DIFF
#   mutant-utc       : after, but the month boundary is UTC, not Eastern    -> B4/B5/B6/R1/N8 and the rows that count R's 30-minutes-before-midnight event go DIFF
#   mutant-paidtrigger  : after, but the payout-paid trigger arm is off     -> P3 must go DIFF
#   mutant-claimwindow  : after, but the window is click -> claim (the pre-D-402 rule) -> F12 must go DIFF
#   mutant-deletetrigger: after, but the payout-delete release is off       -> N8 must go DIFF
# Needs PG16 binaries (PGBIN, default /usr/lib/postgresql/16/bin) and a user that may run initdb (PGRUN_AS, default postgres).
set -euo pipefail
MODE=${1:-after}
HERE=$(cd "$(dirname "$0")" && pwd); SQL=$(cd "$HERE/.." && pwd)
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; AS=${PGRUN_AS:-postgres}
D=$(mktemp -d /tmp/gh3229pg.XXXXXX); chown "$AS" "$D"; PORT=${PGPORT_LOCAL:-54349}
as() { runuser -u "$AS" -- "$@"; }
as "$PGBIN/initdb" -D "$D/data" -A trust >/dev/null
as "$PGBIN/pg_ctl" -D "$D/data" -o "-p $PORT -k $D -c listen_addresses=''" -l "$D/log" -w start >/dev/null
trap 'as "$PGBIN/pg_ctl" -D "$D/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$D"' EXIT
P="$PGBIN/psql -X -q -v ON_ERROR_STOP=1 -h $D -p $PORT -U $AS -d postgres"
PNS="$PGBIN/psql -X -q -1 -v ON_ERROR_STOP=1 -h $D -p $PORT -U $AS -d postgres"   # proof run: the forced exception is the expected exit
FWD="$SQL/migrations_drafts/gh3229_partner_measurement_fee.sql"
RB="$SQL/migrations_drafts/gh3229_partner_measurement_fee_rollback.sql"
PROOF="$SQL/tests/gh3229_partner_measurement_fee_proof.sql"
strip() { grep -v -E '^(BEGIN|COMMIT);$' "$1"; }
$P -f "$SQL/tests/local_pg16/00_stub_schema.sql"
$P -f "$HERE/gh3229_local_stub_extras.sql"
run_proof() { $PNS -f "$1" 2>&1 | sed 's/^psql:[^ ]* //' | grep -v '^CONTEXT' | sed -n '/ERROR:/,$p' || true; }
splice() { awk -v fwd="$(strip "$FWD")" '/^-- @@MIGRATION@@/ { print fwd; next } { print }' "$PROOF"; }
mutate() { # $1 = sed expression, $2 = label; fails if the mutation changed nothing
  splice > "$D/orig.sql"; sed "$1" "$D/orig.sql" > "$D/mut.sql"
  cmp -s "$D/orig.sql" "$D/mut.sql" && { echo "mutant did not change the SQL" >&2; exit 1; }
  echo "== MUTANT: $2"; run_proof "$D/mut.sql"; }
case "$MODE" in
  before) echo "== BEFORE (no migration): negative control"; run_proof "$PROOF" ;;
  after)  echo "== AFTER the migration"; splice > "$D/after.sql"; run_proof "$D/after.sql" ;;
  mutant-inspector) mutate "s/IF v_agent_type IS NOT DISTINCT FROM 'home_inspector' THEN/IF false THEN/" "D-333 inspector check disabled" ;;
  mutant-minimum)   mutate "s/IF r.total < v_min THEN/IF false THEN/; s/IF r.payments_blocked THEN/IF false THEN/" "minimum and payments_blocked checks disabled" ;;
  mutant-rls)       mutate "s/USING (referral_agent_id IN (SELECT ra.id FROM public.referral_agents ra WHERE ra.user_id = (SELECT auth.uid())))/USING (true)/" "partner read policy USING (true)" ;;
  mutant-testmatch) mutate "s/e\.is_test = v_test/NOT e.is_test/g; s/r\.is_test = v_test/NOT r.is_test/g; s/p\.is_test = v_test/NOT p.is_test/g" "stats exclude test rows for everyone" ;;
  mutant-payref)    mutate "s/CONSTRAINT partner_fee_events_payment_ref_key UNIQUE (payment_ref),/CONSTRAINT partner_fee_events_payment_ref_key CHECK (true),/" "UNIQUE(payment_ref) dropped" ;;
  mutant-updatearm) mutate "s/^  AFTER INSERT\$/  AFTER INSERT OR UPDATE OF stripe_payment_id, homeowner_stripe_payment_intent_id/" "accrual trigger also fires on UPDATE" ;;
  mutant-month)     mutate "s/IF v_month >= date_trunc('month', now() AT TIME ZONE 'America\/New_York')::date THEN/IF v_month > date_trunc('month', now() AT TIME ZONE 'America\/New_York')::date THEN/" "current month may be batched" ;;
  mutant-utc)       mutate "s/AT TIME ZONE 'America\/New_York');\$/AT TIME ZONE 'UTC');/" "month boundary is UTC" ;;
  mutant-claimwindow) splice > "$D/orig.sql"
    sed "s/OR COALESCE(NEW.created_at, now()) > v_ref_created + public.referral_attribution_window() THEN/OR (SELECT cl.created_at FROM public.claims cl WHERE cl.id = NEW.claim_id) > v_ref_created + public.referral_attribution_window() THEN/" "$D/orig.sql" > "$D/mut.sql"
    cmp -s "$D/orig.sql" "$D/mut.sql" && { echo "mutant did not change the SQL" >&2; exit 1; }
    echo "== MUTANT: window measured click -> claim (pre-D-402)"; run_proof "$D/mut.sql" ;;
  mutant-paidtrigger)   mutate "s/OR (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')/OR false/" "payout-paid trigger arm off" ;;
  mutant-deletetrigger) mutate "s/WHEN (OLD.payout_type = 'measurement_fees_monthly')/WHEN (false)/" "payout-delete release off" ;;
  mutant-void)
    splice > "$D/orig.sql"
    awk '/^-- run a scalar query; /{print "CREATE FUNCTION public.mut_void() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $m$ BEGIN UPDATE public.partner_fee_events SET status = '"'"'void'"'"', voided_at = now() WHERE hover_order_id = NEW.id AND status = '"'"'accrued'"'"'; RETURN NEW; END $m$;"; print "CREATE TRIGGER mut_void AFTER UPDATE OF rebate_paid_at ON public.hover_orders FOR EACH ROW WHEN (OLD.rebate_paid_at IS NULL AND NEW.rebate_paid_at IS NOT NULL) EXECUTE FUNCTION public.mut_void();"} {print}' "$D/orig.sql" > "$D/mut.sql"
    cmp -s "$D/orig.sql" "$D/mut.sql" && { echo "mutant did not change the SQL" >&2; exit 1; }
    echo "== MUTANT: rebate voids the fee (removed behaviour)"; run_proof "$D/mut.sql" ;;
  rollback)
    $P -f "$FWD"
    echo "== forward applied for real in the throwaway DB; now the rollback"
    $P -f "$RB"
    $P -At -c "SELECT 'leftovers (want 0): ' || count(*) FROM (SELECT 1 FROM pg_proc WHERE proname IN ('get_partner_dashboard_stats','create_monthly_fee_batch','partner_fee_events_mark_paid','partner_fee_accrue_on_order','partner_fee_release_on_reject','partner_fee_events_follow_payout') UNION ALL SELECT 1 FROM pg_trigger WHERE tgname LIKE 'partner_fee_%' UNION ALL SELECT 1 FROM pg_class WHERE relname='partner_fee_events' UNION ALL SELECT 1 FROM public.platform_settings WHERE key LIKE 'partner_%_cents') x"
    $P -At -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='payout_approvals_payout_type_check'"
    echo "== proof alone after rollback (DIFF again)"; run_proof "$PROOF" ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
