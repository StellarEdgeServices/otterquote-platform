#!/usr/bin/env bash
# LOCAL throwaway Postgres 16 run of the gh-3470 proof. Never touches production.
# usage: gh3470_create_monthly_fee_batch_guard_local_run.sh [workdir]   (workdir must be new/empty; default: mktemp -d)
# For each is_admin_email() variant (p18 = NULL on no email, gh3009 = live) it loads TODAY's body (extracted from the gh3229 draft, md5-checked against the
# production definition), calls it as 4 callers, applies the real forward migration file, calls it again, then applies the real rollback and checks the body is TODAY's again.
# Expected exit 0 and the final line "PROOF RESULT: ... FAIL=0".
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}; AS=${PGRUN_AS:-postgres}
D=${1:-$(mktemp -d /tmp/gh3470pg.XXXXXX)}; mkdir -p "$D"; chmod 755 "$D"; chown "$AS" "$D"
PORT=${PGPORT_LOCAL:-54370}
as() { runuser -u "$AS" -- "$@"; }
as "$PGBIN/initdb" -D "$D/data" -A trust >/dev/null
as "$PGBIN/pg_ctl" -D "$D/data" -o "-p $PORT -k $D -c listen_addresses=''" -l "$D/log" -w start >/dev/null
trap 'as "$PGBIN/pg_ctl" -D "$D/data" -m immediate stop >/dev/null 2>&1 || true' EXIT
P="$PGBIN/psql -X -q -At -v ON_ERROR_STOP=1 -h $D -p $PORT -U $AS -d postgres"
DRAFT="$REPO/supabase/migrations_drafts/gh3229_partner_measurement_fee.sql"
FWD="$REPO/supabase/migrations_drafts/gh3470_create_monthly_fee_batch_guard_fail_closed.sql"
RB="$REPO/supabase/migrations_drafts/gh3470_create_monthly_fee_batch_guard_fail_closed_rollback.sql"
python3 - "$DRAFT" "$D/today.sql" <<'PY'
import sys,hashlib
t=open(sys.argv[1]).read(); i=t.index('CREATE OR REPLACE FUNCTION public.create_monthly_fee_batch'); j=t.index('$function$;',i)
blk=t[i:j]+'$function$\n'
assert hashlib.md5(blk.encode()).hexdigest()=='a8f66ee8688a71d710d05a644623c4a6', 'draft body != production pg_get_functiondef md5'
open(sys.argv[2],'w').write(blk.rstrip('\n')+";\n"+"GRANT EXECUTE ON FUNCTION public.create_monthly_fee_batch(date) TO authenticated, service_role;\nREVOKE ALL ON FUNCTION public.create_monthly_fee_batch(date) FROM PUBLIC, anon;\n")
print('TODAY body md5 equals production a8f66ee8688a71d710d05a644623c4a6')
PY
$P -f "$HERE/gh3470_create_monthly_fee_batch_guard_stub.sql"
$P -f "$HERE/gh3470_create_monthly_fee_batch_guard_proof.sql"
declare -A CLAIM=( [noemail]='{"role":"authenticated","sub":"33333333-3333-3333-3333-333333333333"}'
  [admin]='{"role":"authenticated","sub":"44444444-4444-4444-4444-444444444444","email":"dustinstohler1@gmail.com"}'
  [service]='{"role":"service_role"}'
  [other]='{"role":"authenticated","sub":"55555555-5555-5555-5555-555555555555","email":"someone.else@example.com"}' )
declare -A ROLE=( [noemail]=authenticated [admin]=authenticated [service]=service_role [other]=authenticated )
declare -A WANT_FIXED=( [noemail]=REFUSED [admin]=ADMITTED [service]=ADMITTED [other]=REFUSED )
PASS=0; FAIL=0; EXPECTED_TODAY_FAIL=0
check() { # variant body case want
  local got; got=$($P -c "SELECT public.gh3470_try('${ROLE[$3]}', '${CLAIM[$3]}')")
  local ok=OK; [[ "$got" == $4* ]] || ok=DIFF
  printf '%-7s %-6s %-8s want=%-8s got=%-34s %s\n' "$1" "$2" "$3" "$4" "$got" "$ok"
  if [[ $ok == OK ]]; then PASS=$((PASS+1)); else if [[ $2 == TODAY ]]; then EXPECTED_TODAY_FAIL=$((EXPECTED_TODAY_FAIL+1)); else FAIL=$((FAIL+1)); fi; fi
}
for V in p18 gh3009; do
  echo "== is_admin_email variant: $V"; $P -f "$HERE/gh3470_is_admin_email_$V.sql"
  $P -c "SELECT set_config('request.jwt.claims','{\"role\":\"authenticated\"}',false)" >/dev/null
  echo "is_admin_email() with a no-email JWT = $($P -c "SELECT COALESCE(public.is_admin_email()::text,'NULL')")"
  $P -f "$D/today.sql"
  echo "-- TODAY body (the live gh3229 body); DIFF here = today's body admits a caller it should refuse"
  for C in noemail admin service other; do check $V TODAY $C "${WANT_FIXED[$C]}"; done
  $P -f "$FWD"
  echo "-- FIXED body (forward migration applied for real); every row must be OK"
  for C in noemail admin service other; do check $V FIXED $C "${WANT_FIXED[$C]}"; done
  echo "-- migration preserved ACL, comment, config:"
  $P -c "SELECT 'acl=' || proacl::text || ' cfg=' || proconfig::text || ' comment=' || (obj_description(oid,'pg_proc') IS NOT NULL)::text FROM pg_proc WHERE oid='public.create_monthly_fee_batch(date)'::regprocedure"
  $P -f "$RB"
  RBMD5=$($P -c "SELECT md5(pg_get_functiondef('public.create_monthly_fee_batch(date)'::regprocedure))")
  echo "-- rollback applied; def md5 = $RBMD5 (want a8f66ee8688a71d710d05a644623c4a6 once the stub ACL/comment are the same; body checked below)"
  $P -c "SELECT 'rollback body == TODAY body: ' || (md5(prosrc) = '1e48a0254db3b738f03f09d731ea90cf')::text FROM pg_proc WHERE oid='public.create_monthly_fee_batch(date)'::regprocedure"
  $P -f "$FWD"  # re-apply after rollback proves the guard in the migration (md5 of the prosrc is TODAY's again) lets it go forward
done
echo "-- forward refuses a drifted body (negative control):"
$P -c "CREATE OR REPLACE FUNCTION public.create_monthly_fee_batch(p_month date) RETURNS jsonb LANGUAGE sql AS 'SELECT 1::text::jsonb'" 
if $P -f "$FWD" 2>"$D/drift.err"; then echo "DRIFT GUARD FAILED"; FAIL=$((FAIL+1)); else echo "refused: $(grep -m1 -o 'gh3470:[^.]*' "$D/drift.err")"; PASS=$((PASS+1)); fi
echo "PROOF RESULT: PASS=$PASS FAIL=$FAIL TODAY_BODY_DIFFS=$EXPECTED_TODAY_FAIL"
[[ $FAIL -eq 0 ]]
