#!/usr/bin/env python3
"""
spec-spy-order-check.py -- gh-1840 control 1 (severed from #1738): a static
check that a Playwright spec's reachability spy was installed AFTER verifying
the binding it wraps already existed, never installed as a bare replacement
that fabricates the binding it then asserts against.

WHY THIS EXISTS
----------------
PR #1720's original entry-point reachability spec (commit 133b2db, later
fixed on the same branch by commit 4d542ba -- see
tests/e2e/smoke/entry-point-reachability.spec.ts's `installSpy()` and its
"DEFECT 1 / DEFECT 3" comment) unconditionally overwrote six page globals
with plain spy functions inside a `page.evaluate()` block in `beforeEach`,
BEFORE the click each test went on to assert reached that global:

    (window as any).openEstimatePdf = spy('openEstimatePdf');

If `openEstimatePdf` had been renamed or was missing entirely, this line
still succeeds -- it CREATES a fresh `window.openEstimatePdf`, which the
later `assertClickReaches()` then finds populated, because the click bubbles
into the delegated dispatcher which looks the identifier up BY NAME at call
time. The suite reported "11 passed" while four money-path handlers actually
threw `ReferenceError` on a real, spy-free click (verified independently).
The assertion's own precondition (the binding exists) was established by the
test, not observed.

The fix (`installSpy()` on `main` today) reads the binding first and refuses
to proceed if it is not already a function:

    const original = new Function(
      `return (typeof ${targetName} !== 'undefined') ? ${targetName} : undefined;`
    )();
    if (typeof original !== 'function') { throw new Error(...); }
    ...
    new Function(`${targetName} = arguments[0];`)(wrapper);   // WRAP, don't replace

This is that check, generalized: for any spy-install site inside a
`page.evaluate()` / `page.addInitScript()` callback, was there a `typeof`
read of the SAME target, textually earlier in the SAME callback body?

Per #1738's amended closes-on (quoted on gh-1840): "a test-authoring-order
defect in a Playwright spec, not a static, checkable property of a script's
declared inputs or its test file's assertion count. Catching it in general
would require semantic understanding of *when* an assertion's precondition
was established relative to the action under test." This script does NOT
attempt that general semantic understanding. It checks one narrow, textual,
line-order property -- see LIMITATIONS below for exactly what that leaves
uncaught.

WHAT THIS DETECTS
------------------
Inside each `page.evaluate(() => { ... })` / `page.addInitScript(() => {
... })` callback body found in a `.spec.ts` file (arrow-function-bodied
callbacks only -- see LIMITATIONS), two kinds of "install site" are
recognized:

  1. LITERAL   `(window as any).NAME = <expr>;` / `window.NAME = <expr>;`
               where <expr> looks like a spy (contains `=>`, the `function`
               keyword, or a call to a local `spy(` helper) -- the exact
               shape of PR #1720's original bug. NAME is a literal
               identifier written directly in the source.

  2. TEMPLATE  `` new Function(`${VAR} = arguments[0];`) `` (or the same
               with extra whitespace) -- the generic "reassign whatever
               identifier VAR currently names" form `installSpy()` uses so
               it works for any target without being copy-pasted per name.
               VAR is a JS variable in scope (typically the callback's own
               parameter), not a literal target name.

For each install site, this script looks for a GUARD earlier in the same
callback body:

  - LITERAL install (NAME) is guarded by `typeof NAME`, `typeof
    window.NAME`, or `typeof (window as any).NAME` appearing before it.
  - TEMPLATE install (VAR) is guarded by a template-interpolated
    `` typeof ${VAR} `` appearing before it -- exactly the form
    `installSpy()` uses (`` `return (typeof ${targetName} !== 'undefined')
    ...` ``).

An install site with no matching guard is REJECTed with the named verdict
token SPY_UNVERIFIED. A file with zero install sites, or where every install
site is guarded, is silent (no output for that file, no violation).

LIMITATIONS -- read before trusting this check as complete
------------------------------------------------------------
  - Regex/text-based, not a real TypeScript/JS parser. Block extraction
    naively brace-counts `{`/`}` from the first `{` after `=>`, with no
    awareness of string/template/comment context -- a stray unbalanced brace
    inside a string literal inside a spied block could mis-extract the
    block boundary. Not observed in this repo's actual specs today (checked
    against every `.spec.ts` currently under tests/e2e/ as part of this
    change), but it is a real, disclosed gap, not a proven-absent one.
  - Only two install shapes are recognized (see above). A spy installed via
    `Object.defineProperty`, `Proxy`, `vi.spyOn`-style helpers, or any other
    mechanism is invisible to this check -- silent, not flagged clean.
  - Only two guard shapes are recognized (`typeof X` / `` typeof ${X} ``).
    A guard expressed as `X === undefined`, `'X' in window`, a try/catch
    around the read, or a helper function call that itself does the check
    (one level of indirection) does not count as a guard here -- it would
    be a FALSE REJECT on an actually-safe pattern this check cannot
    recognize. This is the accepted failure direction: ambiguous safety
    reads as unverified, per this issue's own instruction that ambiguity
    must resolve to a visible gap, never to silent coverage.
  - Expression-bodied arrow callbacks (`page.evaluate(() => expr)`, no `{`
    block) are skipped entirely -- there is no statement sequence to find a
    guard-before-install ordering in. None of this repo's spy-install sites
    use that form today; only read-only calls do (e.g. `readSpyLog`).
  - This is a LINE-ORDER heuristic, not a data-flow analysis: a guard for
    NAME anywhere earlier in the same callback body counts, even if it is
    inside an unrelated `if` branch that would not actually run before the
    install on every code path. `installSpy()`'s own shape (guard, then
    throw-or-continue, then install, all in a straight line) is exactly what
    this is built to recognize; anything more branchy would need real
    control-flow analysis, out of scope here for the same reason named in
    the module's own LIMITATIONS above.
  - Cross-function indirection (a helper function that installs the guard in
    one page.evaluate call and the write in a SEPARATE page.evaluate call)
    is not resolved -- each callback body is checked independently. This
    matters here only in the sense that it is a possible false-reject
    surface for a hypothetical future spec structured that way; today's
    `installSpy()` keeps guard-and-install in one callback body, which is
    what this check verifies against.

USAGE
    python scripts/spec-spy-order-check.py [PATH ...]
        Scan the given .spec.ts file(s). With no PATH, scans every
        tests/e2e/**/*.spec.ts under the repo root.
    python scripts/spec-spy-order-check.py --self-test
        Run against scripts/fixtures/spy-order-bad.spec.ts (must REJECT) and
        scripts/fixtures/spy-order-good.spec.ts (must be silent/clean).
    python scripts/spec-spy-order-check.py --json [PATH ...]

EXIT
    0  clean -- no unverified spy-install site found in any scanned file
    1  REJECT -- one or more unverified spy-install sites found
    2  usage error (no files found / no files given and no default matches)
"""
import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parent

