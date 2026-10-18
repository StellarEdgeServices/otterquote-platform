#!/usr/bin/env bash
# gh-2479 signed-in leg (CLOSE-REVIEW: FAIL #2479 comment 6168644280, items 1 and 4): the refusals of the SQL proofs, but through the
# public HTTP surface as SIGNED-IN is_test users (real PostgREST role switch, real RLS, real Edge Function), which set_config('role')
# in SQL cannot show.
#
# WHAT IT CHANGES IF A GUARD IS MISSING (read this before running). Every call is EXPECTED to be refused. The script is NOT rollback-safe:
# if a refusal does not hold, that call COMMITS. Mitigations, in order: (1) all five ids are checked is_test = true, through a JWT that can
# see each row, BEFORE any write is sent, and the script aborts otherwise; (2) it stops at the first leg whose refusal did not hold, so
# legs 3-4 (referral_id / completion_date PATCH, and mark-job-complete) are never sent after an earlier failure; (3) legs 1-2 write only
# is_test rows. Residual risk, stated plainly: if the completion_date PATCH or mark-job-complete were accepted (leg 3b, leg 4), the claim
# completes, apply_referral_commission() may accrue a $200 is_test payout_approvals row, and notify_hover_rebate (no is_test check) and
# net.http_post notifications may fire; none of that can be rolled back. The guards and the 409 are live today, so the expected result
# is refusal, but that is exactly what this script is for. It deliberately does NOT call mark-job-complete on a contract_signed claim
# (that completes the claim and sends mail); the contract_signed accrual is proved in SQL (gh2479_completion_path_proof.sql, C1).
#
# Secrets: JWTs and the anon key are NEVER on a command line. They are written to a 0600 mktemp header file and given to curl as
# -H @file, so they do not appear in ps/argv. The files are removed on exit.
#
# Not run against PostgREST or production by its author (no production access from the cloud container; PostgREST is not installable
# there). Its pass/fail and abort logic was exercised only against a local mock HTTP server (see PR #2779). Whoever runs it on
# production pastes the raw output.
#
# Env (values are never printed):
#   SUPABASE_URL SUPABASE_ANON_KEY
#   OWNER_JWT        is_test homeowner who OWNS AWARDED_CLAIM_ID and OTHER_CLAIM_ID
#   CONTRACTOR_JWT   is_test contractor with the won quote QUOTE_ID on AWARDED_CLAIM_ID
#   AWARDED_CLAIM_ID an is_test claim in status 'awarded' with referral_id and completion_date NULL
#   OTHER_CLAIM_ID   another is_test claim of the same owner
#   QUOTE_ID         the selected is_test quote on AWARDED_CLAIM_ID
#   REFERRAL_ID      an is_test referral of another agent
#   CONTRACTOR_ID    the contractor row id of the CONTRACTOR_JWT user
#   ADMIN_JWT        optional: an is_test-safe admin session, used only for the is_test pre-check of rows the other JWTs cannot see
set -u
: "${SUPABASE_URL:?}" "${SUPABASE_ANON_KEY:?}" "${OWNER_JWT:?}" "${CONTRACTOR_JWT:?}" "${AWARDED_CLAIM_ID:?}" "${OTHER_CLAIM_ID:?}" "${QUOTE_ID:?}" "${REFERRAL_ID:?}" "${CONTRACTOR_ID:?}"
umask 077
TMP=$(mktemp -d "${TMPDIR:-/tmp}/gh2479leg.XXXXXX") || exit 3
trap 'rm -rf "$TMP"' EXIT
mkhdr() { printf 'apikey: %s\nAuthorization: Bearer %s\nContent-Type: application/json\nPrefer: return=representation\n' "$SUPABASE_ANON_KEY" "$2" > "$TMP/h.$1"; }
mkhdr owner "$OWNER_JWT"; mkhdr contractor "$CONTRACTOR_JWT"; [ -n "${ADMIN_JWT:-}" ] && mkhdr admin "$ADMIN_JWT"
fails=0
call() { # call <owner|contractor|admin> <method> <path> [json body]  -> sets CODE and BODY; the JWT is only ever in a 0600 header file
  local d=(); if [ -n "${4:-}" ]; then printf '%s' "$4" > "$TMP/req"; d=(-d "@$TMP/req"); fi
  CODE=$(curl -sS -o "$TMP/body" -w '%{http_code}' -X "$2" "$SUPABASE_URL$3" -H "@$TMP/h.$1" "${d[@]}") || CODE=000
  BODY=$(cat "$TMP/body" 2>/dev/null)
}
refused() { # refused <leg> <expected-substring-or-empty>: 4xx expected (guards raise 42501; RLS can answer 401/403/404)
  if [[ "$CODE" =~ ^4 ]] && [[ -z "${2:-}" || "$BODY" == *"$2"* ]]; then echo "PASS $1 -> HTTP $CODE ${BODY:0:140}"
  else echo "FAIL $1 -> HTTP $CODE ${BODY:0:140}"; fails=$((fails+1)); fi
}
gate() { [ "$fails" -eq 0 ] || { echo "ABORT before $1: an earlier refusal did not hold ($fails failure(s)); nothing further was sent"; exit 1; }; }
istest() { # istest <label> <table> <id>: some JWT we hold must SEE the row and read is_test:true
  local who
  for who in owner contractor ${ADMIN_JWT:+admin}; do
    call "$who" GET "/rest/v1/$2?id=eq.$3&select=id,is_test"
    if [[ "$CODE" == 200 && "$BODY" == *'"is_test":true'* ]]; then echo "is_test ok: $1 ($2, seen as $who)"; return 0; fi
  done
  echo "ABORT: cannot confirm $1 ($2 $3) is an is_test row through any JWT supplied (set ADMIN_JWT if RLS hides it); nothing was written"; exit 2
}
echo "== leg 0 (R-174 SELECT first): all five ids are is_test, before any write"
istest AWARDED_CLAIM_ID claims "$AWARDED_CLAIM_ID"; istest OTHER_CLAIM_ID claims "$OTHER_CLAIM_ID"; istest QUOTE_ID quotes "$QUOTE_ID"
istest REFERRAL_ID referrals "$REFERRAL_ID"; istest CONTRACTOR_ID contractors "$CONTRACTOR_ID"
call owner GET "/rest/v1/claims?id=eq.$AWARDED_CLAIM_ID&select=id,status,referral_id,completion_date,created_at"
echo "$CODE ${BODY:0:200}"
[[ "$CODE" == 200 && "$BODY" == *'"status":"awarded"'* && "$BODY" == *'"referral_id":null'* && "$BODY" == *'"completion_date":null'* ]] \
  || { echo "ABORT: AWARDED_CLAIM_ID must be awarded with referral_id and completion_date NULL as OWNER_JWT sees it; nothing was written"; exit 2; }
