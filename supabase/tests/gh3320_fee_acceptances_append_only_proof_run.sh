#!/usr/bin/env bash
# gh-3320: run the fee_acceptances append-only proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGUSER=postgres bash supabase/tests/gh3320_fee_acceptances_append_only_proof_run.sh [outdir]
# Phases in one fresh database: 1-BEFORE (today; negative control) -> 2-AFTER (forward) -> 3-ROLLBACK (must look like BEFORE) -> 4-REAPPLIED (forward again, after a repeat run of the forward file).
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
DB=gh3320_proof; rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh3320_throwaway_schema.sql" >/dev/null || exit 2
snap() { psql -q -At -d "$DB" -c "SELECT relacl::text FROM pg_class WHERE oid='public.fee_acceptances'::regclass" -c "SELECT policyname||'|'||cmd||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'') FROM pg_policies WHERE schemaname='public' AND tablename='fee_acceptances' ORDER BY policyname" > "$OUT/$1.snap"; }
pass() { psql -q -At -d "$DB" -f "$T/gh3320_fee_acceptances_append_only_proof.sql" > "$OUT/$1.txt" 2> "$OUT/$1.err"; echo "== $1"; cat "$OUT/$1.txt"; cat "$OUT/$1.err"; snap "$1"; }
pass 1-BEFORE
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3320_fee_acceptances_append_only.sql" >/dev/null || fail "forward failed"
pass 2-AFTER
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3320_fee_acceptances_append_only.sql" >/dev/null || fail "forward not idempotent"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB/gh3320_fee_acceptances_append_only_rollback.sql" >/dev/null || fail "rollback failed"
pass 3-ROLLBACK
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3320_fee_acceptances_append_only.sql" >/dev/null || fail "forward after rollback failed"
pass 4-REAPPLIED
for p in 1-BEFORE 2-AFTER 3-ROLLBACK 4-REAPPLIED; do grep -q '^FAILING=0 of' "$OUT/$p.txt" || fail "$p has failing rows"; done
diff "$OUT/1-BEFORE.snap" "$OUT/3-ROLLBACK.snap" >/dev/null || fail "ROLLBACK grants/policies differ from BEFORE"
diff "$OUT/2-AFTER.snap" "$OUT/4-REAPPLIED.snap" >/dev/null || fail "REAPPLIED differs from AFTER"
diff "$OUT/1-BEFORE.snap" "$OUT/2-AFTER.snap" >/dev/null && fail "AFTER identical to BEFORE (forward changed nothing)"
echo "== grants/policies BEFORE vs AFTER (diff)"; diff "$OUT/1-BEFORE.snap" "$OUT/2-AFTER.snap"
echo "RUNNER rc=$rc"; exit $rc
