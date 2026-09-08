#!/usr/bin/env python3
r"""
workflow-safety-ratchet.py -- gh-1651 CI gate: fail a PR that introduces a
`pull_request_target` workflow which can execute, or hand a token to,
fork-controlled input.

WHY THIS EXISTS (gh-1651)
-------------------------
#1651's body recorded, as its single most important negative result:

    "No workflow in this repository uses `pull_request_target`. All 13 read;
     zero occurrences ... it must keep appearing nowhere."

That sentence was written 2026-09-04T20:16:10Z. One hour fifty-three minutes
later commit c1b0afb7 landed `r120-signed-review.yml`, which used
`pull_request_target`, and nothing noticed for two days (#1651 comment
5561638561). The invariant was a note in an issue, not a check, and a note
cannot fail a build.

`pull_request_target` runs in BASE-branch context: the job gets the
repository's secrets and a write-scoped `GITHUB_TOKEN`, on an event a
stranger triggers by opening a pull request. That is safe only while the
workflow never executes, and never interpolates, anything the PR head
controls. Today's only instance -- `r177-legal-read.yml`, successor to the
retired r120 gate -- is safe on exactly those terms: it checks out the BASE
branch with `persist-credentials: false`, sparse-checks-out one script, takes
the PR diff as an API STRING, and references zero secrets. This ratchet is
that reasoning turned into a gate, so the next such workflow cannot quietly
drop one of those properties.

WHAT IT IS NOT
--------------
It is not a YAML linter and it does not police `pull_request` workflows: a
fork's `pull_request` run gets no secrets and a read-only token, which is the
whole reason `pull_request_target` is the dangerous trigger and the ordinary
one is not. Files that never mention `pull_request_target` are reported as
`skipped` and can never fail this check.

THE THREE RULES (each with a fixture observed failing on the bad shape and
passing on the safe shape -- run `--self-test`)
-----------------------------------------------------------------------
  1. HEAD_CHECKOUT   -- a `ref:` (or `sha:`) input whose value interpolates
     PR-head-controlled state: `github.event.pull_request.head.*`,
     `github.event.pull_request.merge_commit_sha`, `github.head_ref`, or a
     literal `refs/pull/...` ref. This is the classic pwn shape: base-context
     secrets plus the attacker's tree checked out on top of them.
  2. UNTRUSTED_RUN   -- an untrusted `${{ github.event.* }}` /
     `${{ github.head_ref }}` expression interpolated directly into a `run:`
     script. The PR title, body, branch name and label names are all
     attacker-authored strings pasted into a shell. An `env:` indirection --
     `env: { T: ${{ github.event.pull_request.title }} }` then `"$T"` in the
     script -- is the documented safe form and is NOT flagged; only the
     direct `run:`-body interpolation is.
     Allowlisted as structurally non-injectable scalars:
     `github.event.pull_request.number`, `github.event.number`,
     `github.event.repository.default_branch`,
     `github.event.pull_request.base.sha`, `github.event.pull_request.head.sha`
     is NOT allowlisted here (it is attacker-CHOSEN, even though it is hex,
     and checking it out is rule 1's business).
  3. SECRETS_IN_PRT  -- any `secrets.<NAME>` other than `secrets.GITHUB_TOKEN`
     referenced by a `pull_request_target` workflow. The automatic
     `GITHUB_TOKEN` is already scoped by the file's own `permissions:` block;
     a named repository secret in a stranger-triggered job is the exposure
     #1651 § 4 describes, and there is no legitimate instance in this repo
     today (measured: `r177-legal-read.yml` references zero).

SCOPE
-----
`.github/workflows/*.yml` and `*.yaml`, whole-tree (this is a small, bounded
file set -- 19 files at the time of writing -- so the ratchet reads all of
them rather than diffing; a repo-wide read that is GREEN today cannot have a
"can never go green" problem, and the green state is this file's positive
control).

PARSING
-------
Deliberately stdlib-only, no PyYAML: the CI job must not depend on a pip
install to answer a security question, and the shapes this looks for are
line-local. Full-line comments are dropped; inline comments are stripped
quote-aware. A `run:` block scalar's body is taken by indentation.

Usage:
  python3 scripts/workflow-safety-ratchet.py --root .        # gate (exit 1 on findings)
  python3 scripts/workflow-safety-ratchet.py --self-test     # rule self-test
"""
import argparse
import os
import re
import sys
from pathlib import Path

WORKFLOW_DIR = ".github/workflows"
FIXTURE_DIR = "scripts/workflow-safety-fixtures"

# --- untrusted expression vocabulary -----------------------------------------

HEAD_REF_PATTERNS = [
    r"github\.event\.pull_request\.head\.",
    r"github\.event\.pull_request\.merge_commit_sha",
    r"github\.head_ref",
    r"refs/pull/",
]