echo "== leg 1 (V2): owner re-points the selected quote at another claim"
call owner PATCH "/rest/v1/quotes?id=eq.$QUOTE_ID" "{\"claim_id\":\"$OTHER_CLAIM_ID\"}"; refused "V2 PATCH quotes.claim_id" 42501
gate "leg 2"
echo "== leg 2 (E1/E7): a contractor INSERTs a quote born selected (and with is_auto_bid)"
Q="{\"claim_id\":\"$OTHER_CLAIM_ID\",\"contractor_id\":\"$CONTRACTOR_ID\",\"total_price\":13560,\"fee_percentage\":5,\"fee_amount\":678,\"is_test\":true,\"trade_type\":\"roofing\",\"status\":\"selected\""
call contractor POST "/rest/v1/quotes" "$Q}"; refused "E1 POST quotes born selected" ""
gate "E7"
call contractor POST "/rest/v1/quotes" "$Q,\"is_auto_bid\":true}"; refused "E7 POST quotes born selected, is_auto_bid" ""
gate "leg 3 (referral_id / completion_date / created_at PATCH; a miss here is not reversible)"
echo "== leg 3: owner writes referral_id / created_at / completion_date on the awarded claim (completion_date LAST: it can accrue)"
call owner PATCH "/rest/v1/claims?id=eq.$AWARDED_CLAIM_ID" "{\"referral_id\":\"$REFERRAL_ID\"}"; refused "PATCH claims.referral_id" 42501
gate "created_at PATCH"
call owner PATCH "/rest/v1/claims?id=eq.$AWARDED_CLAIM_ID" '{"created_at":null}'; refused "PATCH claims.created_at=null" 42501
gate "completion_date PATCH"
call owner PATCH "/rest/v1/claims?id=eq.$AWARDED_CLAIM_ID" '{"completion_date":"2026-01-01T00:00:00Z"}'; refused "PATCH claims.completion_date" 42501
gate "leg 4 (mark-job-complete)"
echo "== leg 4 (E3p/E3q, the 409): the contractor calls mark-job-complete on the ALREADY-AWARDED claim"
call contractor POST "/functions/v1/mark-job-complete" "{\"claim_id\":\"$AWARDED_CLAIM_ID\"}"
if [[ "$CODE" == 409 ]]; then echo "PASS mark-job-complete on awarded -> HTTP 409 ${BODY:0:160}"; else echo "FAIL mark-job-complete on awarded -> HTTP $CODE ${BODY:0:160}"; fails=$((fails+1)); fi
echo "== leg 5: the claim is unchanged"
call owner GET "/rest/v1/claims?id=eq.$AWARDED_CLAIM_ID&select=status,referral_id,completion_date,created_at"; echo "$CODE ${BODY:0:200}"
[[ "$BODY" == *'"completion_date":null'* && "$BODY" == *'"referral_id":null'* && "$BODY" == *'"status":"awarded"'* ]] || { echo "FAIL claim changed"; fails=$((fails+1)); }
echo "== $fails failure(s)"; [ "$fails" -eq 0 ]
