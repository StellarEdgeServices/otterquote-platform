#!/usr/bin/env python3
"""
Self-test for scripts/workflow-safety-ratchet.py (gh-1651).

Two layers, per this repo's detector-negative-control-check.py (gh-1738)
convention -- a self-test must actually RUN and self-report PASS/FAIL lines,
not merely exist:

  1. Runs the script's own `--self-test` as a subprocess against
     scripts/workflow-safety-fixtures/ and asserts it exits 0. That is the
     same invocation .github/workflows/workflow-safety-ratchet.yml makes, so
     this layer proves the wiring, not only the logic.
  2. Imports the module and exercises the negative controls inline, so the
     asymmetry this ratchet exists to encode does not depend on the fixture
     files staying in sync with this file:
       - the UNSAFE shape on `pull_request_target` FAILS;
       - the SAME unsafe body on `pull_request` PASSES (trigger-level control
         -- a ratchet that failed here would fail most of this repo's CI);
       - a job NAME merely containing the string on a `pull_request` workflow
         PASSES (this was a real false positive, observed 2026-09-08 against
         this repo's own new workflow file, before the trigger match was
         anchored);
       - the `env:` indirection form PASSES while direct interpolation into
         `run:` FAILS.

Layer 3 (added after PR #1857's REVIEW: FAIL, comment 5584425701) carries the
reviewer's three attacks inline as well as in the fixture directory, so
deleting a fixture cannot quietly un-refute them: the flow-mapping trigger
form, the one-`env:`-hop head checkout, and the `github-script` `script:`
sink -- plus the gh-1419 rule that an empty root is UNMEASURED (exit 3), not
a PASS.

Run: python scripts/workflow-safety-ratchet.test.py
"""
import importlib.util
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("wsr", HERE / "workflow-safety-ratchet.py")
wsr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wsr)

FAILURES = []
TOTAL_CHECKS = 0


def check(label, actual, expected):
    global TOTAL_CHECKS
    TOTAL_CHECKS += 1
    if actual == expected:
        print("  PASS  %s: %r" % (label, actual))
    else:
        print("  FAIL  %s: expected %r, got %r" % (label, expected, actual))
        FAILURES.append(label)


def rules_for(yaml_text):
    findings, applicable = wsr.evaluate("inline.yml", yaml_text)
    return sorted({f.rule for f in findings}), applicable


# ── Layer 1: the fixture suite the workflow itself runs ──────────────────────
proc = subprocess.run(
    [sys.executable, str(HERE / "workflow-safety-ratchet.py"), "--self-test",
     "--root", str(HERE.parent)],
    capture_output=True, text=True,
)
print(proc.stdout.rstrip())
check("fixture self-test (--self-test) exits 0", proc.returncode, 0)

# ── Layer 2: negative controls, inline ───────────────────────────────────────
PRT_HEAD = """
on:
  pull_request_target:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - run: npm ci
"""
rules, applicable = rules_for(PRT_HEAD)
check("pull_request_target + PR-head checkout is FLAGGED", "HEAD_CHECKOUT" in rules, True)
check("...and the file is recognised as PRT-triggered", applicable, True)

# NEGATIVE CONTROL: byte-identical body, ordinary trigger. A fork's
# pull_request run gets no secrets and a read-only token, which is the whole
# reason this ratchet polices one trigger and not the other.
PR_HEAD = PRT_HEAD.replace("pull_request_target:", "pull_request:")
rules, applicable = rules_for(PR_HEAD)
check("NEGATIVE CONTROL: same unsafe body on `pull_request` is NOT flagged", rules, [])
check("...and the file is NOT treated as PRT-triggered", applicable, False)

NAME_ONLY = """
on:
  pull_request:
jobs:
  scan:
    name: No unsafe pull_request_target workflow
    runs-on: ubuntu-latest
    steps:
      - run: echo "${{ github.event.pull_request.title }}"
"""
rules, applicable = rules_for(NAME_ONLY)
check("NEGATIVE CONTROL: the string in a job NAME does not arm the rules", rules, [])
check("...trigger match is anchored, not a substring search", applicable, False)

RUN_INTERP = """
on:
  pull_request_target:
jobs:
  echo:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "${{ github.event.pull_request.title }}"
"""
rules, _ = rules_for(RUN_INTERP)
check("untrusted expression interpolated into `run:` is FLAGGED", "UNTRUSTED_SINK" in rules, True)

ENV_INDIRECTION = """
on:
  pull_request_target:
jobs:
  echo:
    runs-on: ubuntu-latest
    steps:
      - env:
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: |
          echo "$PR_TITLE"
"""
rules, _ = rules_for(ENV_INDIRECTION)
check("NEGATIVE CONTROL: the documented `env:` indirection form PASSES", rules, [])