# Expressions a fork controls the CONTENT of. Anything matching
# `github.event.` that is not allowlisted below counts as untrusted.
SAFE_EVENT_EXPRS = {
    "github.event.pull_request.number",
    "github.event.number",
    "github.event.repository.default_branch",
    "github.event.pull_request.base.sha",
    "github.event.pull_request.state",
    "github.event.action",
}

EXPR_RE = re.compile(r"\$\{\{([^}]*)\}\}")
REF_INPUT_RE = re.compile(r"^\s*(ref|sha|commit)\s*:\s*(.+?)\s*$")
RUN_START_RE = re.compile(r"^(\s*)-?\s*run\s*:\s*(\|-?|>-?|)\s*(.*)$")
SECRET_RE = re.compile(r"secrets\.([A-Za-z_][A-Za-z0-9_]*)")
# A trigger key, not the string. `name: No unsafe pull_request_target workflow`
# is prose in a job name and must not arm the rules -- see the fixture
# name_mentions_prt_good.yml, which is this repo's own workflow-safety-ratchet.yml
# shape and was a live false positive before this was anchored.
PRT_KEY_RE = re.compile(r"^\s*(?:-\s*)?pull_request_target\s*:\s*(\{.*\})?$")
PRT_ITEM_RE = re.compile(r"^\s*-\s*pull_request_target\s*$")
PRT_FLOW_RE = re.compile(r"^\s*on\s*:\s*\[[^\]]*\bpull_request_target\b[^\]]*\]\s*$")


def strip_comments(text: str) -> str:
    """Drop full-line comments; strip inline `#` comments outside quotes."""
    out = []
    for line in text.split("\n"):
        if line.lstrip().startswith("#"):
            out.append("")
            continue
        cleaned, quote = [], None
        i = 0
        while i < len(line):
            ch = line[i]
            if quote:
                cleaned.append(ch)
                if ch == quote:
                    quote = None
            elif ch in "'\"":
                quote = ch
                cleaned.append(ch)
            elif ch == "#" and (not cleaned or cleaned[-1] in " \t"):
                break
            else:
                cleaned.append(ch)
            i += 1
        out.append("".join(cleaned).rstrip())
    return "\n".join(out)


def triggers_pull_request_target(lines) -> bool:
    """True if `pull_request_target` appears as a trigger key, not in prose.

    Comments are already stripped, so any surviving occurrence is YAML. The
    match is anchored to the three legal spellings of the trigger -- a mapping
    key, a sequence item, and a flow-sequence `on: [...]` -- because an
    unanchored search matched this repo's own `name: No unsafe
    pull_request_target workflow` job label and armed all three rules against
    a `pull_request` workflow (observed live 2026-09-08; fixture
    name_mentions_prt_good.yml).
    """
    return any(
        PRT_KEY_RE.match(l) or PRT_ITEM_RE.match(l) or PRT_FLOW_RE.match(l)
        for l in lines
    )


def untrusted_exprs(fragment: str):
    """Untrusted `${{ ... }}` expressions inside a fragment of YAML/shell."""
    found = []
    for m in EXPR_RE.finditer(fragment):
        expr = m.group(1).strip()
        bare = expr.strip("() ")
        if bare in SAFE_EVENT_EXPRS:
            continue
        if bare.startswith("github.event.") or bare == "github.head_ref":
            found.append(bare)
        elif "github.event." in bare or "github.head_ref" in bare:
            # e.g. `format('{0}', github.event.pull_request.title)`
            inner = re.findall(r"github\.(?:event\.[A-Za-z0-9_.]+|head_ref)", bare)
            found.extend(i for i in inner if i not in SAFE_EVENT_EXPRS)
    return found


def run_bodies(lines):
    """Yield (start_line_no, body_text) for every `run:` scalar."""
    i = 0
    while i < len(lines):
        m = RUN_START_RE.match(lines[i])
        if not m:
            i += 1
            continue
        indent, block, inline = m.group(1), m.group(2), m.group(3)
        start = i + 1
        if not block:
            yield start, inline
            i += 1
            continue
        body, j = [], i + 1
        base_indent = None
        while j < len(lines):
            line = lines[j]
            if line.strip() == "":
                body.append("")
                j += 1
                continue
            cur = len(line) - len(line.lstrip())
            if base_indent is None:
                if cur <= len(indent):
                    break
                base_indent = cur
            if cur < base_indent:
                break
            body.append(line)
            j += 1
        yield start, "\n".join(body)
        i = j


class Finding:
    def __init__(self, rule, file, line, message):
        self.rule, self.file, self.line, self.message = rule, file, line, message

    def render(self):
        return f"  [{self.rule}] {self.file}:{self.line} -- {self.message}"


