#!/usr/bin/env bash
# gh-3237: prove gh3237_reserved_slugs_add on a THROWAWAY Postgres 16. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3237_reserved_slugs_add_proof_run.sh [outdir]
# Base: gh3239_throwaway_schema.sql (roles, auth.*, referral_agents) + platform_settings + p18_vanity_slug_data.sql (the applied
# reserved_slugs set, ledger 20261030141912). Phases: BEFORE (negative control: both names NOT reserved) -> AFTER -> re-run -> AFTER
# -> ROLLBACK (back to BEFORE) and a row-count check that the rollback deleted exactly two rows.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; T=supabase/tests; DB=gh3237_proof; rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null 2>&1 || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh3239_throwaway_schema.sql" >/dev/null || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS public.platform_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz DEFAULT now())" >/dev/null || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/p18_vanity_slug_data.sql" >/dev/null 2>&1 || { echo "base p18_vanity_slug_data failed"; exit 2; }
chk() { psql -q -At -d "$DB" -v phase="$2" -f "$T/gh3237_reserved_slugs_add_check.sql" > "$OUT/$1.txt" 2>&1; echo "== $1"; cat "$OUT/$1.txt"; grep -q '^FAILING=0$' "$OUT/$1.txt" || fail "$1"; }
n0=$(psql -At -d "$DB" -c "SELECT count(*) FROM public.reserved_slugs")
chk 1-BEFORE before
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3237_reserved_slugs_add.sql" >/dev/null || fail "forward failed"
chk 2-AFTER after
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3237_reserved_slugs_add.sql" >/dev/null || fail "forward re-run failed"
n1=$(psql -At -d "$DB" -c "SELECT count(*) FROM public.reserved_slugs")
[ "$n1" = "$((n0 + 2))" ] || fail "forward should add exactly 2 rows (before $n0, after $n1)"
chk 3-AFTER-RERUN after
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3237_reserved_slugs_add_rollback.sql" >/dev/null || fail "rollback failed"
n2=$(psql -At -d "$DB" -c "SELECT count(*) FROM public.reserved_slugs")
[ "$n2" = "$n0" ] || fail "rollback should delete exactly the 2 rows (before $n0, after rollback $n2)"
chk 4-ROLLBACK before
# negative control: the AFTER expectations must FAIL on the rolled-back database
psql -q -At -d "$DB" -v phase=after -f "$T/gh3237_reserved_slugs_add_check.sql" > "$OUT/nc.txt" 2>&1
grep -q '^FAILING=3$' "$OUT/nc.txt" && echo "== NEGATIVE CONTROL: after-expectations fail on the rolled-back database (3 rows) (OK)" || fail "negative control: $(cat "$OUT/nc.txt")"
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
echo "seed rows: before=$n0 after=$n1 rollback=$n2"; echo "RUNNER rc=$rc"; exit $rc