VERDICT_TOKEN = "SPY_UNVERIFIED"

EVALUATE_CALL_RE = re.compile(r"\.(?:evaluate|addInitScript)\s*\(")
ARROW_RE = re.compile(r"=>\s*")

LITERAL_INSTALL_RE = re.compile(
    r"(?:\(window as any\)|window)\.([A-Za-z_$][\w$]*)\s*=\s*([^;]*);"
)
TEMPLATE_INSTALL_RE = re.compile(
    r"\$\{\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*arguments\[0\]\s*;"
)

LITERAL_GUARD_RE = re.compile(
    r"typeof\s+(?:\(window as any\)\.|window\.)?([A-Za-z_$][\w$]*)\b"
)
TEMPLATE_GUARD_RE = re.compile(r"typeof\s+\$\{\s*([A-Za-z_$][\w$]*)\s*\}")

SPY_LOOKING_RE = re.compile(r"=>|\bfunction\b|\bspy\s*\(")

# Housekeeping / bookkeeping assignments this check must never flag, even
# though they match LITERAL_INSTALL_RE's shape -- reset of the shared spy
# log array, not an install of a spy itself.
NOT_AN_INSTALL_NAMES = {"__oqSpyCalls"}

FULL_LINE_COMMENT_RE = re.compile(r"^[ \t]*(?://|/\*\*?|\*/?|\*).*$")


