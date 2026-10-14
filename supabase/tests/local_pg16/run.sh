#!/usr/bin/env bash
# LOCAL throwaway Postgres 16 harness for the gh-2479 / gh-2403 proofs. Never touches production.
# usage: run.sh <proof.sql> [pre|post|mutant-nullclaimdate]
#   post (default): functions and triggers loaded from supabase/migrations/ (the live definitions).
#   pre           : apply_referral_commission() and the guards replaced by the PRE-FIX bodies
#                   (supabase/migrations_rollbacks/20261005151842_..._rollback.sql, which restores the pre-gh2479 body
#                   and drops the claims guard; the quotes guard and the born-state guard are dropped too).
#   mutant-nullclaimdate: post, then apply_referral_commission() re-created WITHOUT the `NEW.created_at IS NULL` clause
#                   (everything else live), to show S10 is sensitive to exactly that clause.
# Needs PG16 binaries (PGBIN, default /usr/lib/postgresql/16/bin) and a user that may run initdb (PGRUN_AS, default postgres).
set -euo pipefail
PROOF=$(realpath "$1"); MODE=${2:-post}
HERE=$(cd "$(dirname "$0")" && pwd); SQL=$(cd "$HERE/../.." && pwd)
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; AS=${PGRUN_AS:-postgres}
D=$(mktemp -d /tmp/gh2479pg.XXXXXX); chown "$AS" "$D"; PORT=${PGPORT_LOCAL:-54329}
as() { runuser -u "$AS" -- "$@"; }
as "$PGBIN/initdb" -D "$D/data" -A trust >/dev/null
as "$PGBIN/pg_ctl" -D "$D/data" -o "-p $PORT -k $D -c listen_addresses=''" -l "$D/log" -w start >/dev/null
trap 'as "$PGBIN/pg_ctl" -D "$D/data" -m immediate stop >/dev/null 2>&1 || true' EXIT
P="$PGBIN/psql -X -q -v ON_ERROR_STOP=1 -h $D -p $PORT -U $AS -d postgres"
strip() { grep -v -E '^(BEGIN|COMMIT);$' "$1"; }
$P -f "$HERE/00_stub_schema.sql"
M="$SQL/migrations"
# helpers the migrations call (is_admin_email, referral_attribution_window) and the completion trigger, loaded from the repo
$P -c "$(sed -n '/^CREATE OR REPLACE FUNCTION public.is_admin_email()/,/^\$\$;/p' "$M/20260621213735_p18_admin_identity_allowlist.sql")"
$P -c "$(sed -n '/^CREATE OR REPLACE FUNCTION public.referral_attribution_window()/,/^\$\$;/p' "$M/20260929180000_gh2345_referral_rpc_age_check.sql")"
if [ "$MODE" = pre ]; then
  # pre-fix: the rollback file's body (restores the pre-gh2479 apply_referral_commission, drops claims guard)
  $P -c "$(strip "$SQL/migrations_rollbacks/20261005151842_gh2479_referral_guard_and_commission_checks_rollback.sql")" 2>&1 | grep -v 'does not exist' || true
else
  $P -c "$(strip "$M/20261005151842_gh2479_referral_guard_and_commission_checks.sql")"
  $P -c "$(strip "$M/20261005203540_gh2479_born_state_guard.sql")"
  $P -c "$(strip "$M/20261006170000_gh2519_quotes_fee_columns_guard.sql")"
fi
if [ "$MODE" = mutant-nullclaimdate ]; then
  DEF=$($P -At -c "SELECT pg_get_functiondef('public.apply_referral_commission'::regproc)")
  MUT=$(printf '%s\n' "$DEF" | grep -v -F 'OR NEW.created_at IS NULL')
  [ "$MUT" != "$DEF" ] || { echo "mutant did not change the body" >&2; exit 1; }
  $P -c "$MUT"
fi
# the completion trigger (gh-1050) is the same before and after the fix
$P -c "$(sed -n '/^CREATE TRIGGER after_claim_completed/,/;$/p' "$M/20260819225113_gh1050_commission_accrual_job_completion.sql" | sed -n '1,/EXECUTE FUNCTION/p')"
$P -f "$HERE/10_seed.sql"
echo "== mode=$MODE proof=$(basename "$PROOF")"
$P -f "$PROOF" 2>&1 | sed 's/^psql:[^ ]* //' || true
