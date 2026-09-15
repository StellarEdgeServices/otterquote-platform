#!/usr/bin/env python3
"""
Stage 5 prevention for the ungated-analytics-loader cluster (gh-1619, 2026-09-04).

The production GA4 tag (and Microsoft Clarity) used to load unconditionally on
every host that served these pages -- staging, branch-deploy previews,
localhost -- so 92% of the GA4 property was our own CI and every funnel
denominator derived from it was wrong by ~17x. The fix routes every loader
through ONE gate per app that checks `location.hostname` against a
production allowlist and never injects the vendor <script> off-allowlist:

  js/ga-gate.js                        (static site: gtag.js + clarity.ms)
  react-app/app/components/GA4Gate.tsx (React app: gtag.js)

A per-file variant of the loader -- a fresh page that pastes the vendor
snippet, or a .tsx that adds its own `next/script` -- is how the bug recurs,
and the first sweep found the React loader only because it looked past
.html/.js. So this check scans .html, .js, .jsx, .ts and .tsx (excluding
node_modules, .next, build output and this script) for any occurrence of an
analytics loader URL outside the gate files.

gh-1817: extended to also guard the Meta Pixel loader (fbevents.js), routed
through the same two-file gate pattern (js/meta-pixel-gate.js and
react-app/app/components/MetaPixelGate.tsx).

gh-1969: js/meta-pixel-gate.js was found sending a token-bearing URL
fragment (Supabase access_token/refresh_token) to facebook.com/tr as `dl`,
because fbevents.js reads window.location itself and offers no supported
override -- the only fix is to never load fbevents.js while the fragment
carries a live credential (the same fragment predicate PR #1947 added to
js/ga-gate.js for Clarity). This check now also asserts that predicate is
present in js/meta-pixel-gate.js, so a future edit that removes it (the
"single loader location" property alone does not catch this class -- the
gate file can load fbevents.js unconditionally and still pass the loader
scan) fails CI instead of shipping silently.

gh-1969 follow-up (ceo47-review-pr1970-20260915.md, defect 1): the first cut
of this check searched the gate file's raw source text, so a predicate that
was still textually present but no longer *live* -- commented out with
`//`, wrapped in a `/* */` block, or neutered with a constant-folded
condition such as `if (false && urlHasAuthToken)` -- still satisfied the
regex search and exited 0 while the runtime leak remained. This version:

  1. Strips JS comments (`//` to end of line, `/* ... */` blocks) from the
     gate file's text before every regex search below, using a small
     string-aware scanner so a comment marker that appears inside a string
     literal (e.g. the `'https://connect.facebook.net/...'` script-src
     literal, which contains `//`) is never mistaken for a comment start.
  2. After stripping, additionally rejects a predicate whose *governing*
     `if (...)` condition is constant-folded into always-false or
     always-true noise -- `false && ...`, `0 && ...`, `... && false`,
     `... && 0`, `true || ...`, `1 || ...`, `... || true`, `... || 1` --
     which would otherwise still contain the real token-check substrings
     and a real `return`, and so still pass a naive text search.

Exit codes:
  0 -- no violations
  1 -- one or more ungated loader sites, or the pixel gate is missing (or
       has a dead/neutered) token-fragment predicate (each printed as
       path:line or as a named violation)
"""
from __future__ import annotations
import pathlib, re, sys

REPO = pathlib.Path(__file__).resolve().parent.parent
GATE_FILES = {
    "js/ga-gate.js",
    "react-app/app/components/GA4Gate.tsx",
    "js/meta-pixel-gate.js",
    "react-app/app/components/MetaPixelGate.tsx",
}
LOADER_RES = [
    ("gtag.js loader", re.compile(r"googletagmanager\.com/gtag/js")),
    ("clarity.ms loader", re.compile(r"clarity\.ms/tag")),
    ("fbevents.js loader", re.compile(r"connect\.facebook\.net/[^\s\"']*fbevents\.js")),
]
META_PIXEL_GATE = REPO / "js" / "meta-pixel-gate.js"


