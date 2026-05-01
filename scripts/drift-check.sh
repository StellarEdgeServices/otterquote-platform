#!/usr/bin/env bash
# =============================================================================
# D-196 Drift Check -- OtterQuote Deploy Gate
# =============================================================================
# Purpose: After rsync from otterquote-deploy/ to $DEPLOY_DIR, verify that only
#          the intended files appear as changed in git. Any unexpected file is
#          a local-repo drift artifact that should NOT hit production.
#
# Usage:
#   bash scripts/drift-check.sh "file1.html file2.html js/app.js"
#
# Arguments:
#   $1 -- Space-delimited list of files in this deploy's intended changeset.
#         Pass the exact paths relative to repo root, matching git status output.
#         Example: "terms.html privacy.html contractor-agreement.html"
#
# Exit codes:
#   0 -- Drift check passed. Only intended files are changed.
#   1 -- Drift detected. Unexpected files found. Halt deploy.
#   2 -- Usage error (wrong number of arguments).
#
# Rule: CRITICAL -- always blocks. Call before git add and before pushing.
# =============================================================================

set -euo pipefail

# --- Argument validation -----------------------------------------------------

if [[ $# -lt 1 ]]; then
  echo "USAGE ERROR: drift-check.sh requires the intended changeset as argument 1."
  echo "   Example: bash scripts/drift-check.sh \"terms.html privacy.html\""
  exit 2
fi

INTENDED="$1"

# --- Confirm we are inside a git repo ----------------------------------------

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  echo "ERROR: Not inside a git repository. Run from DEPLOY_DIR."
  exit 2
fi

# --- Build expected set -------------------------------------------------------

declare -A EXPECTED
for f in $INTENDED; do
  EXPECTED["$f"]=1
done

# --- Run git status -----------------------------------------------------------

echo ""
echo "=== D-196 Drift Check ==="
echo ""
echo "Intended changeset (${#EXPECTED[@]} files):"
for f in "${!EXPECTED[@]}"; do
  echo "  [OK] $f"
done
echo ""

# git status --short -u: -u expands new untracked directories to individual
# files rather than collapsing to "dir/".
# Columns are XY + space + filepath -- strip prefix with awk.
ACTUAL_FILES=$(git status --short -u | awk '{print $NF}')

if [[ -z "$ACTUAL_FILES" ]]; then
  echo "WARNING: No changes detected after rsync. Nothing to deploy."
  echo "   If this is unexpected, verify the rsync command ran correctly."
  exit 0
fi

echo "Actual changes detected by git:"
UNEXPECTED_COUNT=0
UNEXPECTED_FILES=()

while IFS= read -r file; do
  if [[ -n "${EXPECTED[$file]+_}" ]]; then
    echo "  [OK]  $file  (expected)"
  else
    echo "  [!!]  $file  <- UNEXPECTED DRIFT"
    UNEXPECTED_FILES+=("$file")
    ((UNEXPECTED_COUNT++)) || true
  fi
done <<< "$ACTUAL_FILES"

echo ""

# --- Result ------------------------------------------------------------------

if [[ $UNEXPECTED_COUNT -gt 0 ]]; then
  echo "=== DRIFT DETECTED -- DEPLOY HALTED (D-196) ==="
  echo ""
  echo " $UNEXPECTED_COUNT unexpected file(s) in DEPLOY_DIR that are NOT"
  echo " part of this deploy's intended changeset:"
  echo ""
  for f in "${UNEXPECTED_FILES[@]}"; do
    echo "   -> $f"
  done
  echo ""
  echo " Action required: Surface to Dustin. Do not git add, commit, or push"
  echo " until the unexpected file(s) have been reviewed and resolved."
  echo " Options:"
  echo "   (a) Add to intended changeset if the change is correct"
  echo "   (b) Discard via: git checkout -- <file>"
  echo ""
  exit 1
else
  echo "=== Drift check passed -- proceed with deploy ==="
  echo ""
  exit 0
fi
