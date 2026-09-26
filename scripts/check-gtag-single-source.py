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

gh-1969 follow-up round 1 (ceo47-review-pr1970-20260915.md, defect 1): the
first cut of this check searched the gate file's raw source text, so a
predicate that was still textually present but no longer *live* -- commented
out with `//`, wrapped in a `/* */` block, or neutered with a constant-folded
condition such as `if (false && urlHasAuthToken)` -- still satisfied the
regex search and exited 0 while the runtime leak remained. That version
fixed those three shapes with comment-stripping plus a constant-fold
denylist on the guarding `if`.

gh-1969 follow-up round 2 (cto32-review-pr1977-20260915.md, defects 1-3):
the denylist approach is inherently incomplete -- it is a list of known-bad
shapes, and the refuter planted 12+ more that still exited 0 while the
runtime harness showed the FAKE123 fragment leaking: the governing `if`
moved/deleted, the predicate wrapped in a nested function, the condition
swapped for an unrelated flag, the predicate variable reassigned to false
before the check, `!1 &&` / `(false) &&` / `null &&` (denylist misses on
every one), predicate code pasted into a string literal, and a genuinely
commented-out predicate hidden from the comment stripper by a `/"/`-style
regex literal that fooled its (regex-unaware) string tracking.

This version replaces the "does the predicate substantively exist"
denylist/allowlist approach with a **structural** one: after stripping
comments (now regex-literal-aware, see strip_js_comments), it requires the
*exact* canonical guard block below -- CANONICAL_BLOCK_SRC, the real form
in js/meta-pixel-gate.js today -- to appear verbatim (whitespace amount and
kind aside; no other difference is tolerated) at the top level of the gate
IIFE (not nested inside any `if`/function -- see _scan_structure's depth
tracking), in the same top-level block as the fbevents.js script-src
assignment, and strictly before it. It also requires `urlHasAuthToken` is
never reassigned anywhere else in the file. A denylist can always be one
shape behind the next planted bypass; requiring the known-good shape to
match exactly closes the whole class at once instead. The tradeoff is
deliberate: if js/meta-pixel-gate.js's guard ever changes on purpose,
CANONICAL_BLOCK_SRC in this checker must change with it, in the same
commit -- and the checker says so when it does not.

Known accepted gap (cto32-review-pr1977-20260915.md defect 4, left as-is):
a `return` with the semicolon dropped (relying on ASI) does not match
CANONICAL_BLOCK_SRC's literal `return;`, so it exits 1 even on a gate that
still short-circuits correctly at runtime. This is a fail-*closed* false
positive -- it blocks CI on a harmless style edit, it never lets a leak
through -- so it is left alone rather than special-cased.

