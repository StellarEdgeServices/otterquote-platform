#!/usr/bin/env python3
"""
Stage 5 prevention for gh-1964 (Clarity recording authenticated pages).

scripts/check-gtag-single-source.py enforces WHERE the Clarity loader lives
(js/ga-gate.js, and nowhere else). It says nothing about WHICH PAGES include
that gate -- and Microsoft Clarity was, correctly, the only place the loader
lived while still being included on 9 of 12 admin-*.html pages plus
contractor-profile.html, all authenticated surfaces, none of them masked.

This check closes that gap. It:

  (a) enumerates every *.html in the repo that includes js/ga-gate.js (or
      carries a Clarity loader directly -- clarity.ms/tag -- which would be
      a second, ungated copy that (a) alone must still catch);
  (b) classes each page AUTHENTICATED or UNAUTHENTICATED from evidence
      found IN THE FILE -- an Auth.requireAuth()/requireAuth(role) call, an
      admin-email/getSession-redirect gate, an Auth.getUser()+email-check
      admin gate, or equivalent -- never from the filename, and prints the
      table;
  (c) exits 1 if any AUTHENTICATED page's normalised path is on
      js/ga-gate.js's CLARITY_ALLOWED_PATHS allowlist, or if that allowlist
      gate is missing or neutered in js/ga-gate.js (comments stripped first,
      so a real removal cannot hide behind a comment still describing it;
      an `if (false && ...)`-style short-circuit counts as neutered, not
      present).

Exit codes:
  0 -- every allowlisted page is unauthenticated by in-file evidence, and
       the gate itself is present and live in js/ga-gate.js
  1 -- an authenticated page is on the allowlist, or the gate is
       absent/neutered (each printed as a named violation)
"""
from __future__ import annotations
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
GATE_FILE = REPO / "js" / "ga-gate.js"
SELF = pathlib.Path(__file__).resolve()
SKIP_DIR_NAMES = {"node_modules", ".git", ".next", "dist", "build", "coverage",
                  "playwright-report", "test-results"}

CLARITY_LOADER_RE = re.compile(r"ga-gate\.js|clarity\.ms/tag")

# ---------------------------------------------------------------------------
# Comment stripping (JS-ish: // line comments, /* */ block comments, string
# literals left alone so a URL or path inside a string is never eaten).
# ---------------------------------------------------------------------------

def strip_js_comments(src: str) -> str:
    out = []
    i, n = 0, len(src)
    in_block = in_line = False
    in_str = ""
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if in_block:
            if c == "*" and nxt == "/":
                in_block = False
                i += 2
                out.append("  ")
                continue
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue
        if in_line:
            if c == "\n":
                in_line = False
                out.append("\n")
            else:
                out.append(" ")
            i += 1
            continue
        if in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if c == in_str:
                in_str = ""
            i += 1
            continue
        if c == "/" and nxt == "*":
            in_block = True
            i += 2
            out.append("  ")
            continue
        if c == "/" and nxt == "/":
            in_line = True
            i += 2
            out.append("  ")
            continue
        if c in ("'", '"', "`"):
            in_str = c
            out.append(c)
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def strip_html_comments(src: str) -> str:
    return re.sub(r"<!--.*?-->", lambda m: " " * len(m.group(0)), src, flags=re.S)


# ---------------------------------------------------------------------------
# (a) enumerate pages that include a Clarity-carrying loader
# ---------------------------------------------------------------------------

def find_gated_pages() -> list[pathlib.Path]:
    out = []
    for path in REPO.rglob("*.html"):
        if any(part in SKIP_DIR_NAMES for part in path.relative_to(REPO).parts):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if CLARITY_LOADER_RE.search(strip_html_comments(text)):
            out.append(path)
    return sorted(out)


# ---------------------------------------------------------------------------
# (b) classify authenticated / unauthenticated from in-file evidence
# ---------------------------------------------------------------------------

