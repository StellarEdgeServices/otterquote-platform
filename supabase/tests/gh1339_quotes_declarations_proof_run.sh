#!/usr/bin/env bash
# gh-1339: run the guard proof on a THROWAWAY Postgres 16 (initdb in a temp dir, unix socket only). Never touches production.
# usage: bash supabase/tests/gh1339_quotes_declarations_proof_run.sh [outdir]   (run as root or postgres; PGBIN default /usr/lib/postgresql/16/bin)
# Pass 1 TODAY (no migration: negative control, bad bids are accepted), pass 2 AFTER (+ forward), pass 3 ROLLBACK (+ forward then rollback; must equal pass 1).
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${1:-$(mktemp -d /tmp/gh1339out.XXXXXX)}; mkdir -p "$OUT"; chmod 777 "$OUT"
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; AS=${PGRUN_AS:-postgres}
D=$(mktemp -d /tmp/gh1339pg.XXXXXX); chown "$AS" "$D"; PORT=${PGPORT_LOCAL:-54339}
as() { if [ "$(id -u)" = 0 ]; then runuser -u "$AS" -- "$@"; else "$@"; fi; }
as "$PGBIN/initdb" -D "$D/data" -A trust >/dev/null
as "$PGBIN/pg_ctl" -D "$D/data" -o "-p $PORT -k $D -c listen_addresses=''" -l "$D/log" -w start >/dev/null
trap 'as "$PGBIN/pg_ctl" -D "$D/data" -m immediate stop >/dev/null 2>&1 || true' EXIT
F=supabase/migrations_drafts/20261115170000_gh1339_quotes_section2_declarations_guard.sql
R=supabase/migrations_drafts/20261115170000_gh1339_quotes_section2_declarations_guard_rollback.sql
PS="$PGBIN/psql -X -q -At -h $D -p $PORT -U $AS"
run() { # $1 label, $2 migration prelude or empty, $3 also-rollback (1)
  as $PS -d postgres -c "DROP DATABASE IF EXISTS g" -c "CREATE DATABASE g" >/dev/null
  python3 - supabase/tests/gh1339_quotes_declarations_proof.sql "${2:-}" "${3:-}" "$R" > "$OUT/$1.sql" <<'PY'
import sys
proof=open(sys.argv[1]).read(); mig=open(sys.argv[2]).read() if sys.argv[2] else ""
if sys.argv[3]: mig += "\n" + open(sys.argv[4]).read()
print(proof.replace("-- @@MIGRATION@@", mig))
PY
  chmod 644 "$OUT/$1.sql"
  as $PS -d g -f "$OUT/$1.sql" > "$OUT/$1.txt" 2>&1 || true
  echo "=== $1"; sed -n '/GUARD PROOF/,$p;/ERROR/p' "$OUT/$1.txt"
}
run 1-TODAY ""
run 2-AFTER "$F"
run 3-ROLLBACK "$F" 1
rc=0
for k in 'N1 .*REFUSED 23514' 'N2 .*REFUSED 23514' 'N3 .*REFUSED 23514' 'N4 .*REFUSED 23514.*drip_edge' 'N5 .*REFUSED 23514.*gutters' 'N6 .*REFUSED 23514' 'P1 .*ACCEPTED' 'P2 .*ACCEPTED' 'P3 .*ACCEPTED' 'P4 .*ACCEPTED' 'P5 .*ACCEPTED' 'N7 .*REFUSED 23514' 'P6 .*ACCEPTED' 'N8 .*REFUSED 23514' 'N9 .*REFUSED 23514' 'X1a .*REFUSED 23514' 'X1b .*ACCEPTED' 'X2a .*REFUSED 23514' 'X2b .*ACCEPTED' 'X3 .*REFUSED 23514' 'FN_EXEC anon=false authenticated=false'; do
  grep -Eq "$k" "$OUT/2-AFTER.txt" || { echo "EXPECT FAIL (after): $k"; rc=1; }; done
for k in 'N1 .*ACCEPTED' 'N3 .*ACCEPTED' 'N4 .*ACCEPTED' 'N5 .*ACCEPTED' 'X1a .*ACCEPTED' 'X2a .*ACCEPTED' 'X3 .*ACCEPTED'; do
  grep -Eq "$k" "$OUT/1-TODAY.txt" || { echo "EXPECT FAIL (today, negative control): $k"; rc=1; }; done
diff <(grep ' | ' "$OUT/1-TODAY.txt") <(grep ' | ' "$OUT/3-ROLLBACK.txt") >/dev/null && echo "ROLLBACK matches TODAY" || { echo "ROLLBACK differs from TODAY"; rc=1; }
echo "EXIT=$rc"; exit $rc