Exit codes:
  0 -- no violations
  1 -- one or more ungated loader sites, or the pixel gate's token-fragment
       guard is missing, not the canonical live block, wrongly located, or
       the predicate variable is reassigned elsewhere (each printed as
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


def _looks_like_division(prev_sig: str) -> bool:
    """True if a `/` right after `prev_sig` is almost certainly a division
    operator rather than the start of a regex literal -- the standard
    lexer heuristic: division follows an identifier/number character or a
    closing `)`/`]`; a regex literal follows everything else (operators,
    punctuation, or the start of input/statement). Not a full JS parser,
    and deliberately not: getting this wrong pushes the checker toward
    treating a `/` as regex-literal-start it should not have, which can
    only make comment-stripping *more* conservative (less gets removed),
    never less."""
    return prev_sig != "" and (prev_sig.isalnum() or prev_sig in ")]$_")


def _skip_regex_literal(text: str, i: int) -> int | None:
    """If a JS regex literal (`/.../flags`) starts at text[i] == '/',
    return the index just past its flags; otherwise None. Honors `[...]`
    character classes (a `/` inside one does not close the literal) and
    backslash escapes; a literal newline before an unescaped closing `/`
    means this was not actually a regex literal (bails to None)."""
    n = len(text)
    j = i + 1
    in_class = False
    while j < n:
        cj = text[j]
        if cj == "\\" and j + 1 < n:
            j += 2
            continue
        if cj == "[":
            in_class = True
        elif cj == "]":
            in_class = False
        elif cj == "/" and not in_class:
            k = j + 1
            while k < n and text[k].isalpha():
                k += 1
            return k
        elif cj == "\n":
            return None
        j += 1
    return None


def strip_js_comments(text: str) -> str:
    """Remove `//...` and `/*...*/` comments from JS source, without ever
    treating characters inside a string literal (', ", `) -- or inside a
    regex literal (`/like this/flags`) -- as a comment marker or a string
    delimiter. Newlines inside a removed comment are preserved as newlines
    so surrounding line-based logic still lines up; comment bodies become
    a single collapsing newline rather than being kept.

    gh-1969 (cto32-review-pr1977-20260915.md, defect 3): the first version
    of this function did not know about regex literals, so `/"/ ` (a
    one-character-class regex containing a quote) was read as `/` followed
    by a string opening at `"` -- everything up to the *next* `"` (which
    could be inside a second, unrelated regex literal several lines later)
    was then treated as "inside a string" and passed through unstripped,
    including any genuine `//`-commented-out lines in between. A commented-
    out predicate bracketed by two such regex literals therefore looked
    untouched -- still textually present -- to every check below, even
    though at runtime it never executes. This version recognizes a regex
    literal via the standard division-vs-regex heuristic (see
    _looks_like_division) and skips over it as a single opaque token,
    exactly like a string, so the quote inside it can never be mistaken for
    a string delimiter."""
    out: list[str] = []
    i = 0
    n = len(text)
    in_str: str | None = None
    prev_sig = ""
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
                prev_sig = c
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
            prev_sig = ""
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            j = text.find("*/", i + 2)
            if j == -1:
                i = n
            else:
                out.append("\n" * text.count("\n", i, j + 2))
                i = j + 2
            prev_sig = ""
            continue
        if c == "/" and not _looks_like_division(prev_sig):
            end = _skip_regex_literal(text, i)
            if end is not None:
                out.append(text[i:end])
                prev_sig = "/"
                i = end
                continue
        out.append(c)
        if not c.isspace():
            prev_sig = c
        i += 1
    return "".join(out)


FBEVENTS_SRC_RE = re.compile(r"s\.src\s*=.*fbevents\.js")

# gh-1969 round 2 (cto32-review-pr1977-20260915.md): the exact guard block
# from js/meta-pixel-gate.js on origin/main today. If that file's guard
# ever changes on purpose, this constant must change with it, in the same
# commit -- that is the intended coupling, not a bug to route around.
CANONICAL_BLOCK_SRC = """\
var hash = window.location.hash;
var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
hash.indexOf('refresh_token') !== -1 ||
hash.indexOf('provider_token') !== -1;
if (urlHasAuthToken) {
return;
}"""


def _ws_tolerant_pattern(src: str) -> re.Pattern[str]:
    """Build a regex matching `src` exactly, token for token, tolerating
    only how much (or what kind of) whitespace separates each token --
    i.e. re-indenting or re-wrapping the canonical block still matches,
    but adding, removing, or altering any token does not."""
    tokens = src.split()
    return re.compile(r"\s+".join(re.escape(t) for t in tokens))


CANONICAL_BLOCK_RE = _ws_tolerant_pattern(CANONICAL_BLOCK_SRC)
REASSIGN_RE = re.compile(r"\burlHasAuthToken\s*=(?!=)")


def _scan_structure(text: str):
    """Walk *comment-stripped* JS text once (string- and regex-literal
    aware, same heuristic as strip_js_comments) and return three things
    indexed by character position (length len(text)+1, so a match's
    `.end()` can be queried too):

      depth_before[i] -- brace nesting depth just before text[i]. A `{`
                         or `}` inside a string or regex literal is walked
                         over, never counted.
      span_before[i]  -- an id naming which top-level (depth 0->1) block
                         text[i] is a direct descendant of (0 at depth 0).
                         Two positions share a span id only when they sit
                         inside the *same* outer function/block, however
                         deeply either is nested inside it -- this is how
                         the guard and the fbevents.js src line are
                         confirmed to be in the same gate IIFE rather than,
                         say, two different top-level IIFEs in the file.
      string_spans    -- (start, end) ranges covering each string literal
                         (quotes included), so a match found inside one
                         (predicate text pasted into a string) can be
                         excluded.
    """
    n = len(text)
    depth_before = [0] * (n + 1)
    span_before = [0] * (n + 1)
    string_spans: list[tuple[int, int]] = []
    depth = 0
    span_stack: list[int] = []
    next_span_id = 1
    in_str: str | None = None
    str_start = 0
    prev_sig = ""
    i = 0
    while i < n:
        depth_before[i] = depth
        span_before[i] = span_stack[-1] if span_stack else 0
        c = text[i]
        if in_str:
            if c == "\\" and i + 1 < n:
                i += 2
                continue
            if c == in_str:
                string_spans.append((str_start, i + 1))
                in_str = None
                prev_sig = c
            i += 1
            continue
        if c in ("'", '"', "`"):
            in_str = c
            str_start = i
            i += 1
            continue
        if c == "/" and not _looks_like_division(prev_sig):
            end = _skip_regex_literal(text, i)
            if end is not None:
                i = end
                prev_sig = "/"
                continue
        if c == "{":
            depth += 1
            if depth == 1:
                span_stack.append(next_span_id)
                next_span_id += 1
            i += 1
            prev_sig = c
            continue
        if c == "}":
            if depth == 1 and span_stack:
                span_stack.pop()
            depth = max(0, depth - 1)
            i += 1
            prev_sig = c
            continue
        if not c.isspace():
            prev_sig = c
        i += 1
    depth_before[n] = depth
    span_before[n] = span_stack[-1] if span_stack else 0
    return depth_before, span_before, string_spans


def check_meta_pixel_fragment_guard() -> list[str]:
    rel = META_PIXEL_GATE.relative_to(REPO).as_posix()
    if not META_PIXEL_GATE.is_file():
        return [f"{rel}: file missing"]
    raw_text = META_PIXEL_GATE.read_text(encoding="utf-8", errors="replace")
    text = strip_js_comments(raw_text)

    fb_match = FBEVENTS_SRC_RE.search(text)
    if fb_match is None:
        return [f"{rel}: fbevents.js script-src assignment not found -- cannot verify the "
                f"fragment predicate gates it"]
    fbevents_pos = fb_match.start()

    depth_before, span_before, string_spans = _scan_structure(text)

    def _inside_string(pos: int) -> bool:
        return any(s <= pos < e for s, e in string_spans)

    gate_span = span_before[fbevents_pos]
    valid_guards = [
        m for m in CANONICAL_BLOCK_RE.finditer(text)
        if not _inside_string(m.start())
        and depth_before[m.start()] == 1
        and span_before[m.start()] == gate_span
        and m.end() <= fbevents_pos
    ]
    if not valid_guards:
        return [f"{rel}: the token-fragment guard is not the exact canonical block this "
                f"checker requires (CANONICAL_BLOCK_SRC in scripts/check-gtag-single-source.py) "
                f"-- it must appear verbatim (whitespace aside), at the top level of the gate "
                f"IIFE with no enclosing conditional or wrapping function, in the same top-level "
                f"block as -- and strictly before -- the fbevents.js script-src assignment. If "
                f"js/meta-pixel-gate.js's guard changed on purpose, CANONICAL_BLOCK_SRC in this "
                f"checker must be updated deliberately alongside it (gh-1969) -- this failure "
                f"must not be silenced generically"]

    reassigned = [
        m for m in REASSIGN_RE.finditer(text)
        if not _inside_string(m.start())
        and not any(g.start() <= m.start() < g.end() for g in valid_guards)
    ]
    if reassigned:
        return [f"{rel}: urlHasAuthToken is assigned somewhere outside the canonical guard "
                f"block -- the gh-1969 fragment-guard predicate must not be reassigned anywhere "
                f"else in the file"]

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
# Self-test: planted fixtures proving this check catches every bypass shape
# found across both rounds of review (ceo47-review-pr1970-20260915.md and
# cto32-review-pr1977-20260915.md), plus a clean pass. Run with
# `--self-test`; does not touch the real repo.
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

GUARD_BLOCK = """\
  var hash = window.location.hash;
  var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
    hash.indexOf('refresh_token') !== -1 ||
    hash.indexOf('provider_token') !== -1;
  if (urlHasAuthToken) {
    return; // a live Supabase credential is in this URL; the pixel never loads.
  }
"""

assert GUARD_BLOCK in CLEAN_GATE  # keep the two literals in sync

FIXTURES: dict[str, tuple[str, int]] = {}


def _mk(name: str, gate_body: str, expect_exit: int) -> None:
    FIXTURES[name] = (gate_body, expect_exit)


# --- round 1 fixtures (ceo47-review-pr1970-20260915.md defect 1) -----------

_mk("clean", CLEAN_GATE, 0)

_mk("predicate_removed", CLEAN_GATE.replace(GUARD_BLOCK, ""), 1)

_mk(
    "commented_line",
    CLEAN_GATE.replace(
        GUARD_BLOCK,
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
        GUARD_BLOCK,
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
    CLEAN_GATE.replace("if (urlHasAuthToken) {", "if (false && urlHasAuthToken) {"),
    1,
)

_mk(
    "mention_only_predicate_removed",
    CLEAN_GATE.replace(
        GUARD_BLOCK,
        """  // NOTE: this gate used to check location.hash for access_token,
  // refresh_token and provider_token here. Do not remove -- gh-1969.
""",
    ),
    1,
)

# --- round 2 fixtures (cto32-review-pr1977-20260915.md defects 1-3) --------

_mk(
    "host_allowlist_moved_ifblock_deleted",
    CLEAN_GATE.replace(
        """  if (urlHasAuthToken) {
    return; // a live Supabase credential is in this URL; the pixel never loads.
  }
""",
        "",
    ),
    1,
)

_mk(
    "predicate_in_nested_function",
    CLEAN_GATE.replace(
        """  if (urlHasAuthToken) {
    return; // a live Supabase credential is in this URL; the pixel never loads.
  }
""",
        """  var maybeSkip = function () {
    if (urlHasAuthToken) {
      return;
    }
  };
  maybeSkip();
""",
    ),
    1,
)

_mk(
    "condition_swapped_debug_flag",
    CLEAN_GATE.replace("if (urlHasAuthToken) {", "if (window.__OQ_DEBUG_PIXEL) {"),
    1,
)

_mk(
    "wrapped_in_if_false",
    CLEAN_GATE.replace(
        GUARD_BLOCK,
        """  if (false) {
  var hash = window.location.hash;
  var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
    hash.indexOf('refresh_token') !== -1 ||
    hash.indexOf('provider_token') !== -1;
  if (urlHasAuthToken) {
    return;
  }
  }
""",
    ),
    1,
)

_mk(
    "reassigned_false_before_if",
    CLEAN_GATE.replace(
        "    hash.indexOf('provider_token') !== -1;\n  if (urlHasAuthToken) {",
        "    hash.indexOf('provider_token') !== -1;\n  urlHasAuthToken = false;\n  if (urlHasAuthToken) {",
    ),
    1,
)

_mk(
    "enabled_flag_and",
    CLEAN_GATE.replace(
        "if (urlHasAuthToken) {",
        "var enabled = false;\n  if (enabled && urlHasAuthToken) {",
    ),
    1,
)

_mk("inverted_bang", CLEAN_GATE.replace("if (urlHasAuthToken) {", "if (!urlHasAuthToken) {"), 1)

_mk(
    "hash_replaced_with_search",
    CLEAN_GATE.replace(
        "var hash = window.location.hash;", "var hash = window.location.search;"
    ),
    1,
)

_mk("not1_and", CLEAN_GATE.replace("if (urlHasAuthToken) {", "if (!1 && urlHasAuthToken) {"), 1)

_mk(
    "paren_false_and",
    CLEAN_GATE.replace("if (urlHasAuthToken) {", "if ((false) && urlHasAuthToken) {"),
    1,
)

_mk("null_and", CLEAN_GATE.replace("if (urlHasAuthToken) {", "if (null && urlHasAuthToken) {"), 1)

_mk(
    "predicate_in_string_literal",
    CLEAN_GATE.replace(
        GUARD_BLOCK,
        """  var legacyNote = "var hash = window.location.hash; var urlHasAuthToken = """
        """hash.indexOf('access_token') !== -1; if (urlHasAuthToken) { return; }";
""",
    ),
    1,
)

_mk(
    "commented_between_quote_bearing_regex_literals",
    CLEAN_GATE.replace(
        GUARD_BLOCK,
        """  var q1 = /"/;
  // var hash = window.location.hash;
  // var urlHasAuthToken = hash.indexOf('access_token') !== -1 ||
  //   hash.indexOf('refresh_token') !== -1 ||
  //   hash.indexOf('provider_token') !== -1;
  // if (urlHasAuthToken) {
  //   return;
  // }
  var q2 = /"/;
""",
    ),
    1,
)


def _self_test_strip_js_comments() -> int:
    """Unit-level checks on strip_js_comments itself, independent of the
    fixtures above -- these are the specific properties round 2's fix
    depends on."""
    failures = 0

    def check(label: str, condition: bool) -> None:
        nonlocal failures
        print(f"[self-test:strip_js_comments] {label}: {'OK' if condition else 'FAIL'}")
        if not condition:
            failures += 1

    src_url = "s.src = 'https://connect.facebook.net/en_US/fbevents.js'; // load it\n"
    stripped = strip_js_comments(src_url)
    check(
        "URL-in-string-literal preserved through comment stripping",
        "https://connect.facebook.net/en_US/fbevents.js" in stripped and "load it" not in stripped,
    )

    genuine_comment = "// this whole line is a comment\nvar x = 1;\n"
    check(
        "genuine // comment lines ARE stripped",
        "this whole line is a comment" not in strip_js_comments(genuine_comment)
        and "var x = 1;" in strip_js_comments(genuine_comment),
    )

    fooling_attempt = 'var q1 = /"/;\n// var real = "still code";\nvar q2 = /"/;\n'
    stripped_fooling = strip_js_comments(fooling_attempt)
    check(
        "quote-bearing regex literal does not fool string tracking into hiding a // comment",
        "still code" not in stripped_fooling and "var q1 = /\"/;" in stripped_fooling,
    )

    return 1 if failures else 0


def self_test() -> int:
    import tempfile

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

    failures += _self_test_strip_js_comments()

    return 1 if failures else 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    sys.exit(main())
