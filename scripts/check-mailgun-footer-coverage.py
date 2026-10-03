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
# MODE D (gh-1824, partner-invite senders): the street-only constant plus a
# signed opt-out link in the same footer builder.
DEFINE_ONLY_RE = re.compile(r'\bPOSTAL_ADDRESS_ONLY\b\s*(?::\s*string)?\s*=\s*"([^"]*)"')
INTERP_ONLY_RE = re.compile(r"\$\{POSTAL_ADDRESS_ONLY\}")
OPTOUT_RE = re.compile(r"Unsubscribe[^`\n]*\$\{(?:unsubText|optOutUrl)\}")

# The street-only form of the D-237 address, as used by the partner-invite
# footers (meta-leadgen-webhook/invite-email.ts, send-partner-invite-reminder/
# invite-email-copy.ts). The business-name prefix is a separate sentence in
# those footers ("Otter Quotes is a service of Stellar Edge Services LLC.").
CANONICAL_ADDRESS_ONLY = "3410 N High School Rd, Ste G #102, Indianapolis, IN 46224"

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

# gh-1824 ratchet (CTO RUN 51, cto51-tri-build2): every sender that ALREADY has a
# USED D-237 footer on main but was never enforced. Before this set existed only
# the 7 REQUIRED_FOOTER functions could turn CI red; 27 more covered senders could
# silently lose their footer. This set is a floor, not a target: add a function
# here when its footer lands, never remove one to make CI green. It is kept
# separate from REQUIRED_FOOTER so the two grow in different PRs without
# touching the same lines.
RATCHET_FOOTER = {
    "admin-contractor-action",
    "approve-payout",
    "approve-warranty-drift",
    "check-rate-limits",
    "counter-sig-reminders",
    "mark-job-complete",
    "mark-payout-paid",
    "meta-leadgen-webhook",       # MODE D (partner invite footer + opt-out)
    "notify-admin-new-contractor",
    "notify-contractors",
    "notify-feature-request",
    "notify-partner-w9",
    "notify-payout-pending",
    "process-auto-bids",
    "process-bid-expirations",
    "process-coi-reminders",
    "process-payout-reminders",
    "refresh-warranty-manifest",
    "resend-hover-link",
    "send-bid-confirmation",
    "send-home-profile-prompt",
    "send-incomplete-onboarding-reminders",
    "send-message-notification",
    "send-partner-invite-reminder",  # MODE D (partner invite footer + opt-out)
    "send-referral-out-email",
    "send-support-email",
    "send-welcome-email",
    "switch-contractor",
    "watch-template-mapping",
}

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
    # gh-1824 footer batch 6 (PR #2331; REVIEW: FAIL 5881354201 -- these 5 must
    # be enforced so removing a wrap turns CI red)
    "docusign-webhook",            # MODE A
    "notify-admin-new-homeowner",  # MODE A
    "notify-admin-new-partner",    # MODE A
    "platform-health-check",       # MODE A
    "process-dunning",             # MODE A
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


_LINE_COMMENT_RE = re.compile(r"(^|[^:])//")
_FUNC_DECL_RE = re.compile(r"function\s+([A-Za-z_$][\w$]*)\s*\(")


def _first_live_match(regex, text):
    """First match of regex that is not inside a `//` line comment.

    A `//` preceded by `:` is a URL scheme (https://), not a comment."""
    for m in regex.finditer(text):
        line_start = text.rfind("\n", 0, m.start()) + 1
        if not _LINE_COMMENT_RE.search(text[line_start:m.start()]):
            return m
    return None


def _enclosing_function(text, pos):
    """Name of the nearest `function NAME(` declared before pos, or None."""
    name = None
    for m in _FUNC_DECL_RE.finditer(text, 0, pos):
        name = m.group(1)
    return name


def _call_count(text, name):
    """Live (non-comment) call sites of name(...), excluding its declaration."""
    call_re = re.compile(r"(?<![\w$])" + re.escape(name) + r"\s*\(")
    count = 0
    for m in call_re.finditer(text):
        before = text[max(0, m.start() - 9):m.start()]
        if before.rstrip().endswith("function"):
            continue
        line_start = text.rfind("\n", 0, m.start()) + 1
        if _LINE_COMMENT_RE.search(text[line_start:m.start()]):
            continue
        count += 1
    return count


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


_EXPORT_FN_RE = re.compile(r"export\s+function\s+([A-Za-z_$][\w$]*)\s*\(")
_BODY_MARK_RE = re.compile(
    r"(?:^|(?<=[\s{,]))(?:(?:const|let|var)\s+(text|html)\s*=|(text|html)\s*:)"
)


def _function_body(text, name_end):
    """Source from a top-level function's `(` to its closing `}` at column 0."""
    end = text.find("\n}", name_end)
    return text[name_end:end if end != -1 else len(text)]


