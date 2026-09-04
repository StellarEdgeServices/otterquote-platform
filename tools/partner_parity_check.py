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
  - post-signup dashboard-access block: the 5 vertical signup pages ONLY.
    (The Get-the-App promo block this check used to also require was removed
    from all 5 vertical pages -- gh-1261 -- so that check was deleted rather
    than widened to a five-page exemption; see check_get_the_app_promo's old
    entry in git history if it needs reviving.)

REACT PARITY (D-266, this file's second half): the four checks above read
root-level *.html only, so they were structurally blind to react-app/ -- the
Next.js port that a cutover would publish in place of those pages. D-266's
disclaimer was dropped entirely in the port of refer-a-friend.html -> /refer
and CI stayed green, because no check in this repo could see a .tsx file. The
React half below closes that: for each React route with a static twin, if the
twin carries the D-266 text then the React route must (a) carry the text
verbatim in its route-local copy and (b) actually RENDER it from page.tsx.
The requirement is DERIVED from the twin rather than asserted, so the two
halves cannot drift apart. A React route that looks like a referral funnel
surface but has no twin mapping is itself reported, so the next ported funnel
cannot go invisible the way /refer did.

Note on matching: the canonical sentence is compared with whitespace
NORMALIZED, not as a literal substring. partners.html wraps it across four
source lines (partners.html:215-218); a literal `in` test reports that page as
missing the disclaimer when it plainly has it. Every comparison in this file
runs through _norm().

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

REACT_APP_DIR = REPO_ROOT / "react-app" / "app"

# React route (relative to react-app/app) -> its static HTML twin. The D-266
# requirement is DERIVED: a React route is only required to carry the
# disclaimer when its twin carries it, so the static and React halves of this
# check can never disagree about what is mandatory.
REACT_TWINS = {
    "partner/dashboard": "partner-dashboard.html",
    "refer": "refer-a-friend.html",
}

# A react-app route that builds or displays a referral / recruit link is a
# referral funnel surface. If one shows up that REACT_TWINS has no entry for,
# say so instead of silently skipping it -- an unmapped funnel surface is
# exactly how /refer stayed invisible to this script (D-266 gap).
REACT_FUNNEL_RE = re.compile(
    r"referralUrl|referralLink|recruitLink|referral-link|REFERRAL_FEE_DISCLAIMER"
)

# Exported `const NAME =` in a route-local copy module, for the render check.
REACT_CONST_RE = re.compile(r"export const ([A-Z0-9_]+)\s*=")

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


def _norm(text: str) -> str:
    """Collapse all whitespace runs to single spaces.

    The canonical D-266 sentence is one sentence, but source files are free to
    wrap it: partners.html:215-218 breaks it across four lines, and a literal
    substring test calls that page non-compliant when it is compliant. Every
    D-266 comparison in this file normalizes both sides first.
    """
    return re.sub(r"\s+", " ", text)


def check_d266_disclaimer(html: str) -> bool:
    return _norm(D266_TEXT) in _norm(html)


def check_signed_in_redirect(html: str) -> bool:
    return STAY_ESCAPE_RE.search(html) is not None


def check_dashboard_access_block(html: str) -> bool:
    return "/partner-dashboard.html" in html and GO_TO_DASHBOARD_RE.search(html) is not None


def _react_route_sources(route: str) -> dict[str, str]:
    """Route-local .ts/.tsx sources, keyed by filename (non-recursive).

    Non-recursive on purpose: __tests__/ pins the constant but never renders
    it, so counting a test file as "the copy is present" would make the
    render half of this check vacuous.
    """
    route_dir = REACT_APP_DIR / route
    if not route_dir.is_dir():
        return {}
    return {
        f.name: f.read_text(encoding="utf-8", errors="ignore")
        for f in sorted(route_dir.iterdir())
        if f.is_file() and f.suffix in (".ts", ".tsx")
    }


def check_react_d266(route: str) -> list[str]:
    """Return failure strings for one React route (empty list == pass).

    Two halves, because either alone is defeatable: the disclaimer must exist
    verbatim in the route's copy, AND page.tsx must actually render it. A
    constant nobody renders is not a disclosure.
    """
    sources = _react_route_sources(route)
    if not sources:
        return [f"react-app/app/{route}: MISSING ROUTE DIRECTORY"]

    page = sources.get("page.tsx")
    if page is None:
        return [f"react-app/app/{route}: MISSING page.tsx"]

    target = _norm(D266_TEXT)
    carriers = [name for name, src in sources.items() if target in _norm(src)]
    if not carriers:
        return [
            f"react-app/app/{route}: missing D-266 disclaimer verbatim text "
            f"(react_d266_disclaimer)"
        ]

    # Rendered directly as a literal, or via a constant page.tsx references.
    if target in _norm(page):
        return []
    for name in carriers:
        for const in REACT_CONST_RE.findall(sources[name]):
            body = sources[name].split(f"export const {const}", 1)[1]
            # the constant whose value IS the disclaimer, not a later one
            if target in _norm(body.split("export const", 1)[0]) and const in page:
                return []

    return [
        f"react-app/app/{route}: D-266 disclaimer present in "
        f"{'/'.join(carriers)} but never rendered by page.tsx "
        f"(react_d266_rendered)"
    ]


def find_unmapped_react_funnels() -> list[str]:
    """React routes that look like referral funnels but REACT_TWINS omits."""
    if not REACT_APP_DIR.is_dir():
        return []
    findings = []
    for page in sorted(REACT_APP_DIR.rglob("page.tsx")):
        route = page.parent.relative_to(REACT_APP_DIR).as_posix()
        if route in REACT_TWINS:
            continue
        if REACT_FUNNEL_RE.search(page.read_text(encoding="utf-8", errors="ignore")):
            findings.append(
                f"react-app/app/{route}: looks like a referral funnel surface but has "
                f"no REACT_TWINS entry -- add it (with its static twin) or explain why "
                f"D-266 does not apply (react_twin_unmapped)"
            )
    return findings


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

    # ── React parity half (D-266) ────────────────────────────────────────────
    # Root-level *.html is only what main publishes TODAY; react-app/ is what a
    # cutover publishes instead. A disclaimer that survives in one and not the
    # other is a gap this script previously could not see at all.
    react_routes = []
    for route, twin in sorted(REACT_TWINS.items()):
        twin_path = REPO_ROOT / twin
        if not twin_path.is_file():
            failures.append(f"{twin}: MISSING FILE (static twin of react-app/app/{route})")
            continue
        if not check_d266_disclaimer(twin_path.read_text(encoding="utf-8", errors="ignore")):
            # The twin itself lost it -- reported by the static half above for
            # pages in D266_PAGES; nothing to require of the React port here.
            continue
        react_routes.append(route)
        failures.extend(check_react_d266(route))
    failures.extend(find_unmapped_react_funnels())

    checked_pages = sorted(set(ALL_PAGES) | set(D266_PAGES))
    if failures:
        print("Partner parity check: FAIL\n")
        for f in failures:
            print(f"  [FAIL] {f}")
        print(
            f"\n{len(failures)} structural drift issue(s) found across "
            f"{len(checked_pages)} partner pages and {len(react_routes)} React route(s)."
        )
        return 1

    print(
        f"Partner parity check: PASS -- {len(checked_pages)} pages, {len(CHECKS)} checks, "
        f"{len(react_routes)} React route(s) D-266-covered, no drift."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
