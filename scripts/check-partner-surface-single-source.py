#!/usr/bin/env python3
"""
gh-807: partner-surface-definition single-source-of-truth guard.

`js/auth.js` used to define "is this a partner surface" twice:
requireAuth() tested `/(^|\\/)(partner-|ref-|recruit|refer-a-friend)/`
against the full pathname; redirectToDashboard()'s #783 guard tested only
`indexOf('partner-') === 0` against the trailing filename. The two
definitions silently diverged -- ref-*/recruit*/refer-a-friend* pages were
partner surfaces by requireAuth()'s definition but not by
redirectToDashboard()'s, so a signed-in partner landing on one of those
pages could be bounced into the homeowner intake flow.

The fix introduced one shared regex (`PARTNER_SURFACE_FILE_RE`) and one
shared helper (`_isPartnerSurfaceFile()`), used by requireAuth(),
redirectToDashboard(), and its cs_redirect staleness check. This script
enforces that the fix can't quietly regress back into two definitions:

  1. Exactly one partner-surface regex literal exists in js/auth.js.
  2. requireAuth(), redirectToDashboard(), and the cs_redirect check inside
     it each call _isPartnerSurfaceFile(...) -- no inline
     partner-/ref-/recruit/refer-a-friend regex or indexOf() check of their
     own.

Demonstrated failure mode (run manually, do not leave applied): re-inline
`currentFile.indexOf('partner-') === 0` in place of
`_isPartnerSurfaceFile(window.location.pathname)` inside
redirectToDashboard() and re-run this script -- it fails on check 2
(missing call site) and, if the inlined literal also reintroduces a second
`partner-` pattern, on check 1 (regex count) too.

Exit codes:
  0 -- single source of truth intact
  1 -- diverged, or the file/functions couldn't be parsed
"""
from __future__ import annotations
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
AUTH_JS = REPO / "js" / "auth.js"

# Any regex or indexOf() literal that could independently decide "is this a
# partner surface" -- i.e. a second definition, not a call to the shared one.
SUSPECT_PARTNER_LITERAL_RE = re.compile(
    r"""
    /\^?\(?\^?\|?\\?/\)?\(partner-   # a regex literal starting with the partner- alternation
  | indexOf\(['"]partner-['"]\)      # the old indexOf('partner-') check
    """,
    re.VERBOSE,
)
SHARED_DEFINITION_RE = re.compile(r"PARTNER_SURFACE_FILE_RE\s*=\s*/")
SHARED_CALL_RE = re.compile(r"_isPartnerSurfaceFile\(")


def extract_function(text: str, name: str) -> str | None:
    """Best-effort extraction of a function/method body by brace matching,
    starting from its declaration/assignment through the matching '}'."""
    m = re.search(r"(?:function\s+" + name + r"\s*\(|" + name + r"\s*\([^)]*\)\s*\{)", text)
    if not m:
        return None
    start = text.find("{", m.start())
    if start == -1:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def main() -> int:
    if not AUTH_JS.exists():
        print(f"FAIL: {AUTH_JS} not found.")
        return 1
    text = AUTH_JS.read_text(encoding="utf-8")
    failures: list[str] = []

    # Check 1: exactly one shared regex definition.
    def_count = len(SHARED_DEFINITION_RE.findall(text))
    if def_count != 1:
        failures.append(
            f"expected exactly 1 `PARTNER_SURFACE_FILE_RE = /.../ ` definition, found {def_count}."
        )

    # Check 1b: no OTHER partner-surface literal anywhere outside that one
    # definition line (a second inline regex/indexOf would be a re-divergence).
    # Comments (both // and /* */) are stripped first -- this file's own
    # gh-807 comments document the OLD `indexOf('partner-')` code as prose,
    # which would otherwise false-positive against this same check.
    code_only = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    code_only = re.sub(r"//[^\n]*", "", code_only)
    non_def_lines = [
        line for line in code_only.splitlines() if not SHARED_DEFINITION_RE.search(line)
    ]
    suspect_hits = [line.strip() for line in non_def_lines if SUSPECT_PARTNER_LITERAL_RE.search(line)]
    if suspect_hits:
        failures.append(
            "found a partner-surface literal outside the shared definition "
            f"(re-inlined regex or indexOf check): {suspect_hits}"
        )

    # Check 2: each call site uses the shared helper.
    for fn_name in ("requireAuth", "redirectToDashboard"):
        body = extract_function(text, fn_name)
        if body is None:
            failures.append(f"could not locate {fn_name}() to verify it calls _isPartnerSurfaceFile().")
            continue
        if not SHARED_CALL_RE.search(body):
            failures.append(f"{fn_name}() does not call _isPartnerSurfaceFile() anywhere in its body.")

    if failures:
        print("FAIL: partner-surface definition has diverged from single-source-of-truth (gh-807):")
        for f in failures:
            print(f"  - {f}")
        return 1

    print("PASS: js/auth.js has exactly one partner-surface definition, used by requireAuth() and redirectToDashboard().")
    return 0


if __name__ == "__main__":
    sys.exit(main())
