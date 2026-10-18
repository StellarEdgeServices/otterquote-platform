#!/usr/bin/env bash
# gh-2710: run the fee/stripe-id column guard proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh2710_claims_fee_stripe_columns_guard_proof_run.sh [outdir]
# Per apply order, in one fresh database each:
#   TODAY      production's schema as read 2026-10-08 plus the other claims-guard drafts in that order (failing controls)
#   AFTER      + gh2710 forward (U1/U2/U3/U4/I1/I2 refused 42501; S1/S2/A1/I4/U5/U6/I3 accepted)
#   ROLLBACK   + gh2710 rollback (must print what TODAY printed, other guards still present)
# Orders (gh2519 always follows gh2626, the documented order A; gh2564 follows gh2519):
#   O1 gh2710 first   : gh2710, gh2491, gh2626, gh2519, gh2564
#   O2 gh2710 last    : gh2491, gh2626, gh2519, gh2564, gh2710
#   O3 gh2710 middle  : gh2626, gh2710, gh2519, gh2491, gh2564
#   O4 gh2710 alone
# Exit 0 only if every order passes every check.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
D=supabase/migrations_drafts; RB=supabase/migrations_rollbacks; T=supabase/tests
F2710=$D/gh2710_claims_fee_stripe_columns_guard.sql
declare -A F=([2491]=supabase/migrations/20261015205709_gh2491_claims_platform_fee_charged_guard.sql [2626]=supabase/migrations/20261015205851_gh2626_claims_award_columns_guard.sql [2519]=supabase/migrations/20261015205902_gh2519_quotes_server_set_fee.sql [2564]=supabase/migrations/20261018195342_gh2564_quotes_selected_price_lock.sql [2710]=$F2710)
rc=0
fail() { echo "EXPECT FAIL: $*"; rc=1; }
run_order() {
  local name="$1"; shift
  local DB="gh2710_${name,,}_proof"
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" || exit 2
  psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2519_gh2564_throwaway_schema.sql" >/dev/null || exit 2
  pass() { psql -q -At -d "$DB" -f "$T/gh2710_claims_fee_stripe_columns_guard_proof.sql" > "$OUT/$name-$1.txt" 2> "$OUT/$name-$1.err"; echo "== $name $1"; cat "$OUT/$name-$1.txt"; grep -q 'undo: gh2710 proof rolled back' "$OUT/$name-$1.err" || fail "$name $1: proof did not end in its RAISE undo"; }
  local others=()
  for k in "$@"; do [ "$k" = 2710 ] || others+=("$k"); done
  # apply the others in order, with gh2710 at its position, but run TODAY before gh2710 is in the stack
  for k in "${others[@]}"; do psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "${F[$k]}" >/dev/null 2>"$OUT/$name-apply-$k.err" || fail "$name: apply $k failed"; done
  pass 1-TODAY
  psql -q -d "$DB" -c "DROP TRIGGER IF EXISTS claims_guard_fee_stripe_columns ON public.claims" >/dev/null 2>&1
  # now rebuild the real order: fresh db, apply in the listed order
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" >/dev/null
  psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$T/gh2519_gh2564_throwaway_schema.sql" >/dev/null
  for k in "$@"; do psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "${F[$k]}" >/dev/null 2>"$OUT/$name-order-$k.err" || fail "$name: ordered apply $k failed"; done
  pass 2-AFTER
  psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$RB/gh2710_claims_fee_stripe_columns_guard_rollback.sql" >/dev/null || fail "$name: rollback failed"
  pass 3-ROLLBACK
  # verdicts
  grep -q '^U1 .*ACCEPTED' "$OUT/$name-1-TODAY.txt" || fail "$name: U1 must be ACCEPTED today"
  grep -q '^U1 .*REJECTED 42501' "$OUT/$name-2-AFTER.txt" || fail "$name: U1 must be REJECTED 42501 after"
  for k in U2 U3 U4 I1 I2; do grep -q "^$k .*REJECTED 42501" "$OUT/$name-2-AFTER.txt" || fail "$name: $k must be REJECTED 42501 after"; done
  for k in U5 U6 S1 S2 A1 I3 I4; do grep -q "^$k .*ACCEPTED" "$OUT/$name-2-AFTER.txt" || fail "$name: $k must be ACCEPTED after"; done
  grep -q '^END .*: 0$' "$OUT/$name-2-AFTER.txt" || fail "$name: owner claims must hold no forged value after"
  diff <(sed '/^GUARD /d' "$OUT/$name-1-TODAY.txt") <(sed '/^GUARD /d' "$OUT/$name-3-ROLLBACK.txt") >/dev/null && echo "$name: ROLLBACK matches TODAY (GUARD line excluded)" || fail "$name: ROLLBACK differs from TODAY"
  # the other guards must survive our rollback and not have been touched by our apply
  for k in "${others[@]}"; do
    case $k in
      2491) q="select count(*) from pg_trigger where tgrelid='public.claims'::regclass and tgname='claims_guard_platform_fee_charged'";;
      2626) q="select count(*) from pg_trigger where tgrelid='public.claims'::regclass and tgname='claims_guard_award_columns'";;
      2519) q="select (to_regprocedure('public.quotes_platform_fee_for(uuid,uuid)') is not null)::int";;
      2564) q="select (prosrc like '%gh-2564%')::int from pg_proc where proname='quotes_guard_homeowner_columns'";;
    esac
    [ "$(psql -At -d "$DB" -c "$q")" = "1" ] && echo "$name: gh$k object still present after gh2710 rollback" || fail "$name: gh$k object missing after gh2710 rollback"
  done
}
run_order O1 2710 2491 2626 2519 2564
run_order O2 2491 2626 2519 2564 2710
run_order O3 2626 2710 2519 2491 2564
run_order O4 2710
echo "EXIT=$rc"; exit $rc