def _body_reaches_footer(body, builder):
    """True if BOTH the text and the HTML body of an email-builder function
    interpolate the footer builder's RESULT: `${v}` where `const v = builder(`,
    or a direct `${builder(`. Computing the footer without interpolating it
    does not count (gh-2439 hole 1)."""
    refs = [re.escape("${" + builder + "(")]
    for m in re.finditer(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*"
                         + re.escape(builder) + r"\s*\(", body):
        line_start = body.rfind("\n", 0, m.start()) + 1
        if not _LINE_COMMENT_RE.search(body[line_start:m.start()]):
            refs.append(r"\$\{\s*" + re.escape(m.group(1)) + r"\s*\}")
    ref_re = re.compile("|".join(refs))
    marks = [(m.start(), m.group(1) or m.group(2)) for m in _BODY_MARK_RE.finditer(body)]
    seen = set()
    for i, (pos, key) in enumerate(marks):
        seg = body[pos:marks[i + 1][0] if i + 1 < len(marks) else len(body)]
        if _first_live_match(ref_re, seg) is not None:
            seen.add(key)
    return seen == {"text", "html"}


def _sender_uses_builder(text, fn):
    """True if the Mailgun-sending file calls exported builder fn and uses the
    result's .text and .html (gh-2439 hole 3), via `const v = fn(...)` then
    `v.text` / `v.html`, or `const { text, html } = fn(...)`."""
    for m in re.finditer(r"(?<![\w$])" + re.escape(fn) + r"\s*\(", text):
        line_start = text.rfind("\n", 0, m.start()) + 1
        head = text[line_start:m.start()]
        if _LINE_COMMENT_RE.search(head) or head.rstrip().endswith("function"):
            continue
        a = re.search(r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:await\s+)?$", head)
        if a:
            v = re.escape(a.group(1))
            if all(_first_live_match(re.compile(r"(?<![\w$.])" + v + r"\.%s\b" % f), text)
                   for f in ("text", "html")):
                return True
        d = re.search(r"(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?$", head)
        if d and all(re.search(r"\b%s\b" % f, d.group(1)) for f in ("text", "html")):
            return True
    return False


def _delivers_footer(contents, builder_text, footer_builder):
    """MODE D delivery proof (gh-2439): some EXPORTED email builder in the
    footer's file interpolates the footer result into both bodies, AND a
    different Mailgun-sending file calls that builder and sends its
    .text/.html. Dead builders never satisfy this: only a builder the sender
    actually calls counts."""
    for m in _EXPORT_FN_RE.finditer(builder_text):
        fn = m.group(1)
        if not _body_reaches_footer(_function_body(builder_text, m.end()), footer_builder):
            continue
        for other in contents.values():
            if other is builder_text or not MAILGUN_RE.search(other):
                continue
            if _sender_uses_builder(other, fn):
                return True
    return False


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

    # MODE D -- partner-invite footer: ONE file defines POSTAL_ADDRESS_ONLY as
    # the exact D-237 street string, interpolates it, AND carries an opt-out
    # link in the same footer (CAN-SPAM needs both). An address with no opt-out,
    # an opt-out with no address, or an altered/blank constant never matches.
    # Two refuter-found holes are closed here (PR #2435): the interpolation and
    # opt-out must not sit in a `//` comment, and the footer builder that holds
    # them must actually be called. gh-2439 tightens that from "called twice
    # somewhere" to proof of delivery: see _delivers_footer.
    for text in contents.values():
        m = DEFINE_ONLY_RE.search(text)
        if not m or m.group(1) != CANONICAL_ADDRESS_ONLY:
            continue
        interp = _first_live_match(INTERP_ONLY_RE, text)
        if interp is None or _first_live_match(OPTOUT_RE, text) is None:
            continue
        builder = _enclosing_function(text, interp.start())
        if builder and _delivers_footer(contents, text, builder):
            return True, "D"

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

    enforced = REQUIRED_FOOTER | RATCHET_FOOTER
    failures = sorted(n for n in enforced if n not in covered)
    if failures:
        print()
        print("FAIL: check-mailgun-footer-coverage: the following REQUIRED_FOOTER "
              "functions do not have a USED D-237 postal-address footer (regression):")
        for n in failures:
            print(f"  - {n}")
        return 1

    stale = sorted(n for n in enforced if n not in senders)
    if stale:
        print()
        print("FAIL: check-mailgun-footer-coverage: REQUIRED_FOOTER names a function "
              "that no longer appears to send via Mailgun at all (stale allowlist entry "
              "-- fix REQUIRED_FOOTER, this is not a pass):")
        for n in stale:
            print(f"  - {n}")
        return 1

    other_gap = sorted(set(missing) - enforced)
    print()
    print(f"PASS: check-mailgun-footer-coverage: all {len(enforced)} "
          f"REQUIRED_FOOTER/RATCHET_FOOTER functions have a USED D-237 footer. "
          f"{len(other_gap)} other Mailgun sender(s) remain a known gap "
          f"(#1824 continuation, not yet enforced).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
