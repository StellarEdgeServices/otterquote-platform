#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/detector-negative-control-check.py (gh-1738).

Builds two synthetic repo roots under a temp directory -- never touches this
repo's real scripts/ or .github/workflows/ -- and shows:

  RED:   a seeded tree carrying THREE independent, deliberately-planted instances
         of this issue's class is REJECTED (non-zero exit, each one named):
           A. a brand-new detector-shaped script shipped with NO self-test at all
              (the "nothing was ever observed rejecting anything" shape).
           B. a detector whose self-test passes but contains ONLY clean-input
              fixtures -- the literal "deliberately stubbed detector with only
              clean fixtures" gh-1738's own closes-on calls for -- shown being
              rejected by this gate. This is the negative control OF the
              negative-control gate: without this, gh-1738 would be the fifth
              row in its own table.
           C. instance 5's own shape: a scanner's declared extension set is not
              reconciled against its workflow's push.paths filter, so a real
              file the scanner would scan is never handed to it on a push.

  GREEN: a clean synthetic tree -- a properly self-tested detector plus fully
         reconciled wiring -- is SILENT (exit 0, zero violations).

Also exercises the harder pure-function pieces directly (glob-to-regex
conversion, the hand-rolled paths: extractor, and the comment-vs-live-reference
distinction in the secret-name scan -- a real false positive this test suite
caught during development against the actual edge-function-drift.yml, whose own
postmortem comment narrates the historical secrets.GITHUB_PERSONAL_ACCESS_TOKEN
bug in prose).

