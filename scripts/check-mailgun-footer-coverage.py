#!/usr/bin/env python3
"""check-mailgun-footer-coverage.py (gh-1824)

Enumerates every Supabase Edge Function under supabase/functions/ that sends
mail through Mailgun (a literal call to api.mailgun.net or *.mailgun.net) and
checks whether the D-237 postal address is not just PRESENT somewhere in that
function's directory, but actually USED by the code that builds the outgoing
message.

gh-1824 PR #2197 review (comment 5839071861) found the first version of this
script checked presence only -- `POSTAL_ADDRESS` or the street text appearing
ANYWHERE in a non-test .ts file in the directory was enough to pass, even in
a comment, even with an unrelated/renamed symbol nearby, and even after the
actual call that renders the address into the outgoing email was deleted.
Three reproduced false-PASSes: removing the footer call from the email
builder, blanking the constant's value, and renaming the constant while the
street text survived elsewhere. This version replaces presence-checking with
usage-checking, covering the three real patterns this repo actually uses (no
fourth pattern -- these are the ones on `main` today, verified in the module
docstring's own self-test):

  MODE A -- "wrapper" (notify-measurement-order, send-measurement-ready,
    send-homeowner-next-steps, send-partner-onboarding, send-partner-status-
    email): one file defines `function footerPostalAddressHtml()` /
    `footerPostalAddressText()` wrapping a colocated, canonical, non-empty
    `POSTAL_ADDRESS` constant. Covered only if a DIFFERENT file in the same
    directory contains a genuine CALL to one of those wrappers -- not the
    function *definition* itself (excluded via a negative lookbehind on
    "function ", since the definition's own return statement necessarily
    contains a `${POSTAL_ADDRESS}` interpolation that must never count as
    its own usage).

  MODE B -- "direct embed via a bare constant" (send-lead-next-step-reminder):
    no wrapper function exists anywhere in the directory; a file defines a
    canonical, non-empty `POSTAL_ADDRESS` constant AND some file in the
    directory contains a genuine `${POSTAL_ADDRESS}` template-literal
    interpolation. Because no wrapper exists in this mode, there is no
    self-referential function body to produce a false match, so no
    same-file/different-file restriction is needed here.

  MODE C -- "literal embed, no constant at all" (create-invoice): the full
    canonical address string appears verbatim in the SAME file that makes
    the Mailgun call -- create-invoice's fixed-field invoice DOCUMENT, not
    an email footer. This is flagged explicitly wherever this script's
    coverage is reported, per the #1824 PR #2197 review (finding 3): it
    counts because of the invoice content, not because of a footer.

A function is covered if MODE A, B, or C matches. All three require the
FULL canonical D-237 string, not a substring -- a blanked, truncated, or
altered value never matches.

Exit status:
  0  every function on REQUIRED_FOOTER below is covered (any mode).
  1  a REQUIRED_FOOTER function is not covered, OR REQUIRED_FOOTER names a
     function that no longer sends via Mailgun at all (stale allowlist
     entry -- fix the list, don't let it silently stop meaning anything).
  3  supabase/functions/ does not exist at FUNCTIONS_DIR (unmeasured, not a
     silent pass).

REQUIRED_FOOTER is deliberately NOT "every Mailgun sender in the repo" yet.
See scripts/check-mailgun-footer-coverage.test.py for this script's own
negative-control self-test (required by the Detector Negative Control Gate,
gh-1738/gh-1841) and gh-1824's PR/issue comments for the current full
enumeration and count.

`send-home-profile-prompt` is intentionally NOT in REQUIRED_FOOTER: its own
fix ships on PR #2190 (gh-2013), not this script's PR -- see that PR and the
gh-1824 rework comment for the overlap-resolution reasoning.

FUNCTIONS_DIR is a module-level variable (not a function-local computation)
so the self-test can monkeypatch it to a fixture tree, per this repo's
established convention (scripts/check-credential-claims.py's `REPO`).
"""
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FUNCTIONS_DIR = os.path.join(REPO_ROOT, "supabase", "functions")  # monkeypatchable by the self-test

MAILGUN_RE = re.compile(r"api\.mailgun\.net|[a-z0-9.-]*mailgun\.net")
DEFINE_RE = re.compile(r'\bPOSTAL_ADDRESS\b\s*(?::\s*string)?\s*=\s*"([^"]*)"')
WRAPPER_DEFINE_RE = re.compile(r"function\s+footerPostalAddress(?:Html|Text)\s*\(")
WRAPPER_CALL_RE = re.compile(r"(?<!function )footerPostalAddress(?:Html|Text)\s*\(\s*\)")
INTERP_RE = re.compile(r"\$\{POSTAL_ADDRESS\}")

CANONICAL_ADDRESS = (
    "Stellar Edge Services, LLC d/b/a Otter Quotes · "
    "3410 N High School Rd, Ste G #102, Indianapolis, IN 46224"
)

# create-invoice's fixed-field invoice document (MODE C) renders the same
# business identity and address as CANONICAL_ADDRESS, but as a multi-line
# "FROM:" block without the middle-dot separator this repo's email footers
# use -- a legitimate different layout for a different document type, not a
# different address. MODE C therefore checks for these components rather
# than an exact CANONICAL_ADDRESS substring match.
CANONICAL_ADDRESS_COMPONENTS = (
    "Stellar Edge Services, LLC d/b/a Otter Quotes",
    "3410 N High School Rd",
    "Ste G #102",
    "Indianapolis, IN 46224",
)

