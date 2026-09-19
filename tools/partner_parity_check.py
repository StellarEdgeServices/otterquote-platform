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
# gh-2020 comment 5737683786 (amended closes-on) (4): partners.html is the
# profession-picker hub the vertical pages link out from. It carries
# D266_TEXT verbatim (wrapped across partners.html:210-211 -- see the
# whitespace-normalization note above) but was in neither ALL_PAGES nor
# D266_PAGES, so nothing in this file verified it: the disclaimer could be
# deleted from it and every check here stayed green. Registered directly in
# D266_PAGES (not ALL_PAGES, since site-chrome/signed-in-redirect/
# dashboard-access-block do not apply to this page) so it now gets the same
# D-266 presence check as the other partner pages via the loop in main().
D266_PAGES = sorted(
    {p.stem for p in REPO_ROOT.glob("partner-insurance*.html")}
    | {p for p in ALL_PAGES if p not in ("partner-insurance", "partner-login")}
    | {"partners"}
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

# gh-2020 / D-266: js/router-discovery.js is a NON-html, non-React partner
# surface (draft #2019's file, three partner/referral-fee funnels -- realtor,
# insurance, inspector/PM -- inside one router module). A .js module matches
# no ALL_PAGES entry and no partner-insurance*.html glob, so without this
# registration it is invisible to every check in this file, exactly the way
# /refer was invisible before REACT_TWINS existed. May not exist in this tree
# yet (see check_js_d266_surfaces) -- its absence is tolerated, not a failure.
D266_JS_SURFACES = [
    "js/router-discovery.js",
]

# gh-2020 comment 5737683786 (amended closes-on): check_js_d266_surfaces()
# below was a WHOLE-FILE presence test -- it passed if D266_TEXT appeared
# anywhere in the module, so deleting the disclaimer from any ONE track
# while a sibling track's occurrence survived left the check green and
# named nothing. Reproduced live against js/router-discovery.js: deleting
# only the insurance track's occurrence (leaving the realtor track's intact)
# stayed exit 0; only deleting BOTH flipped it to exit 1. These regexes
# derive the track list from the module's own step vocabulary instead of a
# hand-maintained Python literal, so a track added later is picked up
# without an edit here.
#
# A "track" is discovered from its own RENDERERS['c-<name>-close'] screen --
# the step that actually displays the close-copy paragraphs -- and the
# COPY.<name>Close array that screen's body renders via .forEach(). Both are
# read structurally from the file text, not asserted by name.
JS_D266_CLOSE_RENDERER_RE = re.compile(
    r"RENDERERS\['c-([a-z0-9]+)-close'\]\s*=\s*function\s*\([^)]*\)\s*\{\n(.*?)\n  \};",
    re.DOTALL,
)
# A track is a "referral/partner track" -- as opposed to the c-home-*
# homeowner-quote flow, which is a different funnel entirely and reachable
# through this same file's RENDERERS map -- when its own contact/completion
# screen calls renderPartnerContact(...). That is the module's own signal
# for "this track hands off to a partner enrollment," not a hand-picked
# name list: the homeowner flow completes a different way and never calls
# renderPartnerContact, so it is never swept in here.
JS_D266_PARTNER_CONTACT_RE = re.compile(
    r"RENDERERS\['c-([a-z0-9]+)-contact'\]\s*=\s*function\s*\([^)]*\)\s*\{\n(.*?)\n  \};",
    re.DOTALL,
)
JS_D266_COPY_FOREACH_RE = re.compile(r"COPY\.(\w+)\.forEach")
JS_D266_PARTNER_INDUSTRY_RE = re.compile(r"partnerIndustry:\s*'([a-zA-Z_]+)'")

# Tracks this module defines that carry NO D-266 disclaimer BY DESIGN, with
# the reason on record -- mirrors STATIC_FUNNEL_EXEMPT's written-reason
# convention below. This dict is NOT how the checked-track list is derived
# (that is structural, from JS_D266_CLOSE_RENDERER_RE above); it is only how
# a track that has an entry screen but deliberately no close-disclaimer
# screen gets DECLARED rather than silently skipped (gh-2020 (3c)). A track
# with neither a close screen nor an entry here fails loudly instead of
# passing green with nothing said (see check_js_d266_surfaces).
JS_D266_EXEMPT_TRACKS = {
    "contractor": (
        "platform fee, not a referral fee -- a contractor is not a referral "
        "partner (js/router-discovery.js:~1007)"
    ),
}


def _js_track_industry_labels() -> dict[str, str]:
    """Human labels for partnerIndustry codes, read from js/agent-types.js's
    own AGENT_TYPE_CHOOSER_LABELS rather than hand-copied here, so a label
    can't drift between the two files. Returns {} if that file or dict shape
    is unavailable -- callers fall back to the raw track id in that case.
    """
    path = REPO_ROOT / "js" / "agent-types.js"
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8", errors="ignore")
    m = re.search(r"AGENT_TYPE_CHOOSER_LABELS\s*=\s*\{(.*?)\n\};", text, re.DOTALL)
    if not m:
        return {}
    return dict(re.findall(r"(\w+):\s*'([^']*)'", m.group(1)))


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
# `!== '1'` (partner-app.html-style inverted guard) -- same escape, written
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


def check_js_d266_surfaces() -> tuple[list[str], list[str]]:
    """D-266 disclaimer check for JS-module partner surfaces (gh-2020).

    js/router-discovery.js may not exist in this tree yet -- its absence is
    TOLERATED (not a failure) so this guard can land ahead of the draft that
    creates it. Once it exists, TWO layers apply, because either alone is
    defeatable:

      1. WHOLE-FILE FLOOR (kept from before gh-2020 comment 5737683786's
         amendment): the disclaimer must appear SOMEWHERE in the file at
         all. Catches "the sentence is gone entirely" and remains the
         backstop if layer 2's structural parsing can't discover any
         tracks (e.g. a rewrite this regex doesn't anticipate) -- a
         different, still-real failure mode from layer 2 below.
      2. PER-TRACK (the amendment itself): within EACH referral-fee track's
         OWN close-copy scope, not just the file at large. A track passing
         the whole-file floor while missing its own disclaimer -- because a
         SIBLING track's copy still carries it -- is exactly the hole
         layer 1 alone could not see; deleting only the insurance track's
         occurrence left the pre-amendment check at exit 0, naming nothing.

    Tracks are DISCOVERED, not hand-listed: JS_D266_CLOSE_RENDERER_RE finds
    every RENDERERS['c-<name>-close'] screen and the COPY.<name>Close array
    it renders. A track built later (a new c-<name>-close renderer plus its
    own COPY array) is picked up automatically -- nothing here needs
    editing. A partner track -- one whose own c-<name>-contact screen calls
    renderPartnerContact(...), the module's own signal for "hands off to a
    partner enrollment," distinct from the unrelated c-home-* homeowner
    quote flow this same file also routes -- that has no close screen is
    either a DECLARED exemption (JS_D266_EXEMPT_TRACKS, with a written
    reason -- e.g. the contractor track's platform fee) or, if undeclared,
    a failure: gh-2020 (3c) requires an exemption to be stated, not silently
    skipped, so an undeclared no-close track cannot pass green either.
    """
    failures: list[str] = []
    notes: list[str] = []
    for surface in D266_JS_SURFACES:
        path = REPO_ROOT / surface
        if not path.is_file():
            notes.append(
                f"{surface}: not present in this tree yet -- skipped, not failed "
                f"(gh-2020 registers it ahead of draft #2019 landing it)"
            )
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")

        # Layer 1 -- whole-file floor.
        if not check_d266_disclaimer(text):
            failures.append(
                f"{surface}: missing D-266 disclaimer verbatim text (d266_js_surface)"
            )

        # Layer 2 -- per-track, discovered from the module's own vocabulary.
        close_matches = list(JS_D266_CLOSE_RENDERER_RE.finditer(text))
        if not close_matches:
            notes.append(
                f"{surface}: no c-<track>-close renderer discovered -- per-track "
                f"D-266 check not applicable this run; relying on the whole-file "
                f"floor above (d266_js_no_tracks_discovered)"
            )

        labels = _js_track_industry_labels()
        close_track_ids: set[str] = set()
        for m in close_matches:
            track_id = m.group(1)
            close_track_ids.add(track_id)
            route = f"c-{track_id}-close"
            body = m.group(2)

            copy_match = JS_D266_COPY_FOREACH_RE.search(body)
            if not copy_match:
                failures.append(
                    f"{surface}: {route} renders no discoverable COPY.<name>Close "
                    f"array -- extend this parser or the renderer "
                    f"(d266_js_track_unparseable)"
                )
                continue
            copy_name = copy_match.group(1)
            array_match = re.search(
                r"\b" + re.escape(copy_name) + r"\s*:\s*\[(.*?)\]", text, re.DOTALL
            )
            if not array_match:
                failures.append(
                    f"{surface}: {route} references COPY.{copy_name} but its array "
                    f"literal could not be located (d266_js_track_unparseable)"
                )
                continue

            industry_match = JS_D266_PARTNER_INDUSTRY_RE.search(
                text[m.start(): m.start() + 4000]
            )
            label = track_id
            if industry_match:
                raw_label = labels.get(industry_match.group(1))
                if raw_label:
                    label = (
                        raw_label.replace(" Agent", "").replace(" agent", "").strip().lower()
                        or track_id
                    )

            if not check_d266_disclaimer(array_match.group(1)):
                failures.append(
                    f"{surface}: {label} track ({route}) missing D-266 disclaimer "
                    f"(d266_js_track)"
                )

        partner_track_ids = {
            m.group(1)
            for m in JS_D266_PARTNER_CONTACT_RE.finditer(text)
            if "renderPartnerContact(" in m.group(2)
        }
        for track_id in sorted(partner_track_ids - close_track_ids):
            reason = JS_D266_EXEMPT_TRACKS.get(track_id)
            if reason is not None:
                notes.append(
                    f"{surface}: {track_id} track (c-{track_id}-*) exempt from "
                    f"D-266 -- {reason}"
                )
            else:
                failures.append(
                    f"{surface}: {track_id} track (c-{track_id}-contact) hands "
                    f"off to a partner but has no c-{track_id}-close disclaimer "
                    f"screen, and is not a declared D-266 exemption -- add a "
                    f"close screen with the disclaimer, or add it to "
                    f"JS_D266_EXEMPT_TRACKS with a written reason "
                    f"(d266_js_track_undeclared)"
                )
    return failures, notes


# gh-2020 / D-266: the static analogue of find_unmapped_react_funnels() above.
# js/router-discovery.js was invisible to every check in this file -- not in
# ALL_PAGES, not matched by the partner-insurance*.html glob, not a React
# route -- because a .js module is not an .html page. This closes that CLASS
# of gap, not just this one instance: any non-React, non-partner-* file
# carrying referral-fee-shaped content with no entry anywhere in the checked
# set is reported here, the same way an unmapped React funnel is reported
# above.
#
# Scope is root-level *.html and top-level js/*.js, matching this file's
# existing convention that "root-level *.html is only what main publishes
# TODAY" (see the React-parity docstring above): blog/ and guides/ are
# consumer-education content, never a funnel surface, and admin-*.html is
# internal staff-only tooling that can never be partner-facing, so neither
# is a source of D-266 risk worth scanning here.
STATIC_FUNNEL_RE = re.compile(r"\$200\b|referral[\s-]?link|referral[\s-]?fee", re.IGNORECASE)

# (relative path -> reason) -- files that match STATIC_FUNNEL_RE today but are
# not themselves a partner/referral-fee enrollment funnel, so D-266
# registration does not apply. Written-reason convention mirrors
# scripts/check-credential-claims.py's ALLOWLIST -- never add an entry here
# without one, and never add one to quiet a real gap.
STATIC_FUNNEL_EXEMPT = {
    "contractor-login.html": (
        "Contractor-facing sales copy contrasting OtterQuote with buying ads "
        "(\"no truck, gas, or referral fees needed\") -- addressed to "
        "contractors, not a partner referral-fee enrollment funnel."
    ),
    "faq.html": (
        "Homeowner-facing FAQ answer stating that a referral program exists "
        "and how it is paid -- informational, not itself an enrollment "
        "funnel a partner would go through."
    ),
    "privacy.html": (
        "Privacy-policy disclosure describing what a referrer sees about "
        "your project after they refer you -- legal data-sharing text, not "
        "a partner funnel."
    ),
    "recruit.html": (
        "Client-side redirect router (title: \"Recruit Router\") with no "
        "visible referral-fee copy of its own; the match is a JS "
        "implementation comment about recruit-code attribution plumbing, "
        "not rendered funnel text."
    ),
    "ref.html": (
        "Short-link redirect/resolver page; the match is its \"Referral link "
        "not found\" error state, not fee content."
    ),
    # partners.html: no longer exempt -- gh-2020 comment 5737683786 (4)
    # registers it directly in D266_PAGES (see that constant's comment
    # above), so it is now checked there and no longer needs an entry here.
    "js/auth.js": (
        "Source-code comment describing referral-status tracking logic "
        "(\"Advance referral status ... if homeowner arrived via referral "
        "link\") -- not rendered funnel copy."
    ),
    "js/ga-gate.js": (
        "Source-code comment using \"referral link\" as an example while "
        "explaining analytics-gating behavior -- not rendered funnel copy."
    ),
}


def _static_funnel_checked_set() -> set[str]:
    """Every surface this script already verifies, by stem or relative path."""
    checked = set(ALL_PAGES) | set(D266_PAGES) | set(D266_JS_SURFACES)
    checked |= {Path(twin).stem for twin in REACT_TWINS.values()}
    return checked


def find_unmapped_static_funnels() -> list[str]:
    """Non-React, non-partner-* files that look like a referral-fee funnel
    but are registered nowhere in this script (gh-2020)."""
    checked = _static_funnel_checked_set()
    findings = []
    candidates = sorted(REPO_ROOT.glob("*.html"))
    js_dir = REPO_ROOT / "js"
    if js_dir.is_dir():
        candidates += sorted(js_dir.glob("*.js"))
    for path in candidates:
        rel_path = path.relative_to(REPO_ROOT).as_posix()
        if path.stem in checked or rel_path in checked:
            continue
        if path.name.startswith("partner-") or path.name.startswith("admin-"):
            continue
        if rel_path in STATIC_FUNNEL_EXEMPT:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        if STATIC_FUNNEL_RE.search(text):
            findings.append(
                f"{rel_path}: looks like a referral-fee funnel surface but is "
                f"registered nowhere in this script -- add it to D266_PAGES / "
                f"D266_JS_SURFACES (with the disclaimer) or explain why D-266 "
                f"does not apply (static_funnel_unmapped)"
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

    # ── React parity half (D-266) ───────────────────────────────────────────────────────────────
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

    # gh-2020: JS-module D-266 surfaces (currently just js/router-discovery.js)
    # and the static-file analogue of find_unmapped_react_funnels().
    js_failures, js_notes = check_js_d266_surfaces()
    failures.extend(js_failures)
    failures.extend(find_unmapped_static_funnels())

    checked_pages = sorted(set(ALL_PAGES) | set(D266_PAGES))
    for note in js_notes:
        print(f"  [NOTE] {note}")
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