def strip_js_comments(text: str) -> str:
    """Remove `//...` and `/*...*/` comments from JS source, without ever
    treating characters inside a string literal (', ", `) as a comment
    marker. Newlines inside a removed comment are preserved as newlines so
    that surrounding line-based logic (none currently depends on it here,
    but callers may) still lines up; comment bodies themselves become
    spaces so a comment does not accidentally glue two tokens together
    (e.g. `if(x)/*c*/{` must not become `if(x){` -- it already would be
    fine here, but staying token-safe is cheap and avoids surprises).
    Does not handle JS regex literals (`/foo\\//`) specially; this file's
    gate scripts do not contain any, and getting that wrong would be far
    riskier than the case this guards against.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    in_str: str | None = None
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ("'", '"', "`"):
            in_str = c
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            j = text.find("\n", i)
            if j == -1:
                i = n
            else:
                out.append("\n")
                i = j + 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            if j == -1:
                i = n
            else:
                out.append("\n" * text.count("\n", i, j + 2))
                i = j + 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


# gh-1969: the fragment predicate must gate the fbevents.js load itself.
# Match the actual `hash.indexOf('access_token')`-style code, not prose --
# a comment mentioning these names (as this very file's writeup does) must
# NOT satisfy the check, or a planted removal of the real predicate that
# leaves the comment behind would pass. hash/window.location.hash is
# required too, since the token names alone could appear in an unrelated
# check. Comments are stripped before this ever runs (see
# strip_js_comments), so a `//`- or `/* */`-commented predicate no longer
# matches at all.
TOKEN_NAMES = ("access_token", "refresh_token", "provider_token")
TOKEN_CODE_RES = {
    name: re.compile(r"""(?:hash|location\.hash)[^\n]*indexOf\(['"]""" + re.escape(name) + r"""['"]\)""")
    for name in TOKEN_NAMES
}
RETURN_STATEMENT_RE = re.compile(r"\breturn\b[^\n]*;")
FBEVENTS_SRC_RE = re.compile(r"s\.src\s*=.*fbevents\.js")

# gh-1969 defect 1 (ceo47-review-pr1970-20260915.md): a predicate can stay
# textually intact yet be neutered by constant-folding its guarding `if`
# condition -- `if (false && urlHasAuthToken)` never executes the return,
# `if (true || urlHasAuthToken)` always executes it regardless of the
# actual check. Either makes the condition dead weight rather than a live
# gate. We find the nearest enclosing `if (...)` for each token-check match
# and require its condition contain none of these constant-folding shapes.
# This is deliberately a denylist of known-cheap tells, not a general
# constant-expression evaluator -- see the docstring's "at least" scoping.
NEUTER_RES = [
    ("false && ...", re.compile(r"\b(?:false|0)\s*&&")),
    ("... && false", re.compile(r"&&\s*(?:false|0)\b")),
    ("true || ...", re.compile(r"\b(?:true|1)\s*\|\|")),
    ("... || true", re.compile(r"\|\|\s*(?:true|1)\b")),
]


def _enclosing_if_condition(text: str, pos: int) -> str | None:
    """Return the condition text of the nearest `if ( ... )` whose opening
    paren is the last one before `pos` that is still unclosed at `pos` --
    i.e. the `if` statement `pos` lexically sits inside. Returns None if
    `pos` is not inside any `if (...)` condition or body reachable this
    way (best-effort; false negatives here fail closed via the ordering /
    return checks that already run, not silently pass)."""
    # Walk backwards from pos tracking paren depth to find the start of the
    # innermost enclosing (...) group, then confirm it is an `if` group.
    depth = 0
    j = pos - 1
    # First, are we inside a body (past the closing paren of an if) rather
    # than inside the condition itself? Search for the nearest preceding
    # `if (` and take everything up to its matching `)`, then check pos
    # falls before that `)` (condition) or after (body, e.g. inside the
    # `{ ... return; }` block) -- either way we want that if's condition.
    if_starts = [m.start() for m in re.finditer(r"\bif\s*\(", text[:pos])]
    if not if_starts:
        return None
    start = if_starts[-1]
    open_paren = text.index("(", start)
    depth = 0
    k = open_paren
    while k < len(text):
        if text[k] == "(":
            depth += 1
        elif text[k] == ")":
            depth -= 1
            if depth == 0:
                return text[open_paren + 1 : k]
        k += 1
    return None


