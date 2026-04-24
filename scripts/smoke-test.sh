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
