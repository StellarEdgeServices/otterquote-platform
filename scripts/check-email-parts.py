#!/usr/bin/env python3
"""
gh-869: Mailgun email HTML/text parity + bare-URL guard.

Scans every Mailgun-sending Supabase Edge Function under supabase/functions/
(any index.ts that references api.mailgun.net) and fails when:

  (a) a function appends/sets a Mailgun "html" form field without ever
      appending/setting "text", or vice versa -- UNLESS the function is on
      TEXT_ONLY_ALLOWLIST below (a function confirmed to send ONLY to an
      internal admin inbox, #869 AC 4's exception clause).

  (b) an HTML-named template literal (see _classify_literal_owner) contains
      a bare platform URL (otterquote.com apex/subdomain, or a Netlify
      preview domain) that is not inside an href="..." attribute value.

Per #869 AC 2, rule (b) is deliberately NOT applied to text-named template
literals -- the text/plain part of an email is REQUIRED to keep the bare
URL (accessibility fallback / HTML-blocked-client fallback), never "fixed".

── Known limitations (read before trusting a clean run) ─────────────────────
This is a dependency-free regex heuristic, not a TypeScript parser, and it
was written for gh-869's own migration. Two known gaps, both intentional
trade-offs favoring zero false positives over exhaustive coverage:

  1. Granularity is per EDGE-FUNCTION-FILE, not per send call-site. A file
     with three different email sends where only one pairs html+text will
     still PASS rule (a) as long as html and text both appear *somewhere*
     in the file (e.g. admin-contractor-action/index.ts sends one dual-part
     email and two text-only emails from the same file -- this script sees
     "has html" + "has text" and passes it).
  2. Rule (b) only inspects template literals whose owning function/const
     name contains "html" (case-insensitive) and does not also contain
     "text". Literals that can't be confidently named (e.g. deeply nested
     inline template expressions) are skipped rather than guessed at.

Both gaps are why gh-869's task report carries a manually-verified table of
all Mailgun-sending functions alongside this script -- this script is the
regression guard for future changes, not a substitute for that one-time audit.

Usage: python scripts/check-email-parts.py
Exit codes:
  0 -- no violations found
  1 -- violations found (printed to stdout)

NOT wired into .github/workflows/ yet -- workflow-file pushes are blocked
org-wide pending #814's PAT gap. See the #869 PR body for the follow-up.
"""
from __future__ import annotations
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
FUNCTIONS_DIR = REPO / "supabase" / "functions"

# #869 AC 4: functions manually verified to send ONLY to an internal admin
# inbox (dustinstohler1@gmail.com or an equivalent hardcoded alert address),
# never to a homeowner/contractor/external party. Deliberately left
# text-only. Do not add an entry here without re-verifying the recipient --
# see the #869 task report's AC9 table for how each entry was confirmed.
TEXT_ONLY_ALLOWLIST = {
    "check-rate-limits",           # to ALERT_EMAIL = dustinstohler1@gmail.com
    "check-docusign-usage",        # to "dustinstohler1@gmail.com" (hardcoded)
    "refresh-warranty-manifest",   # to ADMIN_EMAIL = dustinstohler1@gmail.com
    "platform-health-check",       # to ALERT_EMAIL = dustinstohler1@gmail.com
    "send-support-email",          # to SUPPORT_DESTINATION = dustinstohler1@gmail.com (hardcoded, caller cannot override)
}

MAILGUN_RE = re.compile(r"api\.mailgun\.net")
HTML_APPEND_RE = re.compile(r"""(?:append|set)\(\s*["']html["']""")
TEXT_APPEND_RE = re.compile(r"""(?:append|set)\(\s*["']text["']""")

# Literal platform domains that must never appear bare (outside href=) in an
# HTML-named template literal. Mailgun's own API domain is intentionally
# excluded -- that's infrastructure, not a link shown to a recipient.
PLATFORM_URL_RE = re.compile(
    r"https://(?:app-staging|app|staging--[\w-]+)?\.?otterquote\.com|"
    r"https://[\w-]+\.netlify\.app"
)

