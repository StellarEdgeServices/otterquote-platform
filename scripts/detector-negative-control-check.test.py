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


GOOD_TEST_FILE = (
    "#!/usr/bin/env python3\n"
    "print(\"  PASS  clean case: OK\")\n"
    "print(\"  PASS  bad-input case -> REJECTED: REJECTED\")\n"
    "import sys\n"
    "sys.exit(0)\n"
)

NO_NEGATIVE_TEST_FILE = (
    "#!/usr/bin/env python3\n"
    "# Only clean-input fixtures -- the exact shape gh-1738 exists to catch: a\n"
    "# detector that has never been observed rejecting the thing it exists to\n"
    "# reject.\n"
    "print(\"  PASS  clean case 1: OK\")\n"
    "print(\"  PASS  clean case 2: OK\")\n"
    "import sys\n"
    "sys.exit(0)\n"
)

DETECTOR_SOURCE = (
    "#!/usr/bin/env python3\n"
    "def main():\n"
    "    print(\"ok\")\n"
    "if __name__ == \"__main__\":\n"
    "    main()\n"
)


def build_clean_tree(root: Path):
    """A properly self-tested detector + fully reconciled wiring."""
    write(root / "scripts" / "good-detector.py", DETECTOR_SOURCE + '\nSCAN_EXTENSIONS = {".txt"}\n')
    write(root / "scripts" / "good-detector.test.py", GOOD_TEST_FILE)
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
    write(root / "scripts" / "clean-only-detector.test.py", NO_NEGATIVE_TEST_FILE)

    # Instance C: instance-5's own shape -- a scanner's declared extensions are
    # not reconciled against its workflow's push.paths filter.
    write(root / "scripts" / "bad-scanner.py", DETECTOR_SOURCE + '\nSCAN_EXTENSIONS = {".html", ".ts"}\n')
    write(root / "scripts" / "bad-scanner.test.py", GOOD_TEST_FILE)
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
        # here for this run only, then restored, exactly as a reviewer would add
        # one permanently for a real detector.
        saved_registry = dict(neg.DETECTOR_REGISTRY)
        neg.DETECTOR_REGISTRY["scripts/clean-only-detector.py"] = {
            "test": "scripts/clean-only-detector.test.py",
            "negative_tokens": ["REJECTED"],
        }
        try:
            result = neg.run_all(root)
        finally:
            neg.DETECTOR_REGISTRY.clear()
            neg.DETECTOR_REGISTRY.update(saved_registry)

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

    print()
    if FAILURES:
        print("FAILED -- %d assertion(s): %s" % (len(FAILURES), ", ".join(FAILURES)))
        return 1
    print("detector-negative-control-check: all assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