def check_meta_pixel_fragment_guard() -> list[str]:
    rel = META_PIXEL_GATE.relative_to(REPO).as_posix()
    if not META_PIXEL_GATE.is_file():
        return [f"{rel}: file missing"]
    raw_text = META_PIXEL_GATE.read_text(encoding="utf-8", errors="replace")
    text = strip_js_comments(raw_text)

    missing = [name for name, rx in TOKEN_CODE_RES.items() if not rx.search(text)]
    if missing:
        return [f"{rel}: missing live token-fragment predicate code for {missing} "
                f"(a substring/comment mention is not enough -- gh-1969 fragment guard "
                f"removed or weakened)"]

    fb_match = FBEVENTS_SRC_RE.search(text)
    if fb_match is None:
        return [f"{rel}: fbevents.js script-src assignment not found -- cannot verify the "
                f"fragment predicate gates it"]
    fbevents_pos = fb_match.start()

    token_matches = {name: rx.search(text) for name, rx in TOKEN_CODE_RES.items()}
    last_token_code_pos = max(m.start() for m in token_matches.values())
    if last_token_code_pos > fbevents_pos:
        return [f"{rel}: token-fragment predicate code appears after the fbevents.js script "
                f"tag is built -- it must gate the load, not run after it"]

    # The predicate must actually short-circuit before the load: there must
    # be a `return` between the last token check and the fbevents.js src
    # assignment (mirrors js/ga-gate.js's `if (urlHasAuthToken) { return; }`).
    between = text[last_token_code_pos:fbevents_pos]
    if not RETURN_STATEMENT_RE.search(between):
        return [f"{rel}: no return/early-exit found between the token-fragment predicate and "
                f"the fbevents.js load -- the predicate is not actually gating it"]

    # gh-1969 defect 1: the predicate must also be a *live* condition, not
    # one neutered by a constant-folded `if`. Check every `if` that encloses
    # a token-check match (the check may reference the raw hash.indexOf(...)
    # expressions directly, or a variable like `urlHasAuthToken` computed
    # from them -- either way, walk every `if (...)` in the file whose
    # condition mentions the token names or is the one wrapping the return
    # we just verified).
    neutered: list[str] = []
    checked_conditions: set[str] = set()
    candidate_positions = list(token_matches.values()) + [RETURN_STATEMENT_RE.search(between)]
    for m in candidate_positions:
        if m is None:
            continue
        cond = _enclosing_if_condition(text, last_token_code_pos if m in token_matches.values() else last_token_code_pos + m.start())
        if cond is None or cond in checked_conditions:
            continue
        checked_conditions.add(cond)
        for label, rx in NEUTER_RES:
            if rx.search(cond):
                neutered.append(f"{rel}: token-fragment predicate's guarding `if ({cond.strip()})` "
                                 f"is constant-folded ({label}) -- gh-1969 fragment guard neutered, "
                                 f"not a live condition")
                break
    if neutered:
        return neutered

    return []


SCAN_SUFFIXES = {".html", ".js", ".jsx", ".ts", ".tsx"}
SKIP_DIR_NAMES = {"node_modules", ".git", ".next", "dist", "build", "coverage", "playwright-report", "test-results"}
SELF = pathlib.Path(__file__).resolve()


def scan_files() -> list[pathlib.Path]:
    out: list[pathlib.Path] = []
    for path in REPO.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in SCAN_SUFFIXES:
            continue
        if any(part in SKIP_DIR_NAMES for part in path.relative_to(REPO).parts):
            continue
        if path.resolve() == SELF:
            continue
        out.append(path)
    return sorted(out)


def run_checks(repo: pathlib.Path | None = None) -> list[str]:
    """Run all checks against `repo` (defaults to the real REPO) and return
    the list of violation strings. Factored out so --self-test can point it
    at planted fixture trees without touching module-level globals for the
    scan-loop half of the check."""
    global REPO, META_PIXEL_GATE
    if repo is not None:
        REPO = repo
        META_PIXEL_GATE = REPO / "js" / "meta-pixel-gate.js"
    violations: list[str] = []
    violations.extend(check_meta_pixel_fragment_guard())
    for path in scan_files():
        rel = path.relative_to(REPO).as_posix()
        if rel in GATE_FILES:
            continue
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError as e:
            violations.append(f"{rel}: unreadable ({e})")
            continue
        for i, line in enumerate(lines, 1):
            for label, rx in LOADER_RES:
                if rx.search(line):
                    violations.append(f"{rel}:{i}: {label} outside the gate")
    return violations


def main() -> int:
    violations = run_checks()
    if violations:
        print(f"check-gtag-single-source: {len(violations)} ungated analytics loader site(s) "
              f"(only {sorted(GATE_FILES)} may load gtag.js / clarity.ms):")
        for v in violations:
            print("  " + v)
        return 1
    print("check-gtag-single-source: OK -- every gtag.js / clarity.ms loader lives in a gate file")
    return 0


