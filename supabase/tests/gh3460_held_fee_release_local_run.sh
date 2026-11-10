#!/usr/bin/env bash
# LOCAL throwaway Postgres 16 run of the gh-3460 (P18) proof. Never touches production. Same harness as gh3229_partner_measurement_fee_local_run.sh.
# usage: gh3460_held_fee_release_local_run.sh [before|after|rollback|mutant-wide-arm|mutant-no-refusal|mutant-no-admin|mutant-null-guard|mutant-null-require|mutant-copy-checks]
#   before            : gh3229 NOT applied, gh3460 NOT applied, proof alone -> rows DIFF (negative control)
#   after             : gh3229 body + gh3460 body spliced into the proof -> every row OK
#   rollback          : both applied for real, then the gh3460 rollback; prints leftovers (want 0) and that gh3229's trigger is intact, then the proof against gh3229-only (settle rows DIFF)
#   mutant-wide-arm   : the new trigger fires on any role change (drop the OLD='unspecified' condition)      -> T2 must go DIFF
#   mutant-no-refusal : the function never refuses a settlement that accrued no fee (require_fee ignored)     -> R1-R7 must go DIFF
#   mutant-no-admin   : the admin check is off                                                               -> G1 must go DIFF (G2 stays OK: anon has no EXECUTE grant)
#   mutant-null-guard : the OLD guard restored (`OR public.is_admin_email()` without COALESCE)                  -> G8, G9, G10 must go DIFF (the NULL bypass)
#   mutant-null-require: `IF NOT FOUND AND p_require_fee` restored (no COALESCE)                             -> R9 must go DIFF
#   mutant-no-upgrade : the D-317 upgrade exclusion removed from BOTH the trigger WHEN and the admin function -> U1, U2, U3 must go DIFF
#   mutant-no-contractor-check  : contractor id not validated against contractors.id -> K1, K2 DIFF
#   mutant-no-contractor-repeat : a repeat with a different contractor id is accepted -> K5 DIFF
#   mutant-no-missing-fee       : a homeowner repeat with no fee reports plain success -> D1, Z3 DIFF
#   mutant-copy-checks: the accrual function loses the excluded-state check (a drifted copy would do this)    -> R1, T1(MS) go DIFF on BOTH paths: one function, one place
# Needs PG16 binaries (PGBIN, default /usr/lib/postgresql/16/bin) and a user that may run initdb (PGRUN_AS, default postgres).
set -euo pipefail
MODE=${1:-after}
HERE=$(cd "$(dirname "$0")" && pwd); SQL=$(cd "$HERE/.." && pwd)
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; AS=${PGRUN_AS:-postgres}
D=$(mktemp -d /tmp/gh3460pg.XXXXXX); chown "$AS" "$D"; PORT=${PGPORT_LOCAL:-54360}
as() { runuser -u "$AS" -- "$@"; }
as "$PGBIN/initdb" -D "$D/data" -A trust >/dev/null
as "$PGBIN/pg_ctl" -D "$D/data" -o "-p $PORT -k $D -c listen_addresses=''" -l "$D/log" -w start >/dev/null
trap 'as "$PGBIN/pg_ctl" -D "$D/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$D"' EXIT
P="$PGBIN/psql -X -q -v ON_ERROR_STOP=1 -h $D -p $PORT -U $AS -d postgres"
PNS="$PGBIN/psql -X -q -1 -v ON_ERROR_STOP=1 -h $D -p $PORT -U $AS -d postgres"
F29="$SQL/migrations_applied_manually/20261105194055_gh3229_partner_measurement_fee.sql"
FWD="$SQL/migrations_drafts/gh3460_held_fee_release.sql"
RB="$SQL/migrations_drafts/gh3460_held_fee_release_rollback.sql"
PROOF="$SQL/tests/gh3460_held_fee_release_proof.sql"
strip() { grep -v -E '^(BEGIN|COMMIT);$' "$1"; }
$P -f "$SQL/tests/local_pg16/00_stub_schema.sql"
$P -f "$HERE/gh3229_local_stub_extras.sql"
$P -f "$HERE/gh3460_local_stub_extras.sql"
run_proof() { $PNS -f "$1" 2>&1 | sed 's/^psql:[^ ]* //' | grep -v '^CONTEXT' | sed -n '/ERROR:/,$p' || true; }
splice() { awk -v a="$(strip "$F29")" -v b="$(strip "$FWD")" '/^-- @@MIGRATION_3229@@/ { print a; next } /^-- @@MIGRATION@@/ { print b; next } { print }' "$PROOF"; }
mutate() { splice > "$D/orig.sql"; sed "$1" "$D/orig.sql" > "$D/mut.sql"
  cmp -s "$D/orig.sql" "$D/mut.sql" && { echo "mutant did not change the SQL" >&2; exit 1; }
  echo "== MUTANT: $2"; run_proof "$D/mut.sql"; }
