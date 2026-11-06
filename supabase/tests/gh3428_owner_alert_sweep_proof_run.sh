#!/usr/bin/env bash
# gh-3428: run the owner-alert-sweep SQL proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3428_owner_alert_sweep_proof_run.sh [outdir]
# Phases in one fresh database: BEFORE (negative control: nothing installed) -> AFTER (forward + cron file, full scenario)
#   -> forward run a second time (idempotent) -> ROLLBACK (must look like BEFORE) -> REAPPLIED (forward again).
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
DB=gh3428_proof; rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh3428_throwaway_schema.sql" >/dev/null || exit 2
digest() { psql -q -At -d "$DB" -c "SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM (SELECT * FROM public.claims) t" -c "SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM (SELECT * FROM public.hover_orders) t" -c "SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) FROM (SELECT * FROM public.profiles) t"; }
pass() { psql -q -At -d "$DB" -v phase="$1" -f "$T/gh3428_owner_alert_sweep_proof.sql" > "$OUT/$1.txt" 2> "$OUT/$1.err"; echo "== $1"; cat "$OUT/$1.txt"; cat "$OUT/$1.err"; grep -q '^FAILING=0 of' "$OUT/$1.txt" || fail "$1 has failing rows"; }
digest > "$OUT/data.before"
pass BEFORE
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3428_owner_alert_sweep.sql" >/dev/null || fail "forward (schema) failed"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3428_owner_alert_sweep_cron.sql" >/dev/null || fail "forward (cron) failed"
digest > "$OUT/data.afterforward"
pass AFTER
digest > "$OUT/data.afterscenario"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3428_owner_alert_sweep.sql" >/dev/null || fail "forward not idempotent (schema)"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3428_owner_alert_sweep_cron.sql" >/dev/null || fail "forward not idempotent (cron)"
[ "$(psql -q -At -d "$DB" -c "SELECT count(*) FROM cron.job WHERE jobname='gh3428-owner-alert-sweep'")" = 1 ] || fail "cron job doubled on re-run"
# Rollback section 1 alone stops the schedule and leaves the table.
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB/gh3428_owner_alert_sweep_rollback.sql" >/dev/null || fail "rollback failed"
[ "$(psql -q -At -d "$DB" -c "SELECT count(*) FROM cron.job")" = 0 ] || fail "cron job survived rollback"
# Rollback is safe to run twice.
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB/gh3428_owner_alert_sweep_rollback.sql" >/dev/null || fail "rollback not idempotent"
digest > "$OUT/data.afterrollback"
pass ROLLBACK
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3428_owner_alert_sweep.sql" >/dev/null || fail "forward after rollback failed"
pass REAPPLIED
# The sweep never wrote the payment-path tables: the scenario's own inserts are the only change; forward and rollback add and remove no row in them.
diff "$OUT/data.before" "$OUT/data.afterforward" >/dev/null || fail "forward changed claims/hover_orders/profiles"
diff "$OUT/data.before" "$OUT/data.afterrollback" >/dev/null && fail "expected the scenario's inserts to differ from BEFORE (sanity)"
echo "== claims/hover_orders/profiles digest BEFORE vs AFTER FORWARD (must be equal)"; diff "$OUT/data.before" "$OUT/data.afterforward" && echo equal
echo "== exit $rc (0 = every phase passed)"
exit $rc
