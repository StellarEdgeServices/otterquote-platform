#!/usr/bin/env python3
"""Partner-path structural parity check (gh-634).

Guards against the #618/#632/#633 defect class: a fix landing on one
partner-facing page but not its siblings, discovered only when someone
reads the file by hand. Fails (non-zero exit) on any structural drift
from the applicability matrix below.

The matrix is NOT "all 8 pages need all 5 elements" -- that was checked
against the live pages on main and is false by design, not by drift:
partner-app.html doesn't promote itself, partner-dashboard.html IS the
redirect target so redirecting-to-itself is meaningless, and
partner-login.html is a bare magic-link form with no referral action.
Each check below lists exactly the pages it applies to, verified by
reading every page's actual markup rather than assumed.

  - site chrome (site-header/site-footer ids + js/nav.js): ALL 8 pages.
    Basic page furniture, not referral-specific -- the one check that
    legitimately applies everywhere.
  - D-266 disclaimer: 7 of 8 (everywhere a partner could be party to a
    referral-fee arrangement). NOT partner-login.html.
  - signed-in-partner redirect snippet (?stay=1 escape): 6 of 8 (the 5
    vertical signup pages + partner-app.html). NOT partner-login.html
    (gh-737: decided as an intentional exception, not drift -- it's a bare
    magic-link form with no content a signed-in user would want to revisit,
    unlike the marketing/signup pages the escape exists for) and NOT
    partner-dashboard.html (it is the redirect destination).
  - Get-the-App promo block + post-signup dashboard-access block: the 5
    vertical signup pages ONLY.

gh-634's 2026-08-11 adversarial review flagged partner-login.html's missing
?stay=1 escape as an open gap needing its own decision, tracked separately
as gh-737 rather than resolved silently by this tool's exclusion list. gh-737
settled it (see the signed_in_redirect entry above): intentional exception,
not drift. partner-login.html's own redirect block carries a matching
comment recording the same decision.
"""
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

VERTICAL_PAGES = [
    "partner-re",
    "partner-insurance",
    "partner-inspectors",
    "partner-adjusters",
    "partner-other",
]
ALL_PAGES = VERTICAL_PAGES + ["partner-app", "partner-login", "partner-dashboard"]

# gh-1254: partner-insurance grew sibling pages (partner-insurance-fees.html,
# partner-insurance-how-it-works.html, partner-insurance-why.html) that the
# hardcoded ALL_PAGES/VERTICAL_PAGES lists above have no slot for, making them
# structurally invisible to this script. Rather than hardcode each new sibling
# by hand (repeating the exact defect this tool exists to catch), the D-266
# disclaimer check discovers its own page set by globbing partner-insurance*.html
# at the repo root and unioning it with the other non-insurance, non-login pages
# from ALL_PAGES. Only the discovery mechanism for this one check changes; the
# other checks keep using ALL_PAGES/VERTICAL_PAGES unchanged.
D266_PAGES = sorted(
    {p.stem for p in REPO_ROOT.glob("partner-insurance*.html")}
    | {p for p in ALL_PAGES if p not in ("partner-insurance", "partner-login")}
)

D266_TEXT = (
    "Check your employment agreement and your governing licensing agency "
    "to make sure it is lawful for you to accept referral fees."
)

SITE_HEADER_RE = re.compile(r'<header\b[^>]*\bid=["\']site-header["\']')
SITE_FOOTER_RE = re.compile(r'<footer\b[^>]*\bid=["\']site-footer["\']')
# Matches both `=== '1'` (partner-other.html-style opt-out check) and
# `!== '1'` (partner-app.html-style inverted guard) — same escape, written
# either direction depending on how the surrounding condition is phrased.
STAY_ESCAPE_RE = re.compile(r'''get\(['"]stay['"]\)\s*[!=]==\s*['"]1['"]''')
GO_TO_DASHBOARD_RE = re.compile(r'Go to\s+(Partner\s+)?Dashboard', re.IGNORECASE)