def evaluate(file_rel: str, text: str):
    """Return (findings, applicable) for one workflow file."""
    lines = strip_comments(text).split("\n")
    if not triggers_pull_request_target(lines):
        return [], False

    findings = []

    # Rule 1 -- HEAD_CHECKOUT
    for n, line in enumerate(lines, 1):
        m = REF_INPUT_RE.match(line)
        if not m:
            continue
        value = m.group(2)
        for pat in HEAD_REF_PATTERNS:
            if re.search(pat, value):
                findings.append(Finding(
                    "HEAD_CHECKOUT", file_rel, n,
                    f"`{m.group(1)}:` resolves to PR-head-controlled state ({pat!r}) "
                    f"in a pull_request_target workflow: base-context secrets would run the fork's tree",
                ))
                break

    # Rule 2 -- UNTRUSTED_RUN
    for start, body in run_bodies(lines):
        bad = untrusted_exprs(body)
        if bad:
            findings.append(Finding(
                "UNTRUSTED_RUN", file_rel, start,
                "attacker-authored expression(s) interpolated directly into a `run:` script: "
                + ", ".join(sorted(set(bad)))
                + " -- pass them through `env:` and quote the variable instead",
            ))

    # Rule 3 -- SECRETS_IN_PRT
    for n, line in enumerate(lines, 1):
        for m in SECRET_RE.finditer(line):
            name = m.group(1)
            if name == "GITHUB_TOKEN":
                continue
            findings.append(Finding(
                "SECRETS_IN_PRT", file_rel, n,
                f"`secrets.{name}` referenced in a pull_request_target workflow -- "
                f"a stranger-triggered job must not hold a named repository secret",
            ))

    return findings, True


def scan_root(root: Path):
    wf_dir = root / WORKFLOW_DIR
    files = sorted(
        [p for p in wf_dir.glob("*.yml")] + [p for p in wf_dir.glob("*.yaml")]
    ) if wf_dir.is_dir() else []
    findings, applicable, skipped = [], [], []
    for p in files:
        rel = str(p.relative_to(root))
        f, is_prt = evaluate(rel, p.read_text(encoding="utf-8", errors="replace"))
        (applicable if is_prt else skipped).append(rel)
        findings.extend(f)
    return findings, applicable, skipped, files


def self_test(root: Path):
    """Every rule, on a fixture observed failing bad and passing good."""
    fx = root / FIXTURE_DIR
    expectations = [
        ("prt_head_checkout_bad.yml", "HEAD_CHECKOUT"),
        ("prt_base_checkout_good.yml", None),
        ("prt_untrusted_run_bad.yml", "UNTRUSTED_RUN"),
        ("prt_env_indirection_good.yml", None),
        ("prt_named_secret_bad.yml", "SECRETS_IN_PRT"),
        ("prt_github_token_only_good.yml", None),
        ("plain_pull_request_head_checkout_good.yml", None),
        ("name_mentions_prt_good.yml", None),
        ("prt_flow_sequence_trigger_bad.yml", "HEAD_CHECKOUT"),
    ]
    failures = 0
    print("SELF-TEST -- each rule beside its negative control")
    for name, expect in expectations:
        p = fx / name
        if not p.exists():
            print(f"  MISSING FIXTURE {name}")
            failures += 1
            continue
        found, applicable = evaluate(name, p.read_text(encoding="utf-8"))
        rules = sorted({f.rule for f in found})
        if expect is None:
            ok = not found
            detail = "no findings" if ok else f"UNEXPECTED {rules}"
        else:
            ok = expect in rules
            detail = f"{rules}" if ok else f"expected {expect}, got {rules or 'none'}"
        print(f"  {'ok  ' if ok else 'FAIL'} {name:48s} {detail}")
        if not ok:
            failures += 1
    print(f"self-test: {len(expectations) - failures} passed | {failures} failed")
    return 1 if failures else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="gh-1651 pull_request_target safety ratchet")
    ap.add_argument("--root", default=".")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)
    root = Path(args.root).resolve()

    if args.self_test:
        return self_test(root)

    findings, applicable, skipped, files = scan_root(root)
    print(f"workflow-safety-ratchet (gh-1651) -- root {root}")
    print(f"  workflow files read           : {len(files)}")
    print(f"  pull_request_target workflows : {len(applicable)} {applicable}")
    print(f"  skipped (not PRT-triggered)   : {len(skipped)}")
    if not findings:
        print("PASS -- no pull_request_target workflow executes or interpolates "
              "fork-controlled input, and none holds a named secret.")
        return 0
    print(f"FAIL -- {len(findings)} finding(s):")
    for f in findings:
        print(f.render())
    print("\nSee scripts/workflow-safety-ratchet.py's module docstring for why each rule exists.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
