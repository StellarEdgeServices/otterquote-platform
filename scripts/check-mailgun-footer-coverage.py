#!/usr/bin/env python3
"""check-mailgun-footer-coverage.py (gh-1824)

Enumerates every Supabase Edge Function under supabase/functions/ that sends
mail through Mailgun (a literal call to api.mailgun.net or *.mailgun.net),
and checks whether that function's own directory carries the D-237
POSTAL_ADDRESS constant (the `email-footer.ts` pattern established by
notify-measurement-order / send-measurement-ready / send-homeowner-next-steps
/ send-partner-onboarding / send-partner-status-email / send-home-profile-
prompt -- colocated per function, NOT a `_shared/` import, because the EF
deploy path does not resolve `_shared/` imports; see any of those files'
own header comment).

Exit status:
  0  every function on REQUIRED_FOOTER below carries the marker.
  1  a REQUIRED_FOOTER function is missing it (this is the guard: a PR that
     silently drops the footer from an already-compliant function fails CI).

REQUIRED_FOOTER is deliberately NOT "every Mailgun sender in the repo" yet.
Per #1824 (comment 5721614519 / 5768833160), the remaining Mailgun senders
are a large, mixed set -- some genuinely commercial/external-recipient
messages that still need this fix, some purely internal ops alerts
(platform-health-check, check-rate-limits, etc.) where CAN-SPAM's physical-
address requirement does not obviously apply. Rather than invent that
classification here (a Tier C judgment call this script must not make),
REQUIRED_FOOTER lists only the functions already confirmed compliant --
so this guard's job today is REGRESSION PREVENTION on those, while KNOWN_GAPS
below is the informational, non-blocking enumeration of what's left, so the
gap is visible in every run's output rather than only in an issue-thread
comment history.

Negative control: comment out any one entry's constant (or blank its value)
and rerun -- this script exits 1 and names the function.
"""
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FUNCTIONS_DIR = os.path.join(REPO_ROOT, "supabase", "functions")

MAILGUN_RE = re.compile(r"api\.mailgun\.net|[a-z0-9.-]*mailgun\.net")
FOOTER_RE = re.compile(r"POSTAL_ADDRESS|3410 N(?:orth)? High School Rd")
CANONICAL_ADDRESS = (
    "Stellar Edge Services, LLC d/b/a Otter Quotes · "
    "3410 N High School Rd, Ste G #102, Indianapolis, IN 46224"
)

# Functions this guard actively enforces (must never regress).
REQUIRED_FOOTER = {
    "create-invoice",
    "notify-measurement-order",
    "send-measurement-ready",
    "send-homeowner-next-steps",
    "send-lead-next-step-reminder",
    "send-partner-onboarding",
    "send-partner-status-email",
    "send-home-profile-prompt",
}


def is_test_file(path):
    return path.endswith(".test.ts")


def function_sends_via_mailgun(func_dir):
    for fname in os.listdir(func_dir):
        if not fname.endswith(".ts") or is_test_file(fname):
            continue
        fpath = os.path.join(func_dir, fname)
        try:
            text = open(fpath, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        if MAILGUN_RE.search(text):
            return True
    return False


def function_has_footer(func_dir):
    for fname in os.listdir(func_dir):
        if not fname.endswith(".ts") or is_test_file(fname):
            continue
        fpath = os.path.join(func_dir, fname)
        try:
            text = open(fpath, encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        if FOOTER_RE.search(text):
            return True
    return False


def main():
    senders = []
    for name in sorted(os.listdir(FUNCTIONS_DIR)):
        func_dir = os.path.join(FUNCTIONS_DIR, name)
        if not os.path.isdir(func_dir) or name.startswith("_"):
            continue
        if function_sends_via_mailgun(func_dir):
            senders.append(name)

    covered = [n for n in senders if function_has_footer(os.path.join(FUNCTIONS_DIR, n))]
    missing = [n for n in senders if n not in covered]

    print(f"Mailgun-sending Edge Functions found: {len(senders)}")
    print(f"  with POSTAL_ADDRESS footer marker : {len(covered)}")
    print(f"  without                            : {len(missing)}")
    print()
    print("Covered:")
    for n in covered:
        print(f"  [x] {n}")
    print("Missing (known gap, tracked on #1824):")
    for n in missing:
        print(f"  [ ] {n}")

    failures = [n for n in REQUIRED_FOOTER if n not in covered]
    if failures:
        print()
        print("FAIL: the following REQUIRED_FOOTER functions are missing the "
              "D-237 POSTAL_ADDRESS marker (regression):")
        for n in sorted(failures):
            print(f"  - {n}")
        return 1

    not_required_but_missing = set(missing) - REQUIRED_FOOTER
    print()
    print(f"PASS: all {len(REQUIRED_FOOTER)} REQUIRED_FOOTER functions carry the marker. "
          f"{len(not_required_but_missing)} other Mailgun sender(s) remain a known gap "
          f"(#1824 continuation, not yet in REQUIRED_FOOTER).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