def check_site_chrome(html: str) -> bool:
    return (
        SITE_HEADER_RE.search(html) is not None
        and SITE_FOOTER_RE.search(html) is not None
        and "js/nav.js" in html
    )


def check_d266_disclaimer(html: str) -> bool:
    return D266_TEXT in html


def check_signed_in_redirect(html: str) -> bool:
    return STAY_ESCAPE_RE.search(html) is not None


def check_get_the_app_promo(html: str) -> bool:
    return "/partner-app.html" in html and "Get the App" in html


def check_dashboard_access_block(html: str) -> bool:
    return "/partner-dashboard.html" in html and GO_TO_DASHBOARD_RE.search(html) is not None


CHECKS = [
    {
        "key": "site_chrome",
        "description": "site-header/site-footer ids + js/nav.js include",
        "pages": ALL_PAGES,
        "test": check_site_chrome,
    },
    {
        "key": "d266_disclaimer",
        "description": "D-266 disclaimer verbatim text",
        "pages": [p for p in ALL_PAGES if p != "partner-login"],
        "test": check_d266_disclaimer,
    },
    {
        "key": "signed_in_redirect",
        "description": "signed-in-partner redirect snippet (?stay=1 escape)",
        "pages": VERTICAL_PAGES + ["partner-app"],
        "test": check_signed_in_redirect,
    },
    {
        "key": "get_the_app_promo",
        # partner-insurance is exempt as of 2026-08-25, Dustin-directed:
        # "Remove the 'Get the Otter Quotes Partner app'. That should be once
        # they are in." The promo was competing with the signup form on a page
        # whose only job is to convert a cold insurance agent, and the app is
        # useless to someone who has no account yet.
        #
        # This is a ONE-PAGE exemption, not a policy change, because that is
        # the only page the instruction covered. NOTE FOR WHOEVER READS THIS
        # NEXT: the same argument applies verbatim to the other four vertical
        # pages, which still carry the promo above the fold for logged-out
        # visitors. If that is resolved, delete this exemption rather than
        # widening it — a parity check with five exemptions is not a parity
        # check.
        "description": "Get-the-App promo block",
        "pages": [p for p in VERTICAL_PAGES if p != "partner-insurance"],
        "test": check_get_the_app_promo,
    },
    {
        "key": "dashboard_access_block",
        "description": "post-signup dashboard-access block",
        "pages": VERTICAL_PAGES,
        "test": check_dashboard_access_block,
    },
]


def main() -> int:
    failures = []
    for page in ALL_PAGES:
        path = REPO_ROOT / f"{page}.html"
        if not path.is_file():
            failures.append(f"{page}.html: MISSING FILE")
            continue
        html = path.read_text(encoding="utf-8", errors="ignore")
        for check in CHECKS:
            if check["key"] == "d266_disclaimer":
                continue  # handled below via glob-discovered D266_PAGES (gh-1254)
            if page not in check["pages"]:
                continue
            if not check["test"](html):
                failures.append(f"{page}.html: missing {check['description']} ({check['key']})")

    # D-266 disclaimer check uses its own glob-discovered page set (gh-1254)
    # instead of the ALL_PAGES loop above, so newly-added partner-insurance
    # siblings are visible without editing a hardcoded list.
    for page in D266_PAGES:
        path = REPO_ROOT / f"{page}.html"
        if not path.is_file():
            failures.append(f"{page}.html: MISSING FILE")
            continue
        html = path.read_text(encoding="utf-8", errors="ignore")
        if not check_d266_disclaimer(html):
            failures.append(f"{page}.html: missing D-266 disclaimer verbatim text (d266_disclaimer)")

    checked_pages = sorted(set(ALL_PAGES) | set(D266_PAGES))
    if failures:
        print("Partner parity check: FAIL\n")
        for f in failures:
            print(f"  [FAIL] {f}")
        print(f"\n{len(failures)} structural drift issue(s) found across {len(checked_pages)} partner pages.")
        return 1

    print(f"Partner parity check: PASS -- {len(checked_pages)} pages, {len(CHECKS)} checks, no drift.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
