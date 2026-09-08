#!/usr/bin/env bash
#
# Pre-push lint — catches the class of bug that broke staging for 5 days
# starting May 1, 2026 (commit 11b32d1e). A sed-style edit to js/auth.js
# orphaned a closing brace; node failed to parse the file; window.Auth
# was never defined; every authenticated page silently broke. Six CI
# fix attempts addressed symptoms because Chrome does not surface
# SyntaxErrors prominently. node --check would have caught it in 50ms.
#
# Also catches inline <script> SyntaxErrors in HTML files.
# May 7, 2026: unescaped apostrophe in contractor-pre-approval.html
# submitStep2() caused 54 Sentry events and a 3-hour production outage
# (bug-killer case 86e18fcny). node --check on the extracted inline script
# would have caught it at push time.
#
# HARDENED (2026-05-08):
# - Null-byte check: detects partial writes and truncated file corruption
# - Truncated HTML check: catches HTML files missing closing tag (truncation)
# - File size delta check: warns on large deletions (< 50% original size)
# See 86e19cdbq for incident context (51 corruption incidents pre-2026-05-08).
#
# Run from repo root: bash scripts/pre-push-check.sh
# FAIL count > 0 blocks push (waiver via [LINT-WAIVER: reason] in commit message).
#
set -uo pipefail

FAIL=0
WARN=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Shallow-clone guard (gh-1887) ==="
# git merge-base --is-ancestor exits 1 both when a commit truly isn't an
# ancestor AND when a shallow clone can't see far enough back to tell --
# with no stderr distinction between the two. Any ancestry check downstream
# of this script (this file or a caller) that relies on --is-ancestor is
# only as trustworthy as this guard passing first.
if bash "$ROOT/scripts/check-shallow-clone-guard.sh"; then
  :
else
  FAIL=$((FAIL+1))
fi

echo ""
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
echo "=== HTML inline script syntax check ==="
HTML_FILES=$(find . -maxdepth 1 -name "*.html" -type f 2>/dev/null)
INLINE_FAIL=0
for html in $HTML_FILES; do
  result=$(python3 - "$html" << 'PYBLOCK'
import sys, re, subprocess, tempfile, os

html_file = sys.argv[1]
with open(html_file, 'r', encoding='utf-8', errors='replace') as fh:
    content = fh.read()

# Match inline scripts that:
#   - have no src attribute (not external)
#   - have no type attribute that is NOT text/javascript
#     (excludes application/ld+json, text/template, etc.)
pattern = (
    r'<script'
    r'(?![^>]*\bsrc\b)'                                            # no src=
    r'(?![^>]*\btype\b\s*=\s*["\'](?!text/javascript)[^"\']*["\'])'  # no non-JS type
    r'[^>]*>(.*?)</script>'
)
blocks = re.findall(pattern, content, re.DOTALL | re.IGNORECASE)

failures = []
for i, block in enumerate(blocks):
    stripped = block.strip()
    if not stripped:
        continue
    with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False) as tmp:
        tmp.write(stripped)
        tmp_path = tmp.name
    try:
        result = subprocess.run(
            ['node', '--check', tmp_path],
            capture_output=True, text=True
        )
        if result.returncode != 0:
            err = result.stderr.strip().split('\n')[0]
            failures.append(f'block {i+1}: {err}')
    finally:
        os.unlink(tmp_path)

if failures:
    for f in failures:
        print(f'INLINE_FAIL:{f}')
PYBLOCK
)
  if echo "$result" | grep -q "^INLINE_FAIL:"; then
    echo "FAIL: $html (inline script syntax error)"
    echo "$result" | grep "^INLINE_FAIL:" | sed 's/^INLINE_FAIL:/    /'
    FAIL=$((FAIL+1))
    INLINE_FAIL=$((INLINE_FAIL+1))
  else
    echo "  ok: $html"
  fi
done

echo ""
echo "=== Null-byte check (86e19cdbq hardening) ==="
# Scan all tracked files for null bytes. Exclude known binary types.
# A null byte in a text file indicates truncation, partial write, or corruption.
NULL_BYTE_FILES=$(grep -rPl $'\x00' \
  --include='*.html' --include='*.js' --include='*.css' --include='*.ts' \
  --include='*.tsx' --include='*.jsx' --include='*.sql' --include='*.md' \
  --include='*.sh' --include='*.toml' --include='*.yml' --include='*.yaml' \
  --include='*.json' . 2>/dev/null || true)
if [ -z "$NULL_BYTE_FILES" ]; then
  echo "  ok: no null bytes in tracked text files"
else
  while IFS= read -r f; do
    count=$(grep -ao $'\x00' "$f" | wc -l)
    echo "FAIL: $f (null bytes: $count)"
    FAIL=$((FAIL+1))
  done <<< "$NULL_BYTE_FILES"
fi

echo ""
echo "=== Truncated HTML check (86e19cdbq hardening) ==="
# Each .html file MUST have a closing </html> tag within the last 500 bytes.
# Absence indicates truncation or file corruption during write.
for html in $(find . -maxdepth 1 -name "*.html" -type f 2>/dev/null); do
  if [ ! -s "$html" ]; then
    echo "  skip: $html (empty file)"
    continue
  fi
  tail_bytes=$(tail -c 500 "$html")
  if ! echo "$tail_bytes" | grep -qi '</html>'; then
    echo "FAIL: $html (missing closing </html> tag in last 500 bytes — possible truncation)"
    FAIL=$((FAIL+1))
  else
    echo "  ok: $html"
  fi
done

echo ""
echo "=== File size delta check (86e19cdbq hardening — WARN only) ==="
# For each modified file (staged for commit), compare byte count to HEAD.
# If new size is < 50% of old size AND old > 100 bytes, issue WARN.
# This catches large unexpected deletions without blocking (legitimate deletions exist).
if git rev-parse --git-dir > /dev/null 2>&1; then
  MODIFIED=$(git diff --cached --name-only --diff-filter=M 2>/dev/null || true)
  if [ -n "$MODIFIED" ]; then
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      if git show "HEAD:$f" > /tmp/head_version 2>/dev/null; then
        old_size=$(wc -c < /tmp/head_version)
        new_size=$(wc -c < "$f")
        if [ "$old_size" -gt 100 ] && [ "$new_size" -lt $((old_size / 2)) ]; then
          pct=$((new_size * 100 / old_size))
          echo "WARN: $f (size delta: $old_size → $new_size bytes, $pct% of original)"
          WARN=$((WARN+1))
        fi
      fi
    done <<< "$MODIFIED"
  else
    echo "  skip: no modified files staged"
  fi
  rm -f /tmp/head_version
else
  echo "  skip: not a git repository"
fi

echo ""
echo "=== React app scaffold check (main/staging branches) ==="
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "staging" ]]; then
  if [ ! -f "react-app/package.json" ]; then
    echo "FAIL: react-app/package.json missing on branch '$CURRENT_BRANCH'."
    echo "      The Netlify otterquote-app site (app.otterquote.com) requires react-app/ to exist."
    echo "      Merge or restore react-app/ before pushing to main/staging."
    FAIL=$((FAIL+1))
  else
    echo "  ok: react-app/package.json present"
  fi
else
  echo "  skip: not main/staging (branch: $CURRENT_BRANCH)"
fi

echo ""
echo "=== Summary ==="
echo "FAIL: $FAIL, WARN: $WARN"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "BLOCKED. Fix errors above or add [LINT-WAIVER: reason] to commit message."
  exit 1
fi
echo "PASS"
exit 0
