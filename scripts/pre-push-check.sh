#!/usr/bin/env bash
#
# Pre-push lint — catches the class of bug that broke staging for 5 days
# starting May 1, 2026 (commit 11b32d1e). A sed-style edit to js/auth.js
# orphaned a closing brace; node failed to parse the file; window.Auth
# was never defined; every authenticated page silently broke. Six CI
# fix attempts addressed symptoms because Chrome does not surface
# SyntaxErrors prominently. node --check would have caught it in 50ms.
#
# Run from repo root: bash scripts/pre-push-check.sh
# FAIL count > 0 blocks push (waiver via [LINT-WAIVER: reason] in commit message).
#
# SCOPE: vanilla-JS files under js/. HTML inline-script linting is a
# separate problem (cross-block scope, multiple inline blocks per file)
# that needs a real bundler-aware approach; left for a future iteration.
# Don't bolt on a noisy heuristic here — it would train people to ignore
# the output, which is exactly the failure mode this script exists to fix.
#
set -uo pipefail

FAIL=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== JS syntax check (js/**/*.js) ==="
JS_FILES=$(find js -maxdepth 3 -name "*.js" -type f 2>/dev/null)
for f in $JS_FILES; do
  if ! node --check "$f" 2>/dev/null; then
    echo "FAIL: $f"
    node --check "$f" 2>&1 | head -3 | sed 's/^/    /'
    FAIL=$((FAIL+1))
  else
    echo "  ok: $f"
  fi
done

echo ""
echo "=== Summary ==="
echo "FAIL: $FAIL"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "BLOCKED. Fix syntax errors above or add [LINT-WAIVER: reason] to commit message."
  exit 1
fi
echo "PASS"
exit 0