TEMPLATE_LITERAL_RE = re.compile(r"`([^`]*)`", re.DOTALL)
# href= is a clickable link (what AC 6b is about). src= is excluded too --
# an <img src="https://otterquote.com/logo.svg"> is an image resource, not
# a link shown to the recipient, and is not what this rule polices.
HREF_VALUE_RE = re.compile(r"""(?:href|src)\s*=\s*["']([^"']*)["']""")

# Looking backward from a template literal's opening backtick, the nearest
# of these is treated as the literal's "owner" name for classification.
OWNER_NAME_RE = re.compile(r"(?:function\s+(\w+)|const\s+(\w+)\s*=)")

BACKWARD_WINDOW = 500  # chars to look back from a backtick for an owner name


def _classify_literal_owner(content: str, literal_start: int) -> str | None:
    window = content[max(0, literal_start - BACKWARD_WINDOW):literal_start]
    matches = list(OWNER_NAME_RE.finditer(window))
    if not matches:
        return None
    m = matches[-1]
    return next((g for g in m.groups() if g), None)


def _href_spans(text: str) -> list[tuple[int, int]]:
    return [m.span(1) for m in HREF_VALUE_RE.finditer(text)]


def _is_within(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(start <= pos < end for start, end in spans)


def check_file(path: pathlib.Path, content: str) -> list[str]:
    violations: list[str] = []
    rel = str(path.relative_to(REPO)).replace("\\", "/")
    fn_name = path.parent.name

    has_html = bool(HTML_APPEND_RE.search(content))
    has_text = bool(TEXT_APPEND_RE.search(content))
    allowlisted = fn_name in TEXT_ONLY_ALLOWLIST

    if has_html and not has_text and not allowlisted:
        violations.append(
            f"{rel}: appends Mailgun 'html' but never 'text' (gh-869 AC 6a) "
            f"-- add a text/plain part"
        )
    if has_text and not has_html and not allowlisted:
        violations.append(
            f"{rel}: appends Mailgun 'text' but never 'html', and "
            f"'{fn_name}' is not on TEXT_ONLY_ALLOWLIST (gh-869 AC 4/AC 6a) "
            f"-- add an HTML part, or add to TEXT_ONLY_ALLOWLIST with a "
            f"comment stating why the recipient is internal-admin-only"
        )

    for m in TEMPLATE_LITERAL_RE.finditer(content):
        literal = m.group(1)
        owner = _classify_literal_owner(content, m.start())
        if not owner:
            continue
        owner_lower = owner.lower()
        if "html" not in owner_lower or "text" in owner_lower:
            continue  # not confidently HTML-only-named -- skip rather than guess
        spans = _href_spans(literal)
        for url_m in PLATFORM_URL_RE.finditer(literal):
            if not _is_within(url_m.start(), spans):
                line_no = literal[: url_m.start()].count("\n") + 1
                snippet = literal[max(0, url_m.start() - 20): url_m.start() + 40].strip()
                violations.append(
                    f"{rel}: bare platform URL in HTML-named literal "
                    f"'{owner}' (approx. literal line {line_no}) not inside "
                    f"href= (gh-869 AC 6b): ...{snippet}..."
                )

    return violations


def main() -> int:
    if not FUNCTIONS_DIR.is_dir():
        print(f"ERROR: {FUNCTIONS_DIR} not found", file=sys.stderr)
        return 1

    all_violations: list[str] = []
    scanned = 0
    for index_ts in sorted(FUNCTIONS_DIR.glob("*/index.ts")):
        try:
            content = index_ts.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if not MAILGUN_RE.search(content):
            continue
        scanned += 1
        all_violations.extend(check_file(index_ts, content))

    print(f"check-email-parts: scanned {scanned} Mailgun-sending Edge Function(s) "
          f"under {FUNCTIONS_DIR.relative_to(REPO)}")

    if all_violations:
        print(f"\nFAIL: {len(all_violations)} violation(s):\n")
        for v in all_violations:
            print(f"  - {v}")
        return 1

    print(f"PASS: no HTML/text parity or bare-URL violations found "
          f"({len(TEXT_ONLY_ALLOWLIST)} functions on the internal-admin text-only allowlist).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
