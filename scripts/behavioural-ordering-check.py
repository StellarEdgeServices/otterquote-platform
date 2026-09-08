#!/usr/bin/env python3
"""
behavioural-ordering-check.py -- gh-1840 gate for the two shapes gh-1738 SEVERED.

WHY THIS EXISTS
---------------
gh-1738 closed on a structural technique: reconcile a scanner's declared inputs
against what its workflow trigger actually hands it. Two of its five instances
were explicitly severed to gh-1840 because that technique cannot reach them, and
scripts/detector-negative-control-check.py says so in its own LIMITATIONS block:

  INSTANCE 1 -- PR #1720's entry-point reachability spec installed its spy BEFORE
  the action it was meant to observe, and the installation CREATED the binding
  the spec asserted existed. It reported `11 passed` while four money-path
  handlers threw ReferenceError on a real click.

  INSTANCE 3 -- PR #1737's require_cli() crashed and short-circuited its job
  BEFORE an unrelated, pre-existing drift step later in the same job ever ran.
  The job's red was about the new step; the old check simply never executed and
  nothing said so.

Both are BEHAVIOURAL ORDERING defects: an assertion whose precondition was
established by the test itself, and a step whose crash removed a later
assertion. They need the same new technique -- reasoning about ORDER within a
file -- so they get one gate.

WHAT IS CHECKABLE, AND WHAT IS NOT
----------------------------------
detector-negative-control-check.py argued instance 1 is out of reach because
catching it "would require semantic understanding of *when* an assertion's
precondition was established relative to the action under test". That is true of
the general problem and NOT true of the specific, mechanical property that made
#1720 fail, which is what this gate checks instead:

  A spy/stub installer that REPLACES a target binding must first REFUSE when the
  target is not already a live function.

That is a static, ordered property of one function body: a guard on
`typeof <target> !== 'function'` that throws, appearing BEFORE the first
assignment to the target. #1720's version had the assignment and no guard, so
the spy manufactured its own subject. The current (fixed) version has the guard
first -- and its own comment names the defect. This gate makes that ordering a
requirement instead of a memory.

For instance 3, the checkable property is likewise narrower than "model job
semantics":

  A verification step that can only run if every earlier crashable step passed
  is UNRUN-shadowed. Its silence is indistinguishable from its success.

The fix a workflow author has is already idiomatic Actions: `if: always()` (or
`if: '!cancelled()'`, or `continue-on-error: true` on the earlier step). This
gate does not forbid ordering -- it requires that a step whose result someone
relies on cannot be silently skipped by an unrelated earlier crash.

VERDICT TOKENS (the negative controls this gate must be observed rejecting)
--------------------------------------------------------------------------
  SPY_CREATES_ITS_OWN_BINDING   -- CHECK A, instance 1's shape
  STEP_UNRUN_SHADOWED           -- CHECK B, instance 3's shape

EXIT CODES: 0 PASS · 2 FAIL · 3 UNMEASURED (nothing to inspect -- never PASS on
an empty root, which is gh-1738's founding shape and would be this gate
reproducing the defect it exists to close).
"""

import os
import re
import sys

SPEC_EXTENSIONS = (".spec.ts", ".spec.js", ".spec.mjs", ".test.ts", ".mjs")
SPEC_ROOTS = ("tests", "e2e")

TOKEN_SPY = "SPY_CREATES_ITS_OWN_BINDING"
TOKEN_STEP = "STEP_UNRUN_SHADOWED"

# A function is treated as a spy/stub installer when its NAME says so, or when
# its body both records calls and writes a global back. Name-only would miss a
# helper called `patchHandler`; body-only would drag in unrelated assignments.
INSTALLER_NAME = re.compile(r"\b(install|patch|stub|mock|fake|shim)\w*(spy|stub|mock|fake|handler|target|global)\w*\b", re.I)
RECORDS_CALLS = re.compile(r"(spyCalls|__\w*[Ss]py\w*|calls\.push|recordCall)")

# Assignments that REPLACE a global binding.
# Assignments that REPLACE a global HANDLER binding. The target must be
# DYNAMIC -- a variable or template hole -- because that is what makes it a
# handler under test rather than a fixture of the harness. A spec resetting its
# own literal-named bookkeeping (`(window as any).__oqSpyCalls = []`) is not
# installing a spy on anything and must not be flagged: that would be this gate
# firing on the fixture instead of the defect.
ASSIGN_PATTERNS = [
    re.compile(r"new\s+Function\(\s*[`'\"][^`'\"]*\$\{\s*\w+\s*\}\s*=\s*arguments\[0\]"),
    re.compile(r"\(\s*window\s+as\s+any\s*\)\s*\[\s*\w+\s*\]\s*=\s*(?!\[|\{)"),
    re.compile(r"\bwindow\s*\[\s*\w+\s*\]\s*=\s*(?!\[|\{)"),
    re.compile(r"\bglobalThis\s*\[\s*\w+\s*\]\s*=\s*(?!\[|\{)"),
]

