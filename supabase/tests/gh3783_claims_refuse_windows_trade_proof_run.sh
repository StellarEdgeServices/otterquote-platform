#!/usr/bin/env bash
# gh-3783 (D-375): prove supabase/migrations_drafts/gh3783_claims_refuse_windows_trade.sql on a THROWAWAY Postgres. Never point at production.
# usage: bash supabase/tests/gh3783_claims_refuse_windows_trade_proof_run.sh   (PGBIN default /usr/lib/postgresql/16/bin; runs as postgres if root)
# TODAY (no migration) = negative control: every refused case is ACCEPTED. AFTER (forward, applied twice) = refused/accepted as expected.
# ROLLBACK (forward then rollback twice) = same as TODAY. Exit 0 only if every expectation holds.
set -uo pipefail
cd "$(dirname "$0")/../.."
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; AS=${PGRUN_AS:-postgres}; PORT=${PGPORT_LOCAL:-54383}
D=$(mktemp -d /tmp/gh3783pg.XXXXXX); chown "$AS" "$D" 2>/dev/null || true
as() { if [ "$(id -u)" = 0 ]; then runuser -u "$AS" -- "$@"; else "$@"; fi; }
as "$PGBIN/initdb" -D "$D/data" -A trust >/dev/null || exit 2
as "$PGBIN/pg_ctl" -D "$D/data" -o "-p $PORT -k $D -c listen_addresses=''" -l "$D/log" -w start >/dev/null || exit 2
trap 'as "$PGBIN/pg_ctl" -D "$D/data" -m immediate stop >/dev/null 2>&1; rm -rf "$D"' EXIT
F=$PWD/supabase/migrations_drafts/gh3783_claims_refuse_windows_trade.sql; R=$PWD/supabase/migrations_drafts/gh3783_claims_refuse_windows_trade_rollback.sql
Q() { as "$PGBIN/psql" -X -q -At -h "$D" -p "$PORT" -U "$AS" -d g "$@" 2>&1; }
rc=0
# $1 label, $2 sql, $3 expectation for this phase: ok|refused
t() { out=$(Q -c "$2"); if echo "$out" | grep -q "gh-3783"; then got=refused; else got=ok; fi
      if [ "$got" = "$3" ]; then echo "  PASS [$PHASE] $1 -> $got"; else echo "  FAIL [$PHASE] $1 -> $got (want $3): $out"; rc=1; fi; }
phase() { # $1 name, $2 refused-expectation (refused|ok), then files to apply
  PHASE=$1; X=$2; shift 2
  as "$PGBIN/psql" -X -q -h "$D" -p "$PORT" -U "$AS" -d postgres -c "DROP DATABASE IF EXISTS g" -c "CREATE DATABASE g" >/dev/null
  Q -c "create table public.claims(id serial primary key, trades text[] default '{}', roofing_bid_released_at timestamptz, windows_bid_released_at timestamptz, status text, ready_for_bids boolean)" >/dev/null
  for f in "$@"; do Q -f "$f" >/dev/null; done
  t "insert roofing" "insert into public.claims(trades) values ('{roofing}')" ok
  t "insert NULL trades" "insert into public.claims(trades) values (NULL)" ok
  t "insert windows" "insert into public.claims(trades) values ('{windows}')" $X
  t "insert roofing+windows (mixed)" "insert into public.claims(trades) values ('{roofing,windows}')" $X
  t "insert ' Windows '" "insert into public.claims(trades) values ('{\" Windows \"}')" $X
  t "insert roofing + windows stamp" "insert into public.claims(trades, windows_bid_released_at) values ('{roofing}', now())" $X
  t "update add windows" "update public.claims set trades='{roofing,windows}' where id=1" $X
  t "update stamp windows" "update public.claims set windows_bid_released_at=now() where id=1" $X
  t "submit payload (status, ready_for_bids, roofing stamp)" "update public.claims set status='active', ready_for_bids=true, roofing_bid_released_at=now() where id=1" ok
}
phase TODAY ok
phase AFTER refused "$F" "$F"
phase ROLLBACK ok "$F" "$R" "$R"
[ $rc = 0 ] && echo "ALL EXPECTATIONS HOLD" || echo "EXPECTATION FAILED"
exit $rc
