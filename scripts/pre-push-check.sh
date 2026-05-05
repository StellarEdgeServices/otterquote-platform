#!/usr/bin/env bash
# OtterQuote Pre-Push Static Analysis Gate
# Runs before Deploy_Review_Checklist.md
# Per Base Deploy Step 5 — added 2026-05-05
set -euo pipefail

PASS=0
FAIL=0
WARN=0

echo "=== OtterQuote Static Analysis Gate ==="
echo "Running at: $(date)"

# --- HTML Validation (htmlhint) ---
echo ""
echo "[1/3] HTML Validation (htmlhint)..."
if [ -f "*.html" ] 2>/dev/null || ls *.html >/dev/null 2>&1; then
  HTML_ERRORS=$(npx --yes htmlhint "*.html" 2>&1 || true)
  ERROR_COUNT=$(echo "$HTML_ERRORS" | grep -c "error" || true)
  if [ "$ERROR_COUNT" -gt 0 ]; then
    echo "  FAIL: HTML validation errors found ($ERROR_COUNT errors):"
    echo "$HTML_ERRORS" | grep "error" | head -5
    FAIL=$((FAIL+1))
  else
    echo "  PASS: HTML validation clean"
    PASS=$((PASS+1))
  fi
else
  echo "  SKIP: No .html files found"
  WARN=$((WARN+1))
fi

# --- JS Lint (biome) ---
echo ""
echo "[2/3] JS Linting (biome)..."
if [ -f "biome.json" ]; then
  if npx --yes @biomejs/biome check . 2>&1 | grep -q "error"; then
    BIOME_OUT=$(npx --yes @biomejs/biome check . 2>&1 || true)
    echo "  FAIL: Biome lint errors:"
    echo "$BIOME_OUT" | grep "error" | head -5
    FAIL=$((FAIL+1))
  elif npx --yes @biomejs/biome check . 2>&1 | grep -q "warn"; then
    BIOME_OUT=$(npx --yes @biomejs/biome check . 2>&1 || true)
    echo "  WARN: Biome lint warnings (non-blocking):"
    echo "$BIOME_OUT" | grep "warn" | head -3
    WARN=$((WARN+1))
    PASS=$((PASS+1))
  else
    echo "  PASS: JS lint clean"
    PASS=$((PASS+1))
  fi
else
  echo "  SKIP: biome.json not found at root"
  WARN=$((WARN+1))
fi

# --- TypeScript check for Edge Functions ---
echo ""
echo "[3/3] TypeScript check (Edge Functions)..."
if [ -d "tests/e2e" ]; then
  echo "  INFO: TypeScript check skipped — requires deno/supabase runtime (non-blocking pre-D-211)"
  WARN=$((WARN+1))
else
  echo "  SKIP: tests/e2e not found"
fi

echo ""
echo "=== Results: $PASS PASS | $WARN WARN | $FAIL FAIL ==="

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "BLOCKED: Static analysis gate failed. Fix errors before pushing."
  echo "To override (with documented reason): add [LINT-WAIVER: <reason>] to commit message."
  # Check for waiver in last commit message
  LAST_MSG=$(git log -1 --pretty=%B 2>/dev/null || echo "")
  if echo "$LAST_MSG" | grep -q "\[LINT-WAIVER:"; then
    echo "Waiver found in commit message — proceeding despite failures."
    exit 0
  fi
  exit 1
fi

echo "Static analysis gate PASSED — proceed to Deploy_Review_Checklist."
exit 0