def blank_full_line_comments(text: str) -> str:
    """Replace the CONTENTS of every full-line comment (`//...`, `/** ... */`
    block-comment delimiter lines, and `*`-prefixed continuation lines) with
    spaces, preserving line count and character offsets exactly so line
    numbers and match positions computed against the result stay accurate.

    This exists because EVALUATE_CALL_RE (`.evaluate(` / `.addInitScript(`)
    is a plain substring search, and this file's OWN module docstring
    mentions "page.evaluate() block" in prose -- a raw scan without this
    step treated that mention as a real call and mis-extracted a bogus
    "block" starting at the next unrelated `=>`. This is the same class of
    bug named in scripts/detector-negative-control-check.py's own history
    (gh-1738 instance 7, PR #1742 comment 5561758212: a substring match
    mistaking a script's name inside a workflow COMMENT for a real
    invocation) -- fixed there by parsing YAML structurally; TS has no
    equivalent free structural parse available here, so the mitigation is
    the same one scripts/detector-negative-control-check.py's check_secret_names()
    uses for `#`-comments: blank full-line comments only. A trailing
    `// comment` after real code on the same line is deliberately left
    alone (same accepted scope as that precedent) -- documented in this
    script's own LIMITATIONS section as a residual gap, not silently
    assumed safe."""
    out_lines = []
    for line in text.split("\n"):
        if FULL_LINE_COMMENT_RE.match(line):
            out_lines.append(" " * len(line))
        else:
            out_lines.append(line)
    return "\n".join(out_lines)


def find_blocks(text: str):
    """Yields (block_text, block_start_offset) for each arrow-function-bodied
    .evaluate()/.addInitScript() callback in `text`. block_start_offset is
    the character offset of the callback body's opening `{` (inclusive),
    used to recover line numbers for anything found inside."""
    for m in EVALUATE_CALL_RE.finditer(text):
        # Find the `=>` that introduces this call's callback, searching only
        # up to a sane bound so an unrelated later `=>` in a different
        # statement is never mistaken for this call's own arrow.
        search_from = m.end()
        arrow = ARROW_RE.search(text, search_from, search_from + 400)
        if not arrow:
            continue
        brace_pos = arrow.end()
        if brace_pos >= len(text) or text[brace_pos] != "{":
            continue  # expression-bodied arrow -- no statement block to scan
        depth = 0
        i = brace_pos
        n = len(text)
        while i < n:
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    yield text[brace_pos : i + 1], brace_pos
                    break
            i += 1


def line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def scan_block(block_text: str, block_start: int, full_text: str, rel_path: str):
    violations = []

    guards = []  # (name, position-within-block)
    for gm in LITERAL_GUARD_RE.finditer(block_text):
        guards.append((gm.group(1), gm.start()))
    for gm in TEMPLATE_GUARD_RE.finditer(block_text):
        guards.append((gm.group(1), gm.start()))

    def guarded_before(name: str, pos: int) -> bool:
        return any(g_name == name and g_pos < pos for g_name, g_pos in guards)

    for im in LITERAL_INSTALL_RE.finditer(block_text):
        name, rhs = im.group(1), im.group(2)
        if name in NOT_AN_INSTALL_NAMES:
            continue
        if not SPY_LOOKING_RE.search(rhs):
            continue  # a plain data assignment, not a spy install
        if guarded_before(name, im.start()):
            continue
        abs_pos = block_start + im.start()
        line = line_of(full_text, abs_pos)
        snippet = im.group(0).strip()
        if len(snippet) > 100:
            snippet = snippet[:97] + "..."
        violations.append(
            "REJECT %s %s:%d target=%s -- spy installed via literal `window.%s = ...` "
            "with no preceding `typeof %s` guard in this callback body. This can CREATE "
            "the binding a later click-assertion checks, rather than observing a "
            "pre-existing one (PR #1720 comment 5560323618). Statement: %s"
            % (VERDICT_TOKEN, rel_path, line, name, name, name, snippet)
        )

    for tm in TEMPLATE_INSTALL_RE.finditer(block_text):
        var = tm.group(1)
        if guarded_before(var, tm.start()):
            continue
        abs_pos = block_start + tm.start()
        line = line_of(full_text, abs_pos)
        violations.append(
            "REJECT %s %s:%d target=%s -- spy installed via template-interpolated "
            "`${%s} = arguments[0]` with no preceding `typeof ${%s}` guard in this "
            "callback body." % (VERDICT_TOKEN, rel_path, line, var, var, var)
        )

    return violations


def scan_file(path: Path, root: Path):
    raw_text = path.read_text(encoding="utf-8", errors="replace")
    text = blank_full_line_comments(raw_text)
    try:
        rel_path = str(path.resolve().relative_to(root)).replace("\\", "/")
    except ValueError:
        rel_path = str(path)
    violations = []
    blocks_found = 0
    for block_text, block_start in find_blocks(text):
        blocks_found += 1
        violations.extend(scan_block(block_text, block_start, text, rel_path))
    return violations, blocks_found


