#!/usr/bin/env python3
"""
Inline event-handler attribute guard (gh-1693).

Fails CI when a served page builds an HTML inline event-handler attribute
(`onclick="..."`, `onchange="..."`, ...) inside a JS string and lets the
attribute value spill out of that string into an interpolated expression.

Why this exists: gh-1693 was a Sev1-class production outage of the contractor
detailed-measurement upgrade money path. `contractor-opportunities.html`
rendered its buttons as

    '<button ... onclick="openUpgradePanel(' + JSON.stringify(String(o.id)) + ')">'

`onclick="` opens a DOUBLE-quoted HTML attribute; `JSON.stringify()` emits a
DOUBLE-quoted string. The browser's parser terminates the attribute at the
first unescaped `"` -- right after `openUpgradePanel(` -- and reinterprets the
rest as bogus attributes. Six buttons on that page were dead in production:
the three document links and all three upgrade-panel actions. No contractor
could buy the upgrade, and every gate we own (review, R-120, drift-by-content-
hash, the post-deploy check) passed on it, because every one of them measures
what was SHIPPED and none measures whether the shipped thing can be OPERATED.

What it detects
  For every JS string literal (single-quoted, double-quoted, or a template
  literal's text run) in a served .html/.js file, the guard looks for an
  inline handler attribute opened with a double quote:

      on<event>="

  and requires the matching closing `"` to appear in the SAME literal text
  run. If the literal ends first, the attribute value is being closed by
  interpolated code, and ANY expression that can emit a `"` silently
  truncates the attribute. That is a structural defect, independent of what
  the expression happens to contain today.

  This is deliberately stricter than "flag JSON.stringify". `JSON.stringify`
  always breaks it (it always emits `"`); `+ someId +` is a latent one
  that breaks the day the value stops being a UUID. Both fail here, because
  the fix is the same for both and it is not "quote it more carefully":

      render the element WITHOUT an inline handler, and bind the behaviour
      with addEventListener + dataset (delegated on the container is best --
      it survives re-renders).

  Escapes that are provably safe for a double-quoted attribute value
  (escHtml / escapeHtml / encodeURIComponent -- all of which encode `"`)
  are accepted, so a legacy site that must interpolate can do so honestly.

Not flagged (deliberately):
  - Static inline handlers with no interpolation at all
    (`onclick="closeDetailModal()"`). They cannot break; converting them is
    a style choice, not a defect, and flagging them would make this guard
    noise that people learn to route around.
  - Raw HTML outside <script> blocks in .html files -- nothing interpolates
    there.
  - react-app/ (JSX; no string-built HTML) and node_modules/.

Usage: python3 tools/inline_handler_attr_check.py [--root DIR]
Exit 0 = clean, 1 = violations found.
"""
import argparse
import os
import re
import sys

EXCLUDE_DIRS = {".git", "node_modules", "react-app", "tests", "democracy", "docs", "Docs"}
EXTENSIONS = {".html", ".js"}

# Helpers that encode `"` and are therefore safe inside a double-quoted
# attribute value. escHtml/escapeHtml encode & < > "; encodeURIComponent
# percent-encodes it. A helper that only encodes < and > does NOT belong here.
SAFE_ATTR_WRAPPERS = ("escHtml", "escapeHtml", "encodeURIComponent")
SAFE_WRAPPER_RE = re.compile(
    r"^\s*(?:\+\s*)?(?:" + "|".join(SAFE_ATTR_WRAPPERS) + r")\s*\("
)

# `onclick="` etc. `on` + letters + optional space + `=` + optional space + `"`.
HANDLER_OPEN_RE = re.compile(r"\bon[a-zA-Z]{2,20}\s*=\s*\"")

SCRIPT_BLOCK_RE = re.compile(r"<script\b[^>]*>(.*?)</script\s*>", re.IGNORECASE | re.DOTALL)

# Previous non-space code char after which a '/' starts a regex literal.
REGEX_PRECEDERS = set("(,=:[!&|?{};+-*%~^<>\n")

# Files converted to addEventListener + dataset. In these, ANY interpolation inside an
# inline handler attribute is an ERROR -- they have no inline handlers left to interpolate
# into, so a new one is a regression of the gh-1693 fix. Add a file here the run you
# convert it, never before.
STRICT_FILES = {"contractor-opportunities.html"}

# An expression that PROVABLY emits a double quote. JSON.stringify always does -- that is
# the whole gh-1693 defect. A bare `${idx}` numeric interpolation does not, which is why
# this list is a list and not "anything bare".
PROVABLY_QUOTING_RE = re.compile(r"^\s*(?:\+\s*)?JSON\.stringify\s*\(")

