#!/usr/bin/env python3
"""
detector-negative-control-check.py -- gh-1738 gate: a detector is not trusted until
it has been observed rejecting the thing it exists to reject, AND a scanner's
declared input set is reconciled against what it actually receives.

WHY THIS EXISTS
----------------
Filed after FIVE detectors in one day could not fire, and none of them showed it
(gh-1738). Four were the same shape -- a detector that could not run, rendering as
silence, a false green, or an UNMEASURED nobody could act on:
  1. PR #1720 e2e spec installed its spy BEFORE the click, creating the binding it
     asserted -- "11 passed" while four money-path handlers threw ReferenceError.
  2. PR #1735 asked for `secrets.GITHUB_PERSONAL_ACCESS_TOKEN` -- a name Actions
     structurally refuses to create -- so the check would read UNMEASURED forever.
  3. PR #1737's require_cli() crashed before the pre-existing drift step ran,
     silently short-circuiting the job.
  4. scripts/drift-detector-age.py reads a dead env PAT, and its own recovery
     diagnostic names that same uncreatable secret.

The FIFTH was categorically different, and is the harder half of this gate:
  5. .github/workflows/schema-lint.yml's `push.paths` never lists react-app
     TS/TSX/JSX files, while scripts/schema-column-lint.py's own SCAN_EXTENSIONS
     scans them. The linter is fine -- it correctly scans everything it is given.
     It was simply never given the files. A firing self-test on the detector would
     NOT have caught this, because the detector is not the broken part; the wiring
     that feeds it is.

Per R-148 (a recurring defect closes on a mechanism, never a rule alone) and the
precedent of queue-adapter-check.py, this is a script with a printed verdict, not a
paragraph asking people to remember something.

THREE INDEPENDENT CHECKS
------------------------
CHECK 1 -- Firing self-test coverage (catches shape #1/#2/#4; NOT #1720's ordering
  bug specifically -- see LIMITATIONS below).
    For every scripts/*.py file that looks like a detector (this directory's whole
    job), a sibling <name>.test.py must exist and, when run, must exit 0 and print
    at least one self-reported PASS/FAIL assertion line (the repo's existing
    convention). Scripts enriched in DETECTOR_REGISTRY are additionally required to
    demonstrate a PASS line naming each of that detector's declared "bad verdict"
    tokens (its negative-control fixture actually ran and actually passed, not just
    exists in source). A brand-new detector-shaped script with NO test file at all
    fails this gate outright unless explicitly grandfathered in LEGACY_EXEMPT with a
    reason -- so the gate does not silently stay quiet on the next instance of this
    class, per gh-1738's "five is a lower bound, not a census."

CHECK 2 -- Declared-input reconciliation (catches shape #5, the harder half).
    Auto-discovers every scripts/*.py that declares a top-level SCAN_EXTENSIONS or
    EXTENSIONS set, finds the workflow(s) that invoke it, and -- for any push
    trigger with a `paths:` filter -- walks the REAL repo tree for files matching
    those extensions and checks each one against the filter. Any real file the
    scanner would scan but the workflow's push trigger would never hand it is a
    violation. This is driven by the actual filesystem, not a hardcoded list of
    "react-app" or any other directory, so it generalizes past today's instance.

CHECK 3 -- Uncreatable secret-name scan (catches shape #2, generically).
    Every .github/workflows/*.yml is scanned for `secrets.GITHUB_*` other than the
    one GitHub-reserved exception, `secrets.GITHUB_TOKEN`. GitHub Actions refuses to
    let a repository secret be created with a `GITHUB_` prefix, so any such
    reference is dead on arrival and would read UNMEASURED forever -- exactly #2 and
    the recovery-path half of #4.

LIMITATIONS -- read before trusting this gate as complete
---------------------------------------------------------
This gate does NOT generically catch:
  - #1720's shape (a spy/mock installed before the action it should observe,
    creating the very binding it asserts exists). That is a test-authoring-order
    defect in a Playwright spec, not a static, checkable property of a script's
    declared inputs or its test file's assertion count. Catching it in general
    would require semantic understanding of *when* an assertion's precondition was
    established relative to the action under test -- out of reach for a static
    check at this scope. The nearest structural mitigation this repo has is
    "installed a spy BEFORE the click" style code review, not automation.
  - #1737's shape (a new step that crashes and short-circuits a job BEFORE a
    pre-existing, unrelated check runs later in the same job). This is a
    job-ordering / fail-open-vs-fail-closed property of a workflow's step sequence,
    not a declared-input mismatch. CHECK 2's reconciliation logic does not model
    step ordering or step-to-step data flow within a job.
Per gh-1738's own instruction: say this plainly rather than quietly narrowing scope
to only what got built. Instances 1 and 3 need a different mechanism; this issue's
mechanism is not a census of all five, only of shapes #2, #4, and (the harder half)
#5.

USAGE
    python scripts/detector-negative-control-check.py
    python scripts/detector-negative-control-check.py --json
    python scripts/detector-negative-control-check.py --root PATH   # for self-tests

EXIT
    0  GATE: PASS -- every check above is clean
    1  GATE: FAIL -- one or more violations found (printed above the summary)
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parent

# ---------------------------------------------------------------------------
# CHECK 1 configuration
# ---------------------------------------------------------------------------

# Detectors with a negative-control manifest: the specific "bad verdict" tokens
# their test file must demonstrate PASSING (not merely mentioning) before this
# gate trusts the detector. Add an entry here when a detector's test file grows
# a real negative-control fixture; until then it still gets the generic check
# below (test exists, runs clean, self-reports >0 assertions).
DETECTOR_REGISTRY = {
    "scripts/netlify-deploy-drift.py": {
        "test": "scripts/netlify-deploy-drift.test.py",
        "negative_tokens": ["BEHIND", "BUILD_FAILING", "UNMEASURED"],
    },
    "scripts/drift-detector-age.py": {
        "test": "scripts/drift-detector-age.test.py",
        "negative_tokens": ["STALE", "UNMEASURED"],
    },
}

# Detector-shaped scripts that predate this gate (gh-1738) and have no test file
# at all. Grandfathered so this gate does not retroactively fail the whole repo in
# one PR -- but each is real, uncovered debt, and this dict is the visible list
# (WARN, not silent). When one of these gains a <name>.test.py, remove it from
# here; it will then be picked up by the generic check automatically.
LEGACY_EXEMPT = {
    "scripts/check-10k-floor-phrasing.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/check-email-parts.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/check-gtag-single-source.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/check-partner-consent-link.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/check-partner-surface-single-source.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/check-partner-sw-version.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/check-payout-timing-copy-drift.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/check-sb-auth-guards.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/check-script-load-order.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/check-spec-files-closed.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/ci-file-integrity.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/migration-filename-lint.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/patch-fatigue-detector.py": "no negative-control test yet (pre-gh-1738)",
    "scripts/schema-column-lint.py": (
        "firing is not this detector's gap -- CHECK 2 (wiring reconciliation) is "
        "what covers it; see gh-1738 instance 5"
    ),
    "scripts/schema-secret-lint.py": "no negative-control test yet (pre-gh-1738)",
}

# Scripts in scripts/ that are not themselves a detector with a pass/fail verdict
# (helper libraries invoked as subprocesses by a real detector, generators, etc).
NOT_A_DETECTOR = {
    "scripts/find-legal-surface-links.py",  # generator invoked by check-legal-surface-links.py
    "scripts/detector-negative-control-check.py",  # this file
}

PASS_LINE_RE = re.compile(r"^\s*PASS\s", re.MULTILINE)
FAIL_LINE_RE = re.compile(r"^\s*FAIL\s", re.MULTILINE)
# Fallback for test files written against stdlib unittest (e.g.
# ci-test-function-parity.test.py) instead of this repo's hand-rolled
# check()/PASS/FAIL convention -- unittest's own summary line is the
# self-reported count in that case.
UNITTEST_RAN_RE = re.compile(r"^Ran (\d+) tests? in", re.MULTILINE)


def discover_detector_scripts(root: Path):
    """Every scripts/*.py file (excluding *.test.py) that is a candidate detector."""
    scripts_dir = root / "scripts"
    out = []
    for p in sorted(scripts_dir.glob("*.py")):
        if p.name.endswith(".test.py"):
            continue
        rel = "scripts/" + p.name
        if rel in NOT_A_DETECTOR:
            continue
        out.append(rel)
    return out


def run_test_file(root: Path, test_rel: str, timeout=60):
    """Run a <name>.test.py the same way a human/CI would: `python <path>`."""
    path = root / test_rel
    try:
        proc = subprocess.run(
            [sys.executable, str(path)],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout + proc.stderr
    except Exception as exc:  # noqa: BLE001
        return None, "could not execute test file: %s: %s" % (type(exc).__name__, exc)


def count_assertions(output: str):
    pass_n = len(PASS_LINE_RE.findall(output))
    fail_n = len(FAIL_LINE_RE.findall(output))
    if pass_n + fail_n == 0:
        m = UNITTEST_RAN_RE.search(output)
        if m:
            # unittest's exit code (checked separately by the caller) already
            # tells us pass vs fail; its own text output does not reliably give a
            # per-line failure count the way this repo's check()/PASS/FAIL
            # convention does, so the whole total is reported as the assertion
            # count and left to the caller's exit-code check to gate PASS/FAIL.
            return int(m.group(1)), 0
    return pass_n, fail_n


def check_firing_tests(root: Path):
    """CHECK 1. Returns (violations: list[str], info_lines: list[str], total_assertions: int)."""
    violations = []
    info = []
    total_assertions = 0

    for rel in discover_detector_scripts(root):
        test_rel = rel[:-3] + ".test.py"
        test_path = root / test_rel
        manifest = DETECTOR_REGISTRY.get(rel)

        if not test_path.exists():
            if rel in LEGACY_EXEMPT:
                info.append("WARN  %-55s no self-test (grandfathered: %s)" % (rel, LEGACY_EXEMPT[rel]))
                continue
            violations.append(
                "FAIL  %s -- detector-shaped script has NO self-test and is not in "
                "LEGACY_EXEMPT. Add scripts/%s.test.py with a negative-control fixture "
                "before this ships, or add an explicit, justified LEGACY_EXEMPT entry."
                % (rel, Path(rel).stem)
            )
            continue

        code, output = run_test_file(root, test_rel)
        pass_n, fail_n = count_assertions(output)
        total_assertions += pass_n + fail_n

        if code != 0:
            violations.append(
                "FAIL  %s -- self-test %s exited %s (expected 0). Assertions observed: "
                "%d pass / %d fail." % (rel, test_rel, code, pass_n, fail_n)
            )
            continue

        if pass_n + fail_n == 0:
            violations.append(
                "FAIL  %s -- self-test %s exited 0 but self-reported ZERO assertions "
                "(PASS/FAIL lines). A test that asserts nothing proves nothing." % (rel, test_rel)
            )
            continue

        if manifest is None:
            info.append(
                "PASS  %-55s self-test ran clean, %d assertion(s) self-reported "
                "(no negative-control token manifest registered -- generic check only)"
                % (rel, pass_n)
            )
            continue

        missing_tokens = []
        for token in manifest["negative_tokens"]:
            token_pattern = re.compile(
                r"^\s*PASS\s.*\b%s\b.*$" % re.escape(token), re.MULTILINE
            )
            if not token_pattern.search(output):
                missing_tokens.append(token)

        if missing_tokens:
            violations.append(
                "FAIL  %s -- self-test passed (%d assertions) but never demonstrated a "
                "PASSING assertion naming the negative-control token(s) %s. A detector "
                "whose suite contains only clean-input fixtures fails this gate."
                % (rel, pass_n, ", ".join(missing_tokens))
            )
            continue

        info.append(
            "PASS  %-55s self-test ran clean, %d assertion(s) self-reported, "
            "negative-control tokens observed passing: %s"
            % (rel, pass_n, ", ".join(manifest["negative_tokens"]))
        )

    return violations, info, total_assertions


# ---------------------------------------------------------------------------
# CHECK 2 -- declared-input reconciliation
# ---------------------------------------------------------------------------

EXT_SET_RE = re.compile(r"^(?:SCAN_EXTENSIONS|EXTENSIONS)\s*=\s*\{([^}]*)\}", re.MULTILINE)
STRING_LITERAL_RE = re.compile(r"""['"]([^'"]+)['"]""")
SKIP_DIRS_RE = re.compile(r"^SKIP_DIRS\s*:?\s*(?:set\[str\])?\s*=\s*\{([^}]*)\}", re.MULTILINE)

DEFAULT_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".github"}


def extract_extension_set(script_text: str):
    m = EXT_SET_RE.search(script_text)
    if not m:
        return None
    return {s for s in STRING_LITERAL_RE.findall(m.group(1)) if s.startswith(".")}


def extract_skip_dirs(script_text: str):
    m = SKIP_DIRS_RE.search(script_text)
    if not m:
        return set(DEFAULT_SKIP_DIRS)
    return set(STRING_LITERAL_RE.findall(m.group(1))) | DEFAULT_SKIP_DIRS


def find_referencing_workflows(root: Path, script_rel: str):
    basename = Path(script_rel).name
    out = []
    wf_dir = root / ".github" / "workflows"
    if not wf_dir.exists():
        return out
    for wf in sorted(wf_dir.glob("*.yml")):
        text = wf.read_text(encoding="utf-8", errors="replace")
        if basename in text:
            out.append(".github/workflows/" + wf.name)
    return out


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _get_block(lines, start_idx, key_indent):
    """Lines strictly more indented than key_indent, following lines[start_idx]."""
    block = []
    i = start_idx + 1
    while i < len(lines):
        line = lines[i]
        if line.strip() == "":
            i += 1
            continue
        if _indent_of(line) <= key_indent:
            break
        block.append(line)
        i += 1
    return block


def _find_key(lines, key):
    """First line (anywhere in `lines`) whose stripped text starts with `key:`."""
    for idx, line in enumerate(lines):
        if line.strip().startswith(key + ":"):
            return idx, _indent_of(line)
    return None, None


NO_PUSH_TRIGGER = "NO_PUSH_TRIGGER"
NO_PATH_FILTER = "NO_PATH_FILTER"


def extract_push_paths(workflow_text: str):
    """Returns a list of path-glob patterns from `on.push.paths`, or one of the two
    sentinels above: NO_PUSH_TRIGGER (this workflow has no push trigger at all -- not
    applicable to this reconciliation) or NO_PATH_FILTER (push trigger exists with no
    `paths:` key -- fires unconditionally, i.e. full coverage by construction)."""
    lines = workflow_text.splitlines()
    on_idx, on_indent = _find_key(lines, "on")
    if on_idx is None:
        return NO_PUSH_TRIGGER
    on_block = _get_block(lines, on_idx, on_indent)

    push_idx, push_indent = _find_key(on_block, "push")
    if push_idx is None:
        return NO_PUSH_TRIGGER
    push_block = _get_block(on_block, push_idx, push_indent)

    paths_idx, paths_indent = _find_key(push_block, "paths")
    if paths_idx is None:
        return NO_PATH_FILTER
    paths_block = _get_block(push_block, paths_idx, paths_indent)

    patterns = []
    for line in paths_block:
        s = line.strip()
        if s.startswith("- "):
            val = s[2:].strip()
            if val and val[0] in ("'", '"') and val[-1] == val[0]:
                val = val[1:-1]
            patterns.append(val)
    return patterns


def path_pattern_to_regex(pattern: str):
    out = []
    i = 0
    n = len(pattern)
    while i < n:
        if pattern[i : i + 2] == "**":
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append(".")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def enumerate_real_files(root: Path, extensions: set, skip_dirs: set):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        parts = [] if rel_dir == "." else rel_dir.split("/")
        dirnames[:] = [
            d for d in dirnames
            if d not in skip_dirs and not any(p in skip_dirs for p in parts)
        ]
        for fname in filenames:
            ext = Path(fname).suffix
            if ext in extensions:
                rel_file = (rel_dir + "/" + fname) if rel_dir != "." else fname
                out.append(rel_file.replace(os.sep, "/"))
    return out


def check_wiring(root: Path):
    """CHECK 2. Returns (violations: list[str], info_lines: list[str], files_verified: int)."""
    violations = []
    info = []
    files_verified = 0

    scripts_dir = root / "scripts"
    for p in sorted(scripts_dir.glob("*.py")):
        rel = "scripts/" + p.name
        text = p.read_text(encoding="utf-8", errors="replace")
        extensions = extract_extension_set(text)
        if not extensions:
            continue

        skip_dirs = extract_skip_dirs(text)
        workflows = find_referencing_workflows(root, rel)
        if not workflows:
            info.append(
                "WARN  %-40s declares %s but is not invoked from any "
                ".github/workflows/*.yml -- cannot reconcile wiring."
                % (rel, sorted(extensions))
            )
            continue

        real_files = enumerate_real_files(root, extensions, skip_dirs)

        for wf_rel in workflows:
            wf_text = (root / wf_rel).read_text(encoding="utf-8", errors="replace")
            push_paths = extract_push_paths(wf_text)

            if push_paths == NO_PUSH_TRIGGER:
                info.append(
                    "PASS  %-40s <- %-40s no push trigger (not applicable)"
                    % (rel, wf_rel)
                )
                continue
            if push_paths == NO_PATH_FILTER:
                info.append(
                    "PASS  %-40s <- %-40s push trigger has no paths: filter "
                    "(fires on every push -- full coverage by construction, %d real "
                    "file(s) verified moot)" % (rel, wf_rel, len(real_files))
                )
                files_verified += len(real_files)
                continue

            regexes = [path_pattern_to_regex(pat) for pat in push_paths]
            uncovered_by_ext = {}
            for f in real_files:
                if not any(rx.match(f) for rx in regexes):
                    ext = Path(f).suffix
                    uncovered_by_ext.setdefault(ext, []).append(f)

            if uncovered_by_ext:
                for ext, files in sorted(uncovered_by_ext.items()):
                    examples = ", ".join(files[:3])
                    more = "" if len(files) <= 3 else " (+%d more)" % (len(files) - 3)
                    violations.append(
                        "FAIL  %s declares %s in its scanned extension set, and %s's "
                        "push.paths trigger this scanner from, but push.paths has NO "
                        "pattern matching real '%s' files under this repo -- e.g. %s%s. "
                        "%s runs but is never handed these files on a direct push."
                        % (rel, sorted(extensions), wf_rel, ext, examples, more, rel)
                    )
            else:
                files_verified += len(real_files)
                info.append(
                    "PASS  %-40s <- %-40s every one of %d real matching file(s) is "
                    "covered by push.paths" % (rel, wf_rel, len(real_files))
                )

    return violations, info, files_verified


# ---------------------------------------------------------------------------
# CHECK 3 -- uncreatable secret-name scan
# ---------------------------------------------------------------------------

SECRET_REF_RE = re.compile(r"secrets\.(GITHUB_[A-Za-z0-9_]*)")
ALLOWED_GITHUB_SECRET = "GITHUB_TOKEN"  # the one GitHub-reserved, always-creatable exception


def check_secret_names(root: Path):
    """CHECK 3. Returns (violations: list[str], info_lines: list[str], refs_checked: int)."""
    violations = []
    info = []
    refs_checked = 0

    wf_dir = root / ".github" / "workflows"
    if not wf_dir.exists():
        return violations, info, refs_checked

    for wf in sorted(wf_dir.glob("*.yml")):
        text = wf.read_text(encoding="utf-8", errors="replace")
        rel = ".github/workflows/" + wf.name
        # Line-by-line, skipping full-line comments: this repo documents past
        # secrets.GITHUB_* incidents in `#`-prefixed narrative comments (e.g.
        # edge-function-drift.yml's own postmortem header), and those must not
        # be mistaken for a live reference to the same dead name.
        for line_no, line in enumerate(text.splitlines(), start=1):
            if line.strip().startswith("#"):
                continue
            for m in SECRET_REF_RE.finditer(line):
                refs_checked += 1
                name = m.group(1)
                if name == ALLOWED_GITHUB_SECRET:
                    continue
                violations.append(
                    "FAIL  %s:%d -- references secrets.%s. GitHub Actions refuses to let a "
                    "repository secret be created with a GITHUB_ prefix (only the reserved "
                    "secrets.GITHUB_TOKEN is exempt), so this reference is dead on arrival "
                    "and would read UNMEASURED forever." % (rel, line_no, name)
                )
    info.append("PASS  scanned %d workflow file(s) for secrets.GITHUB_* references, %d checked, %d violation(s)"
                % (len(list(wf_dir.glob('*.yml'))), refs_checked, len(violations)))
    return violations, info, refs_checked


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run_all(root: Path):
    firing_violations, firing_info, total_assertions = check_firing_tests(root)
    wiring_violations, wiring_info, files_verified = check_wiring(root)
    secret_violations, secret_info, refs_checked = check_secret_names(root)

    all_violations = firing_violations + wiring_violations + secret_violations
    all_info = firing_info + wiring_info + secret_info

    result = {
        "verdict": "FAIL" if all_violations else "PASS",
        "code": 1 if all_violations else 0,
        "violations": all_violations,
        "info": all_info,
        "counts": {
            "check1_firing_total_assertions": total_assertions,
            "check2_wiring_files_verified": files_verified,
            "check3_secret_refs_checked": refs_checked,
        },
    }
    return result


def print_report(result: dict):
    print("=" * 78)
    print("CHECK 1 -- firing self-test coverage / CHECK 2 -- wiring reconciliation /")
    print("CHECK 3 -- uncreatable secret-name scan   (gh-1738)")
    print("=" * 78)
    for line in result["info"]:
        print(line)
    if result["violations"]:
        print("-" * 78)
        for line in result["violations"]:
            print(line)
    print("-" * 78)
    c = result["counts"]
    print(
        "SELF-REPORTED COUNTS: check1_assertions=%d  check2_files_verified=%d  "
        "check3_secret_refs_checked=%d"
        % (
            c["check1_firing_total_assertions"],
            c["check2_wiring_files_verified"],
            c["check3_secret_refs_checked"],
        )
    )
    print("VIOLATIONS: %d" % len(result["violations"]))
    print("GATE: %s" % result["verdict"])


def main():
    argv = sys.argv[1:]
    as_json = "--json" in argv
    root = DEFAULT_ROOT
    if "--root" in argv:
        root = Path(argv[argv.index("--root") + 1]).resolve()

    result = run_all(root)

    if as_json:
        print(json.dumps(result, indent=2))
    else:
        print_report(result)

    return result["code"]


if __name__ == "__main__":
    sys.exit(main())