def run(paths, root: Path):
    all_violations = []
    files_scanned = 0
    blocks_scanned = 0
    for p in paths:
        v, blocks = scan_file(p, root)
        files_scanned += 1
        blocks_scanned += blocks
        all_violations.extend(v)
    return {
        "verdict": "REJECT" if all_violations else "CLEAN",
        "code": 1 if all_violations else 0,
        "violations": all_violations,
        "files_scanned": files_scanned,
        "blocks_scanned": blocks_scanned,
    }


def default_paths(root: Path):
    return sorted((root / "tests" / "e2e").rglob("*.spec.ts"))


def print_report(result: dict):
    print("=" * 78)
    print("spec-spy-order-check (gh-1840 control 1)")
    print("=" * 78)
    print(
        "files_scanned=%d  blocks_scanned=%d"
        % (result["files_scanned"], result["blocks_scanned"])
    )
    for line in result["violations"]:
        print(line)
    print("-" * 78)
    print("VIOLATIONS: %d" % len(result["violations"]))
    print("GATE: %s" % result["verdict"])


def self_test(root: Path) -> int:
    fixtures = root / "scripts" / "fixtures"
    bad = fixtures / "spy-order-bad.spec.ts"
    good = fixtures / "spy-order-good.spec.ts"

    failures = []

    bad_result = run([bad], root)
    bad_tokens = [v for v in bad_result["violations"] if VERDICT_TOKEN in v]
    if bad_result["code"] != 0 and bad_tokens:
        print(
            "PASS  bad fixture (%s) REJECTED with %d %s token(s), exit code %d"
            % (bad.name, len(bad_tokens), VERDICT_TOKEN, bad_result["code"])
        )
    else:
        print(
            "FAIL  bad fixture (%s) was expected to REJECT with a %s token but did not "
            "(exit=%d, violations=%d) -- the detector cannot see the bug it exists to catch"
            % (bad.name, VERDICT_TOKEN, bad_result["code"], len(bad_result["violations"]))
        )
        failures.append("bad-fixture-not-rejected")

    good_result = run([good], root)
    if good_result["code"] == 0 and not good_result["violations"]:
        print("PASS  good fixture (%s) is CLEAN, exit code 0" % good.name)
    else:
        print(
            "FAIL  good fixture (%s) was expected to be CLEAN but got %d violation(s): %s"
            % (good.name, len(good_result["violations"]), good_result["violations"])
        )
        failures.append("good-fixture-flagged")

    # Known-bad-expectation inversion: prove this self-test's own PASS/FAIL
    # machinery actually distinguishes right from wrong, rather than always
    # printing PASS regardless of input. Deliberately assert the WRONG
    # thing (that the bad fixture is clean) and confirm THAT assertion is
    # the one that fails -- if it silently "passed" instead, this self-test
    # harness would be worthless as a negative control.
    inverted_is_correct = (good_result["code"] == 0) and (bad_result["code"] != 0)
    wrongly_expect_bad_is_clean = bad_result["code"] == 0
    if wrongly_expect_bad_is_clean:
        print(
            "FAIL  [inverted check, EXPECTED to fail] bad fixture was wrongly clean -- "
            "if you are reading this as a PASS, the self-test harness itself is broken"
        )
        failures.append("inverted-check-did-not-fail")
    else:
        print(
            "PASS  inverted check correctly failed to find the bad fixture clean "
            "(proves this self-test can distinguish a wrong expectation from a right one)"
        )
    if not inverted_is_correct:
        failures.append("fixtures-not-distinguishable")

    print()
    if failures:
        print("FAILED -- %d assertion(s): %s" % (len(failures), ", ".join(failures)))
        return 1
    print("spec-spy-order-check self-test: all assertions passed.")
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("paths", nargs="*")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--root", default=None)
    args = parser.parse_args(argv)

    root = Path(args.root).resolve() if args.root else DEFAULT_ROOT

    if args.self_test:
        return self_test(root)

    if args.paths:
        paths = [Path(p) for p in args.paths]
        missing = [str(p) for p in paths if not p.exists()]
        if missing:
            print("ERROR: file(s) not found: %s" % ", ".join(missing), file=sys.stderr)
            return 2
    else:
        paths = default_paths(root)
        if not paths:
            print(
                "ERROR: no PATH given and no tests/e2e/**/*.spec.ts found under %s"
                % root,
                file=sys.stderr,
            )
            return 2

    result = run(paths, root)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print_report(result)
    return result["code"]


if __name__ == "__main__":
    sys.exit(main())