Run: python scripts/detector-negative-control-check.test.py
"""
import contextlib
import importlib.util
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("neg", HERE / "detector-negative-control-check.py")
neg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(neg)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def check_true(label, cond):
    check(label, bool(cond), True)


def write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@contextlib.contextmanager
def registry_snapshot(entries=None):
    """Temporarily replace neg.DETECTOR_REGISTRY for a synthetic-root run_all()
    call.

    gh-1884: DETECTOR_REGISTRY is now enumerated on its own inside
    check_firing_tests(), independent of what discover_detector_scripts() finds
    under `root`. That means a synthetic temp root built by this suite -- which
    deliberately never contains this repo's real registered detector files
    (netlify-deploy-drift.py and friends) -- would otherwise see the REAL,
    module-level DETECTOR_REGISTRY and report all of those real entries as
    "missing", polluting every RED/GREEN/UNMEASURED assertion below with
    violations that have nothing to do with what each block is proving. Swap in
    only the entries (if any) that a given synthetic tree actually provides.
    """
    saved = dict(neg.DETECTOR_REGISTRY)
    neg.DETECTOR_REGISTRY.clear()
    if entries:
        neg.DETECTOR_REGISTRY.update(entries)
    try:
        yield
    finally:
        neg.DETECTOR_REGISTRY.clear()
        neg.DETECTOR_REGISTRY.update(saved)


DETECTOR_SOURCE = (
    "#!/usr/bin/env python3\n"
    "def main():\n"
    "    print(\"ok\")\n"
    "if __name__ == \"__main__\":\n"
    "    main()\n"
)


def _importing_test_file(detector_filename: str, print_lines, modvar: str = "mod") -> str:
    """A self-test source that genuinely loads `detector_filename` via this
    repo's real importlib pattern (spec_from_file_location -> module_from_spec
    -> exec_module -> call something on the loaded module -- see e.g.
    scripts/drift-detector-age.test.py) and then emits `print_lines` verbatim.

    gh-1884: this suite's fixtures previously (pre-gh-1884) just printed
    PASS-shaped text with no reference to the detector file at all -- exactly
    the forgery shape this issue exists to reject, just in a synthetic test
    fixture instead of a real detector's self-test. Every registered-detector
    fixture below now genuinely invokes its detector so it satisfies
    self_test_invokes_detector(), matching what this fix now requires of a
    real registered detector's self-test.
    """
    body = [
        "#!/usr/bin/env python3",
        "import importlib.util",
        "from pathlib import Path",
        "HERE = Path(__file__).resolve().parent",
        "spec = importlib.util.spec_from_file_location(%r, HERE / %r)"
        % (modvar, detector_filename),
        "%s = importlib.util.module_from_spec(spec)" % modvar,
        "spec.loader.exec_module(%s)" % modvar,
        "%s.main()  # genuinely invoke the loaded detector -- not decorative" % modvar,
    ]
    body.extend(print_lines)
    body.append("import sys")
    body.append("sys.exit(0)")
    return "\n".join(body) + "\n"


def good_test_file(detector_filename: str) -> str:
    return _importing_test_file(
        detector_filename,
        [
            'print("  PASS  clean case: OK")',
            'print("  PASS  bad-input case -> REJECTED: REJECTED")',
        ],
    )


def no_negative_test_file(detector_filename: str) -> str:
    """Only clean-input fixtures -- the exact shape gh-1738 exists to catch: a
    detector that has never been observed rejecting the thing it exists to
    reject. Genuinely invokes the detector (gh-1884) so the violation this
    produces is isolated to the missing negative-control token, not muddied
    by an unrelated invocation-proof violation."""
    return _importing_test_file(
        detector_filename,
        [
            'print("  PASS  clean case 1: OK")',
            'print("  PASS  clean case 2: OK")',
        ],
    )


def build_clean_tree(root: Path):
    """A properly self-tested detector + fully reconciled wiring."""
    write(root / "scripts" / "good-detector.py", DETECTOR_SOURCE + '\nSCAN_EXTENSIONS = {".txt"}\n')
    write(root / "scripts" / "good-detector.test.py", good_test_file("good-detector.py"))
    write(root / "data" / "sample.txt", "hello\n")
    write(
        root / ".github" / "workflows" / "good.yml",
        "name: Good Workflow\n"
        "on:\n"
        "  push:\n"
        "    branches: [main]\n"
        "    paths:\n"
        "      - 'data/**.txt'\n"
        "      - 'scripts/good-detector.py'\n"
        "  pull_request:\n"
        "    branches: [main]\n"
        "jobs:\n"
        "  run:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - run: python3 scripts/good-detector.py\n",
    )


def build_broken_tree(root: Path):
    """Three independent, seeded instances of the gh-1738 class."""
    # Instance A: brand-new detector-shaped script, NO self-test at all.
    write(root / "scripts" / "untested-detector.py", DETECTOR_SOURCE)

    # Instance B: a detector WITH a passing self-test that has only clean
    # fixtures. Registered below (via a monkeypatched manifest entry) the same
    # way a real reviewer enriches DETECTOR_REGISTRY when they care enough about
    # a detector to demand a specific verdict token from its suite.
    write(root / "scripts" / "clean-only-detector.py", DETECTOR_SOURCE)
    write(root / "scripts" / "clean-only-detector.test.py", no_negative_test_file("clean-only-detector.py"))

    # Instance C: instance-5's own shape -- a scanner's declared extensions are
    # not reconciled against its workflow's push.paths filter.
    write(root / "scripts" / "bad-scanner.py", DETECTOR_SOURCE + '\nSCAN_EXTENSIONS = {".html", ".ts"}\n')
    write(root / "scripts" / "bad-scanner.test.py", good_test_file("bad-scanner.py"))
    write(root / "site" / "index.html", "<html></html>\n")
    write(root / "app" / "widget.ts", "export const x = 1;\n")
    write(
        root / ".github" / "workflows" / "bad-scanner.yml",
        "name: Bad Scanner Workflow\n"
        "on:\n"
        "  push:\n"
        "    branches: [main]\n"
        "    paths:\n"
        "      - '**.html'\n"
        "      - 'scripts/bad-scanner.py'\n"
        "  pull_request:\n"
        "    branches: [main]\n"
        "jobs:\n"
        "  run:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - run: python3 scripts/bad-scanner.py\n",
    )


def main():
    print("=" * 70)
    print("RED -- seeded tree carrying three instances of the gh-1738 class")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build_broken_tree(root)

        # Instances A and C are caught by the checker exactly as shipped -- no
        # manifest needed. Instance B needs a DETECTOR_REGISTRY entry, simulated
        # here for this run only (and this run only sees THAT entry -- not the
        # real repo's registry -- per registry_snapshot()'s docstring above),
        # exactly as a reviewer would add one permanently for a real detector.
        with registry_snapshot({
            "scripts/clean-only-detector.py": {
                "test": "scripts/clean-only-detector.test.py",
                "negative_tokens": ["REJECTED"],
            }
        }):
            result = neg.run_all(root)

    for line in result["info"]:
        print(line)
    for line in result["violations"]:
        print(line)
    print("GATE: %s  (exit %d)" % (result["verdict"], result["code"]))
    print()

    check("RED: gate verdict", result["verdict"], "FAIL")
    check("RED: gate exit code", result["code"], 1)
    check_true(
        "RED: instance A caught (unregistered detector, no self-test at all)",
        any("untested-detector.py" in v and "NO self-test" in v for v in result["violations"]),
    )
    check_true(
        "RED: instance B caught (registered detector, only clean fixtures)",
        any("clean-only-detector.py" in v and "REJECTED" in v for v in result["violations"]),
    )
    check_true(
        "RED: instance C caught (instance-5 shape: wiring reconciliation)",
        any("bad-scanner.py" in v and ".ts" in v for v in result["violations"]),
    )
    check_true(
        "RED: instance C violation names the real uncovered file",
        any("widget.ts" in v for v in result["violations"]),
    )
    check("RED: exactly three violations (no unrelated noise)", len(result["violations"]), 3)

    print()
    print("=" * 70)
    print("GREEN -- clean synthetic tree (properly self-tested + reconciled)")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build_clean_tree(root)
        with registry_snapshot():
            result2 = neg.run_all(root)

    for line in result2["info"]:
        print(line)
    for line in result2["violations"]:
        print(line)
    print("GATE: %s  (exit %d)" % (result2["verdict"], result2["code"]))

    check("GREEN: gate verdict", result2["verdict"], "PASS")
    check("GREEN: gate exit code", result2["code"], 0)
    check("GREEN: zero violations", len(result2["violations"]), 0)

    # -------------------------------------------------------------------
    # UNMEASURED -- zero-discovery root (PR #1742 cycle-3 REVIEW: FAIL, comment
    # 5561884929; known-but-unrecorded since cycle 2, comment 5561758212). A root
    # with no scripts/ and no .github/workflows/ directory must never read the
    # same as a clean PASS -- run_all() found nothing to inspect, which is a
    # distinct, non-clean verdict (see ZERO_DISCOVERY_MESSAGE / LIMITATIONS).
    # -------------------------------------------------------------------
    print()
    print("=" * 70)
    print("UNMEASURED -- zero-discovery root (no scripts/, no .github/workflows/)")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        # Deliberately empty: no scripts/ dir, no .github/ dir at all.
        with registry_snapshot():
            result3 = neg.run_all(root)

    for line in result3["info"]:
        print(line)
    print("GATE: %s  (exit %d)" % (result3["verdict"], result3["code"]))

    check("EMPTY ROOT: gate verdict is UNMEASURED, not PASS", result3["verdict"], "UNMEASURED")
    check("EMPTY ROOT: gate exit code is 3 (distinct from 0=PASS and 1=FAIL)", result3["code"], 3)
    check("EMPTY ROOT: measured flag is False", result3["measured"], False)
    check("EMPTY ROOT: zero violations (this is not a FAIL either)", len(result3["violations"]), 0)
    check_true(
        "EMPTY ROOT: info is non-empty -- 'nothing inspected' is never silent",
        len(result3["info"]) > 0,
    )
    check_true(
        "EMPTY ROOT: the UNMEASURED explanation names itself as such, not a clean bill",
        any("UNMEASURED" in i for i in result3["info"]),
    )

    # A root with a real, populated .github/workflows/ dir but an empty (or
    # absent) scripts/ dir is NOT zero-discovery -- CHECK 3 has real work to do
    # and reports it visibly, so this must stay a normal PASS, not UNMEASURED.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(
            root / ".github" / "workflows" / "only.yml",
            "name: Only\non:\n  push:\n    branches: [main]\njobs:\n  x:\n"
            "    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
        )
        with registry_snapshot():
            result4 = neg.run_all(root)

    check(
        "WORKFLOWS-ONLY ROOT: measured is True (workflows dir alone counts as discovery)",
        result4["measured"],
        True,
    )
    check_true(
        "WORKFLOWS-ONLY ROOT: gate verdict is not UNMEASURED",
        result4["verdict"] != "UNMEASURED",
    )

    # -------------------------------------------------------------------
    # gh-1884: DETECTOR_REGISTRY is now enumerated on its own -- a registered
    # detector's script and/or self-test being deleted must FAIL, even though
    # discover_detector_scripts() (which only lists *.py files still present
    # under scripts/) would never have visited it. This is the exact
    # reproduction shape from the issue: delete the registered detector +
    # self-test, keep everything else clean, and confirm the gate now catches
    # it instead of reading GATE: PASS / VIOLATIONS: 0.
    # -------------------------------------------------------------------
    print()
    print("=" * 70)
    print("REGISTRY GUTTED -- registered detector's script and/or self-test deleted")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        # A registered detector that is fully present and healthy, so the
        # "both missing" and "script-only missing" and "test-only missing"
        # cases below are each isolated, unambiguous signal -- not noise from
        # an unrelated already-broken entry.
        write(root / "scripts" / "present-detector.py", DETECTOR_SOURCE)
        write(root / "scripts" / "present-detector.test.py", good_test_file("present-detector.py"))
        # scripts/deleted-both.py and its self-test: deliberately never
        # written -- simulating a PR that deletes both files outright.
        # scripts/script-only-missing.py: self-test present, script itself
        # deleted.
        write(root / "scripts" / "script-only-missing.test.py", good_test_file("script-only-missing.py"))
        # scripts/test-only-missing.py: script present, self-test deleted.
        write(root / "scripts" / "test-only-missing.py", DETECTOR_SOURCE)

        with registry_snapshot({
            "scripts/present-detector.py": {
                "test": "scripts/present-detector.test.py",
                "negative_tokens": [],
            },
            "scripts/deleted-both.py": {
                "test": "scripts/deleted-both.test.py",
                "negative_tokens": [],
            },
            "scripts/script-only-missing.py": {
                "test": "scripts/script-only-missing.test.py",
                "negative_tokens": [],
            },
            "scripts/test-only-missing.py": {
                "test": "scripts/test-only-missing.test.py",
                "negative_tokens": [],
            },
        }):
            result5 = neg.run_all(root)

    for line in result5["info"]:
        print(line)
    for line in result5["violations"]:
        print(line)
    print("GATE: %s  (exit %d)" % (result5["verdict"], result5["code"]))

    check("REGISTRY GUTTED: gate verdict", result5["verdict"], "FAIL")
    check("REGISTRY GUTTED: gate exit code", result5["code"], 1)
    check_true(
        "REGISTRY GUTTED: deleted-both caught (script AND self-test missing)",
        any(
            "deleted-both.py" in v and "BOTH the detector script and its self-test" in v
            for v in result5["violations"]
        ),
    )
    check_true(
        "REGISTRY GUTTED: script-only-missing caught (script missing, self-test present)",
        any(
            "script-only-missing.py" in v and "script itself is missing" in v
            for v in result5["violations"]
        ),
    )
    check_true(
        "REGISTRY GUTTED: test-only-missing caught (self-test missing)",
        any("test-only-missing.py" in v and "self-test" in v for v in result5["violations"]),
    )
    check_true(
        "REGISTRY GUTTED: the healthy, present-and-registered detector raises no violation",
        not any("present-detector.py" in v for v in result5["violations"]),
    )

    # -------------------------------------------------------------------
    # gh-1884: the measured guard's workflows disjunct used to be a bare
    # `(root / ".github" / "workflows").exists()` -- true for an EMPTY
    # directory, not just a populated one. Prove the fix: an existing-but-
    # empty .github/workflows/ (no *.yml files) plus zero detector scripts
    # must still read UNMEASURED, not silently PASS.
    # -------------------------------------------------------------------
    print()
    print("=" * 70)
    print("WORKFLOWS DIR EXISTS BUT EMPTY -- still UNMEASURED, not PASS")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        # The directory itself exists (mkdir only -- no .yml file inside), and
        # scripts/ is never created at all.
        (root / ".github" / "workflows").mkdir(parents=True)
        with registry_snapshot():
            result6 = neg.run_all(root)

    for line in result6["info"]:
        print(line)
    print("GATE: %s  (exit %d)" % (result6["verdict"], result6["code"]))

    check(
        "EMPTY WORKFLOWS DIR: measured flag is False (dir existing is not enough)",
        result6["measured"],
        False,
    )
    check("EMPTY WORKFLOWS DIR: gate verdict is UNMEASURED", result6["verdict"], "UNMEASURED")
    check("EMPTY WORKFLOWS DIR: gate exit code is 3", result6["code"], 3)

    # -------------------------------------------------------------------
    # gh-1884 CLOSE-REVIEW: FAIL (2026-09-08T21:11:33Z) -- the refuted bypass.
    # A REGISTERED detector's script and self-test both "exist" per
    # Path.exists() (so REGISTRY GUTTED's existence checks above never fire),
    # but the script is truncated to 0 bytes in place and the self-test is a
    # stub that merely PRINTS the expected negative-control tokens -- never
    # importing, exec()'ing, or subprocess-invoking the detector at all. The
    # refuter's own reproduction: pre-fix, this read GATE: PASS, affirming the
    # forgery with a PASS line naming the detector and its tokens as if they
    # had actually been observed. Reproduce that exact shape here and prove
    # both halves of the fix independently.
    # -------------------------------------------------------------------
    print()
    print("=" * 70)
    print("INERT DETECTOR -- registered script truncated to 0 bytes + a")
    print("token-printing self-test stub that never invokes it (gh-1884)")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        # The exact refuted shape: 0-byte script, self-test that never
        # mentions the detector's filename and just prints matching tokens.
        write(root / "scripts" / "truncated-detector.py", "")
        write(
            root / "scripts" / "truncated-detector.test.py",
            "#!/usr/bin/env python3\n"
            "# Forgery: prints tokens that LOOK like a real run, never imports\n"
            "# or executes the detector at all.\n"
            'print("  PASS  bad case -> STALE: STALE")\n',
        )
        with registry_snapshot({
            "scripts/truncated-detector.py": {
                "test": "scripts/truncated-detector.test.py",
                "negative_tokens": ["STALE"],
            }
        }):
            result7 = neg.run_all(root)

    for line in result7["violations"]:
        print(line)
    print("GATE: %s  (exit %d)" % (result7["verdict"], result7["code"]))

    check("INERT DETECTOR: gate verdict is FAIL, not PASS", result7["verdict"], "FAIL")
    check("INERT DETECTOR: gate exit code is 1", result7["code"], 1)
    check_true(
        "INERT DETECTOR: the 0-byte script itself is flagged inert",
        any(
            "truncated-detector.py" in v and "empty" in v
            for v in result7["violations"]
        ),
    )

    print()
    print("=" * 70)
    print("NON-INVOKING SELF-TEST -- registered script is healthy, but its")
    print("self-test never loads or executes it (gh-1884)")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        # Script is real and non-trivial this time; only the self-test is a
        # forgery -- proof the two new checks are independent of each other.
        write(root / "scripts" / "unfired-detector.py", DETECTOR_SOURCE)
        write(
            root / "scripts" / "unfired-detector.test.py",
            "#!/usr/bin/env python3\n"
            'print("  PASS  bad case -> STALE: STALE")\n',
        )
        with registry_snapshot({
            "scripts/unfired-detector.py": {
                "test": "scripts/unfired-detector.test.py",
                "negative_tokens": ["STALE"],
            }
        }):
            result8 = neg.run_all(root)

    for line in result8["violations"]:
        print(line)
    print("GATE: %s  (exit %d)" % (result8["verdict"], result8["code"]))

    check("NON-INVOKING SELF-TEST: gate verdict is FAIL, not PASS", result8["verdict"], "FAIL")
    check("NON-INVOKING SELF-TEST: gate exit code is 1", result8["code"], 1)
    check_true(
        "NON-INVOKING SELF-TEST: flagged for never invoking the detector",
        any(
            "unfired-detector.py" in v
            and ("never mentions" in v or "shows neither an importlib" in v)
            for v in result8["violations"]
        ),
    )

    print()
    print("=" * 70)
    print("INERT DETECTOR, positive control -- the SAME registered detector,")
    print("healthy script + a self-test that genuinely invokes it, is silent")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(root / "scripts" / "healthy-detector.py", DETECTOR_SOURCE)
        write(
            root / "scripts" / "healthy-detector.test.py",
            good_test_file("healthy-detector.py"),
        )
        with registry_snapshot({
            "scripts/healthy-detector.py": {
                "test": "scripts/healthy-detector.test.py",
                "negative_tokens": ["REJECTED"],
            }
        }):
            result9 = neg.run_all(root)

    print("GATE: %s  (exit %d)" % (result9["verdict"], result9["code"]))
    check("INERT DETECTOR positive control: gate verdict is PASS", result9["verdict"], "PASS")
    check_true(
        "INERT DETECTOR positive control: the healthy detector raises no violation",
        not any("healthy-detector.py" in v for v in result9["violations"]),
    )

    # -------------------------------------------------------------------
    # gh-1884 ROUND 2 -- REVIEW: FAIL on PR #2101 (2026-09-22T14:39:35Z): the
    # round-1 self_test_invokes_detector() accepted ANY attribute reference on
    # the loaded module as proof of invocation, so a self-test could
    # exec_module() the detector, touch one decorative attribute (mod.__doc__),
    # print hand-written PASS lines, and never run a single line of the
    # detector's real logic (gated behind if __name__ == "__main__":, which
    # exec_module() never triggers). Reproduce the refuter's EXACT forgery,
    # then its obvious next move (a real CALL, but to something universal to
    # every module object rather than to anything this detector defines), and
    # a positive control proving a genuine call to the detector's own function
    # still passes.
    # -------------------------------------------------------------------
    print()
    print("=" * 70)
    print("ROUND 2 -- attribute-access-only forgery (the refuter's exact repro)")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(root / "scripts" / "decorated-detector.py", DETECTOR_SOURCE)
        write(
            root / "scripts" / "decorated-detector.test.py",
            "#!/usr/bin/env python3\n"
            "import importlib.util\n"
            "from pathlib import Path\n"
            "HERE = Path(__file__).resolve().parent\n"
            "spec = importlib.util.spec_from_file_location('mod', HERE / 'decorated-detector.py')\n"
            "mod = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(mod)\n"
            "_ = mod.__doc__  # attribute access -- NOT a call, pure decoration\n"
            'print("  PASS  clean case: OK")\n'
            'print("  PASS  bad case -> STALE: STALE")\n',
        )
        with registry_snapshot({
            "scripts/decorated-detector.py": {
                "test": "scripts/decorated-detector.test.py",
                "negative_tokens": ["STALE"],
            }
        }):
            result10 = neg.run_all(root)

    for line in result10["violations"]:
        print(line)
    print("GATE: %s  (exit %d)" % (result10["verdict"], result10["code"]))

    check("ROUND2 attribute-only: gate verdict is FAIL, not PASS", result10["verdict"], "FAIL")
    check_true(
        "ROUND2 attribute-only: flagged for never calling anything",
        any(
            "decorated-detector.py" in v and "never CALLS anything" in v
            for v in result10["violations"]
        ),
    )

    print()
    print("=" * 70)
    print("ROUND 2 -- real CALL, but to a universal module dunder, not the")
    print("detector's own logic (the refuter's obvious next move)")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(root / "scripts" / "dunder-called-detector.py", DETECTOR_SOURCE)
        write(
            root / "scripts" / "dunder-called-detector.test.py",
            "#!/usr/bin/env python3\n"
            "import importlib.util\n"
            "from pathlib import Path\n"
            "HERE = Path(__file__).resolve().parent\n"
            "spec = importlib.util.spec_from_file_location('mod', HERE / 'dunder-called-detector.py')\n"
            "mod = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(mod)\n"
            "mod.__dir__()  # a REAL call -- but universal to every module, not this detector's logic\n"
            'print("  PASS  clean case: OK")\n'
            'print("  PASS  bad case -> STALE: STALE")\n',
        )
        with registry_snapshot({
            "scripts/dunder-called-detector.py": {
                "test": "scripts/dunder-called-detector.test.py",
                "negative_tokens": ["STALE"],
            }
        }):
            result11 = neg.run_all(root)

    for line in result11["violations"]:
        print(line)
    print("GATE: %s  (exit %d)" % (result11["verdict"], result11["code"]))

    check("ROUND2 dunder-call: gate verdict is FAIL, not PASS", result11["verdict"], "FAIL")
    check_true(
        "ROUND2 dunder-call: flagged as not among the detector's own defined names",
        any(
            "dunder-called-detector.py" in v and "universal to every Python module object" in v
            for v in result11["violations"]
        ),
    )

    print()
    print("=" * 70)
    print("ROUND 2, positive control -- a genuine call to the detector's OWN")
    print("defined function still passes")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(root / "scripts" / "genuinely-called-detector.py", DETECTOR_SOURCE)
        write(
            root / "scripts" / "genuinely-called-detector.test.py",
            good_test_file("genuinely-called-detector.py"),
        )
        with registry_snapshot({
            "scripts/genuinely-called-detector.py": {
                "test": "scripts/genuinely-called-detector.test.py",
                "negative_tokens": ["REJECTED"],
            }
        }):
            result12 = neg.run_all(root)

    print("GATE: %s  (exit %d)" % (result12["verdict"], result12["code"]))
    check("ROUND2 positive control: gate verdict is PASS", result12["verdict"], "PASS")
    check_true(
        "ROUND2 positive control: the genuinely-called detector raises no violation",
        not any("genuinely-called-detector.py" in v for v in result12["violations"]),
    )

    print()
    print("=" * 70)
    print("ROUND 2 -- subprocess route: result read, but detector's own name")
    print("nowhere near the invocation (nothing ties the call to THIS detector)")
    print("=" * 70)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(root / "scripts" / "unrelated-subprocess-detector.py", DETECTOR_SOURCE)
        write(
            root / "scripts" / "unrelated-subprocess-detector.test.py",
            "#!/usr/bin/env python3\n"
            "import subprocess, sys\n"
            "# unrelated-subprocess-detector.py is mentioned here, far from the call below\n"
            "result = subprocess.run([sys.executable, '-c', 'print(1)'], capture_output=True, text=True)\n"
            "assert result.returncode == 0\n"
            'print("  PASS  clean case: OK")\n'
            'print("  PASS  bad case -> STALE: STALE")\n',
        )
        with registry_snapshot({
            "scripts/unrelated-subprocess-detector.py": {
                "test": "scripts/unrelated-subprocess-detector.test.py",
                "negative_tokens": ["STALE"],
            }
        }):
            result13 = neg.run_all(root)

    for line in result13["violations"]:
        print(line)
    print("GATE: %s  (exit %d)" % (result13["verdict"], result13["code"]))

    check("ROUND2 unrelated-subprocess: gate verdict is FAIL, not PASS", result13["verdict"], "FAIL")
    check_true(
        "ROUND2 unrelated-subprocess: flagged as not tied to this detector",
        any(
            "unrelated-subprocess-detector.py" in v and "does not appear at or near" in v
            for v in result13["violations"]
        ),
    )

    # Regression coverage for the other half of the same review comment: CHECK 3
    # used to return completely bare (no info line at all) when
    # .github/workflows/ does not exist, indistinguishable from "scanned every
    # workflow file and found nothing wrong." It must now say so explicitly, even
    # in isolation (i.e. this is CHECK 3's own fix, independent of the run_all()
    # UNMEASURED guard exercised above).
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        no_wf_violations, no_wf_info, no_wf_refs = neg.check_secret_names(root)
        check_true(
            "check_secret_names: missing .github/workflows/ is reported, not silent",
            len(no_wf_info) > 0,
        )
        check("check_secret_names: missing workflows dir raises no violation", len(no_wf_violations), 0)
        check("check_secret_names: missing workflows dir checks zero refs", no_wf_refs, 0)

    # -------------------------------------------------------------------
    print()
    print("Unit-level coverage of the harder pieces (no filesystem, pure functions)")
    # -------------------------------------------------------------------
    rx = neg.path_pattern_to_regex("**.html")
    check_true("path_pattern_to_regex('**.html') matches a nested path", bool(rx.match("blog/a/b.html")))
    check_true("path_pattern_to_regex('**.html') rejects a non-html file", not rx.match("blog/a/b.ts"))

    rx2 = neg.path_pattern_to_regex("js/**.js")
    check_true("path_pattern_to_regex('js/**.js') matches js/x/y.js", bool(rx2.match("js/x/y.js")))
    check_true("path_pattern_to_regex('js/**.js') rejects a file outside js/", not rx2.match("other/y.js"))

    check(
        "extract_extension_set finds a SCAN_EXTENSIONS literal",
        neg.extract_extension_set('SCAN_EXTENSIONS = {".html", ".ts"}\n'),
        {".html", ".ts"},
    )
    check("extract_extension_set returns None when the script declares none", neg.extract_extension_set("x = 1\n"), None)

    check(
        "extract_push_paths: NO_PUSH_TRIGGER when there is no push trigger",
        neg.extract_push_paths("on:\n  pull_request:\n    branches: [main]\n"),
        neg.NO_PUSH_TRIGGER,
    )
    check(
        "extract_push_paths: NO_PATH_FILTER when push has no paths key",
        neg.extract_push_paths("on:\n  push:\n    branches: [main]\n"),
        neg.NO_PATH_FILTER,
    )
    check(
        "extract_push_paths: extracts the real pattern list",
        neg.extract_push_paths("on:\n  push:\n    paths:\n      - '**.html'\n      - 'js/**.js'\n"),
        ["**.html", "js/**.js"],
    )

    # Secret-name scan: a `#`-prefixed comment narrating the historical bug must
    # never false-positive -- this is a regression test for a real bug this test
    # suite caught during development: edge-function-drift.yml's own postmortem
    # header mentions secrets.GITHUB_PERSONAL_ACCESS_TOKEN in prose, describing a
    # PAST defect it already fixed (renamed to GH_CROSS_REPO_PAT), not a live
    # reference.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(
            root / ".github" / "workflows" / "commented.yml",
            "# secrets.GITHUB_PERSONAL_ACCESS_TOKEN was the old, uncreatable name\n"
            "name: x\non:\n  push: {}\njobs:\n  x:\n    runs-on: ubuntu-latest\n"
            "    steps:\n      - run: echo hi\n",
        )
        violations, info, refs = neg.check_secret_names(root)
        check("secret scan: a comment-only mention is not a violation", len(violations), 0)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(
            root / ".github" / "workflows" / "live.yml",
            "name: y\non:\n  push: {}\njobs:\n  y:\n    runs-on: ubuntu-latest\n"
            "    steps:\n      - run: echo ${{ secrets.GITHUB_PERSONAL_ACCESS_TOKEN }}\n",
        )
        violations2, info2, refs2 = neg.check_secret_names(root)
        check_true(
            "secret scan: a live secrets.GITHUB_* (non-TOKEN) reference IS a violation",
            any("GITHUB_PERSONAL_ACCESS_TOKEN" in v for v in violations2),
        )

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(
            root / ".github" / "workflows" / "reserved.yml",
            "name: z\non:\n  push: {}\njobs:\n  z:\n    runs-on: ubuntu-latest\n"
            "    steps:\n      - run: echo ${{ secrets.GITHUB_TOKEN }}\n",
        )
        violations3, info3, refs3 = neg.check_secret_names(root)
        check("secret scan: the reserved secrets.GITHUB_TOKEN is never a violation", len(violations3), 0)

    # Regression coverage for PR #1742's REVIEW: FAIL (comment 5561074287, MAJOR):
    # a refuter confirmed by fixture test that only the plain dot-notation form
    # was ever matched -- bracket notation (both quote styles), a spaced dot, and
    # a reference split across lines all read refs_checked=0, i.e. the scan did
    # not even know it had seen anything. One fixture per named syntax variant,
    # each run through the real check_secret_names() (not the regex in
    # isolation), asserting BOTH refs_checked > 0 (the miss was invisible, not
    # just unflagged) and that the reference is reported as a violation.
    SECRET_SYNTAX_VARIANTS = [
        ("bracket-single-quoted", "secrets['GITHUB_PERSONAL_ACCESS_TOKEN']"),
        ("bracket-double-quoted", 'secrets["GITHUB_PERSONAL_ACCESS_TOKEN"]'),
        ("spaced-dot", "secrets . GITHUB_PERSONAL_ACCESS_TOKEN"),
    ]
    for variant_label, expr in SECRET_SYNTAX_VARIANTS:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(
                root / ".github" / "workflows" / "variant.yml",
                "name: v\non:\n  push: {}\njobs:\n  v:\n    runs-on: ubuntu-latest\n"
                "    steps:\n      - run: echo ${{ %s }}\n" % expr,
            )
            v_violations, v_info, v_refs = neg.check_secret_names(root)
            check_true(
                "secret scan [%s]: reference is counted (refs_checked > 0)" % variant_label,
                v_refs > 0,
            )
            check_true(
                "secret scan [%s]: reference IS flagged as a violation" % variant_label,
                any("GITHUB_PERSONAL_ACCESS_TOKEN" in v for v in v_violations),
            )

    # A reference split across lines inside ${{ }} -- "expressions split across
    # lines" per the work order. `\s` in SECRET_REF_RE matches the embedded
    # newline, and the comment-blanking pass preserves line count so this still
    # reports a sane line number.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(
            root / ".github" / "workflows" / "multiline.yml",
            "name: m\non:\n  push: {}\njobs:\n  m:\n    runs-on: ubuntu-latest\n"
            "    steps:\n      - run: |\n"
            "          echo ${{ secrets\n"
            "            .GITHUB_PERSONAL_ACCESS_TOKEN }}\n",
        )
        ml_violations, ml_info, ml_refs = neg.check_secret_names(root)
        check_true("secret scan [split-across-lines]: reference is counted (refs_checked > 0)", ml_refs > 0)
        check_true(
            "secret scan [split-across-lines]: reference IS flagged as a violation",
            any("GITHUB_PERSONAL_ACCESS_TOKEN" in v for v in ml_violations),
        )

    # A bracket-notation reference to the one reserved, always-creatable secret
    # must stay clean -- the fix must not turn every bracket reference into a
    # false positive.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(
            root / ".github" / "workflows" / "reserved-bracket.yml",
            "name: rb\non:\n  push: {}\njobs:\n  rb:\n    runs-on: ubuntu-latest\n"
            "    steps:\n      - run: echo ${{ secrets['GITHUB_TOKEN'] }}\n",
        )
        rb_violations, rb_info, rb_refs = neg.check_secret_names(root)
        check("secret scan [bracket, reserved]: refs_checked counts it", rb_refs, 1)
        check("secret scan [bracket, reserved]: reserved secrets.GITHUB_TOKEN is never a violation", len(rb_violations), 0)

    # -------------------------------------------------------------------
    # CHECK 2 structural invocation detection (gh-1738 instance 7, regression
    # for PR #1742's second REVIEW: FAIL, comment 5561758212): the original
    # find_referencing_workflows() was a raw whole-file substring match, so a
    # script's filename appearing ANYWHERE in a workflow file -- a `#`
    # comment, a job/step name, an echo string -- counted as "this workflow
    # invokes this script," producing a genuine false all-clear. Fixed by
    # parsing the YAML and inspecting real execution sites (run: steps,
    # interpreter invocations, args:/entrypoint:) instead of regexing raw
    # file text -- a structural read that makes "the name is in a comment"
    # unrepresentable, since comments do not survive YAML parsing.
    # -------------------------------------------------------------------
    print()
    print("=" * 70)
    print("CHECK 2 structural invocation: mention vs. real invocation")
    print("=" * 70)

    # 1. A comment-only mention (plus a job name and an echo string, for good
    #    measure) must NOT count as invocation -- the script must be reported
    #    as an unreconciled orphan (WARN), never as covered (PASS).
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(
            root / "scripts" / "orphan-scanner.py",
            DETECTOR_SOURCE + '\nSCAN_EXTENSIONS = {".txt"}\n',
        )
        write(root / "data" / "sample.txt", "hello\n")
        write(
            root / ".github" / "workflows" / "unrelated.yml",
            "name: Unrelated\n"
            "# this header just mentions orphan-scanner.py in prose while\n"
            "# describing a different, unrelated check -- it never runs it.\n"
            "on:\n"
            "  push:\n"
            "    branches: [main]\n"
            "jobs:\n"
            "  x:\n"
            "    runs-on: ubuntu-latest\n"
            "    steps:\n"
            "      - name: orphan-scanner.py is named in this step title too\n"
            "        run: echo \"see orphan-scanner.py for context\"\n",
        )
        wfs = neg.find_referencing_workflows(root, "scripts/orphan-scanner.py")
        check("CHECK2 structural: comment/job-name/echo mention is NOT an invocation", wfs, [])

        w_violations, w_info, w_files = neg.check_wiring(root)
        check_true(
            "CHECK2 structural: mention-only script correctly WARNs as unreconciled",
            any("orphan-scanner.py" in i and "WARN" in i for i in w_info),
        )
        check_true(
            "CHECK2 structural: mention-only script never produces a false 'covered' PASS",
            not any("orphan-scanner.py" in i and "PASS" in i for i in w_info),
        )
        check("CHECK2 structural: mention-only script raises no violation either (WARN, not FAIL)", len(w_violations), 0)

    # 2. A genuine invocation -- including the real repo's own multi-line,
    #    backslash-continued `run: |` shape (see schema-lint.yml) -- DOES
    #    count, and a fully-reconciled one reports PASS with no violation.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(
            root / "scripts" / "real-scanner.py",
            DETECTOR_SOURCE + '\nSCAN_EXTENSIONS = {".txt"}\n',
        )
        write(root / "data" / "sample.txt", "hello\n")
        write(
            root / ".github" / "workflows" / "real.yml",
            "name: Real\n"
            "on:\n"
            "  push:\n"
            "    branches: [main]\n"
            "    paths:\n"
            "      - 'data/**.txt'\n"
            "      - 'scripts/real-scanner.py'\n"
            "jobs:\n"
            "  x:\n"
            "    runs-on: ubuntu-latest\n"
            "    steps:\n"
            "      - run: |\n"
            "          python3 scripts/real-scanner.py \\\n"
            "            --root .\n",
        )
        wfs2 = neg.find_referencing_workflows(root, "scripts/real-scanner.py")
        check("CHECK2 structural: a real multi-line, backslash-continued run: invocation IS found", wfs2, [".github/workflows/real.yml"])

        r_violations, r_info, r_files = neg.check_wiring(root)
        check_true(
            "CHECK2 structural: genuinely-invoked, fully-covered script reports PASS",
            any("real-scanner.py" in i and "PASS" in i for i in r_info),
        )
        check("CHECK2 structural: genuinely-invoked, fully-covered script raises no violation", len(r_violations), 0)

    # 3. A composite/Docker action's `args:` (list form) is also a real
    #    invocation site, not just a `run:` step -- per the work order's
    #    design guidance not to narrow so far that genuine invocations
    #    (a composite action, in this shape) are missed.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        write(
            root / "scripts" / "docker-scanner.py",
            DETECTOR_SOURCE + '\nSCAN_EXTENSIONS = {".txt"}\n',
        )
        write(root / "data" / "sample.txt", "hello\n")
        write(
            root / ".github" / "workflows" / "docker.yml",
            "name: Docker\n"
            "on:\n"
            "  push:\n"
            "    branches: [main]\n"
            "jobs:\n"
            "  x:\n"
            "    runs-on: ubuntu-latest\n"
            "    steps:\n"
            "      - uses: docker://python:3.11\n"
            "        with:\n"
            "          args:\n"
            "            - scripts/docker-scanner.py\n"
            "            - --root\n"
            "            - .\n",
        )
        wfs3 = neg.find_referencing_workflows(root, "scripts/docker-scanner.py")
        check("CHECK2 structural: a Docker action's args: list IS an invocation site", wfs3, [".github/workflows/docker.yml"])

    # NOTE: whether this fix still rediscovers instance 5 against the REAL
    # repo tree (schema-column-lint.py / schema-lint.yml) is verified as a
    # separate, standalone run (`python scripts/detector-negative-control-check.py`
    # against this checkout) rather than as an assertion in this file. This
    # suite's own docstring commits to never touching this repo's real
    # scripts/ or .github/workflows/ -- an assertion pinned to today's real
    # workflow content would silently start failing this BUILD-FAILING
    # self-test the moment someone fixes instance 5 for real, for reasons
    # having nothing to do with a regression in this checker's logic.

    print()
    if FAILURES:
        print("FAILED -- %d assertion(s): %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("detector-negative-control-check: all assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
