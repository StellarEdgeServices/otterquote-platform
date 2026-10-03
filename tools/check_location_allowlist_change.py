#!/usr/bin/env python3
"""gh-2422 (D-345): a state joins the /locations/ allow-list only in its own R-177 PR.

CEO ruling (Ben, #2304 5964402773): the copy lint is a tripwire; the guarantee is
the R-177 LEGAL-READ of each state's profile and county content, done in the PR
that adds the state. This check enforces the cheap, diff-scoped half of that rule:

  1. A change may ADD AT MOST ONE state to data/location-pages-state-allowlist.json
     (one state per PR, so each legal read covers exactly one state).
  2. A state added to the allow-list must have its profile,
     data/location-state-profiles/XX.json, changed in the SAME diff, so the copy
     the legal read signs is the copy that ships with the state.

Removing a state is always allowed. Whether the PR carries the R-177 label and
signature is enforced by the R-177 process itself, not here.

Usage:
  python3 tools/check_location_allowlist_change.py --base <sha> --head <sha>
  python3 tools/check_location_allowlist_change.py --self-test
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

ALLOWLIST = "data/location-pages-state-allowlist.json"
PROFILE_DIR = "data/location-state-profiles"


def _states(text: str | None) -> set[str]:
    if text is None:
        return set()
    data = json.loads(text)
    states = data.get("states", [])
    if not isinstance(states, list) or not all(isinstance(s, str) for s in states):
        raise ValueError(f"{ALLOWLIST}: \"states\" must be a list of strings")
    return {s.strip().upper() for s in states}


def evaluate(base_text: str | None, head_text: str | None, changed: set[str]) -> list[str]:
    """Return a list of violations (empty = pass)."""
    added = sorted(_states(head_text) - _states(base_text))
    errors: list[str] = []
    if len(added) > 1:
        errors.append(
            f"{len(added)} states added to {ALLOWLIST} in one change ({', '.join(added)}); "
            "add one state per PR so each R-177 legal read covers exactly one state"
        )
    for st in added:
        profile = f"{PROFILE_DIR}/{st}.json"
        if profile not in changed:
            errors.append(
                f"state {st} added to {ALLOWLIST} but {profile} is not changed in the same PR; "
                "the PR that adds a state must carry that state's profile and county content "
                "for the R-177 legal read"
            )
    return errors


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def _show(rev: str, path: str) -> str | None:
    r = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def self_test() -> int:
    empty = '{"states": []}'
    one = '{"states": ["OH"]}'
    two = '{"states": ["OH", "TN"]}'
    cases = [
        ("no allow-list change", empty, empty, set(), True),
        ("add OH with its profile", empty, one, {f"{PROFILE_DIR}/OH.json", ALLOWLIST}, True),
        ("add OH without its profile", empty, one, {ALLOWLIST}, False),
        ("add OH with another state's profile", empty, one, {f"{PROFILE_DIR}/IN.json", ALLOWLIST}, False),
        ("add two states, both profiles", empty, two, {f"{PROFILE_DIR}/OH.json", f"{PROFILE_DIR}/TN.json"}, False),
        ("remove a state", two, one, {ALLOWLIST}, True),
        ("case-folded add counts", empty, '{"states": ["oh"]}', {ALLOWLIST}, False),
        ("allow-list file newly created with a state, no profile", None, one, {ALLOWLIST}, False),
    ]
    bad = 0
    for name, base, head, changed, want_pass in cases:
        got_pass = not evaluate(base, head, changed)
        ok = got_pass == want_pass
        bad += not ok
        print(f"{'PASS' if ok else 'FAIL'}: {name} (expected {'pass' if want_pass else 'fail'})")
    print(f"\n{len(cases) - bad} passed, {bad} failed")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base")
    ap.add_argument("--head", default="HEAD")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    if not a.base:
        ap.error("--base is required")
    changed = set(_git("diff", "--name-only", a.base, a.head).split())
    errors = evaluate(_show(a.base, ALLOWLIST), _show(a.head, ALLOWLIST), changed)
    for e in errors:
        print(f"::error file={ALLOWLIST}::{e}")
    print("location allow-list change rule:", "FAIL" if errors else "PASS")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