# The precondition that makes the failure loud: a typeof-check against
# 'function' whose failing branch throws (or fails the test) -- and it must come
# BEFORE the assignment, which is the whole point of this gate.
GUARD_TYPEOF = re.compile(r"typeof[^;{}]{0,200}?!==?\s*['\"]function['\"]")
GUARD_RAISES = re.compile(r"(throw\s|expect\(|assert)")

VERIFICATION_STEP = re.compile(r"(check|lint|test|drift|gate|scan|verify|audit|parity|smoke)", re.I)
# Setup steps (checkout, toolchain, dependency installs, seeding) are NOT
# shadowers. When one of those crashes the job goes red for a reason nobody can
# mistake for a passing check, and every later step is obviously unrun. The
# defect gh-1738 instance 3 describes is narrower and nastier: one VERIFICATION
# step crashing takes a DIFFERENT, pre-existing verification step with it, and
# the job's red is attributed to the new step alone.
SETUP_STEP = re.compile(r"(checkout|set ?up|install|seed|cache|download|upload|login|configure|restore|build)", re.I)

# Shadowed steps that already existed when gh-1840 was filed. New ones FAIL;
# these are reported as INFO so the gate can be green on main today rather than
# red forever -- the failure mode .github/workflows/detector-negative-control.yml
# names in its own header ("a check nobody can ever make green trains everyone to
# ignore it"). Each entry is `<workflow>::<job>::<step-name-prefix>`; clearing one
# is a one-line deletion here plus an `if: always()` on the step.
LEGACY_SHADOWED = {
    'detector-negative-control.yml::detector-negative-control::Run the gate against this repo',
    'e2e-tests.yml::is-test-cross-table-guard::RED/GREEN self-test against the CI-test project',
    'e2e-tests.yml::static-integrity::Analytics loader single-source guard (gtag.js + clarity.ms behind the ',
    'e2e-tests.yml::static-integrity::Partner-signup consent checkbox link guard (D-278, gh-943)',
    'e2e-tests.yml::static-integrity::cookie-storage.js/config.js load-order check (Stage 5 prevention,',
    'e2e-tests.yml::static-integrity::partner-surface single-source-of-truth check (gh-807)',
    'e2e-tests.yml::static-integrity::partner-sw.js VERSION-bump check (gh-831)',
    'e2e-tests.yml::static-integrity::payout-timing copy drift check (gh-832)',
    'e2e-tests.yml::static-integrity::sb.auth.onAuthStateChange guard check (Stage 5 prevention, 86e1fratf)',
    'e2e-tests.yml::typescript-check::auth.js partner-role-resolution unit test (#817/#643 regression)',
    'e2e-tests.yml::typescript-check::auth.js partner-surface single-source-of-truth unit test (#807 regress',
    'e2e-tests.yml::typescript-check::auth.js stale-session no-hang unit test (#602 regression)',
    'e2e-tests.yml::typescript-check::index.html bounce routing-outcome unit test (#817 A1b regression)',
    'e2e-tests.yml::typescript-check::tsc --noEmit type gate (gh-414)',
    'edge-function-drift.yml::drift::Check deployed Edge Functions against main',
    'edge-function-drift.yml::drift::Self-test the remote-project detector (otter-crm)',
    'edge-function-drift.yml::is-test-cross-table-guard-prod::Check profiles.is_test vs contractors.is_test on production (read-only',
    'edge-function-drift.yml::netlify-drift::Check Netlify production deploys against main',
    'entry-point-reachability-live.yml::poll-for-new-deploy::Check Netlify for a completed production deploy',
    'schema-lint.yml::schema-lint::Run hardcoded-secret function-body linter',
    'schema-lint.yml::schema-lint::Run migration filename prefix linter',
}
ALWAYS_GUARD = re.compile(r"(always\(\)|!\s*cancelled\(\)|failure\(\))")


def _iter_files(root, exts, subdirs=None):
    out = []
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "dist", "build", ".venv")]
        rel = os.path.relpath(base, root)
        if subdirs is not None:
            top = rel.split(os.sep)[0]
            if rel != "." and top not in subdirs:
                continue
        for f in files:
            if f.endswith(exts):
                out.append(os.path.join(base, f))
    return sorted(out)


def _function_bodies(src):
    """Yield (name, body, body_start) for every `function name(` in src."""
    for m in re.finditer(r"\b(?:async\s+)?function\s+(\w+)\s*\(", src):
        name = m.group(1)
        # walk the parameter list first: destructured params contain braces
        paren = 0
        body_open = -1
        for j in range(m.end() - 1, len(src)):
            if src[j] == "(":
                paren += 1
            elif src[j] == ")":
                paren -= 1
                if paren == 0:
                    body_open = src.find("{", j)
                    break
        if body_open == -1:
            continue
        depth = 0
        end = -1
        for j in range(body_open, len(src)):
            if src[j] == "{":
                depth += 1
            elif src[j] == "}":
                depth -= 1
                if depth == 0:
                    end = j
                    break
        if end == -1:
            continue
        yield name, src[body_open:end + 1], body_open