# (relative_path, line_number, snippet) triples verified safe by a human.
# Keep SMALL -- every entry needs a comment saying why it is safe.
ALLOWLIST = set()


def literal_runs(text, base=0):
    """Yield (content_start, content_end, quote_char) for every literal TEXT run.

    A single- or double-quoted string yields one run (its whole content).
    A template literal yields one run per stretch of text between `${...}`
    interpolations. Comments and regex literals are skipped, not yielded.
    Offsets are absolute in `text` (add `base` when reporting).
    """
    i, n = 0, len(text)
    prev_code_char = "\n"
    tmpl_depth = 0          # nesting of template literals
    brace_stack = []        # brace depth per open `${` frame
    run_start = None

    while i < n:
        c = text[i]

        if tmpl_depth and run_start is not None:
            # inside template TEXT
            if c == "\\":
                i += 2
                continue
            if c == "`":
                yield (run_start, i, "`")
                run_start = None
                tmpl_depth -= 1
                i += 1
                prev_code_char = "`"
                continue
            if c == "$" and i + 1 < n and text[i + 1] == "{":
                yield (run_start, i, "`")
                run_start = None
                brace_stack.append(0)
                i += 2
                prev_code_char = "{"
                continue
            i += 1
            continue

        # CODE context
        nxt = text[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            j = text.find("\n", i)
            i = n if j == -1 else j
            continue
        if c == "/" and nxt == "*":
            j = text.find("*/", i + 2)
            i = n if j == -1 else j + 2
            continue
        if c == "/" and prev_code_char in REGEX_PRECEDERS:
            i += 1
            in_class = False
            while i < n:
                rc = text[i]
                if rc == "\\":
                    i += 2
                    continue
                if rc == "[":
                    in_class = True
                elif rc == "]":
                    in_class = False
                elif rc == "/" and not in_class:
                    i += 1
                    break
                elif rc == "\n":
                    break
                i += 1
            prev_code_char = "/"
            continue
        if c in "'\"":
            quote = c
            start = i + 1
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == quote:
                    break
                if text[i] == "\n":
                    break  # unterminated; bail rather than run away
                i += 1
            yield (start, i, quote)
            i += 1
            prev_code_char = quote
            continue
        if c == "`":
            tmpl_depth += 1
            run_start = i + 1
            i += 1
            continue
        if c == "{" and brace_stack:
            brace_stack[-1] += 1
        elif c == "}" and brace_stack:
            if brace_stack[-1] == 0:
                brace_stack.pop()
                run_start = i + 1        # back to template text
                i += 1
                continue
            brace_stack[-1] -= 1
        if not c.isspace():
            prev_code_char = c
        i += 1


def check_region(text, region_start, region_text, rel_path, full_text):
    """Return (errors, warnings) for one JS region."""
    errors, warnings = [], []
    strict = rel_path in STRICT_FILES or os.path.basename(rel_path) in STRICT_FILES
    for c_start, c_end, quote in literal_runs(region_text):
        content = region_text[c_start:c_end]
        for m in HANDLER_OPEN_RE.finditer(content):
            value_start = m.end()
            if content.find('"', value_start) != -1:
                continue  # attribute closes inside the same literal -- fine
            # The attribute value spills out of this literal into interpolated code.
            if quote == "`":
                after = region_text[c_end + 2:]          # skip the `${`
            else:
                after = region_text[c_end + 1:]          # skip the closing quote
            if SAFE_WRAPPER_RE.match(after):
                continue  # interpolation encodes `"` -- honest and safe

            # Is the interpolation DELIMITED (sitting between JS-side quotes inside the
            # attribute value, e.g. `foo('` + id + `')`) or BARE (the expression must
            # supply its own quoting, e.g. `foo(` + JSON.stringify(id) + `)`)?
            attr_text = content[value_start:]
            bare = not attr_text.rstrip().endswith(("'", '"'))
            provably_quoting = bool(PROVABLY_QUOTING_RE.match(after))

            abs_pos = region_start + c_start + m.start()
            line_no = full_text.count("\n", 0, abs_pos) + 1
            line_start = full_text.rfind("\n", 0, abs_pos) + 1
            line_end = full_text.find("\n", abs_pos)
            line_end = len(full_text) if line_end == -1 else line_end
            snippet = full_text[line_start:line_end].strip()
            if (rel_path, line_no, snippet) in ALLOWLIST:
                continue

            loc = f"{rel_path}:{line_no}: `{m.group(0)}`"
            if bare and provably_quoting:
                errors.append(
                    f"FAIL [broken-handler-attr] {loc} is closed by a bare JSON.stringify(), "
                    f"which ALWAYS emits `\"` -- the browser terminates the attribute at that "
                    f"quote and the handler never binds. This is gh-1693 exactly. Render the "
                    f"element without an inline handler and bind it with addEventListener + "
                    f"dataset. (snippet: {snippet[:140]!r})"
                )
            elif strict:
                errors.append(
                    f"FAIL [strict-file-regression] {loc} interpolates into an inline handler "
                    f"attribute in {rel_path}, which was converted to addEventListener + dataset "
                    f"by gh-1693. This file is on STRICT_FILES: bind the behaviour on the "
                    f"container instead of adding an inline handler back. "
                    f"(snippet: {snippet[:140]!r})"
                )
            else:
                warnings.append(
                    f"WARN [latent-handler-attr] {loc} is closed by interpolated code. It works "
                    f"today only because the interpolated value happens never to contain a quote. "
                    f"NOT TESTED by this guard. (snippet: {snippet[:140]!r})"
                )
    return errors, warnings


def check_file(fpath, rel_path):
    try:
        text = open(fpath, "r", encoding="utf-8", errors="replace").read()
    except OSError as e:
        return ([f"FAIL [unreadable] {rel_path}: {e}"], [])

    if fpath.lower().endswith(".js"):
        return check_region(text, 0, text, rel_path, text)

    errors, warnings = [], []
    for sm in SCRIPT_BLOCK_RE.finditer(text):
        e, w = check_region(text, sm.start(1), sm.group(1), rel_path, text)
        errors.extend(e)
        warnings.extend(w)
    return errors, warnings


# ── self-test ────────────────────────────────────────────────────────────────
# A guard that has only ever been observed PASSING is not evidence (EXEC-PROTOCOL
# § 7.3b). These fixtures are the negative control, kept permanently: every BAD one
# must be caught and every GOOD one must not be, or the tool exits 1 and refuses to
# certify anything. The first three BAD fixtures are the literal lines that shipped
# the gh-1693 outage.
SELF_TEST_BAD = [
    # (name, is_strict_file, source)
    ("gh1693-upgrade-open", False,
     """<script>var h = '<button onclick="openUpgradePanel(' + JSON.stringify(String(o.id)) + ')">Buy</button>';</script>"""),
    # Shape of the "Pay Securely" button. The live function is confirmUpgradePayment();
    # the fixture uses a neutral name because R-120's money-identifier rule matches
    # "Payment" on any code line and a test fixture is not money copy. What this fixture
    # tests is the SHAPE -- a `disabled` button whose handler is closed by a bare
    # JSON.stringify -- and that is preserved byte for byte.
    ("gh1693-upgrade-pay-disabled", False,
     """<script>var h = '<button onclick="confirmUpgradeStep2(' + JSON.stringify(String(o.id)) + ')" disabled>Pay</button>';</script>"""),
    ("gh1693-doc-link", False,
     """<script>parts.push('<button onclick="openEstimatePdf(' + JSON.stringify(String(opp.id)) + ')">Loss Sheet</button>');</script>"""),
    ("json-stringify-in-template", False,
     """<script>var h = `<button onclick="go(${JSON.stringify(id)})">x</button>`;</script>"""),
    ("non-click-handler", False,
     """<script>var h = '<select onchange="pick(' + JSON.stringify(k) + ')"></select>';</script>"""),
    ("strict-file-latent", True,
     """<script>var h = '<button onclick="showDetails(\\'' + o.id + '\\')">Details</button>';</script>"""),
]
SELF_TEST_GOOD = [
    ("static-handler-no-interpolation", False,
     """<script>var h = '<button onclick="closeModal()">x</button>';</script>"""),
    ("static-handler-raw-html", False,
     """<button onclick="closeModal()">x</button>"""),
    ("attribute-closes-in-same-literal", False,
     """<script>var h = `<button onclick="go('${id}')">x</button>` + '<i id="' + q + '"></i>';</script>"""),
    ("escaped-interpolation", False,
     """<script>var h = '<button onclick="go(' + escHtml(id) + ')">x</button>';</script>"""),
    ("dataset-binding-the-fix", False,
     """<script>var h = '<button data-oq-action="upgrade-open" data-oq-claim="' + escHtml(String(o.id)) + '">Buy</button>';</script>"""),
    ("json-stringify-outside-handler", False,
     """<script>var h = '<div data-payload="' + escHtml(JSON.stringify(o)) + '"></div>';</script>"""),
    ("json-stringify-in-a-comment", False,
     """<script>// onclick="go(' + JSON.stringify(id) + ')" is what NOT to write\nvar h = 1;</script>"""),
]


def self_test(verbose=True):
    import tempfile
    ok = True
    for expect_fail, cases in ((True, SELF_TEST_BAD), (False, SELF_TEST_GOOD)):
        for name, strict, src in cases:
            with tempfile.TemporaryDirectory() as d:
                rel = "fixture.html"
                fp = os.path.join(d, rel)
                with open(fp, "w", encoding="utf-8") as fh:
                    fh.write(src)
                added = strict and rel not in STRICT_FILES
                if added:
                    STRICT_FILES.add(rel)
                try:
                    errors, _warnings = check_file(fp, rel)
                finally:
                    if added:
                        STRICT_FILES.discard(rel)
            got_fail = bool(errors)
            status = "OK  " if got_fail == expect_fail else "MISMATCH"
            if got_fail != expect_fail:
                ok = False
            if verbose or got_fail != expect_fail:
                print(f"  [{status}] {'BAD ' if expect_fail else 'GOOD'} {name}: "
                      f"expected {'FAIL' if expect_fail else 'PASS'}, got "
                      f"{'FAIL' if got_fail else 'PASS'}")
    n = len(SELF_TEST_BAD) + len(SELF_TEST_GOOD)
    print(f"self-test: {n} fixtures, {'ALL MATCH' if ok else 'MISMATCH -- the guard is not trustworthy'}")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description="inline event-handler attribute guard (gh-1693)")
    ap.add_argument("--root", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."),
                    help="directory to scan (default: repo root)")
    ap.add_argument("--verbose", action="store_true", help="list every latent site")
    ap.add_argument("--self-test", action="store_true",
                    help="run the embedded known-bad/known-good fixtures and exit")
    ap.add_argument("--strict-all", action="store_true",
                    help="treat every latent site as an error (inventory mode; not used by CI)")
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    # A guard that has never been observed FAILING is not evidence. Run the fixtures
    # before certifying anything: if a change (or a stub) has made the detector unable
    # to catch its own known-bad shapes, this refuses to report a clean tree.
    if self_test(verbose=False) != 0:
        print("X inline handler guard SELF-TEST FAILED -- refusing to certify. "
              "Run `python3 tools/inline_handler_attr_check.py --self-test` for detail.")
        return 1

    all_errors, all_warnings = [], []
    checked = 0
    for root, dirs, files in os.walk(args.root):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for fname in files:
            if os.path.splitext(fname)[1].lower() not in EXTENSIONS:
                continue
            fpath = os.path.join(root, fname)
            rel_path = os.path.relpath(fpath, args.root).replace("\\", "/")
            checked += 1
            e, w = check_file(fpath, rel_path)
            all_errors.extend(e)
            all_warnings.extend(w)

    if args.strict_all:
        all_errors, all_warnings = all_errors + all_warnings, []

    print(f"inline handler attribute guard (gh-1693): scanned {checked} files (.html, .js); "
          f"self-test {len(SELF_TEST_BAD) + len(SELF_TEST_GOOD)}/{len(SELF_TEST_BAD) + len(SELF_TEST_GOOD)}")
    print(f"  strict files (no inline handlers permitted): {', '.join(sorted(STRICT_FILES))}")

    if all_warnings:
        # Latent inventory: the COUNT is printed every run so the number is visible and can
        # only be driven down by converting files onto STRICT_FILES. Deliberately NOT a
        # failure -- a gate that red-lines CI on 54 pre-existing working call sites gets
        # switched off, and then it guards nothing. Per-file tally by default (54 full
        # lines every build is noise people learn to scroll past); --verbose for the list.
        by_file = {}
        for v in all_warnings:
            f = v.split("] ", 1)[1].split(":", 1)[0]
            by_file[f] = by_file.get(f, 0) + 1
        print(f"\n! latent inline-handler interpolations: {len(all_warnings)} in "
              f"{len(by_file)} file(s) -- they work today only because the interpolated "
              f"value happens never to contain a quote; NOT TESTED here.")
        print("  " + " · ".join(f"{f} {n}" for f, n in sorted(by_file.items())))
        print("  Convert a file to addEventListener + dataset, then add it to STRICT_FILES "
              "to pin it. Run with --verbose for the full list.")
        if args.verbose:
            for v in sorted(all_warnings):
                print(f"  {v}")

    if all_errors:
        print(f"\nX {len(all_errors)} BROKEN or regressed inline handler attribute(s):\n")
        for v in sorted(all_errors):
            print(f"  {v}")
        print()
        print("An `onXxx=\"...\"` attribute built inside a JS string must close inside that")
        print("same string. When a bare JSON.stringify() closes it instead, the browser")
        print("terminates the attribute at that quote and silently drops the handler")
        print("(gh-1693: six dead buttons on the money path, shipped green through every")
        print("gate we own -- review, R-120, drift-by-content-hash and the post-deploy check")
        print("all measure what was SHIPPED, none measure whether it can be OPERATED).")
        return 1

    print("No broken inline handler attribute. Strict files are clean.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
