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
  (b) classes each page AUTHENTICATED / SESSION-TOUCHING / PUBLIC from
      evidence found IN THE FILE, never from the filename, and prints the
      table;
  (c) exits 1 if any AUTHENTICATED page's normalised path is on
      js/ga-gate.js's CLARITY_ALLOWED_PATHS allowlist, or if any
      SESSION-TOUCHING page is on that allowlist without an explicit,
      reviewed exception, or if the allowlist gate itself is missing,
      neutered, mis-positioned, or structurally altered in js/ga-gate.js.

gh-1964 PR #1978 refuter review (cto32-review-pr1978-20260915.md, D1/D2/D3)
found three defects this revision fixes:

  D1 -- the classifier was default-PUBLIC (fail-open): a page with no
        AUTH_MARKERS hit was called PUBLIC even if it read a live session
        (contractor-pre-approval.html calls `window.Auth.getSession()`,
        loads the signed-in contractor's own DB row, and collects insurance/
        license uploads -- none of AUTH_MARKERS' patterns happened to match
        its particular `if (!session) { ...; showPanel('error'); return; }`
        shape, so it was classed PUBLIC and shipped on the allowlist). Fixed
        two ways: (1) a new AUTH_MARKERS entry for exactly this
        getSession()+!session-guard shape, so this specific page is now
        correctly classed AUTHENTICATED outright, and its '/contractor-pre-
        approval' entry is removed from js/ga-gate.js's allowlist; (2) the
        classifier is now default-DENY at the SESSION layer underneath that:
        a broader SESSION_MARKERS set (Auth.getSession/getUser,
        supabase.auth.*, onAuthStateChange, requireAuth/requireAdmin, any
        Auth.* call, a sb.from(...) read keyed to the signed-in user's own
        id) means ANY page that touches a session at all and sits on the
        allowlist is now a violation, UNLESS that specific page is listed in
        SESSION_AWARE_PUBLIC below with a one-line, human-reviewed reason
        (e.g. "only bounces an already-signed-in visitor away; renders no
        session data to an anonymous one"). A page is PUBLIC now only if it
        touches no session/auth call at all, or is in SESSION_AWARE_PUBLIC
        (session-touching but reviewed-safe) or PUBLIC_PAGES (an AUTH_MARKERS
        hit judged, on review, to be a false positive). Both override sets
        are reviewed, commented, and empty by default -- a page lands in one
        only because a human read it and wrote why, never automatically.
  D2 -- the Detector Negative Control Gate (.github/workflows/
        detector-negative-control.yml, gh-1738/gh-1841) requires a sibling
        scripts/check-clarity-page-gate.test.py that runs clean and reports
        at least one PASS/FAIL assertion. This script also grew a
        `--self-test` mode with its own planted-fixture suite; the sibling
        test file simply invokes it (see check-clarity-page-gate.test.py).
  D3 -- find_gate_check() used to be a loose, three-stage token search
        within a fixed character window (`.indexOf(` -> `=== -1` -> a nearby
        `return`), which a determined refuter proved exits 0 against eleven
        different bypasses: `if (0 && ...)`, `... === -1 && false`, `if
        (false)` wrapping the gate one line above it, moving the gate after
        the Clarity <script> injection, hiding the gate text inside a string
        literal or an uncalled function, a normalizer that always returns
        '/' or a hardcoded pathname, `=== -1 - 1`, and a stray regex literal
        (`var rx = /'/g;`) that desyncs the old comment-stripper's quote
        tracking so a REAL `//`-commented-out gate reads back as "present."
        This revision replaces that loose search with a structural check:
        (1) a real JS tokenizer that understands block/line comments, string
        literals AND regex literals (so a quote inside a regex literal can
        no longer desync string tracking); (2) the gate's own
        `if (CLARITY_ALLOWED_PATHS.indexOf(normalizeClarityPath(window.
        location.pathname)) === -1) { return; }` must appear as an exact,
        whitespace-normalised canonical block (any inserted token --
        `0 &&`, `false &&`, `!1 &&`, `null &&`, a changed operator --
        breaks the match); (3) it must appear at brace depth 1 of the
        outer loader IIFE (not nested inside `if (false) { ... }`, not
        inside a never-called helper function, not inside a string, since
        all three blank to nothing/wrong-depth under the tokenizer); (4) it
        must appear BEFORE the Clarity vendor snippet's own IIFE call in
        file order; (5) normalizeClarityPath's function body must equal its
        own canonical form exactly (whitespace-normalised) -- a normalizer
        that always returns '/' or some other hardcoded pathname no longer
        matches and is reported as a deviation, not silently trusted. Any
        legitimate, deliberate change to the gate or the normalizer must
        update the canonical text in THIS script in the same commit -- that
        is the point: a tolerant regex that keeps losing to bypasses is the
        wrong design, per the brief that ordered this revision.

Exit codes:
  0 -- every allowlisted page is unauthenticated-and-session-clean by
       in-file evidence (or explicitly reviewed as an exception), and the
       gate itself is present, live, and structurally canonical in
       js/ga-gate.js
  1 -- an authenticated or unreviewed session-touching page is on the
       allowlist, or the gate/normalizer is absent/neutered/mis-positioned/
       non-canonical (each printed as a named violation)

USAGE
    python3 scripts/check-clarity-page-gate.py
    python3 scripts/check-clarity-page-gate.py --root PATH   # point at a
                                                              # different tree
                                                              # (self-tests)
    python3 scripts/check-clarity-page-gate.py --self-test   # run this
                                                              # script's own
                                                              # planted-fixture
                                                              # suite instead
                                                              # of checking a
                                                              # real repo
"""
from __future__ import annotations
import pathlib
import html.parser
import re
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
SKIP_DIR_NAMES = {"node_modules", ".git", ".next", "dist", "build", "coverage",
                  "playwright-report", "test-results"}

CLARITY_LOADER_RE = re.compile(r"ga-gate\.js|clarity\.ms/tag")

# ---------------------------------------------------------------------------
# JS tokenizer: strips block/line comments always; strips string-literal and
# regex-literal CONTENTS only when keep_strings=False. Output is the same
# length as the input (removed spans become spaces, newlines preserved), so
# offsets found in one view line up exactly with the other view and with the
# original source -- load-bearing for the brace-depth/position checks below,
# which are computed on the no-strings view but sliced back out of the
# keep-strings view at the SAME offsets.
#
# Regex-literal awareness is what D3 needed and the old strip_js_comments()
# lacked: without it, `var rx = /'/g;` earlier in the file leaves the naive
# stripper's quote-tracking permanently desynced (it reads the `'` inside the
# regex literal as opening an unterminated string), so a REAL `//`-commented-
# out gate later in the file is never recognised as a comment and reads back
# as "present." The heuristic below (an operand -- identifier char, digit,
# `)`, `]`, quote -- immediately before a `/` means division, not a regex
# literal) is the standard, good-enough disambiguation for this purpose; a
# full JS grammar is not needed to defeat the one bypass this exists for.
# ---------------------------------------------------------------------------

_NOT_REGEX_START_AFTER = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$)]\"'`"
)


def _regex_allowed(prev_sig: str) -> bool:
    if not prev_sig:
        return True
    return prev_sig not in _NOT_REGEX_START_AFTER


def tokenize_js(src: str, keep_strings: bool) -> str:
    out: list[str] = []
    i, n = 0, len(src)
    prev_sig = ""
    while i < n:
        c = src[i]
        nxt = src[i + 1] if i + 1 < n else ""

        # block comment
        if c == "/" and nxt == "*":
            out.append("  ")  # the opening "/*" itself
            i += 2
            while i < n and not (src[i] == "*" and i + 1 < n and src[i + 1] == "/"):
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            if i < n:
                out.append("  ")  # the closing "*/" itself
                i += 2
            continue

        # line comment
        if c == "/" and nxt == "/":
            out.append("  ")  # the opening "//" itself
            i += 2
            while i < n and src[i] != "\n":
                out.append(" ")
                i += 1
            continue

        # string literal
        if c in ("'", '"', "`"):
            quote = c
            start = i
            i += 1
            while i < n:
                if src[i] == "\\" and i + 1 < n:
                    i += 2
                    continue
                if src[i] == quote:
                    i += 1
                    break
                i += 1
            raw = src[start:i]
            if keep_strings:
                out.append(raw)
            else:
                out.append("".join("\n" if ch == "\n" else " " for ch in raw))
            prev_sig = "x"  # an operand -- next `/` is division, not regex
            i = i
            continue

        # regex literal (only where a regex could legally start)
        if c == "/" and _regex_allowed(prev_sig):
            start = i
            j = i + 1
            in_class = False
            closed = False
            while j < n:
                ch = src[j]
                if ch == "\\" and j + 1 < n:
                    j += 2
                    continue
                if ch == "\n":
                    break  # unterminated on this line -- not a regex, bail
                if ch == "[":
                    in_class = True
                elif ch == "]":
                    in_class = False
                elif ch == "/" and not in_class:
                    j += 1
                    closed = True
                    break
                j += 1
            if closed:
                while j < n and src[j].isalpha():
                    j += 1
                raw = src[start:j]
                out.append("".join("\n" if ch == "\n" else " " for ch in raw))
                prev_sig = "x"
                i = j
                continue
            # not actually a regex literal -- fall through, treat `/` plainly

        out.append(c)
        if not c.isspace():
            prev_sig = c
        i += 1
    return "".join(out)


def strip_html_comments(src: str) -> str:
    return re.sub(r"<!--.*?-->", lambda m: " " * len(m.group(0)), src, flags=re.S)


# ---------------------------------------------------------------------------
# (a) enumerate pages that include a Clarity-carrying loader
# ---------------------------------------------------------------------------

def find_gated_pages(root: pathlib.Path) -> list[pathlib.Path]:
    out = []
    for path in root.rglob("*.html"):
        if any(part in SKIP_DIR_NAMES for part in path.relative_to(root).parts):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if CLARITY_LOADER_RE.search(strip_html_comments(text)):
            out.append(path)
    return sorted(out)


# ---------------------------------------------------------------------------
# (b) classify authenticated / session-touching / public from in-file
#     evidence, fail-closed (gh-1964 D1 fix)
# ---------------------------------------------------------------------------

# An explicit auth-GATE: the page itself refuses to render/continue for a
# signed-out (or wrong-role) visitor. Hitting one of these classes a page
# AUTHENTICATED outright, regardless of allowlist status.
AUTH_MARKERS: list[tuple[str, str]] = [
    (r"Auth\.requireAuth\s*\(", "Auth.requireAuth() call"),
    (r"\brequireAuth\s*\(\s*(['\"][A-Za-z]+['\"])?\s*\)", "requireAuth(role) call"),
    (r"onAuthStateChange[\s\S]{0,400}?isAdmin", "onAuthStateChange(...)+isAdmin gate"),
    (r"template_review_role\s*===\s*['\"]admin['\"]", "template_review_role==='admin' check"),
    (r"if\s*\(\s*!\s*session\s*\)\s*\{\s*window\.location\.href\s*=\s*['\"]/?login",
     "getSession() -> redirect-to-login on !session"),
    # gh-1964 PR #1978 D1 fix: contractor-pre-approval.html's own guard shape
    # (`const session = await window.Auth.getSession(); if (!session) { ...;
    # showPanel('error'); return; }`) hit none of the patterns above -- it
    # neither redirects to /login nor names a role -- so the page classed
    # PUBLIC despite requiring a live session to render anything, load the
    # contractor's own DB row, or accept insurance/license uploads.
    (r"if\s*\(\s*!\s*session\s*\)\s*\{[\s\S]{0,250}?showPanel\(\s*['\"]error['\"]",
     "Auth.getSession() + !session -> showPanel('error') guard"),
    (r"session\.user\.email\s*!==\s*ADMIN_EMAIL", "session.user.email !== ADMIN_EMAIL gate"),
    (r"currentUser\.email\s*!==\s*['\"]dustinstohler1@gmail\.com['\"]",
     "currentUser.email !== admin-email gate"),
    (r"Auth\.getUser\s*\(\s*\)[\s\S]{0,300}?showUnauthorized",
     "Auth.getUser()+showUnauthorized() admin gate"),
    (r"You must be signed in", '"You must be signed in..." auth-error markup'),
    (r"reason=admin_required", "redirect with reason=admin_required"),
    (r"unauthorized-container|unauthorized-box", "unauthorized-* CSS/markup block"),
]

# gh-1964 PR #1978 D1 fix: ANY session/auth touch at all, not just an
# explicit gate. Fail-closed underneath AUTH_MARKERS -- a page that reads a
# session, resolves the signed-in user, or reads a table row keyed to that
# user is SESSION-classed by default, and a SESSION-classed page cannot sit
# on the Clarity allowlist unless a human reviewed it and named it in
# SESSION_AWARE_PUBLIC below. This is deliberately broader than AUTH_MARKERS
# and deliberately over-inclusive (a page merely INITIATING sign-in, e.g.
# Auth.signInWithGoogle() on a public join form, also matches "Auth.* call")
# -- see SESSION_AWARE_PUBLIC's own comment for why that is the safe
# direction to err in.
SESSION_MARKERS: list[tuple[str, str]] = [
    (r"Auth\.getSession\s*\(", "Auth.getSession() call"),
    (r"Auth\.getUser\s*\(", "Auth.getUser() call"),
    (r"supabase\.auth\.getSession\s*\(", "supabase.auth.getSession() call"),
    (r"supabase\.auth\.getUser\s*\(", "supabase.auth.getUser() call"),
    (r"\bsb\.auth\.getSession\s*\(", "sb.auth.getSession() call"),
    (r"\bsb\.auth\.getUser\s*\(", "sb.auth.getUser() call"),
    (r"onAuthStateChange\s*\(", "onAuthStateChange() call"),
    (r"\brequireAuth\s*\(", "requireAuth() call"),
    (r"\brequireAdmin\s*\(", "requireAdmin() call"),
    (r"hasPartnerSession", "hasPartnerSession() call"),
    (r"Auth\.\w+\s*\(", "Auth.* call (session/auth helper)"),
    (r"\bsb\.from\([^)]*\)[\s\S]{0,250}?\.eq\(\s*['\"]user_id['\"]",
     "sb.from(...).eq('user_id', ...) user-scoped read"),
    (r"\bsb\.from\([^)]*\)[\s\S]{0,250}?currentUser\.id",
     "sb.from(...) read keyed to currentUser.id"),
]

# Reviewed, one-line-reasoned exception list: a page whose normalised path is
# HERE is SESSION-classed (it does touch a session/auth call) but has been
# read and judged safe to keep on the Clarity allowlist, because it never
# renders session-scoped data to an anonymous visitor -- it only (a) bounces
# an ALREADY-signed-in visitor away to their real dashboard, (b) initiates a
# sign-in/sign-up action without reading any existing session data back, or
# (c) resolves a user's own PUBLIC referral code for the page's own public
# purpose. Every entry traces to a quoted line, matching the PR #1978
# refuter's own per-page judgement (report cto32-review-pr1978-20260915.md,
# "Pages checked and judged not blocking").
SESSION_AWARE_PUBLIC: dict[str, str] = {
    "/contractor-join": "Auth.ready()/Auth.signInWithGoogle() only initiate OAuth "
                         "sign-up; no existing session is read or rendered "
                         "(contractor-join.html:392-409).",
    "/contractor-login": "Auth.getUser() only bounces an ALREADY-signed-in "
                          "contractor to their dashboard (with a loop-guard for "
                          "the dashboard<->login bounce); a signed-out visitor "
                          "sees only the login form (contractor-login.html:471-478).",
    "/partner-adjusters": "hasPartnerSession() only redirects an ALREADY-signed-in "
                           "partner to partner-dashboard.html; renders no "
                           "session-scoped data to an anonymous visitor "
                           "(partner-adjusters.html:1085).",
    "/partner-app": "hasPartnerSession() only redirects an ALREADY-signed-in "
                    "partner to partner-dashboard.html; same pattern as "
                    "partner-adjusters.html (partner-app.html:313).",
    "/partner-inspectors": "hasPartnerSession() only redirects an ALREADY-signed-in "
                           "partner to partner-dashboard.html; same pattern as "
                           "partner-adjusters.html (partner-inspectors.html:1038).",
    "/partner-insurance": "post-OAuth signup finisher: Auth.getUser()/"
                          "onAuthStateChange() only complete the signup redirect "
                          "to partner-dashboard.html; a live token, if present, "
                          "arrives in the URL fragment where the gh-1931 check "
                          "already blocks Clarity (partner-insurance.html:978, "
                          "1159, 1237).",
    "/partner-login": "Auth.getUser() only bounces an ALREADY-signed-in partner "
                       "to their dashboard, same pattern as contractor-login.html "
                       "(partner-login.html:453).",
    "/partner-other": "hasPartnerSession() only redirects an ALREADY-signed-in "
                      "partner to partner-dashboard.html; same pattern as "
                      "partner-adjusters.html (partner-other.html:1064).",
    "/partner-re": "hasPartnerSession() only redirects an ALREADY-signed-in partner "
                   "to partner-dashboard.html; same pattern as "
                   "partner-adjusters.html (partner-re.html:1341).",
    "/ref-insurance": "Auth.getUser()/hasPartnerSession() only bounces an "
                      "ALREADY-signed-in partner away from the anonymous "
                      "referral-code lookup flow (ref-insurance.html:864-902).",
    # gh-2150 round 2 (REVIEW FAIL 5836233175/5836199486, Ben ruling (3),
    # S12 -- js/ga-gate.js CLARITY_ALLOWED_PATHS change made in the same
    # commit): RE-1/INS-1/HI-1 (D-333) are dedicated single-purpose funnel
    # landing pages, same PUBLIC pattern as partner-re/-inspectors/-other
    # above -- hasPartnerSession() only redirects an ALREADY-signed-in
    # partner to partner-dashboard.html; renders no session-scoped data to
    # an anonymous visitor.
    "/re-1": "hasPartnerSession() only redirects an ALREADY-signed-in partner "
             "to partner-dashboard.html; same pattern as "
             "partner-adjusters.html (re-1.html).",
    "/ins-1": "hasPartnerSession() only redirects an ALREADY-signed-in "
              "partner to partner-dashboard.html; same pattern as "
              "partner-adjusters.html (ins-1.html).",
    "/hi-1": "hasPartnerSession() only redirects an ALREADY-signed-in "
             "partner to partner-dashboard.html; same pattern as "
             "partner-adjusters.html (hi-1.html).",
}

# Reviewed, one-line-reasoned override for the OTHER direction: a page that
# hits an AUTH_MARKERS pattern (an apparent explicit gate) but has been read
# and judged, on review, to be a false positive -- e.g. the marker text
# appears in a code path that never actually withholds content from an
# anonymous visitor. Empty today: no current AUTH_MARKERS hit in this repo
# has been judged a false positive. Present as a mechanism, not a default --
# adding an entry here requires the same one-line, quoted-evidence review
# discipline as SESSION_AWARE_PUBLIC above, never a bare path with no reason.
PUBLIC_PAGES: dict[str, str] = {}

# gh-1939 SCOPE EXTENSION -- the ONE reviewed door for an AUTHENTICATED page
# onto the Clarity allowlist. Dustin, 2026-09-16, #1939 comment 5691693161,
# verbatim selected option: "Funnel to bid accept (Recommended)" -- "React
# /trade-selector, project-info (cash/RCV/ACV), repair-intake, dashboard,
# bids, contractor-about. Fields masked. Excluded: contract-signing (the
# signing ceremony), auth-callback, admin, contractor and partner pages."
# An entry here is NOT enough on its own: the page's <body> tag must also
# carry data-clarity-mask="true" (BODY_MASK_RE), or the check fails. Adding a
# path requires a new Dustin ruling quoted in its reason -- never an
# engineering judgement.
RULED_AUTHENTICATED_ALLOWED: dict[str, str] = {
    "/dashboard": "homeowner dashboard -- Dustin ruling #1939 c.5691693161",
    "/bids": "homeowner bid review + accept -- Dustin ruling #1939 c.5691693161",
    "/contractor-about": "contractor profile + 'Select This Contractor' (second award path) -- Dustin ruling #1939 c.5691693161",
    "/project-info-cash": "post-trade-selector intake (cash) -- Dustin ruling #1939 c.5691693161",
    "/project-info-rcv": "post-trade-selector intake (RCV) -- Dustin ruling #1939 c.5691693161",
    "/project-info-acv": "post-trade-selector intake (ACV) -- Dustin ruling #1939 c.5691693161",
    "/repair-intake": "repair intake + photo upload -- Dustin ruling #1939 c.5691693161",
}

class _BodyMaskParser(html.parser.HTMLParser):
    """gh-1939 review finding 2: find the FIRST real <body> start tag -- not a
    string inside <script>, not inside <template>/<noscript>, not a custom
    element like <body-x> -- and every data-clarity-unmask anywhere."""

    RAW_SKIP = {"script", "style", "template", "noscript"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip_depth = 0
        self.body_attrs: dict[str, str] | None = None
        self.unmask_tags: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if "data-clarity-unmask" in a:
            self.unmask_tags.append(tag)
        if tag in self.RAW_SKIP:
            self.skip_depth += 1
            return
        if tag == "body" and self.skip_depth == 0 and self.body_attrs is None:
            self.body_attrs = a

    def handle_endtag(self, tag):
        if tag in self.RAW_SKIP and self.skip_depth > 0:
            self.skip_depth -= 1


def body_mask_problem(path: pathlib.Path) -> str | None:
    """None when the page's real <body> carries data-clarity-mask="true" and
    nothing on the page carries data-clarity-unmask; else the reason."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    p = _BodyMaskParser()
    p.feed(raw)
    p.close()
    if p.body_attrs is None:
        return "no real <body> start tag found"
    if p.body_attrs.get("data-clarity-mask", "").strip().lower() != "true":
        return "its real <body> lacks data-clarity-mask=\"true\""
    if p.unmask_tags:
        return f"it carries data-clarity-unmask on <{p.unmask_tags[0]}>, re-exposing a subtree"
    return None


def classify(path: pathlib.Path) -> tuple[str, list[tuple[str, int]], list[tuple[str, int]]]:
    """Returns (class, auth_hits, session_hits). class is one of AUTH,
    SESSION, PUBLIC. AUTH_MARKERS is checked first (an explicit gate is
    always AUTHENTICATED); SESSION_MARKERS is checked underneath it
    (fail-closed default -- gh-1964 D1)."""
    raw = path.read_text(encoding="utf-8", errors="replace")
    clean = tokenize_js(strip_html_comments(raw), keep_strings=True)
    auth_hits = []
    for pat, label in AUTH_MARKERS:
        m = re.search(pat, clean)
        if m:
            line_no = clean.count("\n", 0, m.start()) + 1
            auth_hits.append((label, line_no))
    session_hits = []
    for pat, label in SESSION_MARKERS:
        m = re.search(pat, clean)
        if m:
            line_no = clean.count("\n", 0, m.start()) + 1
            session_hits.append((label, line_no))
    if auth_hits:
        cls = "AUTH"
    elif session_hits:
        cls = "SESSION"
    else:
        cls = "PUBLIC"
    return cls, auth_hits, session_hits


def normalize_path(rel_posix: str) -> str:
    p = "/" + rel_posix
    if p.endswith(".html"):
        p = p[:-5]
    if p.endswith("/index"):
        p = p[: -len("/index")] or "/"
    return p


# ---------------------------------------------------------------------------
# (c) structural check of js/ga-gate.js: the allowlist array, the page-set
#     gate (exact canonical block, at IIFE top level, before the Clarity
#     injection), and the normalizer's canonical body.
# ---------------------------------------------------------------------------

ARRAY_RE = re.compile(r"CLARITY_ALLOWED_PATHS\s*=\s*\[(.*?)\]", re.S)
ENTRY_RE = re.compile(r"""['"]([^'"]*)['"]""")

OUTER_IIFE_RE = re.compile(r"\(\s*function\s*\(\s*\)\s*\{")
CLARITY_INJECTION_ANCHOR_RE = re.compile(
    r"\(\s*function\s*\(\s*c\s*,\s*l\s*,\s*a\s*,\s*r\s*,\s*i\s*,\s*t\s*,\s*y\s*\)\s*\{"
)
NORMALIZER_SIG_RE = re.compile(r"function\s+normalizeClarityPath\s*\(\s*pathname\s*\)\s*\{")


def _ws_pattern(canonical_single_line: str) -> re.Pattern:
    """Builds a regex requiring the exact token sequence of
    `canonical_single_line` (split on literal single spaces), each token
    separated by >=1 real whitespace char -- i.e. an exact block modulo how
    much whitespace/indentation separates its tokens, and nothing else
    inserted between them."""
    tokens = [t for t in canonical_single_line.split(" ") if t]
    return re.compile(r"\s+".join(re.escape(t) for t in tokens))


CANONICAL_GATE_LINE = (
    "if (CLARITY_ALLOWED_PATHS.indexOf(normalizeClarityPath(window.location.pathname)) "
    "=== -1) { return; }"
)
GATE_PATTERN = _ws_pattern(CANONICAL_GATE_LINE)

CANONICAL_NORMALIZER_BODY = (
    "{ var p = pathname; "
    "if (p.length > 1 && p.charAt(p.length - 1) === '/') { p = p.slice(0, -1); } "
    "if (p.slice(-5) === '.html') { p = p.slice(0, -5); } "
    "if (p === '') { p = '/'; } "
    "if (p.slice(-6) === '/index') { p = p.slice(0, -6); if (p === '') { p = '/'; } } "
    "return p; }"
)


def _matching_brace(no_strings: str, open_pos: int) -> int | None:
    """no_strings[open_pos] must be '{'. Returns the offset of its matching
    '}' by simple depth counting over a view where string/regex/comment
    interiors are already blanked (so no fake braces from literal text)."""
    assert no_strings[open_pos] == "{"
    depth = 0
    i = open_pos
    n = len(no_strings)
    while i < n:
        if no_strings[i] == "{":
            depth += 1
        elif no_strings[i] == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


def _brace_depth_at(no_strings: str, pos: int, outer_open: int) -> int:
    """Depth of `pos` relative to outer_open (a '{' at depth 0 -> contents at
    depth 1), counting only real braces (no_strings has strings/regexes/
    comments already blanked)."""
    depth = 0
    for ch in no_strings[outer_open:pos]:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
    return depth


def analyze_gate_file(gate_src: str) -> tuple[list[str] | None, bool, list[str]]:
    """Returns (allowlist entries or None, gate_is_live_and_canonical, problems)."""
    problems: list[str] = []

    # comments-stripped, strings kept -- for reading the actual allowlist
    # path entries and the normalizer's real body text.
    with_strings = tokenize_js(gate_src, keep_strings=True)
    # comments AND strings AND regex-literal interiors blanked -- for
    # position/depth/canonical-token structural checks, where a bypass
    # hiding gate text inside a string or a regex literal must find nothing.
    no_strings = tokenize_js(gate_src, keep_strings=False)
    assert len(with_strings) == len(no_strings) == len(gate_src)

    array_match = ARRAY_RE.search(with_strings)
    if array_match is None:
        problems.append("CLARITY_ALLOWED_PATHS array not found in js/ga-gate.js")
        entries = None
    else:
        entries = ENTRY_RE.findall(array_match.group(1))

    outer_match = OUTER_IIFE_RE.search(no_strings)
    if outer_match is None:
        problems.append("the outer `(function () { ... })();` loader IIFE was not found "
                         "in js/ga-gate.js -- cannot verify the gate's position")
        return entries, False, problems
    outer_open = outer_match.end() - 1  # offset of the IIFE's own '{'

    gate_match = GATE_PATTERN.search(no_strings)
    gate_present = gate_match is not None
    gate_depth_ok = False
    if gate_present:
        gate_depth_ok = _brace_depth_at(no_strings, gate_match.start(), outer_open) == 1

    if not gate_present:
        problems.append(
            "the exact canonical page-set gate -- "
            "`if (CLARITY_ALLOWED_PATHS.indexOf(normalizeClarityPath(window.location."
            "pathname)) === -1) { return; }` (whitespace-normalised) -- was not found "
            "in js/ga-gate.js. It is missing, commented out, or altered (an inserted "
            "token such as `0 &&`, `false &&`, `!1 &&`, `null &&`, or a changed "
            "operator all break this exact match by design -- update this script's "
            "CANONICAL_GATE_LINE deliberately if the gate's real logic changed)."
        )
    elif not gate_depth_ok:
        problems.append(
            "the page-set gate's exact text was found in js/ga-gate.js, but not at "
            "the top level of the outer loader IIFE (depth check failed) -- it is "
            "nested inside another block (e.g. `if (false) { ... }` wrapping it, or "
            "an uncalled helper function), so it either never runs or runs "
            "conditionally on something other than the allowlist check itself."
        )

    injection_match = CLARITY_INJECTION_ANCHOR_RE.search(no_strings)
    if injection_match is None:
        problems.append(
            "the Clarity vendor snippet's own IIFE call "
            "(`(function (c, l, a, r, i, t, y) { ... }`) was not found in "
            "js/ga-gate.js -- cannot verify the gate runs before it"
        )
    elif gate_present and gate_match.start() >= injection_match.start():
        problems.append(
            "the page-set gate was found AFTER the Clarity vendor snippet's "
            "injection point in js/ga-gate.js -- the loader has already run by "
            "the time the gate's `return` could stop it, so the allowlist check "
            "is not actually gating the load"
        )

    normalizer_ok = False
    sig_match = NORMALIZER_SIG_RE.search(no_strings)
    if sig_match is None:
        problems.append("function normalizeClarityPath(pathname) was not found in "
                         "js/ga-gate.js")
    else:
        brace_pos = no_strings.index("{", sig_match.end() - 1)
        end = _matching_brace(no_strings, brace_pos)
        if end is None:
            problems.append("normalizeClarityPath's body has unbalanced braces in "
                             "js/ga-gate.js -- cannot verify its canonical form")
        else:
            body_with_strings = with_strings[brace_pos:end + 1]
            body_norm = re.sub(r"\s+", " ", body_with_strings).strip()
            canonical_norm = re.sub(r"\s+", " ", CANONICAL_NORMALIZER_BODY).strip()
            if body_norm == canonical_norm:
                normalizer_ok = True
            else:
                problems.append(
                    "normalizeClarityPath's body no longer matches its canonical form "
                    "(whitespace-normalised exact comparison) -- a normalizer that "
                    "always returns '/' or some other hardcoded pathname, or that "
                    "otherwise deviates, is not trusted. If this function's real logic "
                    "changed deliberately, update CANONICAL_NORMALIZER_BODY in this "
                    "script in the same commit."
                )

    gate_live = gate_present and gate_depth_ok and normalizer_ok and (
        injection_match is not None and gate_present and gate_match.start() < injection_match.start()
    )
    return entries, gate_live, problems


def main_check(root: pathlib.Path, ruled: dict[str, str] | None = None) -> tuple[int, str]:
    ruled = RULED_AUTHENTICATED_ALLOWED if ruled is None else ruled
    lines: list[str] = []
    violations: list[str] = []

    gate_file = root / "js" / "ga-gate.js"
    if not gate_file.is_file():
        return 1, "check-clarity-page-gate: js/ga-gate.js is missing entirely\n"

    gate_src = gate_file.read_text(encoding="utf-8", errors="replace")
    allowlist, gate_live, gate_problems = analyze_gate_file(gate_src)
    violations.extend(gate_problems)
    allowlist_set = set(allowlist) if allowlist else set()

    pages = find_gated_pages(root)
    rows: list[tuple[str, str, str, list[tuple[str, int]], list[tuple[str, int]]]] = []
    for path in pages:
        rel = path.relative_to(root).as_posix()
        cls, auth_hits, session_hits = classify(path)
        norm = normalize_path(rel)

        if cls == "AUTH" and norm in PUBLIC_PAGES:
            cls = "SESSION" if session_hits else "PUBLIC"

        rows.append((rel, norm, cls, auth_hits, session_hits))

        if cls in ("AUTH", "SESSION") and norm in allowlist_set and norm in ruled:
            # gh-1939: Dustin-ruled authenticated page -- allowed ONLY with a
            # masked <body>; the row is re-labelled so the table shows it.
            problem = body_mask_problem(path)
            if problem is None:
                rows[-1] = (rel, norm, cls + "-RULED", auth_hits, session_hits)
            else:
                violations.append(
                    f"{rel}: {norm!r} is a Dustin-ruled authenticated Clarity page "
                    f"(RULED_AUTHENTICATED_ALLOWED) but {problem} -- personal fields "
                    f"would be recorded unmasked"
                )
        elif cls == "AUTH" and norm in allowlist_set:
            violations.append(
                f"{rel}: classified AUTHENTICATED ({auth_hits[0][0]}@L{auth_hits[0][1]}) "
                f"but its normalised path {norm!r} is on js/ga-gate.js's "
                f"CLARITY_ALLOWED_PATHS -- Clarity would load on an authenticated page"
            )
        elif cls == "SESSION" and norm in allowlist_set and norm not in SESSION_AWARE_PUBLIC:
            violations.append(
                f"{rel}: classified SESSION-TOUCHING ({session_hits[0][0]}@L"
                f"{session_hits[0][1]}) but its normalised path {norm!r} is on "
                f"js/ga-gate.js's CLARITY_ALLOWED_PATHS with no reviewed "
                f"SESSION_AWARE_PUBLIC exception -- a page that touches a session "
                f"at all fails closed unless explicitly reviewed and listed with a "
                f"reason"
            )

    if not gate_live and pages:
        exposed = [r for r in rows if r[2] in ("AUTH", "SESSION")]
        if exposed:
            violations.append(
                f"page-set gate is absent/neutered/mis-positioned/non-canonical in "
                f"js/ga-gate.js -- {len(exposed)} authenticated or session-touching "
                f"page(s) that include the loader would receive Clarity unconditionally"
            )

    lines.append(f"check-clarity-page-gate: {len(rows)} page(s) include a Clarity-carrying loader")
    lines.append(f"{'CLASS':8s} {'PATH':55s} {'NORMALISED':30s} EVIDENCE")
    for rel, norm, cls, auth_hits, session_hits in rows:
        hits = auth_hits if cls.startswith("AUTH") else session_hits if cls.startswith("SESSION") else []
        evidence = "; ".join(f"{lbl}@L{ln}" for lbl, ln in hits) if hits else "-"
        lines.append(f"{cls:8s} {rel:55s} {norm:30s} {evidence}")
    lines.append("")

    if violations:
        lines.append(f"check-clarity-page-gate: {len(violations)} violation(s):")
        for v in violations:
            lines.append("  - " + v)
        return 1, "\n".join(lines) + "\n"

    lines.append("check-clarity-page-gate: OK -- no authenticated or unreviewed "
                  "session-touching page is on the Clarity allowlist, and the "
                  "page-set gate is present, live and canonical in js/ga-gate.js")
    return 0, "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# --self-test: planted fixtures, run against an in-memory tmp tree
# ---------------------------------------------------------------------------

_BASE_GATE_TEMPLATE = """(function () {{
  var ALLOWED_HOSTS = ['otterquote.com'];
  var CLARITY_PROJECT_ID = 'wwr7qlk8g5';
  var CLARITY_ALLOWED_PATHS = [
    '/',
    '/public-page'
{extra_allow}  ];
  function normalizeClarityPath(pathname) {{
    var p = pathname;
    if (p.length > 1 && p.charAt(p.length - 1) === '/') {{
      p = p.slice(0, -1);
    }}
    if (p.slice(-5) === '.html') {{
      p = p.slice(0, -5);
    }}
    if (p === '') {{
      p = '/';
    }}
    if (p.slice(-6) === '/index') {{
      p = p.slice(0, -6);
      if (p === '') {{
        p = '/';
      }}
    }}
    return p;
  }}
  if (ALLOWED_HOSTS.indexOf(window.location.hostname) === -1) {{
    return;
  }}
{gate_block}
  (function (c, l, a, r, i, t, y) {{
    c[a] = c[a] || function () {{ (c[a].q = c[a].q || []).push(arguments); }};
    t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  }})(window, document, 'clarity', 'script', CLARITY_PROJECT_ID);
}})();
"""

_LIVE_GATE_BLOCK = (
    "  if (CLARITY_ALLOWED_PATHS.indexOf(normalizeClarityPath(window.location.pathname)) "
    "=== -1) {\n    return; // not a recognised public page -- Clarity never loads\n  }"
)

_PUBLIC_HTML = """<html><head><script src="/js/ga-gate.js"></script></head>
<body><h1>Public marketing page</h1></body></html>
"""

_ADMIN_HTML = """<html><head><script src="/js/ga-gate.js"></script></head>
<body>
<script>
  Auth.requireAuth('admin');
</script>
</body></html>
"""

_SESSION_PUBLIC_HTML = """<html><head><script src="/js/ga-gate.js"></script></head>
<body>
<script>
  Auth.getUser().then(function (user) { if (user) { window.location.href = '/dashboard.html'; } });
</script>
</body></html>
"""


def _write_fixture_tree(tmp: pathlib.Path, gate_js: str, allowlist_admin=False,
                         allowlist_session=False) -> None:
    (tmp / "js").mkdir(parents=True, exist_ok=True)
    (tmp / "js" / "ga-gate.js").write_text(gate_js, encoding="utf-8")
    (tmp / "public.html").write_text(_PUBLIC_HTML, encoding="utf-8")
    (tmp / "admin.html").write_text(_ADMIN_HTML, encoding="utf-8")
    (tmp / "session-public.html").write_text(_SESSION_PUBLIC_HTML, encoding="utf-8")
    _ = allowlist_admin, allowlist_session  # entries are baked into gate_js by caller


def _gate_js(extra_allow: str = "", gate_block: str = _LIVE_GATE_BLOCK) -> str:
    return _BASE_GATE_TEMPLATE.format(extra_allow=extra_allow, gate_block=gate_block)


class _SelfTestRunner:
    def __init__(self):
        self.results: list[str] = []
        self.failed = False

    def check(self, name: str, condition: bool, detail: str = "") -> None:
        if condition:
            self.results.append(f"PASS  {name}" + (f" -- {detail}" if detail else ""))
        else:
            self.failed = True
            self.results.append(f"FAIL  {name}" + (f" -- {detail}" if detail else ""))

    def run_scenario(self, name: str, gate_js: str, extra_files: dict[str, str] | None,
                      expect_exit: int, ruled: dict[str, str] | None = None) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = pathlib.Path(td)
            _write_fixture_tree(tmp, gate_js)
            if extra_files:
                for rel, content in extra_files.items():
                    p = tmp / rel
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(content, encoding="utf-8")
            code, output = main_check(tmp, ruled=ruled if ruled is not None else {})
            self.check(
                f"self-test:{name}",
                code == expect_exit,
                f"expected exit {expect_exit}, got {code}",
            )
            if code != expect_exit:
                self.results.append("      --- output ---")
                for line in output.splitlines():
                    self.results.append("      " + line)


def run_self_test() -> tuple[int, str]:
    r = _SelfTestRunner()

    # 1. clean tree -> 0
    r.run_scenario("clean_tree_exit_0", _gate_js(), None, 0)

    # 2. auth page allowlisted -> 1
    r.run_scenario(
        "auth_page_allowlisted_exit_1",
        _gate_js(extra_allow="    ,'/admin'\n"),
        None,
        1,
    )

    # 3. gate commented with // -> 1
    commented_line_by_line = "\n".join(
        "  // " + ln.strip() for ln in _LIVE_GATE_BLOCK.splitlines()
    )
    r.run_scenario("gate_line_commented_exit_1", _gate_js(gate_block=commented_line_by_line), None, 1)

    # 3b. gate commented with /* */ -> 1
    r.run_scenario(
        "gate_block_commented_exit_1",
        _gate_js(gate_block="  /*\n" + _LIVE_GATE_BLOCK + "\n  */"),
        None,
        1,
    )

    # 4. gate neutered variants -> 1 each
    neuter_variants = {
        "if_0_and": _LIVE_GATE_BLOCK.replace(
            "if (CLARITY_ALLOWED_PATHS", "if (0 && CLARITY_ALLOWED_PATHS"
        ),
        "if_false_wrapping": "  if (false) {\n" + _LIVE_GATE_BLOCK + "\n  }",
        "bang1_and": _LIVE_GATE_BLOCK.replace(
            "if (CLARITY_ALLOWED_PATHS", "if (!1 && CLARITY_ALLOWED_PATHS"
        ),
        "null_and": _LIVE_GATE_BLOCK.replace(
            "if (CLARITY_ALLOWED_PATHS", "if (null && CLARITY_ALLOWED_PATHS"
        ),
    }
    for name, block in neuter_variants.items():
        r.run_scenario(f"gate_neutered_{name}_exit_1", _gate_js(gate_block=block), None, 1)

    # 5. allowlist check placed after the loader injection -> 1
    after_injection_template = _BASE_GATE_TEMPLATE.replace(
        "{gate_block}\n  (function (c, l, a, r, i, t, y) {{",
        "  (function (c, l, a, r, i, t, y) {{",
    ).replace(
        "  }})(window, document, 'clarity', 'script', CLARITY_PROJECT_ID);\n}})();",
        "  }})(window, document, 'clarity', 'script', CLARITY_PROJECT_ID);\n"
        "{gate_block}\n}})();",
    )
    moved_gate_js = after_injection_template.format(extra_allow="", gate_block=_LIVE_GATE_BLOCK)
    r.run_scenario("gate_after_injection_exit_1", moved_gate_js, None, 1)

    # 6. normalizer returning a constant -> 1
    constant_normalizer_gate = _gate_js().replace(
        "    return p;\n  }",
        "    return '/';\n  }",
    )
    r.run_scenario("normalizer_returns_constant_exit_1", constant_normalizer_gate, None, 1)

    # 7. session-touching page on allowlist -> 1
    r.run_scenario(
        "session_touching_page_allowlisted_exit_1",
        _gate_js(extra_allow="    ,'/session-public'\n"),
        None,
        1,
    )

    # Bonus (not in the brief's list, but the D3 fix's own reason for
    # existing): a regex literal earlier in the file must not desync the
    # comment stripper into reading a REAL commented-out gate as "present".
    regex_confusion_gate = _gate_js(gate_block=commented_line_by_line)
    regex_confusion_gate = regex_confusion_gate.replace(
        "  var CLARITY_PROJECT_ID = 'wwr7qlk8g5';",
        "  var CLARITY_PROJECT_ID = 'wwr7qlk8g5';\n  var rx = /'/g; // stray quote inside a regex literal",
    )
    r.run_scenario("regex_literal_does_not_desync_comment_strip_exit_1", regex_confusion_gate, None, 1)

    # gh-1939: a Dustin-ruled authenticated page -- allowed only with a masked <body>.
    masked_admin = _ADMIN_HTML.replace("<body>", '<body data-clarity-mask="true">')
    r.run_scenario(
        "ruled_auth_page_masked_body_exit_0",
        _gate_js(extra_allow="    ,'/admin'\n"),
        {"admin.html": masked_admin},
        0,
        ruled={"/admin": "fixture ruling"},
    )
    r.run_scenario(
        "ruled_auth_page_unmasked_body_exit_1",
        _gate_js(extra_allow="    ,'/admin'\n"),
        None,
        1,
        ruled={"/admin": "fixture ruling"},
    )
    r.run_scenario(
        "masked_but_not_ruled_auth_page_exit_1",
        _gate_js(extra_allow="    ,'/admin'\n"),
        {"admin.html": masked_admin},
        1,
        ruled={},
    )
    r.run_scenario(
        "ruled_auth_page_mask_only_in_html_comment_exit_1",
        _gate_js(extra_allow="    ,'/admin'\n"),
        {"admin.html": _ADMIN_HTML.replace("<body>", '<!-- <body data-clarity-mask="true"> --><body>')},
        1,
        ruled={"/admin": "fixture ruling"},
    )

    decoys = {
        "decoy_in_script_string": _ADMIN_HTML.replace("Auth.requireAuth('admin');", "Auth.requireAuth('admin'); var d = '<body data-clarity-mask=\"true\">';"),
        "decoy_in_template": _ADMIN_HTML.replace("<body>", '<template><body data-clarity-mask="true"></template><body>'),
        "decoy_in_noscript_head": _ADMIN_HTML.replace("</head>", '<noscript><body data-clarity-mask="true"></noscript></head>'),
        "decoy_custom_element": _ADMIN_HTML.replace("<body>", '<body-x data-clarity-mask="true"></body-x><body>'),
        "masked_body_with_unmask_child": masked_admin.replace("<script>", '<div data-clarity-unmask="true">x</div><script>'),
    }
    for dname, dhtml in decoys.items():
        r.run_scenario(
            f"ruled_auth_page_{dname}_exit_1",
            _gate_js(extra_allow="    ,'/admin'\n"),
            {"admin.html": dhtml},
            1,
            ruled={"/admin": "fixture ruling"},
        )

    # gh-1981: '/login' sat on CLARITY_ALLOWED_PATHS via a SESSION_AWARE_PUBLIC
    # exception ("only redirects an already-signed-in visitor") that was
    # wrong about what login.html actually does -- it renders the signed-in
    # visitor's own email into the DOM (routeOrExplainNonHomeowner(),
    # login.html) instead of only bouncing them. '/login' is removed from
    # both js/ga-gate.js's CLARITY_ALLOWED_PATHS and this file's
    # SESSION_AWARE_PUBLIC. Unlike the scenarios above, this checks the REAL
    # production gate file and the REAL SESSION_AWARE_PUBLIC dict (not a
    # synthetic fixture) -- the point is to fail --self-test (and so fail
    # CI, via check-clarity-page-gate.test.py) if either is ever silently
    # reverted.
    real_gate_src = (REPO / "js" / "ga-gate.js").read_text(encoding="utf-8")
    real_entries, _, _ = analyze_gate_file(real_gate_src)
    r.check(
        "gh1981_login_not_on_real_clarity_allowed_paths",
        real_entries is not None and "/login" not in real_entries,
        f"js/ga-gate.js CLARITY_ALLOWED_PATHS entries: {real_entries}",
    )
    r.check(
        "gh1981_login_not_in_real_session_aware_public",
        "/login" not in SESSION_AWARE_PUBLIC,
        f"SESSION_AWARE_PUBLIC keys: {sorted(SESSION_AWARE_PUBLIC)}",
    )

    # gh-1981 fix round 1 (PR #1996 review, comment 5698663751; Ben's ruling,
    # comment 5698879235): the re-audit above initially missed
    # '/partner-profile'. Its SESSION_AWARE_PUBLIC reason claimed
    # Auth.getUser() "resolves only the signed-in partner's own PUBLIC
    # referral code ... rendered as a public referral link" -- but with no
    # ?code= in the URL, the signed-in partner's own full profile card
    # (name, company, service area, photo, bio) is rendered via
    # card.innerHTML (partner-profile.html:238-247, renderProfile() at
    # :209), and Clarity loaded while it did. Ben ruled this counts as
    # account data and ordered plain removal (a conditional ?code=-only skip
    # was considered and rejected). Same real-file/real-dict check as the
    # '/login' pair above, same reason: fail --self-test (and CI) if
    # '/partner-profile' is ever silently reverted into either.
    r.check(
        "gh1981_partner_profile_not_on_real_clarity_allowed_paths",
        real_entries is not None and "/partner-profile" not in real_entries,
        f"js/ga-gate.js CLARITY_ALLOWED_PATHS entries: {real_entries}",
    )
    r.check(
        "gh1981_partner_profile_not_in_real_session_aware_public",
        "/partner-profile" not in SESSION_AWARE_PUBLIC,
        f"SESSION_AWARE_PUBLIC keys: {sorted(SESSION_AWARE_PUBLIC)}",
    )

    output = "\n".join(r.results) + "\n"
    return (1 if r.failed else 0), output


def main() -> int:
    argv = sys.argv[1:]
    root = REPO
    if "--root" in argv:
        root = pathlib.Path(argv[argv.index("--root") + 1]).resolve()

    if "--self-test" in argv:
        code, output = run_self_test()
        print(output, end="")
        return code

    code, output = main_check(root)
    print(output, end="")
    return code


if __name__ == "__main__":
    sys.exit(main())