AUTH_MARKERS: list[tuple[str, str]] = [
    (r"Auth\.requireAuth\s*\(", "Auth.requireAuth() call"),
    (r"\brequireAuth\s*\(\s*(['\"][A-Za-z]+['\"])?\s*\)", "requireAuth(role) call"),
    (r"onAuthStateChange[\s\S]{0,400}?isAdmin", "onAuthStateChange(...)+isAdmin gate"),
    (r"template_review_role\s*===\s*['\"]admin['\"]", "template_review_role==='admin' check"),
    (r"if\s*\(\s*!\s*session\s*\)\s*\{\s*window\.location\.href\s*=\s*['\"]/?login",
     "getSession() -> redirect-to-login on !session"),
    (r"session\.user\.email\s*!==\s*ADMIN_EMAIL", "session.user.email !== ADMIN_EMAIL gate"),
    (r"currentUser\.email\s*!==\s*['\"]dustinstohler1@gmail\.com['\"]",
     "currentUser.email !== admin-email gate"),
    (r"Auth\.getUser\s*\(\s*\)[\s\S]{0,300}?showUnauthorized",
     "Auth.getUser()+showUnauthorized() admin gate"),
    (r"You must be signed in", '"You must be signed in..." auth-error markup'),
    (r"reason=admin_required", "redirect with reason=admin_required"),
    (r"unauthorized-container|unauthorized-box", "unauthorized-* CSS/markup block"),
]


def classify(path: pathlib.Path) -> tuple[str, list[tuple[str, int]]]:
    raw = path.read_text(encoding="utf-8", errors="replace")
    clean = strip_js_comments(strip_html_comments(raw))
    hits = []
    for pat, label in AUTH_MARKERS:
        m = re.search(pat, clean)
        if m:
            line_no = clean.count("\n", 0, m.start()) + 1
            hits.append((label, line_no))
    return ("AUTH" if hits else "PUBLIC"), hits


def normalize_path(rel_posix: str) -> str:
    p = "/" + rel_posix
    if p.endswith(".html"):
        p = p[:-5]
    if p.endswith("/index"):
        p = p[: -len("/index")] or "/"
    return p


# ---------------------------------------------------------------------------
# (c) extract the live CLARITY_ALLOWED_PATHS allowlist + gate check from
#     js/ga-gate.js, with comments stripped and neutering detected
# ---------------------------------------------------------------------------

ARRAY_RE = re.compile(r"CLARITY_ALLOWED_PATHS\s*=\s*\[(.*?)\]", re.S)
ENTRY_RE = re.compile(r"""['"]([^'"]*)['"]""")
# The membership test's own argument nests function calls (e.g.
# `normalizeClarityPath(window.location.pathname)`), so this cannot be one
# flat `[^)]*` regex -- it is found in two stages by find_gate_check() below:
# an `.indexOf(` call whose nearby text contains `=== -1`, itself followed
# (within a short window, allowing for the `if (...) {` closer) by `return`.
INDEXOF_RE = re.compile(r"CLARITY_ALLOWED_PATHS\.indexOf\(")
EQUALS_NEG_ONE_RE = re.compile(r"===\s*-1")
RETURN_RE = re.compile(r"\breturn\b")
NEUTER_RE = re.compile(r"if\s*\(\s*false\b")
GATE_SEARCH_WINDOW = 400


def find_gate_check(clean: str) -> int | None:
    """Returns the char offset of a live `...indexOf(...) === -1) { ... return`
    page-set gate in comment-stripped source, or None if no such sequence
    exists. Matching is staged (indexOf call -> === -1 -> return, each within
    a short window of the last) rather than one flat regex, because the
    indexOf() argument itself nests function calls / parens."""
    pos = 0
    while True:
        m = INDEXOF_RE.search(clean, pos)
        if m is None:
            return None
        eq = EQUALS_NEG_ONE_RE.search(clean, m.end(), m.end() + GATE_SEARCH_WINDOW)
        if eq is not None:
            ret = RETURN_RE.search(clean, eq.end(), eq.end() + GATE_SEARCH_WINDOW)
            if ret is not None:
                return m.start()
        pos = m.end()


