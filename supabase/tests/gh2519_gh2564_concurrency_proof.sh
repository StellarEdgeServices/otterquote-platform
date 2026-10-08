#!/usr/bin/env bash
# gh-2519 / gh-2564: TWO-SESSION proof on a THROWAWAY Postgres. Never point this at production.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh2519_gh2564_concurrency_proof.sh
# Applies production's schema (supabase/tests/gh2519_gh2564_throwaway_schema.sql) and the gh2519 draft in a scratch
# database gh2519_concurrency_proof, then runs four races between real concurrent sessions (psql, roles set the way
# PostgREST sets them) and checks the end state. Exit 0 only if every expectation holds.
#   C1  two accepts (rpc accept_bid, different bids) while a third writer holds the claim row for 2 s: the review
#       6051423781 finding 3 deadlock. Expect: no "deadlock detected"; one accept wins, the other is refused.
#   C2  two direct owner UPDATEs of different bids to selected, the first held open 2 s (review A3).
#       Expect: one selected bid at the end (the second fails on quotes_one_selected_bid_per_claim).
#   C3  a direct owner UPDATE to selected held open 2 s, and an rpc accept_bid of the other bid (review A4).
#       Expect: one selected bid at the end.
#   C4  accept_bid held open 3 s, a second accept_bid of the other bid started 0.5 s later: serialized, second refused.
# Run on a head WITHOUT the fix (copy this file into a checkout of f2039239) the same script fails C1 (deadlock),
# C2 and C3 (two selected bids): that is the negative control.
set -uo pipefail
cd "$(dirname "$0")/../.."
DB=gh2519_concurrency_proof; OUT="$(mktemp -d)"; rc=0
O=11111111-1111-4111-8111-111111111111; K1=aaaaaaa1-0000-4000-8000-000000000001; K2=aaaaaaa2-0000-4000-8000-000000000002
C1=c0000001-0000-4000-8000-000000000001; Q1=e0000011-0000-4000-8000-000000000011; Q2=e0000012-0000-4000-8000-000000000012
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
P() { psql -q -d "$DB" -X "$@"; }
P -v ON_ERROR_STOP=1 -f supabase/tests/gh2519_gh2564_throwaway_schema.sql >/dev/null
P -v ON_ERROR_STOP=1 -f supabase/migrations_drafts/gh2519_quotes_server_set_fee.sql >/dev/null
P -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO public.platform_fee_config (id, state, trade, fee_pct, fee_basis, effective_date) VALUES ('fcd50269-f689-42d4-bbc3-8f01e5390c44', NULL, NULL, 5.00, 'bid_amount', DATE '2026-05-06');
INSERT INTO public.contractors (id, user_id, company_name, contact_name, email, status, address_state, coi_file_url, coi_expires_at, attestation_accepted_at, has_payment_method, stripe_payment_method_id, stripe_payment_method_last4, is_test)
VALUES ('$K1', '33333333-3333-4333-8333-333333333333', 'Proof One', 'K One', 'k1@example.invalid', 'active', 'IN', 'coi.pdf', CURRENT_DATE + 365, now(), true, 'pm1', '4242', true),
       ('$K2', '44444444-4444-4444-8444-444444444444', 'Proof Two', 'K Two', 'k2@example.invalid', 'active', 'IN', 'coi.pdf', CURRENT_DATE + 365, now(), true, 'pm2', '4242', true);
INSERT INTO public.claims (id, user_id, status, ready_for_bids, trades, is_test, created_at) VALUES ('$C1', '$O', 'bidding', true, '{roofing}', true, now() - interval '2 days');
INSERT INTO public.quotes (id, claim_id, contractor_id, total_price, fee_percentage, fee_amount, platform_fee_pct, platform_fee_basis, status, bid_status, trade_type, is_test) VALUES
 ('$Q1', '$C1', '$K1', 15000, 5.00, 750, 5.00, 'bid_amount', 'submitted', 'active', 'roofing', true),
 ('$Q2', '$C1', '$K2', 12000, 5.00, 600, 5.00, 'bid_amount', 'submitted', 'active', 'roofing', true);
SQL
reset() { P -v ON_ERROR_STOP=1 -c "UPDATE public.quotes SET status='submitted', bid_status='active'; UPDATE public.claims SET status='bidding', selected_contractor_id=NULL, selected_bid_amount=NULL WHERE id='$C1'" >/dev/null; }
# sess <name> <delay seconds> <hold seconds> <sql as the homeowner>
sess() { { echo "BEGIN; SELECT set_config('request.jwt.claims', '{\"sub\":\"$O\",\"role\":\"authenticated\",\"email\":\"concurrency-proof@example.invalid\"}', true); SET LOCAL ROLE authenticated;"
           echo "$4"; echo "SELECT pg_sleep($3); COMMIT; SELECT 'SESSION-DONE';"; } > "$OUT/$1.sql"
         ( sleep "$2"; P -v ON_ERROR_STOP=0 -v VERBOSITY=terse -f "$OUT/$1.sql" > "$OUT/$1.out" 2>&1 ) & }
