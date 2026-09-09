#!/usr/bin/env bash
# =============================================================================
# Shallow-Clone Guard -- gh-1887
# =============================================================================
# Purpose: `git merge-base --is-ancestor <A> <B>` exits 1 for two entirely
#          different situations and gives no way to tell them apart:
#            (a) A really is not an ancestor of B, or
#            (b) the local repo is a shallow clone and cannot see far enough
#                back in history to know either way.
#          Nothing goes to stderr. There is no "shallow" notice. Case (b) is
#          a confident-looking negative produced by a truncated instrument,
#          not a verified fact about the commit graph.
#
#          On 2026-09-08 exactly this happened on a shared depth-1 clone:
#          `git rev-list --count origin/main` was 1 (should have been ~1836).
#          Two independent people ran `--is-ancestor` against that clone and
#          both concluded main had been force-pushed. It had not
#          (allow_force_pushes.enabled = false, confirmed). The clone was
#          truncated, not the branch. See In Flight/reports/
#          cto30-main-ancestry-20260908.md and GitHub issue #1887.
#
# What this script does: refuses to let that happen silently again. Run it
# BEFORE trusting the output of any `git merge-base --is-ancestor` call in
# this working tree. If the repo is shallow, it FAILS LOUDLY (non-zero exit,
# explicit message naming the cause and the fix) instead of letting a caller
# silently trust a truncated answer.
#
# Usage:
#   bash scripts/check-shallow-clone-guard.sh
#   # then, only if it exited 0:
#   git merge-base --is-ancestor "$A" "$B"
#
# Wired into: scripts/pre-push-check.sh (runs on every invocation, before
# any ancestry-dependent check). A guard nobody calls is the same defect one
# level up (#1501 lesson) -- this one is called, not just present.
#
# Exit codes:
#   0 -- repo has full history; `git merge-base --is-ancestor` answers are
#        trustworthy as far as normal git semantics go.
#   1 -- repo is a shallow clone; `git merge-base --is-ancestor` CANNOT be
#        trusted here. Fix: `git fetch --unshallow` (or a deep-enough
#        `git fetch --depth=N` that covers both commits being compared),
#        then re-run.
#   2 -- usage/environment error (not a git repository, git not on PATH).
# =============================================================================
set -uo pipefail

if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  echo "SHALLOW-GUARD ERROR: not inside a git working tree; cannot check shallow state." >&2
  exit 2
fi

IS_SHALLOW="$(git rev-parse --is-shallow-repository 2>/dev/null)"

if [ "$IS_SHALLOW" = "true" ]; then
  COMMIT_COUNT="$(git rev-list --count HEAD 2>/dev/null || echo "unknown")"
  echo "SHALLOW-GUARD FAIL: this is a shallow clone (git rev-parse --is-shallow-repository = true)." >&2
  echo "  git merge-base --is-ancestor is NOT trustworthy here: it exits 1 both when a commit" >&2
  echo "  really isn't an ancestor AND when the clone can't see far enough back to tell -- with" >&2
  echo "  no stderr output and no way to distinguish the two cases (gh-1887)." >&2
  echo "  HEAD-reachable commit count in this clone: $COMMIT_COUNT." >&2
  echo "  FIX: run 'git fetch --unshallow' (or a --depth deep enough to cover both commits" >&2
  echo "  being compared), then re-run whatever ancestry check called this guard." >&2
  exit 1
fi

if [ "$IS_SHALLOW" != "false" ]; then
  echo "SHALLOW-GUARD ERROR: could not determine shallow state (git rev-parse --is-shallow-repository returned '$IS_SHALLOW')." >&2
  exit 2
fi

echo "SHALLOW-GUARD PASS: full history present; git merge-base --is-ancestor is trustworthy here."
exit 0