def extract_allowlist_and_gate_status(gate_src: str) -> tuple[list[str] | None, bool, list[str]]:
    """Returns (allowlist entries or None, gate_is_live, problems)."""
    clean = strip_js_comments(gate_src)
    problems: list[str] = []

    array_match = ARRAY_RE.search(clean)
    if array_match is None:
        problems.append("CLARITY_ALLOWED_PATHS array not found in js/ga-gate.js")
        entries = None
    else:
        entries = ENTRY_RE.findall(array_match.group(1))

    gate_pos = find_gate_check(clean)
    gate_present = gate_pos is not None
    if not gate_present:
        problems.append(
            "the CLARITY_ALLOWED_PATHS.indexOf(...) === -1 { ... return; } page-set gate "
            "is missing from js/ga-gate.js (comments stripped before matching)"
        )

    # Neutering check: an `if (false ...)` guard immediately wrapping the
    # gate itself means the gate's own short-circuit can never fire even
    # though the text is present, e.g.
    # `if (false && CLARITY_ALLOWED_PATHS.indexOf(...) === -1) { return; }`.
    neutered = False
    if gate_present:
        line_start = clean.rfind("\n", 0, gate_pos) + 1
        guard_line = clean[line_start:gate_pos + 40]
        if NEUTER_RE.search(guard_line):
            neutered = True
            problems.append(
                "the page-set gate's own `if (...)` has been neutered with `if (false` "
                "-- present in text but dead code"
            )

    gate_live = gate_present and not neutered
    return entries, gate_live, problems


def main() -> int:
    violations: list[str] = []

    if not GATE_FILE.is_file():
        print("check-clarity-page-gate: js/ga-gate.js is missing entirely")
        return 1
    gate_src = GATE_FILE.read_text(encoding="utf-8", errors="replace")
    allowlist, gate_live, gate_problems = extract_allowlist_and_gate_status(gate_src)
    violations.extend(gate_problems)
    allowlist_set = set(allowlist) if allowlist else set()

    pages = find_gated_pages()
    rows: list[tuple[str, str, str, list[tuple[str, int]]]] = []
    for path in pages:
        rel = path.relative_to(REPO).as_posix()
        cls, hits = classify(path)
        norm = normalize_path(rel)
        rows.append((rel, norm, cls, hits))
        if cls == "AUTH" and norm in allowlist_set:
            violations.append(
                f"{rel}: classified AUTHENTICATED ({hits[0][0]}@L{hits[0][1]}) but its "
                f"normalised path {norm!r} is on js/ga-gate.js's CLARITY_ALLOWED_PATHS -- "
                f"Clarity would load on an authenticated page"
            )
    if not gate_live and pages:
        # A missing/neutered gate means every allowlist entry is moot -- ALL
        # pages effectively load Clarity unconditionally (subject only to
        # the host/token checks). That is a violation regardless of what the
        # (dead) allowlist text says.
        auth_pages = [r for r in rows if r[2] == "AUTH"]
        if auth_pages:
            violations.append(
                f"page-set gate is absent/neutered in js/ga-gate.js -- {len(auth_pages)} "
                f"authenticated page(s) that include the loader would receive Clarity "
                f"unconditionally"
            )

    print(f"check-clarity-page-gate: {len(rows)} page(s) include a Clarity-carrying loader")
    print(f"{'CLASS':8s} {'PATH':55s} {'NORMALISED':30s} EVIDENCE")
    for rel, norm, cls, hits in rows:
        evidence = "; ".join(f"{lbl}@L{ln}" for lbl, ln in hits) if hits else "-"
        print(f"{cls:8s} {rel:55s} {norm:30s} {evidence}")
    print()

    if violations:
        print(f"check-clarity-page-gate: {len(violations)} violation(s):")
        for v in violations:
            print("  - " + v)
        return 1

    print("check-clarity-page-gate: OK -- no authenticated page is on the Clarity "
          "allowlist, and the page-set gate is present and live in js/ga-gate.js")
    return 0


if __name__ == "__main__":
    sys.exit(main())
