#!/usr/bin/env bash
# gh-3471 coverage: run the guarantee_covered proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGUSER=postgres bash supabase/tests/gh3471_guarantee_covered_proof_run.sh [outdir]
# Phases in one fresh database: 1-BEFORE (negative control) -> 2-AFTER (forward) -> forward again (idempotent) -> 3-ROLLBACK (must look like BEFORE) -> 4-REAPPLIED.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
DB=gh3471_cov_proof; rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" || exit 2
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh3471_guarantee_covered_throwaway_schema.sql" >/dev/null || exit 2
snap() { psql -q -At -d "$DB" -c "SELECT column_name||'|'||data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='hover_orders' ORDER BY column_name" -c "SELECT conname||'|'||pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.hover_orders'::regclass ORDER BY conname" -c "SELECT key||'|'||value::text FROM public.platform_settings ORDER BY key" -c "SELECT admin_notes||'|'||coalesce(guarantee_started_at::text,'') FROM public.hover_orders ORDER BY admin_notes" > "$OUT/$1.snap"; }
pass() { PGOPTIONS="-c gh3471.phase=$2" psql -q -At -d "$DB" -v phase="$2" -f "$T/gh3471_guarantee_covered_proof.sql" > "$OUT/$1.txt" 2> "$OUT/$1.err"; echo "== $1"; cat "$OUT/$1.txt" "$OUT/$1.err"; snap "$1"; }
pass 1-BEFORE before
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3471_guarantee_covered.sql" >/dev/null || fail "forward failed"
pass 2-AFTER after
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3471_guarantee_covered.sql" >/dev/null || fail "forward not idempotent"
pass 2b-AFTER-RERUN after
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB/gh3471_guarantee_covered_rollback.sql" >/dev/null || fail "rollback failed"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB/gh3471_guarantee_covered_rollback.sql" >/dev/null || fail "rollback not idempotent"
pass 3-ROLLBACK rollback
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$D/gh3471_guarantee_covered.sql" >/dev/null || fail "forward after rollback failed"
pass 4-REAPPLIED after
for p in 1-BEFORE 2-AFTER 2b-AFTER-RERUN 3-ROLLBACK 4-REAPPLIED; do grep -q '^FAILING=0 of' "$OUT/$p.txt" || fail "$p has failing rows"; [ -s "$OUT/$p.err" ] && fail "$p wrote to stderr"; done
diff "$OUT/1-BEFORE.snap" "$OUT/3-ROLLBACK.snap" >/dev/null || fail "ROLLBACK differs from BEFORE"
diff "$OUT/2-AFTER.snap" "$OUT/4-REAPPLIED.snap" >/dev/null || fail "REAPPLIED differs from AFTER"
diff "$OUT/1-BEFORE.snap" "$OUT/2-AFTER.snap" >/dev/null && fail "AFTER identical to BEFORE (forward changed nothing)"
echo "== schema BEFORE vs AFTER (diff)"; diff "$OUT/1-BEFORE.snap" "$OUT/2-AFTER.snap"
# Pre-flight document: every sql check runs on the BEFORE state without error.
PF="$OUT/preflight"; mkdir -p "$PF"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB/gh3471_guarantee_covered_rollback.sql" >/dev/null
awk '/^```sql/{on=1;next} /^```/{on=0;exit} on' "$RB/gh3471_guarantee_covered_pre-flight.md" > "$PF/checks.sql"
[ -s "$PF/checks.sql" ] || fail "pre-flight sql block not found"
psql -d "$DB" -A -f "$PF/checks.sql" > "$PF/checks.out" 2> "$PF/checks.err"; echo "== pre-flight checks on the BEFORE state"; cat "$PF/checks.out"
[ -s "$PF/checks.err" ] && fail "pre-flight raised: $(head -1 "$PF/checks.err")"
psql -q -d postgres -c "DROP DATABASE $DB"
# Seed (Dustin 2026-11-09 list): applies after the forward file, is idempotent, keeps the order, refuses without the table, leaves a different value alone, rollback is exact.
SD=gh3471_seed_proof; SEED="$D/gh3471_guarantee_excluded_states_seed.sql"; SRB="$RB/gh3471_guarantee_excluded_states_seed_rollback.sql"
LIST='["FL", "LA", "TX", "OK", "AR", "KS", "NE", "MI", "KY"]'
psql -q -d postgres -c "DROP DATABASE IF EXISTS $SD" -c "CREATE DATABASE $SD" || exit 2
psql -q -d "$SD" -v ON_ERROR_STOP=1 -f "$T/gh3471_guarantee_covered_throwaway_schema.sql" -f "$D/gh3471_guarantee_covered.sql" >/dev/null 2>&1 || exit 2
psql -q -d "$SD" -v ON_ERROR_STOP=1 -f "$SEED" >/dev/null 2>"$OUT/seed1.err" || fail "seed failed"
v=$(psql -q -At -d "$SD" -c "SELECT value::text FROM public.platform_settings WHERE key='guarantee_excluded_states'"); echo "SEED list after apply: $v"; [ "$v" = "$LIST" ] || fail "seed list is not exactly Dustin's nine in order: $v"
src=$(psql -q -At -d "$SD" -c "SELECT value->>'source' || ' | ' || (value->>'date') FROM public.platform_settings WHERE key='guarantee_excluded_states_source'"); echo "SEED source: $src"
[ "$src" = '#3471: excluded states are FL, LA, TX, OK, AR, KS, NE, MI, KY (Dustin 11-09), stored as config. | 2026-11-09' ] || fail "seed source text is not Dustin's sentence + date"
psql -q -d "$SD" -v ON_ERROR_STOP=1 -f "$SEED" >/dev/null 2>"$OUT/seed2.err" || fail "seed not idempotent"
grep -q WARNING "$OUT/seed2.err" && fail "re-seed with the same value warned"
n=$(psql -q -At -d "$SD" -c "SELECT count(*) FROM public.platform_settings WHERE key LIKE 'guarantee_excluded_states%'"); echo "SEED rows after re-run: $n"; [ "$n" = 2 ] || fail "re-seed changed the row count: $n"
o=$(psql -q -At -d "$SD" -c "SELECT string_agg(e, ',' ORDER BY i) FROM jsonb_array_elements_text((SELECT value FROM public.platform_settings WHERE key='guarantee_excluded_states')) WITH ORDINALITY t(e,i)"); echo "SEED order: $o"; [ "$o" = "FL,LA,TX,OK,AR,KS,NE,MI,KY" ] || fail "seed order wrong"
psql -q -d "$SD" -v ON_ERROR_STOP=1 -f "$SRB" -f "$SRB" >/dev/null || fail "seed rollback failed / not idempotent"
n=$(psql -q -At -d "$SD" -c "SELECT count(*) FROM public.platform_settings WHERE key LIKE 'guarantee_excluded_states%'"); echo "SEED rows after rollback x2: $n"; [ "$n" = 0 ] || fail "rollback left seeded rows"
o2=$(psql -q -At -d "$SD" -c "SELECT count(*) FROM public.platform_settings WHERE key='homeowner_blocked_states'"); [ "$o2" = 1 ] || fail "rollback touched another key"
# a later ruling (MI -> MS) wins: re-seed warns and leaves it; rollback does not delete it
psql -q -d "$SD" -c "INSERT INTO public.platform_settings (key, value) VALUES ('guarantee_excluded_states', '[\"FL\",\"LA\",\"TX\",\"OK\",\"AR\",\"KS\",\"NE\",\"MS\",\"KY\"]')" >/dev/null
psql -q -d "$SD" -v ON_ERROR_STOP=1 -f "$SEED" >/dev/null 2>"$OUT/seed3.err" || fail "seed over a changed list failed"
grep -q 'already held a different value' "$OUT/seed3.err" && echo "SEED over a changed list: WARNING raised, value kept" || fail "seed over a changed list did not warn"
v3=$(psql -q -At -d "$SD" -c "SELECT value->>7 FROM public.platform_settings WHERE key='guarantee_excluded_states'"); [ "$v3" = MS ] || fail "seed overwrote a later ruling"
psql -q -d "$SD" -v ON_ERROR_STOP=1 -f "$SRB" >/dev/null
v4=$(psql -q -At -d "$SD" -c "SELECT count(*) FROM public.platform_settings WHERE key='guarantee_excluded_states'"); echo "SEED rollback over a changed list keeps it: $v4 row"; [ "$v4" = 1 ] || fail "rollback deleted a changed list"
psql -q -d postgres -c "DROP DATABASE $SD"
# guard: no platform_settings table -> refused, exit non-zero, nothing created
psql -q -d postgres -c "CREATE DATABASE $SD" || exit 2
psql -q -d "$SD" -v ON_ERROR_STOP=1 -f "$SEED" >/dev/null 2>"$OUT/seed4.err"; g=$?; echo "SEED guard without the table: exit $g, $(grep -o 'gh3471 seed refused[^"]*' "$OUT/seed4.err" | head -1)"
[ "$g" != 0 ] && grep -q 'gh3471 seed refused' "$OUT/seed4.err" || fail "seed guard did not refuse"
psql -q -d postgres -c "DROP DATABASE $SD"
echo "RUNNER rc=$rc"; exit $rc
