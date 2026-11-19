#!/usr/bin/env bash
# gh-2875 (D-391 layer 2): prove supabase/migrations_drafts/gh2875_contractor_sms_verify_rate_limits.sql on a THROWAWAY Postgres.
# Never point this at production. No network, no credentials.
# Usage: PGBIN=<dir with initdb/pg_ctl/psql> bash supabase/tests/gh2875_contractor_sms_verify_rate_limits_proof_run.sh [outdir]
# Databases on one throwaway cluster, each = the stub (production's rate_limit_config / rate_limits shape and the live
# check_rate_limit body, md5-checked) plus:
#   TODAY      nothing                         -> NEGATIVE CONTROL: the limiter refuses everyone (no config row = fail closed)
#   AFTER      forward                         -> allowed within the limits, refused past each window and the budget cap
#   TWICE      forward, forward                -> idempotent: same as AFTER, still 3 config rows
#   PREEXIST   a hand-set start row, forward   -> ON CONFLICT DO NOTHING keeps it; the forward NOTICEs it
#   MUTANT_HR  forward with start 5/hour -> 6  -> Q3 must flip to 6/6 (the burst probe really measures the hourly value)
#   MUTANT_CAP forward with start cap -> 0.00  -> Q14 must flip to allowed (the budget probe really measures the cap)
#   ROLLBACK   forward, rollback               -> same as TODAY; the unrelated send-sms row untouched
#   ROLLBACK2  forward, rollback, rollback     -> the rollback is idempotent
# Exit 0 only if every expectation holds.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-$(mktemp -d)}"; mkdir -p "$OUT"
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
D=supabase/migrations_drafts; T=supabase/tests
FWD=$D/gh2875_contractor_sms_verify_rate_limits.sql; RB=$D/gh2875_contractor_sms_verify_rate_limits_rollback.sql
STUB=$T/gh2875_contractor_sms_verify_rate_limits_stub.sql; PROOF=$T/gh2875_contractor_sms_verify_rate_limits_proof.sql
TMP=$(mktemp -d /tmp/gh2875rl.XXXXXX); PORT=${PGPORT_LOCAL:-54376}
"$PGBIN/initdb" -D "$TMP/data" -A trust -U postgres >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null || exit 2
trap '"$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1; rm -rf "$TMP"' EXIT
P() { "$PGBIN/psql" -X -q -h "$TMP" -p "$PORT" -U postgres "$@"; }
rc=0; fail() { echo "EXPECT FAIL: $*"; rc=1; }

sed 's/(.contractor-sms-verify-start., 5, 10, 30,/(\x27contractor-sms-verify-start\x27, 6, 10, 30,/' "$FWD" > "$OUT/mutant_hr.sql"
sed 's/0\.0292, 10\.00,/0.0292, 0.00,/' "$FWD" > "$OUT/mutant_cap.sql"
cmp -s "$FWD" "$OUT/mutant_hr.sql" && fail "mutant_hr.sql is identical to the forward (sed matched nothing)"
cmp -s "$FWD" "$OUT/mutant_cap.sql" && fail "mutant_cap.sql is identical to the forward (sed matched nothing)"
printf '%s\n' "INSERT INTO public.rate_limit_config (function_name, max_per_hour, max_per_day, max_per_month, enabled, monthly_cost_estimate, monthly_budget_cap, notes) VALUES ('contractor-sms-verify-start', 1, 1, 1, true, 0.0000, 0.00, 'hand-set');" > "$OUT/preexist.sql"

run() { local name=$1; shift; local db="gh2875rl_${name,,}"
  P -d postgres -c "CREATE DATABASE $db" >/dev/null || { fail "$name: create db"; return; }
  P -d "$db" -v ON_ERROR_STOP=1 -f "$STUB" >/dev/null 2>"$OUT/$name-stub.err" || fail "$name: stub failed"
  local md5; md5=$(P -d "$db" -At -c "SELECT md5(pg_get_functiondef('public.check_rate_limit(text,uuid)'::regprocedure))")
  [ "${md5:0:16}" = "905e1e5378a90834" ] || fail "$name: stub check_rate_limit md5 $md5 is not production's 905e1e53..."
  : > "$OUT/$name-apply.err"
  for f in "$@"; do P -d "$db" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>>"$OUT/$name-apply.err" || fail "$name: apply $f failed"; done
  P -d "$db" -f "$PROOF" > "$OUT/$name.txt" 2>"$OUT/$name.err" || fail "$name: proof errored (see $OUT/$name.err)"
  echo "== $name"; grep -E '^(Q|R)[0-9]+ ' "$OUT/$name.txt"; }

