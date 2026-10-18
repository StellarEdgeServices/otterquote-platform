#!/usr/bin/env bash
# gh-2803: before/after proof of supabase/migrations_drafts/gh2803_quotes_notes_signed_lock.sql on a THROWAWAY Postgres 16. Never point this at production.
# Usage: RPC_SQL=<path to gh2803_selected_bid_notes_rpc.sql from PR #2844> PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh2803_notes_signed_lock_proof_run.sh [outdir]
# (NOTE: *.sh is in .gitignore; committed with `git add -f` like the gh2519/gh2564 runners.)
# Schema: gh2519_gh2564_throwaway_schema.sql, then main's gh2626 -> gh2519 -> gh2564, then PR #2844's RPC. Passes of the proof:
#   P1 BEFORE (no trigger)   P2 AFTER (trigger applied)   P3 after its rollback (must equal P1)   P4 re-applied (must equal P2)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"; DB=gh2803_notes_proof
: "${RPC_SQL:?set RPC_SQL to the PR #2844 gh2803_selected_bid_notes_rpc.sql}"
M=supabase/migrations; D=supabase/migrations_drafts; T=supabase/tests
rc=0
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
apply() { psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }
apply "$T/gh2519_gh2564_throwaway_schema.sql"
apply "$M/20261015205851_gh2626_claims_award_columns_guard.sql"; apply "$M/20261015205902_gh2519_quotes_server_set_fee.sql"; apply "$M/20261018195342_gh2564_quotes_selected_price_lock.sql"
apply "$RPC_SQL"
GUARD0=$(psql -q -At -d "$DB" -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.quotes_guard_homeowner_columns()'::regprocedure")
pass() { psql -q -At -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2803_notes_signed_lock_proof.sql" | sed '/^$/d' > "$OUT/$1.txt"; echo "== $1"; cat "$OUT/$1.txt"; }
has() { grep -m1 "^$2 " "$OUT/$1.txt" | grep -qF -- "$3" && return 0; echo "EXPECTATION FAILED in $1: $2 should contain '$3'"; rc=1; }
pass P1_BEFORE
apply "$D/gh2803_quotes_notes_signed_lock.sql"; pass P2_AFTER
GUARD1=$(psql -q -At -d "$DB" -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.quotes_guard_homeowner_columns()'::regprocedure")
[ "$GUARD0" = "$GUARD1" ] && echo "guard body md5 unchanged by the migration ($GUARD0)" || { echo "GUARD BODY CHANGED"; rc=1; }
apply "$D/gh2803_quotes_notes_signed_lock_rollback.sql"; pass P3_ROLLBACK
apply "$D/gh2803_quotes_notes_signed_lock.sql"; pass P4_REAPPLY
has P1_BEFORE N1 "rows=1 ACCEPTED"; has P2_AFTER N1 "REJECTED 42501"; has P2_AFTER N1 "notes=ORIGINAL SIGNED NOTE"
for s in P1_BEFORE P2_AFTER; do
  has $s N2 "rows=1 ACCEPTED -> notes=edited before signature"; has $s N3 "rows=1 ACCEPTED -> notes=via rpc before signature"
  has $s N4 "REJECTED 22023"; has $s N5 "rows=1 ACCEPTED -> notes=service edit"; has $s N6 "rows=1 ACCEPTED"
  has $s N7 "REJECTED 42501"; has $s N9 "rows=1 ACCEPTED -> notes=owner edit"; has $s N10 "REJECTED 42501"
done
has P1_BEFORE N8 "rows=1 ACCEPTED -> notes=NULL"; has P2_AFTER N8 "REJECTED 42501"
diff "$OUT/P1_BEFORE.txt" "$OUT/P3_ROLLBACK.txt" >/dev/null && echo "P3_ROLLBACK equals P1_BEFORE" || { echo "P3 DIFFERS from P1"; rc=1; }
diff "$OUT/P2_AFTER.txt" "$OUT/P4_REAPPLY.txt" >/dev/null && echo "P4_REAPPLY equals P2_AFTER" || { echo "P4 DIFFERS from P2"; rc=1; }
echo "EXIT $rc"; exit $rc