SAFE_SCALAR = """
on:
  pull_request_target:
jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/r177/predicate.mjs --pr ${{ github.event.pull_request.number }}
"""
rules, _ = rules_for(SAFE_SCALAR)
check("NEGATIVE CONTROL: an allowlisted non-injectable scalar PASSES", rules, [])

NAMED_SECRET = """
on:
  pull_request_target:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - env:
          KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
        run: |
          curl -H "apikey: $KEY" https://example.invalid
"""
rules, _ = rules_for(NAMED_SECRET)
check("a named repository secret in a PRT workflow is FLAGGED", "SECRETS_IN_PRT" in rules, True)

TOKEN_ONLY = """
on:
  pull_request_target:
permissions:
  contents: read
  pull-requests: write
jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v9
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: core.info('label only')
"""
rules, _ = rules_for(TOKEN_ONLY)
check("NEGATIVE CONTROL: the automatic GITHUB_TOKEN alone PASSES", rules, [])

UNPARSEABLE = """
on:
  pull_request_target:
jobs:
  x:
    steps:
      - run: curl -H "apikey: $KEY" https://example.invalid
"""
rules, applicable = rules_for(UNPARSEABLE)
check("an UNPARSEABLE workflow fails closed rather than passing", rules, ["UNPARSEABLE"])
check("...and is not silently treated as not-PRT", applicable, True)

# ── The three attacks from PR #1857's REVIEW: FAIL (comment 5584425701) ─────
# Carried inline as well as in the fixture files, so a deleted fixture cannot
# quietly un-refute them.

FLOW_MAPPING_PWN = """
name: evade flow map
on: {pull_request_target: {types: [opened, synchronize]}}
permissions: {contents: write}
jobs:
  pwn:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - run: echo "${{ github.event.pull_request.title }}"
      - run: ./build.sh
        env:
          TOKEN: ${{ secrets.GITHUB_DEPLOY_PAT }}
"""
rules, applicable = rules_for(FLOW_MAPPING_PWN)
check("REFUTER 1: the flow-MAPPING trigger form is recognised as PRT", applicable, True)
check("REFUTER 1: ...and the pwn file trips all three rules",
      sorted(rules), ["HEAD_CHECKOUT", "SECRETS_IN_PRT", "UNTRUSTED_SINK"])

ENV_REF_PWN = """
name: evade env ref
on:
  pull_request_target: {types: [opened]}
env:
  PR_HEAD: ${{ github.event.pull_request.head.sha }}
jobs:
  pwn:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ env.PR_HEAD }}
"""
rules, _ = rules_for(ENV_REF_PWN)
check("REFUTER 2a: one env: hop no longer hides a head checkout", "HEAD_CHECKOUT" in rules, True)

SCRIPT_SINK_PWN = """
on:
  pull_request_target: {types: [opened]}
jobs:
  pwn:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            console.log("${{ github.event.pull_request.body }}")
"""
rules, _ = rules_for(SCRIPT_SINK_PWN)
check("REFUTER 2b: github-script's `script:` input is walked as a sink", "UNTRUSTED_SINK" in rules, True)

UNRESOLVABLE_REF = """
on:
  pull_request_target: {types: [opened]}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ env.NOT_DEFINED_HERE }}
"""
rules, _ = rules_for(UNRESOLVABLE_REF)
check("a ref through an env this file never defines FAILS CLOSED", "UNRESOLVED_REF" in rules, True)

# REFUTER 3 -- UNMEASURED is not a PASS (gh-1419). An empty root must exit 3.
import tempfile
with tempfile.TemporaryDirectory() as _tmp:
    empty_code = wsr.main(["--root", _tmp, "--quiet"])
check("REFUTER 3: an empty root exits 3 (UNMEASURED), not 0", empty_code, wsr.EXIT_UNMEASURED)
with tempfile.TemporaryDirectory() as _tmp:
    proc_empty = subprocess.run(
        [sys.executable, str(HERE / "workflow-safety-ratchet.py"), "--root", _tmp],
        capture_output=True, text=True)
check("REFUTER 3: ...and says UNMEASURED out loud", "UNMEASURED" in proc_empty.stdout, True)

# The live tree must be green, or this ratchet ships red on arrival.
findings, applicable, skipped, files = wsr.scan_root(HERE.parent)
check("live .github/workflows scan reports no findings", [f.rule for f in findings], [])
check("...and it actually read some workflow files", len(files) > 0, True)
check("...and it recognised at least one PRT workflow (r177-legal-read.yml)", len(applicable) >= 1, True)
check("the accurate parser is the one that ran", wsr.HAVE_YAML, True)

print()
print("assertions: %d, failures: %d" % (TOTAL_CHECKS, len(FAILURES)))
if FAILURES:
    print("FAILED CHECKS: %s" % ", ".join(FAILURES))
    sys.exit(1)
print("ALL CHECKS PASSED")
sys.exit(0)
