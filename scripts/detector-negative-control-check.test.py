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
