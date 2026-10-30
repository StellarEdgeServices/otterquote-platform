#!/usr/bin/env bash
# LOCAL throwaway Postgres 16 run of the gh-3219 (P18) proof. Never touches production.
# usage: gh3219_partner_credit_lock_local_run.sh [before|after|rollback|mutant-nolock|mutant-nolapse]
#   before   : pre-change state (the rollback file's restored functions) + the proof alone  -> the [BUG] rows differ (negative control)
#   after    : the forward migration body spliced into the proof                           -> every row OK
#   rollback : after, then the rollback file; prints prosrc md5 of the three restored functions (compare to the live md5 in the rollback header)
#              and re-runs the proof alone (the [BUG] rows differ again)
#   mutant-nolapse: after, but the lock never lapses in claims_apply_locked_referral() (LAPSE-CHECK forced true) -> S10/S10b/S11/S11b rows must go DIFF
#   mutant-nolock : after, but claims_apply_locked_referral() is replaced by a no-op -> S2/S2b/S9 rows must go DIFF (proof is sensitive to the lock)
# Needs PG16 binaries (PGBIN, default /usr/lib/postgresql/16/bin) and a user that may run initdb (PGRUN_AS, default postgres).
set -euo pipefail
MODE=${1:-after}
HERE=$(cd "$(dirname "$0")" && pwd); SQL=$(cd "$HERE/.." && pwd)
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; AS=${PGRUN_AS:-postgres}
D=$(mktemp -d /tmp/gh3219pg.XXXXXX); chown "$AS" "$D"; PORT=${PGPORT_LOCAL:-54339}
as() { runuser -u "$AS" -- "$@"; }
as "$PGBIN/initdb" -D "$D/data" -A trust >/dev/null
as "$PGBIN/pg_ctl" -D "$D/data" -o "-p $PORT -k $D -c listen_addresses=''" -l "$D/log" -w start >/dev/null
trap 'as "$PGBIN/pg_ctl" -D "$D/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$D"' EXIT
P="$PGBIN/psql -X -q -v ON_ERROR_STOP=1 -h $D -p $PORT -U $AS -d postgres"
PNS="$PGBIN/psql -X -q -1 -v ON_ERROR_STOP=1 -h $D -p $PORT -U $AS -d postgres"   # proof run: the forced exception is the expected exit
FWD="$SQL/migrations_drafts/gh3219_partner_credit_lock.sql"
RB="$SQL/migrations_drafts/gh3219_partner_credit_lock_rollback.sql"
PROOF="$SQL/tests/gh3219_partner_credit_lock_proof.sql"
strip() { grep -v -E '^(BEGIN|COMMIT);$' "$1"; }
$P -f "$SQL/tests/local_pg16/00_stub_schema.sql"
$P -f "$HERE/gh3219_local_stub_extras.sql"
# pre-change state: the three LIVE function bodies, taken from the rollback file (the rollback's DROP/DELETE statements are IF EXISTS-safe on a fresh schema)
$P -f "$RB"
# the live window function is postgres-only; the stub proof runs as the superuser so that is fine
run_proof() { # $1 = proof file ; prints the forced-exception message
  $PNS -f "$1" 2>&1 | sed 's/^psql:[^ ]* //' | grep -v '^CONTEXT' || true
}
splice() { # forward body (no BEGIN/COMMIT) into the proof at the marker
  awk -v fwd="$(strip "$FWD")" '/^-- @@MIGRATION@@/ { print fwd; next } { print }' "$PROOF"
}
case "$MODE" in
  before)  echo "== BEFORE the fix (negative control)"; run_proof "$PROOF" ;;
  after)   echo "== AFTER the fix"; splice > "$D/after.sql"; run_proof "$D/after.sql" ;;
  mutant-nolock)
    echo "== MUTANT: claims_apply_locked_referral() is a no-op"
    splice | sed -E 's#^ *NEW\.referral_id +:= v_ref_id;#  -- MUTANT#; s#^ *NEW\.referral_agent_id +:= v_agent;#  -- MUTANT#' > "$D/mut.sql"
    grep -c 'MUTANT' "$D/mut.sql" | sed 's/^/mutated lines: /'
    run_proof "$D/mut.sql" ;;
  mutant-nolapse)
    echo "== MUTANT: the lock never lapses at claim time"
    splice | sed 's#IF v_clicked >= now() - public.referral_attribution_window() THEN   -- LAPSE-CHECK: the lock is live#IF true THEN   -- MUTANT#' > "$D/mutl.sql"
    grep -c 'MUTANT' "$D/mutl.sql" | sed 's/^/mutated lines: /'
    run_proof "$D/mutl.sql" ;;
  rollback)
    $P -f "$FWD"
    echo "== forward applied for real in the throwaway DB; now the rollback"
    $P -f "$RB"
    $P -At -c "SELECT proname, md5(prosrc), provolatile FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('advance_referral_registered','claims_advance_referral','referral_attribution_window') ORDER BY 1"
    $P -At -c "SELECT 'leftovers (want 0): ' || count(*) FROM (SELECT 1 FROM pg_proc WHERE proname IN ('get_locked_referral_id','claims_apply_locked_referral') UNION ALL SELECT 1 FROM pg_trigger WHERE tgname='claims_lock_referral' UNION ALL SELECT 1 FROM information_schema.columns WHERE table_name='referrals' AND column_name='homeowner_user_id' UNION ALL SELECT 1 FROM pg_indexes WHERE indexname='referrals_homeowner_user_id_locked_key' UNION ALL SELECT 1 FROM public.platform_settings WHERE key='partner_attribution_window_days') x"
    echo "== proof alone after rollback (the [BUG] rows differ again)"; run_proof "$PROOF" ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