# ---------------------------------------------------------------------------
# Self-test: planted fixtures proving this check actually catches the
# gh-1969 defect-1 bypass classes (commented-out predicate, block-commented
# predicate, constant-folded/neutered predicate) as well as a clean pass and
# a plain removal. Run with `--self-test`; does not touch the real repo.
# ---------------------------------------------------------------------------
CLEAN_GATE = """\
(function () {
  var ALLOWED_HOSTS = ['otterquote.com'];
  var PIXEL_ID = '800470107451795';
  window.fbq = window.fbq || function () {};
  if (ALLOWED_HOSTS.indexOf(window.location.hostname) === -1) {
    return;
  }
  var hash = window.location.hash;
  var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
    hash.indexOf('refresh_token') !== -1 ||
    hash.indexOf('provider_token') !== -1;
  if (urlHasAuthToken) {
    return; // a live Supabase credential is in this URL; the pixel never loads.
  }
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://connect.facebook.net/en_US/fbevents.js';
  document.head.appendChild(s);
  window.fbq('init', PIXEL_ID);
  window.fbq('track', 'PageView');
})();
"""

FIXTURES: dict[str, tuple[str, int]] = {}


def _mk(name: str, gate_body: str, expect_exit: int) -> None:
    FIXTURES[name] = (gate_body, expect_exit)


_mk("clean", CLEAN_GATE, 0)

_mk(
    "predicate_removed",
    CLEAN_GATE.replace(
        """  var hash = window.location.hash;
  var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
    hash.indexOf('refresh_token') !== -1 ||
    hash.indexOf('provider_token') !== -1;
  if (urlHasAuthToken) {
    return; // a live Supabase credential is in this URL; the pixel never loads.
  }
""",
        "",
    ),
    1,
)

_mk(
    "commented_line",
    CLEAN_GATE.replace(
        """  var hash = window.location.hash;
  var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
    hash.indexOf('refresh_token') !== -1 ||
    hash.indexOf('provider_token') !== -1;
  if (urlHasAuthToken) {
    return; // a live Supabase credential is in this URL; the pixel never loads.
  }
""",
        """  // var hash = window.location.hash;
  // var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
  //   hash.indexOf('refresh_token') !== -1 ||
  //   hash.indexOf('provider_token') !== -1;
  // if (urlHasAuthToken) {
  //   return;
  // }
""",
    ),
    1,
)

_mk(
    "commented_block",
    CLEAN_GATE.replace(
        """  var hash = window.location.hash;
  var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
    hash.indexOf('refresh_token') !== -1 ||
    hash.indexOf('provider_token') !== -1;
  if (urlHasAuthToken) {
    return; // a live Supabase credential is in this URL; the pixel never loads.
  }
""",
        """  /*
  var hash = window.location.hash;
  var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
    hash.indexOf('refresh_token') !== -1 ||
    hash.indexOf('provider_token') !== -1;
  if (urlHasAuthToken) {
    return;
  }
  */
""",
    ),
    1,
)

_mk(
    "neutered_false_and",
    CLEAN_GATE.replace(
        "if (urlHasAuthToken) {",
        "if (false && urlHasAuthToken) {",
    ),
    1,
)

_mk(
    "mention_only_predicate_removed",
    CLEAN_GATE.replace(
        """  var hash = window.location.hash;
  var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
    hash.indexOf('refresh_token') !== -1 ||
    hash.indexOf('provider_token') !== -1;
  if (urlHasAuthToken) {
    return; // a live Supabase credential is in this URL; the pixel never loads.
  }
""",
        """  // NOTE: this gate used to check location.hash for access_token,
  // refresh_token and provider_token here. Do not remove -- gh-1969.
""",
    ),
    1,
)


def self_test() -> int:
    import shutil, tempfile

    failures = 0
    for name, (gate_body, expect_exit) in FIXTURES.items():
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "js").mkdir()
            (root / "js" / "meta-pixel-gate.js").write_text(gate_body, encoding="utf-8")
            (root / "js" / "ga-gate.js").write_text("// unrelated\n", encoding="utf-8")
            violations = run_checks(repo=root)
            got_exit = 1 if violations else 0
            ok = got_exit == expect_exit
            status = "PASS" if ok else "FAIL"
            print(f"[self-test] {name}: expected exit {expect_exit}, got {got_exit} -- {status}")
            for v in violations:
                print(f"    {v}")
            if not ok:
                failures += 1
    print(f"[self-test] {len(FIXTURES) - failures}/{len(FIXTURES)} fixtures behaved as expected")
    return 1 if failures else 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    sys.exit(main())