# Functions this guard actively enforces (must never regress). Each one was
# independently confirmed, by this script's own logic, to USE (not merely
# carry) the D-237 address before being added here.
REQUIRED_FOOTER = {
    "create-invoice",              # MODE C -- invoice document, see docstring
    "notify-measurement-order",    # MODE A
    "send-measurement-ready",      # MODE A
    "send-homeowner-next-steps",   # MODE A
    "send-lead-next-step-reminder",  # MODE B
    "send-partner-onboarding",     # MODE A
    "send-partner-status-email",   # MODE A (gh-1824)
}


def _read(path):
    try:
        return open(path, encoding="utf-8", errors="ignore").read()
    except OSError:
        return ""


_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def _strip_block_comments(text):
    """Strip /* ... */ block comments before any usage/definition regex runs.

    Without this, a /** doc comment */ that quotes example or historical
    source (e.g. this repo's own email-footer.ts headers, which literally
    show `export const POSTAL_ADDRESS = "";` as a worked example of the
    empty, pre-#1824-answer state) is indistinguishable from real code to a
    naive regex -- and a comment-only match can win over the real
    declaration below it if the comment happens to come first in the file.
    Line (`//`) comments are deliberately left alone: several files in this
    directory legitimately have `https://...` URLs on the same source line
    as real code this script must still see.
    """
    return _BLOCK_COMMENT_RE.sub("", text)


def _ts_files(func_dir):
    """Non-test .ts files in func_dir as {filename: comment-stripped contents}."""
    out = {}
    try:
        names = sorted(os.listdir(func_dir))
    except OSError:
        return out
    for fname in names:
        if fname.endswith(".ts") and not fname.endswith(".test.ts"):
            out[fname] = _strip_block_comments(_read(os.path.join(func_dir, fname)))
    return out


def function_sends_via_mailgun(contents):
    return any(MAILGUN_RE.search(text) for text in contents.values())


def function_uses_footer(contents):
    """Returns (covered: bool, mode: str|None) for one function's contents."""
    # MODE A -- wrapper functions + a call to them from a different file.
    wrapper_files = {name for name, text in contents.items() if WRAPPER_DEFINE_RE.search(text)}
    for def_name in wrapper_files:
        m = DEFINE_RE.search(contents[def_name])
        if not m or m.group(1) != CANONICAL_ADDRESS:
            continue
        for other_name, other_text in contents.items():
            if other_name == def_name:
                continue
            if WRAPPER_CALL_RE.search(other_text):
                return True, "A"

    # MODE B -- bare constant + direct interpolation, no wrapper anywhere.
    if not wrapper_files:
        define_ok = any(
            (m := DEFINE_RE.search(text)) and m.group(1) == CANONICAL_ADDRESS
            for text in contents.values()
        )
        if define_ok and any(INTERP_RE.search(text) for text in contents.values()):
            return True, "B"

    # MODE C -- literal address embedded directly in the Mailgun-sending file
    # (create-invoice's invoice document -- see CANONICAL_ADDRESS_COMPONENTS
    # docstring above for why this checks components, not the exact string).
    for text in contents.values():
        if MAILGUN_RE.search(text) and all(c in text for c in CANONICAL_ADDRESS_COMPONENTS):
            return True, "C"

    return False, None


def main():
    if not os.path.isdir(FUNCTIONS_DIR):
        print(f"UNMEASURED: check-mailgun-footer-coverage: {FUNCTIONS_DIR} does not exist")
        return 3

    senders = []       # names
    contents_by_fn = {}  # name -> {filename: text}
    for name in sorted(os.listdir(FUNCTIONS_DIR)):
        func_dir = os.path.join(FUNCTIONS_DIR, name)
        if not os.path.isdir(func_dir) or name.startswith("_"):
            continue
        contents = _ts_files(func_dir)
        if function_sends_via_mailgun(contents):
            senders.append(name)
            contents_by_fn[name] = contents

    covered = {}  # name -> mode
    for name in senders:
        ok, mode = function_uses_footer(contents_by_fn[name])
        if ok:
            covered[name] = mode

    missing = [n for n in senders if n not in covered]

    print(f"Mailgun-sending Edge Functions found: {len(senders)}")
    print(f"  with a USED D-237 footer            : {len(covered)}")
    print(f"  without                             : {len(missing)}")
    print()
    print("Covered:")
    for n in sorted(covered):
        note = " (invoice document, not an email footer)" if covered[n] == "C" else ""
        print(f"  [x] {n}  [mode {covered[n]}]{note}")
    print("Missing (known gap, tracked on #1824):")
    for n in sorted(missing):
        print(f"  [ ] {n}")

    failures = sorted(n for n in REQUIRED_FOOTER if n not in covered)
    if failures:
        print()
        print("FAIL: check-mailgun-footer-coverage: the following REQUIRED_FOOTER "
              "functions do not have a USED D-237 postal-address footer (regression):")
        for n in failures:
            print(f"  - {n}")
        return 1

    stale = sorted(n for n in REQUIRED_FOOTER if n not in senders)
    if stale:
        print()
        print("FAIL: check-mailgun-footer-coverage: REQUIRED_FOOTER names a function "
              "that no longer appears to send via Mailgun at all (stale allowlist entry "
              "-- fix REQUIRED_FOOTER, this is not a pass):")
        for n in stale:
            print(f"  - {n}")
        return 1

    other_gap = sorted(set(missing) - REQUIRED_FOOTER)
    print()
    print(f"PASS: check-mailgun-footer-coverage: all {len(REQUIRED_FOOTER)} "
          f"REQUIRED_FOOTER functions have a USED D-237 footer. "
          f"{len(other_gap)} other Mailgun sender(s) remain a known gap "
          f"(#1824 continuation, not yet in REQUIRED_FOOTER).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