case "$MODE" in
  before) echo "== BEFORE (no migrations): negative control"; run_proof "$PROOF" ;;
  after)  echo "== AFTER gh3229 + gh3460"; splice > "$D/after.sql"; run_proof "$D/after.sql" ;;
  mutant-wide-arm)   mutate "s/WHEN (OLD.requested_by_role = 'unspecified' AND NEW.requested_by_role = 'homeowner' AND/WHEN (NEW.requested_by_role = 'homeowner' AND/" "trigger arm fires on any role change" ;;
  mutant-no-refusal) mutate "s/IF NOT FOUND AND COALESCE(p_require_fee, true) THEN/IF false THEN/" "settlement never refused" ;;
  mutant-no-admin)   splice > "$D/orig.sql"
                     awk 'BEGIN{n=0} /IF NOT \(COALESCE\(auth.role\(\), .*\) = .service_role. OR .*is_admin_email\(\).*\) THEN/ { n++; if (n==2) { sub(/IF NOT \(.*\) THEN/, "IF false THEN") } } { print }' "$D/orig.sql" > "$D/mut.sql"
                     cmp -s "$D/orig.sql" "$D/mut.sql" && { echo "mutant did not change the SQL" >&2; exit 1; }
                     echo "== MUTANT: admin check off in admin_settle_order_buyer_role"; run_proof "$D/mut.sql" ;;
  mutant-null-guard) mutate "s/OR COALESCE(public.is_admin_email(), false)) THEN/OR public.is_admin_email()) THEN/" "old NULL-unsafe admin guard restored" ;;
  mutant-null-require) mutate "s/IF NOT FOUND AND COALESCE(p_require_fee, true) THEN/IF NOT FOUND AND p_require_fee THEN/" "NULL p_require_fee skips the refusal" ;;
  mutant-no-upgrade) mutate "s/ AND NEW.product_code IS DISTINCT FROM 'roof_upgrade_detailed')/)/; s/IF p_role = 'homeowner' AND v_order.product_code IS NOT DISTINCT FROM 'roof_upgrade_detailed' THEN/IF false THEN/" "upgrade exclusion removed (trigger and function)" ;;
  mutant-no-contractor-check)  mutate "s/IF p_role = 'contractor' AND NOT EXISTS (SELECT 1 FROM public.contractors WHERE id = p_contractor_id) THEN/IF false THEN/" "contractor id not validated" ;;
  mutant-no-contractor-repeat) mutate "s/IF p_role = 'contractor' AND v_order.requested_by_contractor_id IS DISTINCT FROM p_contractor_id THEN/IF false THEN/" "differing contractor id on a repeat accepted" ;;
  mutant-no-missing-fee)       mutate "s/IF p_role = 'homeowner' AND v_fee.id IS NULL THEN/IF false THEN/" "fee-less homeowner repeat reports plain success" ;;
  mutant-copy-checks) mutate "s/IF upper(btrim(v_state)) IN ('OK', 'AR', 'KS', 'NE', 'MS') THEN/IF false THEN/" "excluded-state check removed from the single accrual function" ;;
  rollback)
    $P -f "$F29"; $P -f "$FWD"
    echo "== both applied for real in the throwaway DB; now the gh3460 rollback"
    $P -f "$RB"
    $P -At -c "SELECT 'leftovers (want 0): ' || count(*) FROM (SELECT 1 FROM pg_proc WHERE proname='admin_settle_order_buyer_role' UNION ALL SELECT 1 FROM pg_trigger WHERE tgname='partner_fee_accrue_on_role_settled') x"
    $P -At -c "SELECT 'gh3229 insert trigger intact (want 1): ' || count(*) FROM pg_trigger WHERE tgname='partner_fee_accrue_on_order'"
    echo "== re-apply after rollback (idempotent forward)"; $P -f "$FWD"; $P -At -c "SELECT 'after re-apply (want 2): ' || count(*) FROM (SELECT 1 FROM pg_proc WHERE proname='admin_settle_order_buyer_role' UNION ALL SELECT 1 FROM pg_trigger WHERE tgname='partner_fee_accrue_on_role_settled') x" ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