run TODAY
run AFTER "$FWD"
run TWICE "$FWD" "$FWD"
run PREEXIST "$OUT/preexist.sql" "$FWD"
run MUTANT_HR "$OUT/mutant_hr.sql"
run MUTANT_CAP "$OUT/mutant_cap.sql"
run ROLLBACK "$FWD" "$RB"
run ROLLBACK2 "$FWD" "$RB" "$RB"

expect() { local f=$1 k=$2 v=$3; grep -qxF "$k VALUE $v" <(sed -E 's/^([QR][0-9]+) .* VALUE /\1 VALUE /' "$OUT/$f.txt") || fail "$f $k must be '$v', got '$(grep -E "^$k " "$OUT/$f.txt" | sed 's/.* VALUE //')'"; }
NOCFG='denied:No rate limit config found for function'
HOUR='denied:Hourly limit reached'
SMS='10/50/500/0.0079/4.00'
ROWS='contractor-sms-verify-check=10/30/100/t/0.0000/0.00,contractor-sms-verify-start=5/10/30/t/0.0292/10.00'
# Q0: the SQL mirror of handler.ts bucketUuid() must equal an independent computation of the same recipe (sha256, first 16 bytes,
# version nibble 4, variant 10xx), so Q4 really tests the number bucket the deployed function would use.
Q0=$(python3 -c 'import hashlib;d=bytearray(hashlib.sha256(b"contractor-sms-verify:phone:+15555550100").digest()[:16]);d[6]=(d[6]&15)|64;d[8]=(d[8]&63)|128;h=d.hex();print(h[:8]+"-"+h[8:12]+"-"+h[12:16]+"-"+h[16:20]+"-"+h[20:])')
expect AFTER Q0 "$Q0"
for f in TODAY ROLLBACK ROLLBACK2; do
  expect "$f" Q1 "$NOCFG"; expect "$f" Q2 "$NOCFG"; expect "$f" Q3 "0/6 last=$NOCFG"; expect "$f" Q6 "$NOCFG"; expect "$f" Q8 "0/11 last=$NOCFG"
  expect "$f" R1 none; expect "$f" R2 "$SMS"; expect "$f" R3 1
done
for f in AFTER TWICE; do
  expect "$f" Q1 allowed; expect "$f" Q2 allowed
  expect "$f" Q3 "5/6 last=$HOUR"; expect "$f" Q4 "$HOUR"; expect "$f" Q5 "$HOUR"; expect "$f" Q6 allowed; expect "$f" Q7 allowed
  expect "$f" Q8 "10/11 last=$HOUR"
  expect "$f" Q9 allowed; expect "$f" Q10 'denied:Daily limit reached'
  expect "$f" Q11 allowed; expect "$f" Q12 'denied:Monthly limit reached'
  expect "$f" Q13 allowed; expect "$f" Q14 'denied:Monthly budget cap reached'
  expect "$f" Q15 allowed; expect "$f" Q16 allowed
  expect "$f" R1 "$ROWS"; expect "$f" R2 "$SMS"; expect "$f" R3 3
done
expect PREEXIST R1 'contractor-sms-verify-check=10/30/100/t/0.0000/0.00,contractor-sms-verify-start=1/1/1/t/0.0000/0.00'
grep -q 'contractor-sms-verify-start already existed with other values; left unchanged' "$OUT/PREEXIST-apply.err" || fail "PREEXIST: forward did not NOTICE the existing row"
grep -q 'already existed' "$OUT/AFTER-apply.err" && fail "AFTER: forward NOTICEd a row it had just inserted"
grep -q 'already existed' "$OUT/TWICE-apply.err" && fail "TWICE: the second forward NOTICEd its own rows as different"
expect MUTANT_HR Q3 '6/6 last=allowed'
expect MUTANT_CAP Q14 allowed
# the bucket mirror is deterministic across databases
for f in TODAY TWICE ROLLBACK; do [ "$(grep -E '^Q0 ' "$OUT/$f.txt" | sed 's/.* VALUE //')" = "$Q0" ] || fail "$f Q0 differs from AFTER"; done
echo "outputs: $OUT"
[ $rc -eq 0 ] && echo "ALL EXPECTATIONS HOLD" || echo "SOME EXPECTATIONS FAILED"
exit $rc
