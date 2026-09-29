#!/usr/bin/env python3
"""
Regression test for the stale-base trap in the two GRANT gates (gh-1438,
Marty A 5896036859 item 5).

`github.event.pull_request.base.sha` is the base sha as of the last event
that populated it, not the current tip of main. When a PR merges a newer
main into itself, `--base <stale sha>` makes the script's `base...head`
diff span every main commit landed in between, so unrelated, already-live
GRANT/REVOKE lines read as newly added by the PR (false red).

The workflows must resolve --base from the checked-out merge ref instead
(`git rev-parse HEAD^1`). This test asserts neither workflow feeds
`github.event.pull_request.base.sha` into the scripts' --base argument and
that both resolve it dynamically from HEAD^1.

Run: python scripts/grant-gates-dynamic-base.test.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOWS = {
    "permissions-ratchet.yml": "scripts/permissions-ratchet.py",
    "new-table-service-role-grant.yml": "scripts/new-table-service-role-grant-check.py",
}
STALE = "github.event.pull_request.base.sha"
FAILURES = []


def check(label, ok):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    if not ok:
        FAILURES.append(label)


def code_lines(text):
    """Workflow text with full-line YAML comments removed."""
    return [l for l in text.splitlines() if not l.lstrip().startswith("#")]


def main():
    for name, script in WORKFLOWS.items():
        text = (ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8")
        lines = code_lines(text)
        joined = "\n".join(lines)
        # The invocation is a multi-line shell command; take from the script
        # name to the end of its backslash-continued block.
        invocations = [
            mm.group(0)
            for mm in re.finditer(re.escape(script) + r" *\\?\n?(?:[^\n]*\\\n)*[^\n]*--base[^\n]*", joined)
        ]
        check(f"{name}: has a --base invocation of {script}", len(invocations) >= 1)
        check(
            f"{name}: --base does not use {STALE}",
            all(STALE not in inv for inv in invocations) and len(invocations) >= 1,
        )
        check(f"{name}: resolves base from HEAD^1 (merge ref first parent)", "HEAD^1" in joined)
        # The resolve step must feed the gate: the invocation passes the
        # resolved sha, and the step exports it to GITHUB_ENV.
        check(
            f"{name}: --base is the resolved sha",
            len(invocations) >= 1 and all('--base "$RESOLVED_BASE_SHA"' in inv for inv in invocations),
        )
        check(
            f"{name}: resolve step exports RESOLVED_BASE_SHA",
            re.search(r'echo "RESOLVED_BASE_SHA=\$base" >> "\$GITHUB_ENV"', joined) is not None,
        )
    print()
    if FAILURES:
        print(f"FAILED: {len(FAILURES)} check(s)")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