def check_spy_ordering(root):
    """CHECK A -- gh-1738 instance 1: a spy that creates the binding it asserts."""
    violations, info = [], []
    files = _iter_files(root, SPEC_EXTENSIONS, subdirs=SPEC_ROOTS)
    info.append("CHECK A: %d spec file(s) under %s" % (len(files), "/".join(SPEC_ROOTS)))
    installers = 0
    for path in files:
        try:
            src = open(path, encoding="utf-8", errors="replace").read()
        except OSError as e:
            violations.append("CHECK A: %s unreadable (%s)" % (path, e))
            continue
        for name, body, _off in _function_bodies(src):
            looks_installer = bool(INSTALLER_NAME.search(name)) or bool(RECORDS_CALLS.search(body))
            assign = None
            for pat in ASSIGN_PATTERNS:
                m = pat.search(body)
                if m and (assign is None or m.start() < assign):
                    assign = m.start()
            if not looks_installer or assign is None:
                continue
            installers += 1
            guarded = False
            for g in GUARD_TYPEOF.finditer(body):
                if g.start() < assign and GUARD_RAISES.search(body[g.end():g.end() + 400]):
                    guarded = True
                    break
            rel = os.path.relpath(path, root)
            if guarded:
                info.append("CHECK A PASS: %s::%s guards on typeof-!==-function before replacing the binding" % (rel, name))
            else:
                violations.append(
                    "%s: %s::%s replaces a global binding with no preceding "
                    "`typeof <target> !== 'function'` refusal. A spy installed on a target that "
                    "does not exist CREATES the binding the spec then asserts is bound -- the "
                    "suite reports passes over dead handlers (gh-1738 instance 1, PR #1720)."
                    % (TOKEN_SPY, rel, name)
                )
    info.append("CHECK A: %d spy/stub installer(s) inspected" % installers)
    return violations, info, len(files)


def check_step_shadowing(root):
    """CHECK B -- gh-1738 instance 3: a later check that never ran, reported as silence."""
    import yaml
    violations, info = [], []
    wf_dir = os.path.join(root, ".github", "workflows")
    if not os.path.isdir(wf_dir):
        info.append("CHECK B: .github/workflows/ ABSENT (directory does not exist -- not 'present and clean')")
        return violations, info, 0
    files = sorted(f for f in os.listdir(wf_dir) if f.endswith((".yml", ".yaml")))
    info.append("CHECK B: %d workflow file(s)" % len(files))
    for f in files:
        path = os.path.join(wf_dir, f)
        try:
            doc = yaml.safe_load(open(path, encoding="utf-8", errors="replace"))
        except Exception as e:
            violations.append("CHECK B: %s unparseable (%s)" % (f, e))
            continue
        if not isinstance(doc, dict):
            continue
        for job_id, job in (doc.get("jobs") or {}).items():
            if not isinstance(job, dict):
                continue
            steps = job.get("steps") or []
            crashable_before = []
            for step in steps:
                if not isinstance(step, dict):
                    continue
                label = str(step.get("name") or step.get("uses") or (step.get("run") or "").splitlines()[:1])
                guard = str(step.get("if") or "")
                is_guarded = bool(ALWAYS_GUARD.search(guard)) or step.get("continue-on-error") is True
                is_verification = bool(VERIFICATION_STEP.search(label))
                key = "%s::%s::%s" % (f, job_id, label[:70])
                if is_verification and crashable_before and not is_guarded and key in LEGACY_SHADOWED:
                    info.append(
                        "CHECK B LEGACY (pre-existing at gh-1840, not a new regression): %s" % key)
                elif is_verification and crashable_before and not is_guarded:
                    violations.append(
                        "%s: %s job '%s' step '%s' runs only if every earlier step passed "
                        "(first crashable earlier step: '%s'). If that step crashes this one is "
                        "UNRUN, and an UNRUN check is indistinguishable from a passing one -- "
                        "gh-1738 instance 3, PR #1737. Add `if: always()` (or "
                        "`continue-on-error: true` on the earlier step) so a skip is visible."
                        % (TOKEN_STEP, f, job_id, label[:70], crashable_before[0][:70])
                    )
                if (step.get("run") is not None
                        and step.get("continue-on-error") is not True
                        and is_verification and not SETUP_STEP.search(label)):
                    crashable_before.append(label)
    return violations, info, len(files)


def run_all(root="."):
    v_a, i_a, n_specs = check_spy_ordering(root)
    v_b, i_b, n_wf = check_step_shadowing(root)
    violations = v_a + v_b
    for line in i_a + i_b:
        print("INFO: " + line)
    for v in violations:
        print("VIOLATION: " + v)
    print("VIOLATIONS: %d" % len(violations))
    # Never PASS on a root where there was nothing to inspect: that is the exact
    # false-green shape gh-1738 was filed about, and it would be this gate
    # reproducing the defect it exists to close.
    if n_specs == 0 and n_wf == 0:
        print("GATE: UNMEASURED (no spec files and no workflow files found under %s)" % os.path.abspath(root))
        return 3
    print("GATE: " + ("FAIL" if violations else "PASS"))
    return 2 if violations else 0


if __name__ == "__main__":
    sys.exit(run_all(sys.argv[1] if len(sys.argv) > 1 else "."))