# A session that printed SESSION-DONE ran every statement. Anything matching error, fatal, failed or could not (any case, so a psql
# "connection to server ... failed" or "error:" line counts) is a failure; so is a session that printed neither (review 6051777895 finding 6).
res() { if grep -qiE "error|fatal|failed|could not" "$OUT/$1.out"; then grep -m1 -iE "error|fatal|failed|could not" "$OUT/$1.out" | sed -E 's/^.*(ERROR|error|FATAL|fatal|connection)/\1/' | cut -c1-140
        elif grep -q "SESSION-DONE" "$OUT/$1.out"; then echo ok; else echo "ERROR: no result from this session (not run)"; fi; }
state() { P -At -c "SELECT 'selected AND active bids=' || (SELECT count(*) FROM public.quotes WHERE claim_id='$C1' AND status='selected' AND bid_status='active') || ' | q1=' || (SELECT status FROM public.quotes WHERE id='$Q1') || ' q2=' || (SELECT status FROM public.quotes WHERE id='$Q2')"; }
check() { # <label> <condition description> <exit status of the test>
  if [ "$3" = 0 ]; then echo "  PASS $1: $2"; else echo "  FAIL $1: $2"; rc=1; fi; }
infra_bad() { grep -qiE "could not connect|connection to server|server closed|FATAL" "$OUT/A.out" "$OUT/B.out" 2>/dev/null || { [ ! -s "$OUT/A.out" ] && [ ! -s "$OUT/B.out" ]; }; }
nodl() { ! infra_bad && ! grep -qi "deadlock detected" "$OUT/A.out" "$OUT/B.out"; } # a connection failure is never a pass
race() { # <name> <A sql> <A hold> <B sql> <B delay> <B hold> [third writer: 1]
  reset; echo "== $1"
  if [ "${7:-0}" = 1 ]; then { echo "BEGIN; UPDATE public.claims SET updated_at=now() WHERE id='$C1'; SELECT pg_sleep(2); COMMIT;"; } > "$OUT/C.sql"; ( P -f "$OUT/C.sql" >/dev/null 2>&1 ) & sleep 0.3; fi
  sess A 0 "$3" "$2"; sess B "$5" "$6" "$4"; wait
  echo "  A: $(res A)"; echo "  B: $(res B)"; echo "  end: $(state)"
  if infra_bad; then echo "  FAIL $1: a psql session did not connect or did not run (infrastructure failure, not a result)"; rc=1; fi; }
ACC1="SELECT * FROM public.accept_bid('$C1','$Q1');"; ACC2="SELECT * FROM public.accept_bid('$C1','$Q2');"
SEL1="UPDATE public.quotes SET status='selected' WHERE id='$Q1';"; SEL2="UPDATE public.quotes SET status='selected' WHERE id='$Q2';"

race "C1 two accepts of different bids while a third writer holds the claim row" "$ACC1" 0 "$ACC2" 0.3 0 1
nodl; check C1 "no deadlock between the two accepts" $?
[ "$(state | grep -c 'bids=1 ')" = 1 ]; check C1 "exactly one selected, active bid at the end" $?
race "C2 two direct UPDATEs to selected, the first held open 2 s" "$SEL1" 2 "$SEL2" 0.5 0
[ "$(state | grep -c 'bids=1 ')" = 1 ]; check C2 "exactly one selected, active bid at the end" $?
race "C3 a direct UPDATE to selected held open 2 s, and rpc accept_bid of the other bid" "$SEL2" 2 "$ACC1" 0.5 0
[ "$(state | grep -c 'bids=1 ')" = 1 ]; check C3 "exactly one selected, active bid at the end" $?
race "C4 accept_bid held open 3 s, a second accept_bid of the other bid 0.5 s later" "$ACC1" 3 "$ACC2" 0.5 0
nodl; check C4 "no deadlock" $?
grep -q "already selected" "$OUT/B.out"; check C4 "the second accept is refused (already selected)" $?
[ "$(state | grep -c 'bids=1 ')" = 1 ]; check C4 "exactly one selected, active bid at the end" $?
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB"; echo "outputs in $OUT"; exit $rc
