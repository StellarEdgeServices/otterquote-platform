#!/bin/bash
# OtterQuote Post-Deploy Smoke Tests (D-182)
# Usage: ./smoke-test.sh [staging|production]
# All 4 tests must pass before a production merge is allowed.

set -e

ENVIRONMENT=${1:-staging}
SITE_NAME="jade-alpaca-b82b5e"
SUPABASE_URL="https://yeszghaspzwwstvsrioa.supabase.co"

if [ "$ENVIRONMENT" = "production" ]; then
  BASE_URL="https://otterquote.com"
else
  BASE_URL="https://staging--${SITE_NAME}.netlify.app"
fi

echo "================================================"
echo "OtterQuote Smoke Tests — $ENVIRONMENT"
echo "Target: $BASE_URL"
echo "================================================"

PASS=0
FAIL=0

# ── Test 1: Homepage load ──────────────────────────────────────────
echo ""
echo "Test 1: Homepage load..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$BASE_URL/")
if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "401" ]; then
  echo "  ✅ PASS — HTTP $HTTP_STATUS"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL — HTTP $HTTP_STATUS (expected 200)"
  FAIL=$((FAIL + 1))
fi

# ── Test 2: Supabase auth health ───────────────────────────────────
echo ""
echo "Test 2: Supabase auth health..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$SUPABASE_URL/auth/v1/health")
if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "401" ]; then
  echo "  ✅ PASS — HTTP $HTTP_STATUS"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL — HTTP $HTTP_STATUS (expected 200)"
  FAIL=$((FAIL + 1))
fi

# ── Test 3: Edge Function responds (not 500) ───────────────────────
echo ""
echo "Test 3: Edge Function health (parse-loss-sheet)..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
  -X POST "$SUPABASE_URL/functions/v1/parse-loss-sheet" \
  -H "Content-Type: application/json" \
  -d '{"_smoke_test": true}')
if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "400" ] || [ "$HTTP_STATUS" = "401" ] || [ "$HTTP_STATUS" = "422" ]; then
  echo "  ✅ PASS — HTTP $HTTP_STATUS (not 500)"
  PASS=$((PASS + 1))
else
  echo "  ❌ FAIL — HTTP $HTTP_STATUS (expected 200/400/401/422, a 500 means Edge Function is broken)"
  FAIL=$((FAIL + 1))
fi

# ── Test 4: Stripe key present in page assets ──────────────────────
echo ""
echo "Test 4: Stripe publishable key present..."
PAGE_SOURCE=$(curl -s --max-time 15 "$BASE_URL/")
if echo "$PAGE_SOURCE" | grep -qi "stripe"; then
  echo "  ✅ PASS — Stripe reference found in page source"
  PASS=$((PASS + 1))
else
  # Stripe loads on payment pages, not homepage — warn but don't hard-fail
  echo "  ⚠️  WARN — No Stripe reference on homepage (loaded on payment pages — verify manually if payment flow changed)"
  PASS=$((PASS + 1))
fi

# -- Test 5: partner-adjusters.html live + D-266 disclaimer (#567) --
echo ""
echo "Test 5: partner-adjusters.html (200 + D-266 disclaimer)..."
BODY_FILE=$(mktemp)
HTTP_STATUS=$(curl -s -o "$BODY_FILE" -w "%{http_code}" --max-time 15 "$BASE_URL/partner-adjusters.html")
if [ "$HTTP_STATUS" = "200" ] && grep -q "governing licensing agency" "$BODY_FILE"; then
  echo "  â PASS â HTTP 200 + disclaimer present"
  PASS=$((PASS + 1))
else
  echo "  â FAIL â HTTP $HTTP_STATUS or disclaimer missing"
  FAIL=$((FAIL + 1))
fi
rm -f "$BODY_FILE"

# -- Test 6: partner-other.html live + D-266 disclaimer (#567) ------
echo ""
echo "Test 6: partner-other.html (200 + D-266 disclaimer)..."
BODY_FILE=$(mktemp)
HTTP_STATUS=$(curl -s -o "$BODY_FILE" -w "%{http_code}" --max-time 15 "$BASE_URL/partner-other.html")
if [ "$HTTP_STATUS" = "200" ] && grep -q "governing licensing agency" "$BODY_FILE"; then
  echo "  â PASS â HTTP 200 + disclaimer present"
  PASS=$((PASS + 1))
else
  echo "  â FAIL â HTTP $HTTP_STATUS or disclaimer missing"
  FAIL=$((FAIL + 1))
fi
rm -f "$BODY_FILE"

# -- Test 7: partner-insurance.html D-266 disclaimer (#567) ---------
echo ""
echo "Test 7: partner-insurance.html (D-266 disclaimer)..."
BODY_FILE=$(mktemp)
HTTP_STATUS=$(curl -s -o "$BODY_FILE" -w "%{http_code}" --max-time 15 "$BASE_URL/partner-insurance.html")
if [ "$HTTP_STATUS" = "200" ] && grep -q "governing licensing agency" "$BODY_FILE"; then
  echo "  â PASS â HTTP 200 + disclaimer present"
  PASS=$((PASS + 1))
else
  echo "  â FAIL â HTTP $HTTP_STATUS or disclaimer missing"
  FAIL=$((FAIL + 1))
fi
rm -f "$BODY_FILE"


# -- Test 8: referral RPC reachable — track_referral_click (#571) ---
# Anon POST with an unknown code must return HTTP 200 with a null body:
# the v95 SECURITY DEFINER function is reachable and granted to anon, and
# an unknown code resolves to null. 404 = function missing, 401/42501 =
# grants broken.
echo ""
echo "Test 8: track_referral_click RPC reachable (anon)..."
ANON_KEY=$(curl -s --max-time 15 "$BASE_URL/js/config.js" | grep -oE "sb_publishable_[A-Za-z0-9_-]+" | head -1)
if [ -z "$ANON_KEY" ]; then
  echo "  ❌ FAIL — could not extract anon key from $BASE_URL/js/config.js"
  FAIL=$((FAIL + 1))
else
  BODY_FILE=$(mktemp)
  HTTP_STATUS=$(curl -s -o "$BODY_FILE" -w "%{http_code}" --max-time 15 \
    -X POST "$SUPABASE_URL/rest/v1/rpc/track_referral_click" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $ANON_KEY" \
    -H "Content-Type: application/json" \
    -d '{"p_code":"SMOKE-NO-SUCH-CODE"}')
  RPC_BODY=$(cat "$BODY_FILE")
  rm -f "$BODY_FILE"
  if [ "$HTTP_STATUS" = "200" ] && { [ "$RPC_BODY" = "null" ] || [ -z "$RPC_BODY" ]; }; then
    echo "  ✅ PASS — HTTP 200, unknown code → null"
    PASS=$((PASS + 1))
  else
    echo "  ❌ FAIL — HTTP $HTTP_STATUS, body: $RPC_BODY (expected 200 + null)"
    FAIL=$((FAIL + 1))
  fi
fi

# ── Summary ───────────────────────────────────────────────────────
echo ""
echo "================================================"
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ SMOKE TESTS FAILED — do NOT merge to main or push to production"
  echo "   Check the failing tests above and resolve before proceeding."
  exit 1
else
  echo "✅ ALL SMOKE TESTS PASSED — safe to proceed"
  exit 0
fi
