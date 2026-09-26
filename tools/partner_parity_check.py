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
# gh-2020 refuter (comment 5779401001) N20/N21/N22: the old glob above only
# matched partner-insurance*.html, so a new vertical (partner-lenders.html)
# or an existing, unlisted partner-*.html page (partner-agreement.html) was
# invisible to this check, and refer-a-friend.html -- not a partner-*.html
# name at all -- was never registered here even though its own React twin
# loop (see main()) explicitly assumes it would be ("reported by the static
# half above for pages in D266_PAGES"), which was false until now.
#
# gh-2150 RE-1 / D-333: re-1.html is a dedicated single-funnel landing page
# outside the partner-*.html naming convention. It carries the D-266
# disclaimer (approved copy, #2150 comment 5821403227) and is a
# referral-fee funnel surface exactly like partner-re.html, so it is
# registered explicitly (see `explicit` in compute_d266_pages() below).
#
# gh-2151 INS-1 / D-333: ins-1.html, same shape as re-1 above (approved
# copy, #2151 comment 5821408557), also registered explicitly.
#
# gh-2155 HI-0b / D-333 (Ben, comment 5824245098): home inspectors receive
# no referral fee at all (partner-agreement.html Section 4.3), so the D-266
# "make sure it is lawful for you to accept referral fees" warning does not
# apply to that track and partner-inspectors.html no longer carries it.
# gh-2020 CLOSE-REVIEW: FAIL (comment 5824278669) rejected a plain static
# exemption entry for this: `D266_PAGES_EXEMPT` (or an unconditional
# removal from the required set) beats the fee census, so if a referral fee
# ever reappeared on partner-inspectors.html (by mistake or by a future
# track change) it would pass silently -- the exact regression D-333 exists
# to prevent. Instead, partner-inspectors is removed only from the
# unconditional `named` set below (mirroring partner-insurance/
# partner-login, which are also carved out of `named` because they are
# already covered by other layers); it remains fully exposed to the
# fail-closed `fee_pages` census layer. So: no fee sentence on the page ->
# not required to carry D266_TEXT (the D-333 exemption applies); a fee
# sentence reappears -> the census re-adds it to the required set and an
# undisclaimed fee on that page is a FAILURE again, per CLOSE-REVIEW's
# recommendation (a).
#
# Three layers, so a page can't go uncovered just by not matching a naming
# convention:
#   1. Every partner-*.html page, by glob (was partner-insurance*.html only).
#   2. partners.html, refer-a-friend.html, re-1.html and ins-1.html, named
#      explicitly (none matches the partner-*.html glob).
#   3. FAIL-CLOSED CONTENT CENSUS: any *.html page anywhere at the repo
#      root whose own text contains a referral-fee sentence (a dollar
#      amount and the word "referral" in the same sentence) is swept in
#      regardless of its filename -- so a page that follows neither naming
#      convention still cannot carry real fee copy with no disclaimer
#      requirement attached to it. This layer is also what lets the
#      partner-inspectors D-333 exemption above fail closed rather than
#      open.
# A small, written-reason exemption list (D266_PAGES_EXEMPT below) removes
# the handful of partner-*.html pages that are known, by inspection, to
# carry no referral-fee copy of their own (mirrors STATIC_FUNNEL_EXEMPT's
# convention) -- never add to it to silence a real gap.
#
# gh-2020 REVIEW: FAIL (comment 5780386929) X3/X4/X5/N23c: the fee-sentence
# regex used to require a literal `$\d` amount, the exact token "referral"
# and no newline or "." between them, so a line-wrapped fee ("Earn $250 for
# every borrower ... \nwhose project completes"), a decimal amount
# ("$250.00"), a spelled-out amount ("two hundred dollars") or the approved
# copy's own "you refer" phrasing (not the bare noun "referral") all read as
# absent. FEE_SENTENCE_RE now runs against whitespace-NORMALIZED text (see
# _norm(), applied by _fee_sentence_pages() below before sentence-splitting,
# so a source line-wrap can no longer break the match), accepts a decimal
# cents suffix, accepts spelled-out amounts up to "ninehundred"-class
# compounds and "thousand", and widens the fee-word family to the same
# refer*/recruit family D-301 already recognizes as referral-fee vocabulary.
FEE_SENTENCE_RE = re.compile(
    r"\$\d[\d,]*(?:\.\d{2})?\b[^.!?\n]{0,200}\b(?:refer(?:ral|red|rer|s)?|recruit(?:s|ed|ment)?)|"
    r"\b(?:refer(?:ral|red|rer|s)?|recruit(?:s|ed|ment)?)[^.!?\n]{0,200}\$\d[\d,]*(?:\.\d{2})?\b|"
    r"\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|"
    r"fifty|sixty|seventy|eighty|ninety|hundred|thousand)"
    r"(?:[\s-]+(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|"
    r"forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand))*"
    r"\s+dollars\b[^.!?\n]{0,200}\b(?:refer(?:ral|red|rer|s)?|recruit(?:s|ed|ment)?)|"
    r"\b(?:refer(?:ral|red|rer|s)?|recruit(?:s|ed|ment)?)[^.!?\n]{0,200}"
    r"\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|"
    r"fifty|sixty|seventy|eighty|ninety|hundred|thousand)"
    r"(?:[\s-]+(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|"
    r"forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand))*"
    r"\s+dollars\b",
    re.IGNORECASE,
)

D266_PAGES_EXEMPT = {
    "partner-login": (
        "bare magic-link sign-in form; mentions \"referral fee status\" as a "
        "dashboard label, not a fee-sentence disclosure of its own (gh-737)."
    ),
    "partner-app-install-android": "app-store install instructions only, no fee copy.",
    "partner-app-install-ios": "app-store install instructions only, no fee copy.",
    "partner-profile": "signed-in partner's own account/profile settings page, no fee copy.",
    # The three entries below are the fee-sentence census's real findings
    # against the pre-existing tree (verified 2026-09-22 while closing
    # gh-2020 refuter comment 5779401001): each carries a $-amount-plus-
    # "referral" sentence, but it is an IRS 1099/W-9 tax-reporting notice
    # or FAQ answer, not the D-266 employment/licensing-lawfulness
    # disclaimer, and none of the three pages is itself a referral-partner
    # enrollment funnel. contractor-agreement.html and recruit.html mirror
    # this file's own existing STATIC_FUNNEL_EXEMPT reasoning for
    # contractor-login.html and recruit.html respectively; faq.html mirrors
    # its own existing STATIC_FUNNEL_EXEMPT entry directly. FLAGGED, not
    # silently assumed: this PR already carries the R-177 legal-read /
    # CEO-sign-off gate (constitution entry 6) pending on the underlying
    # file, and these three are called out by name in the PR comment as a
    # judgment call for that review, not a settled legal position.
    #
    # "faq" REMOVED (gh-2020 LEGAL-READ: FAIL, comment 5780393531): the
    # "For Insurance Agents" recruit-bonus answer on faq.html is a
    # partner-addressed money promise ("you earn $50 for every job..."),
    # the second half of the approved D-286/D-301 fee pair every partner
    # funnel shows directly above the D-266 disclaimer -- not homeowner-
    # facing informational copy, whatever the STATIC_FUNNEL_EXEMPT entry
    # for the older, narrower unmapped-funnel scan assumed. The LEGAL-READ
    # gave two ways to reach PASS: add the verbatim, already-approved D-266
    # disclaimer to that answer, or get an explicit Tier-C ruling from
    # Dustin. This is the smallest-change option -- no new copy, the
    # byte-identical D266_TEXT sentence already live on every other partner
    # page -- so faq.html now carries it (faq.html, "For Insurance Agents"
    # category, directly under the recruit-bonus answer) and is no longer
    # exempt here.
    "contractor-agreement": (
        "Sec. 7.7 W-9/1099-MISC tax-withholding clause for the contractor "
        "referral commission program; a tax notice, not the D-266 "
        "licensing-lawfulness disclaimer, and this page is not itself a "
        "referral-partner enrollment funnel (see contractor-login.html's "
        "existing STATIC_FUNNEL_EXEMPT entry for the same reasoning)."
    ),
    "recruit": (
        "Client-side redirect router; a belt-and-suspenders IRS "
        "tax-reporting notice on an interstitial page, not a "
        "referral-fee enrollment funnel (mirrors this file's own "
        "STATIC_FUNNEL_EXEMPT entry for recruit.html)."
    ),
}

_FEE_CENSUS_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style)\b[^>]*>.*?</\1\s*>", re.DOTALL | re.IGNORECASE
)
_FEE_CENSUS_TAG_RE = re.compile(r"<[^>]+>")


def _fee_sentence_pages(root: Path) -> set[str]:
    """Stems of *.html pages at the repo root whose own VISIBLE text
    contains a referral-fee sentence (dollar amount + "referral" in the
    same sentence), regardless of filename. Content-driven fail-closed
    backstop for D266_PAGES: a page does not have to follow the
    partner-*.html naming convention to be required to carry the
    disclaimer if it actually discloses a referral fee (gh-2020 refuter
    N20/N22). <script>/<style> content and tag markup are stripped before
    sentence-splitting, so CSS/JS punctuation and JSON-LD structure cannot
    manufacture a false "$ ... referral" adjacency across unrelated text."""
    found: set[str] = set()
    for path in sorted(root.glob("*.html")):
        try:
            raw = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        stripped = _strip_html_comments(raw)
        stripped = _FEE_CENSUS_SCRIPT_STYLE_RE.sub(" ", stripped)
        stripped = _FEE_CENSUS_TAG_RE.sub(" ", stripped)
        # gh-2020 REVIEW: FAIL (comment 5780386929) X3: a source line-wrap
        # put a `\n` between the dollar amount and "referral", and
        # FEE_SENTENCE_RE's gap class excluded `\n`, so a wrapped fee
        # sentence read as two unrelated fragments. Normalize ALL whitespace
        # (including newlines) to single spaces -- the same _norm() already
        # used for the D-266 disclaimer comparison -- before matching, so a
        # source-formatting line break can never break the fee-sentence
        # adjacency test. Sentence-splitting on top of that is now
        # unnecessary: FEE_SENTENCE_RE's own `[^.!?\n]{0,200}` gap already
        # bounds how far apart the amount and the fee-word can be, and with
        # newlines gone that bound is carried entirely by '.', '!', '?'.
        normalized = _norm(stripped)
        if FEE_SENTENCE_RE.search(normalized):
            found.add(path.stem)
    return found


# gh-2155 HI-0b / D-333, gh-2020 CLOSE-REVIEW: FAIL (comment 5824278669)
# must-fix (3): home-inspector partner pages carry NO referral fee by design
# (partner-agreement.html Sec. 4.3 / partner-agreement-inspector.html Sec.
# 7). CLOSE-REVIEW rejected a plain D266_PAGES_EXEMPT entry for these,
# because D266_PAGES_EXEMPT is a FINAL subtraction that beats the
# fail-closed fee census -- if a referral fee were ever added back to one of
# these pages, a plain exemption would hide it silently, exactly the
# regression D-333 exists to prevent (CLOSE-REVIEW reproduced this live: a
# simulated naive exemption + a re-added "$200 referral fee" sentence gave a
# silent PASS). These names are instead removed only from the STRUCTURAL
# (name-based) requirement -- the glob, in compute_d266_pages() below -- so
# they are not unconditionally required to carry D266_TEXT, but they remain
# fully exposed to the `fee_pages` content census: no fee sentence -> not
# required (the D-333 exemption applies); a fee sentence reappears -> the
# census re-adds the page to the required set and a silent PASS is no
# longer possible.
D333_NO_FEE_STRUCTURAL = {"partner-inspectors", "partner-agreement-inspector"}


def compute_d266_pages(root: Path = None) -> list[str]:
    """The full set of pages this run's D-266 disclaimer check applies to.
    A function, not a module-level constant, so it can be evaluated against
    an arbitrary root (a self-test fixture tree) as well as the real repo."""
    root = root or REPO_ROOT
    globbed = {p.stem for p in root.glob("partner-*.html")} - D333_NO_FEE_STRUCTURAL
    named = {
        p
        for p in ALL_PAGES
        if p not in ("partner-insurance", "partner-login", "partner-inspectors")
    }
    explicit = {"partners", "refer-a-friend", "re-1", "ins-1"}
    fee_pages = {
        s for s in _fee_sentence_pages(root) if (root / f"{s}.html").is_file()
    }
    pages = (globbed | named | explicit | fee_pages) - set(D266_PAGES_EXEMPT)
    return sorted(pages)


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
# no ALL_PAGES entry and no partner-*.html glob, so without this
# registration it is invisible to every check in this file, exactly the way
# /refer was invisible before REACT_TWINS existed. A registered surface that
# goes MISSING (moved, renamed, deleted) is a FAILURE, not a tolerated note
# (gh-2020 refuter, comment 5779401001, N19) -- see check_js_d266_surfaces.
# If a surface is intentionally retired, remove it from this list with a
# written reason instead of letting its disappearance pass silently.
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

# gh-2020 refuter N15 (comment 5779401001): the whole-array disclaimer check
# above (check_d266_disclaimer(array_text)) proves the disclaimer PARAGRAPH
# is present in the source array; it does not prove the close screen's own
# forEach actually renders every paragraph, unmodified, to the page. A
# filtered or indexed callback (`function (p, i) { if (i !== 2) ... }`)
# can silently drop exactly the disclaimer paragraph while the array text
# -- and every check above -- stays green. This is the EXACT shape a
# track's close renderer must match for this checker to trust that its
# forEach renders the array as-is: no filter, no index parameter, no
# extra statements.
JS_D266_FOREACH_EXACT_TMPL = (
    r"COPY\.{copy}\.forEach\(\s*function\s*\(\s*p\s*\)\s*\{{\s*"
    r"root\.appendChild\(bodyText\(p\)\)\s*;?\s*\}}\s*\)"
)

# gh-2020 refuter N23 (comment 5779401001): layers 2/3 above only discover a
# track through its own c-<name>-close screen or the COPY.<name>Close.forEach(
# naming convention -- both assume a track follows this module's "close
# screen full of paragraphs" shape. A track that instead shows its fee
# sentence directly in some OTHER screen, and hands off through its own
# contact function rather than renderPartnerContact(...), is invisible to
# every layer above. This regex matches ANY RENDERERS['c-<id>-<suffix>']
# screen (not just -close/-contact), so its body can be scanned for
# fee-sentence-shaped text regardless of the screen's own naming.
JS_D266_ANY_SCREEN_RE = re.compile(
    r"RENDERERS\['c-([a-z0-9]+)-([a-z0-9-]+)'\]\s*=\s*function\s*\([^)]*\)\s*\{\n(.*?)\n  \};",
    re.DOTALL,
)

# gh-2020 refuter (PR #2038 return, comment 5738187596 / 5738197105) broke
# the per-track guard six ways, three of them silent passes. The helpers
# below close every one of them:
#
#   (1, 1b, 2) COMMENT-BLINDNESS. check_d266_disclaimer() and every JS
#   regex below used to read raw file bytes, so a disclaimer commented out
#   in place (`// 'Check your employment agreement ...'`), a partners.html
#   disclaimer wrapped in `<!-- -->`, or a dead `COPY.insCloseV1.forEach`
#   reference left commented out ahead of the real one, all satisfied the
#   check. Every JS surface is now comment-stripped ONCE (_strip_js_comments)
#   before any regex runs against it, and check_d266_disclaimer() itself
#   strips HTML comments (_strip_html_comments) before comparing, so a
#   commented-out disclaimer is absent text, not present text, on both the
#   static-HTML and the JS side.
#
#   (6, plus a false positive) SCOPE. `array_match` used to re-grep the
#   WHOLE file by array name with a non-greedy `\[(.*?)\]` and take the
#   FIRST hit -- so a decoy `insClose: [ '<the sentence>' ]` planted ahead
#   of the real (edited) array satisfied the check, and a `]` inside
#   legitimate copy could truncate the scope early and produce a false
#   FAIL. _extract_array_literal() below binds the search to the file's own
#   `COPY = { ... }` object (a decoy planted outside it is never seen at
#   all), uses balanced-bracket matching instead of a lazy regex (a `]`
#   inside a string literal no longer ends the scope), and -- when the same
#   key appears more than once inside COPY -- takes the LAST occurrence,
#   which is also what the browser actually executes (a later duplicate key
#   in a JS object literal overrides an earlier one), so a decoy duplicate
#   placed *before* the real, edited entry is not the one that wins.
#
#   (3, 4, 5) FAIL-OPEN ON UNRECOGNIZED SYNTAX. JS_D266_CLOSE_RENDERER_RE
#   only matches one exact shape: `RENDERERS['c-<name>-close'] = function
#   (...) {` ... `\n  };`. An arrow-function conversion, a renamed screen id
#   (`c-ins-close` -> `c-ins-final`), or a reindented closing brace
#   (`\n  };` -> `\n};`) all make that regex miss the track entirely --
#   and the pre-fix code treated "discovered zero tracks for this name"
#   as nothing to report. But in every one of those three edits, the
#   underlying `COPY.<name>Close.forEach(` call -- the module's OWN naming
#   convention for a track's close-copy array, unaffected by any of those
#   three edits since it is not the wrapping syntax being changed -- is
#   still sitting in the file. JS_D266_CENSUS_RE below re-derives the set
#   of tracks that MUST exist from that convention, independent of
#   JS_D266_CLOSE_RENDERER_RE's stricter parse. Any name the census finds
#   that the strict parse did not is now a FAILURE naming the surface,
#   not silence: "the renderer's syntax changed and this checker can no
#   longer verify its disclaimer" is a fail-closed statement, not a
#   fail-open guess.
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
JS_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
JS_LINE_COMMENT_RE = re.compile(r"//[^\n]*")


def _strip_js_comments(text: str) -> str:
    """Strip // line comments and /* */ block comments from JS source text
    (gh-2020 refuter bypasses 1, 2: a disclaimer or a forEach reference
    commented out in place must read as ABSENT, not present).

    js/router-discovery.js contains no "://" substring and no "/*" block
    comment (verified against the real file when this was written), so a
    regex-based strip -- rather than a full tokenizer -- cannot mistake a
    URL for a line comment here. If that ever stops being true, this needs
    a real tokenizer instead.
    """
    text = JS_BLOCK_COMMENT_RE.sub(" ", text)
    text = JS_LINE_COMMENT_RE.sub(" ", text)
    return text


def _strip_html_comments(text: str) -> str:
    return HTML_COMMENT_RE.sub(" ", text)


# gh-2020 refuter N8/N9 (comment 5779401001): check_d266_disclaimer() used
# to compare against the raw (comment-stripped) HTML text, so a disclaimer
# <p> given `hidden` or an inline `style="display:none"` /
# `style="visibility:hidden"` still satisfied the check even though no
# visitor can ever see it. Strip the ENTIRE contents of any element whose
# own opening tag carries one of those signals before comparing -- a
# disclaimer inside such an element reads as ABSENT, not present.
# <script>, <template> and <noscript> content is never visible rendered
# text either (code, an inert template, or the no-JS fallback on a site
# that requires JS) and is stripped unconditionally for the same reason.
#
# gh-2020 REVIEW: FAIL (comment 5780386929) X6/X9: the original non-greedy
# `<(\w+)...>.*?</\1>` match (a) treated a collapsed `<details>` (no `open`
# attribute -- hidden by the browser itself until clicked) as visible, and
# (b) stopped at the FIRST closing tag of the same name, so a hidden element
# nesting another element with the identical tag name (`<div hidden><div
# class="...">...</div> <p>disclaimer</p></div>`) ended the match at the
# inner `</div>`, leaving the disclaimer paragraph outside the "stripped"
# span and still counted as present. `_strip_matching_tag_block()` below
# replaces the lazy regex with a depth-counting scan, so nesting the same
# tag name inside a hidden element can no longer end the strip early, and
# `_strip_collapsed_details()` treats an un-`open`ed `<details>` as fully
# hidden the same way.
_HIDDEN_ATTR = r"\bhidden\b(?:\s*=\s*(?:\"[^\"]*\"|'[^']*'|\S+))?"
_HIDDEN_STYLE = (
    r"style\s*=\s*(?:\"[^\"]*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^\"]*\"|"
    r"'[^']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^']*')"
)
HTML_HIDDEN_OPEN_TAG_RE = re.compile(
    r"<(\w+)\b(?:[^>\"']|\"[^\"]*\"|'[^']*')*?(?:" + _HIDDEN_ATTR + "|" + _HIDDEN_STYLE + r")"
    r"(?:[^>\"']|\"[^\"]*\"|'[^']*')*>",
    re.IGNORECASE,
)
# gh-2155 HI-0c (Ben ruling, comment 5836510515) landed on main AFTER this
# issue's last CLOSE-REVIEW (2026-09-25T16:59): partner-app.html's own D-266
# disclaimer, and analogous elements, are now DELIBERATELY shipped with
# inline `style="display:none"` and a fail-closed-for-everyone default,
# revealed only once `js/*.js` resolves the visitor's confirmed partner role
# (`document.getElementById('referralFeeDisclaimer')...`, then a
# `.style.display` mutation). A blanket "style=display:none is always
# absent text" rule -- the correct call against N8/N9's adversarial fixture,
# which ships no such reveal script -- would make this merge fail CI on
# main's own already-ruled, already-shipped page. The distinction: does a
# <script> on the SAME page reference this exact element's id and later
# mutate its display/visibility/hidden state? If yes, the hiding is
# conditional-at-render, not permanent, and the element counts as present
# (subject to the browser actually revealing it, which is a product/QA
# concern, not this guard's). If no such script exists, it is exactly the
# N8/N9 case and stays stripped.
_SCRIPT_CONTENT_RE = re.compile(r"<script\b[^>]*>(.*?)</script>", re.DOTALL | re.IGNORECASE)
_ELEMENT_ID_RE = re.compile(r'\bid\s*=\s*(?:"([^"]+)"|\'([^\']+)\')', re.IGNORECASE)


_REVEAL_MUTATION_RE = re.compile(
    r"\.style\.display\s*=\s*(?!['\"]none['\"])['\"][^'\"]*['\"]|"
    r"\.style\.visibility\s*=\s*(?!['\"]hidden['\"])['\"][^'\"]*['\"]|"
    r"removeAttribute\(\s*['\"]hidden['\"]\s*\)|\.hidden\s*=\s*false",
    re.IGNORECASE,
)


def _js_reveals_element(full_text: str, open_tag: str) -> bool:
    id_match = _ELEMENT_ID_RE.search(open_tag)
    if not id_match:
        return False
    elem_id = id_match.group(1) or id_match.group(2)
    # Direct chain: getElementById('theId')....style.display = ...
    direct_re = re.compile(
        r"getElementById\(\s*['\"]" + re.escape(elem_id) + r"['\"]\s*\)"
        r"[\s\S]{0,400}?(?:\.style\.(?:display|visibility)\s*=|"
        r"removeAttribute\(\s*['\"]hidden['\"]\s*\)|\.hidden\s*=\s*false)",
        re.IGNORECASE,
    )
    # Indirect: the id is listed in a batch (e.g. an array a forEach loop
    # later resolves through a variable, `feeIds.forEach(function (id) {
    # var el = document.getElementById(id); el.style.display = ''; })`) --
    # matched by the id literal and a reveal mutation both appearing
    # somewhere in the same <script> block, rather than adjacent to a
    # literal getElementById(...) call.
    id_literal_re = re.compile(r"['\"]" + re.escape(elem_id) + r"['\"]")
    for sm in _SCRIPT_CONTENT_RE.finditer(full_text):
        block = sm.group(1)
        if direct_re.search(block):
            return True
        if id_literal_re.search(block) and _REVEAL_MUTATION_RE.search(block):
            return True
    return False


HTML_ALWAYS_INVISIBLE_OPEN_TAG_RE = re.compile(
    r"<(script|template|noscript)\b[^>]*>", re.IGNORECASE
)
_DETAILS_OPEN_TAG_RE = re.compile(r"<details\b[^>]*>", re.IGNORECASE)


def _strip_matching_tag_block(text: str, open_tag_re, full_text: str = None) -> str:
    """Find each opening tag matched by open_tag_re, then remove through its
    properly NESTING-AWARE matching closing tag -- a same-named tag nested
    inside cannot end the match early (gh-2020 X9). If no matching close is
    ever found, strips to end of string (fail closed: an unterminated
    "hidden" element is not evidence the rest of the file is visible).

    If `full_text` is given, a matched element carrying an `id` that some
    <script> on the page (searched in `full_text`, since script content is
    stripped elsewhere) later reveals (see _js_reveals_element) is left
    UNSTRIPPED -- the gh-2155 HI-0c conditional-disclosure pattern."""
    out = []
    pos = 0
    n = len(text)
    while pos < n:
        m = open_tag_re.search(text, pos)
        if not m:
            out.append(text[pos:])
            break
        tag = m.group(1)
        out.append(text[pos : m.start()])
        close_re = re.compile(r"<(/?)" + re.escape(tag) + r"\b[^>]*>", re.IGNORECASE)
        depth = 1
        end = None
        for cm in close_re.finditer(text, m.end()):
            if cm.group(1):
                depth -= 1
                if depth == 0:
                    end = cm.end()
                    break
            else:
                depth += 1
        span_end = end if end is not None else n
        if full_text is not None and _js_reveals_element(full_text, m.group(0)):
            out.append(text[m.start() : span_end])  # keep: conditionally revealed
        else:
            out.append(" ")
        pos = span_end
    return "".join(out)


def _strip_collapsed_details(text: str) -> str:
    """A <details> element with no `open` attribute is collapsed by default
    -- its body (everything but <summary>) is not visible until a user
    clicks it. gh-2020 REVIEW: FAIL X6: wrapping the disclaimer in a
    collapsed <details><summary>Legal</summary>...disclaimer...</details>
    read as present. Strip the whole block (summary included -- simpler
    than re-inserting just the summary text, and never wrong, since a real
    disclaimer is never placed inside a <summary>). A <details open> is
    left untouched: its body is visible by default."""
    out = []
    pos = 0
    n = len(text)
    while pos < n:
        m = _DETAILS_OPEN_TAG_RE.search(text, pos)
        if not m:
            out.append(text[pos:])
            break
        out.append(text[pos : m.start()])
        has_open = re.search(r"\bopen\b", m.group(0), re.IGNORECASE) is not None
        close_re = re.compile(r"<(/?)details\b[^>]*>", re.IGNORECASE)
        depth = 1
        end = None
        for cm in close_re.finditer(text, m.end()):
            if cm.group(1):
                depth -= 1
                if depth == 0:
                    end = cm.end()
                    break
            else:
                depth += 1
        if has_open:
            out.append(text[m.end() : end] if end is not None else text[m.end() :])
        else:
            out.append(" ")
        pos = end if end is not None else n
    return "".join(out)


def _strip_invisible_html(text: str) -> str:
    original = text
    text = _strip_collapsed_details(text)
    text = _strip_matching_tag_block(text, HTML_HIDDEN_OPEN_TAG_RE, full_text=original)
    text = _strip_matching_tag_block(text, HTML_ALWAYS_INVISIBLE_OPEN_TAG_RE)
    return text


def _find_matching_bracket(text: str, open_pos: int, open_ch: str, close_ch: str) -> int:
    r"""Index of the bracket matching the one at open_pos, skipping bracket
    characters that occur inside a quoted JS string literal (so a `]`
    inside copy text can't end the scope early -- gh-2020 refuter's false
    positive against the old `\[(.*?)\]` lazy regex)."""
    depth = 0
    i = open_pos
    n = len(text)
    in_str = None
    while i < n:
        ch = text[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == in_str:
                in_str = None
            i += 1
            continue
        if ch in ("'", '"', "`"):
            in_str = ch
            i += 1
            continue
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


COPY_OBJECT_OPEN_RE = re.compile(r"\b(?:var|const|let)\s+COPY\s*=\s*\{")


def _copy_object_span(text: str):
    """(open_pos, close_pos) of the file's own `COPY = { ... }` object
    literal, via balanced-bracket matching, or None if not found."""
    m = COPY_OBJECT_OPEN_RE.search(text)
    if not m:
        return None
    open_pos = m.end() - 1
    close_pos = _find_matching_bracket(text, open_pos, "{", "}")
    if close_pos == -1:
        return None
    return open_pos, close_pos


def _extract_array_literal(text: str, name: str):
    """The array literal assigned to `name:` inside the file's own COPY
    object (gh-2020 refuter bypass 6). Returns the LAST occurrence's inner
    text if `name` appears more than once inside COPY (matching JS
    duplicate-key runtime semantics), or None if not found at all. Falls
    back to searching the whole file only if no COPY object could be
    located structurally, so this never regresses to being MORE permissive
    than the old whole-file re-grep it replaces.
    """
    span = _copy_object_span(text)
    scope = text[span[0] : span[1] + 1] if span else text
    last = None
    for m in re.finditer(r"\b" + re.escape(name) + r"\s*:\s*\[", scope):
        open_pos = m.end() - 1
        close_pos = _find_matching_bracket(scope, open_pos, "[", "]")
        if close_pos == -1:
            continue
        last = scope[open_pos + 1 : close_pos]
    return last


# Independent of JS_D266_CLOSE_RENDERER_RE's stricter RENDERERS-key parse:
# re-derives the set of tracks that must exist from the module's own
# `COPY.<name>Close.forEach(` naming convention alone, so a track whose
# RENDERERS wrapper syntax changed (arrow function, renamed screen id,
# reindented closing brace) is still counted as existing.
JS_D266_CENSUS_RE = re.compile(r"COPY\.([a-z][a-zA-Z0-9_]*)Close\.forEach\(")

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
    # gh-2020 refuter bypass 1b: a disclaimer wrapped in `<!-- -->` still
    # matched here because the comparison ran on raw bytes. A commented-out
    # disclaimer is absent text, not present text -- strip HTML comments
    # first, on every caller (static pages, React twins, and the JS
    # whole-file floor below, where an HTML-style comment would be
    # harmless noise anyway since JS comments are stripped separately).
    # gh-2020 refuter N8/N9: also strip any element hidden via `hidden` or
    # display:none/visibility:hidden (plus <script>/<template>/<noscript>)
    # -- none of that is visible rendered text either.
    visible = _strip_invisible_html(_strip_html_comments(html))
    return _norm(D266_TEXT) in _norm(visible)


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

    A registered surface (D266_JS_SURFACES) that is MISSING from this tree
    is a FAILURE (gh-2020 refuter, comment 5779401001, N19) -- moved,
    renamed or deleted, its D-266 coverage went with it, and a passing exit
    code must not say otherwise. FOUR layers apply once a surface exists,
    because any one alone is defeatable:

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
      3. FAIL-CLOSED CENSUS (added after PR #2038's refuter, comment
         5738197105 criterion (6)): layer 2's RENDERERS-key parse is exact
         and therefore breakable -- an arrow-function conversion, a
         renamed screen id, or a reindented closing brace all make it miss
         a track that is still really there. JS_D266_CENSUS_RE re-derives
         the same track set from the module's OWN `COPY.<name>Close.forEach(`
         naming convention, which those three edits do not touch. Any name
         the census finds that layer 2 did not discover is a FAILURE, not
         a skipped note: a JS surface this checker cannot fully parse must
         say so loudly, not pass quietly.
      4. FEE-SENTENCE TRACK DISCOVERY (added after PR #2038's second refuter,
         comment 5779401001, N23): layers 2/3 both assume a track follows
         the "close screen full of paragraphs" shape. A track that shows
         its fee sentence directly in some OTHER screen, with its own
         contact function instead of renderPartnerContact(...), is
         invisible to both. This layer scans EVERY RENDERERS['c-<id>-*']
         screen's own body (and any scalar COPY property it references)
         for fee-sentence-shaped text, and fails if that screen's track id
         is not already accounted for by layers 2/3, a partner-contact
         track, or a declared exemption.

    Every JS surface is comment-stripped once before any of the four
    layers run (gh-2020 refuter bypasses 1 and 2): a disclaimer commented
    out in place, or a dead commented-out COPY.<name>Close.forEach
    reference left ahead of the real one, is absent text, not present
    text.

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
            failures.append(
                f"{surface}: registered D-266 JS surface is MISSING from "
                f"this tree (moved, renamed, or deleted) -- its D-266 "
                f"coverage went with it; if it was intentionally retired, "
                f"remove it from D266_JS_SURFACES with a written reason "
                f"instead of letting the disappearance pass silently "
                f"(d266_js_surface_missing)"
            )
            continue
        # Comment-stripped ONCE; every layer below reads this, not the raw
        # bytes (gh-2020 refuter bypasses 1, 2).
        text = _strip_js_comments(path.read_text(encoding="utf-8", errors="ignore"))

        # Layer 1 -- whole-file floor.
        if not check_d266_disclaimer(text):
            failures.append(
                f"{surface}: missing D-266 disclaimer verbatim text (d266_js_surface)"
            )

        # Layer 2 -- per-track, discovered from the module's own vocabulary.
        close_matches = list(JS_D266_CLOSE_RENDERER_RE.finditer(text))
        census_track_ids = {m.group(1) for m in JS_D266_CENSUS_RE.finditer(text)}
        if not close_matches and not census_track_ids:
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
            array_text = _extract_array_literal(text, copy_name)
            if array_text is None:
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

            if not check_d266_disclaimer(array_text):
                failures.append(
                    f"{surface}: {label} track ({route}) missing D-266 disclaimer "
                    f"(d266_js_track)"
                )

            # gh-2020 refuter N13/N15 (comment 5779401001): the array-content
            # check above proves the disclaimer PARAGRAPH exists in the
            # source; it proves nothing about whether it ever RENDERS.
            #   N13 -- a step upstream of the close screen is repointed
            #   straight at the contact screen (go('c-<id>-contact')),
            #   skipping the close screen entirely. The close renderer and
            #   its array are untouched and pass every check above, but
            #   nothing in the file ever navigates to them.
            if not re.search(r"go\(\s*['\"]" + re.escape(route) + r"['\"]\s*\)", text):
                failures.append(
                    f"{surface}: {route} exists and its disclaimer array is "
                    f"present, but no go('{route}') call anywhere else in the "
                    f"file reaches it -- the close screen (and its "
                    f"disclosure) may be unreachable from normal navigation "
                    f"(d266_js_close_unreachable)"
                )
            #   N15 -- the close screen's own forEach is given a filter or an
            #   index parameter (`function (p, i) { if (i !== 2) ... }`), so
            #   some paragraphs render and others -- possibly the disclaimer
            #   -- silently do not, even though the array text still
            #   contains it. Require the forEach to match the module's own
            #   unmodified shape exactly.
            foreach_exact_re = re.compile(
                JS_D266_FOREACH_EXACT_TMPL.format(copy=re.escape(copy_name))
            )
            if not foreach_exact_re.search(body):
                failures.append(
                    f"{surface}: {route} renders COPY.{copy_name} through a "
                    f"forEach callback that is filtered, indexed, or "
                    f"otherwise modified from `function (p) {{ "
                    f"root.appendChild(bodyText(p)); }}` -- cannot verify "
                    f"every paragraph (including the disclaimer) actually "
                    f"renders unmodified (d266_js_close_foreach_filtered)"
                )

        # Layer 3 -- fail-closed census cross-check (gh-2020 refuter bypasses
        # 3, 4, 5): a name the census found via COPY.<name>Close.forEach(
        # that layer 2's stricter RENDERERS-key parse did not discover means
        # the renderer's own syntax changed in a way this checker no longer
        # recognizes -- reported as a failure, not silently skipped.
        for track_id in sorted(census_track_ids - close_track_ids):
            failures.append(
                f"{surface}: found COPY.{track_id}Close.forEach( with no "
                f"structurally recognizable RENDERERS['c-{track_id}-close'] = "
                f"function (...) {{ ... }}; screen for it (renamed screen id, "
                f"arrow-function conversion, or reindented closing brace) -- "
                f"this checker can no longer verify its D-266 disclaimer and "
                f"treats that as FAILED, not skipped (d266_js_track_unrecognized)"
            )

        partner_track_ids = {
            m.group(1)
            for m in JS_D266_PARTNER_CONTACT_RE.finditer(text)
            if "renderPartnerContact(" in m.group(2)
        }
        for track_id in sorted(partner_track_ids - close_track_ids - census_track_ids):
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

        # Layer 4 -- fee-sentence track discovery (gh-2020 refuter N23,
        # comment 5779401001): layers 2/3 only discover a track through its
        # own c-<name>-close screen or the COPY.<name>Close.forEach( naming
        # convention. A track that instead renders its fee sentence in some
        # OTHER screen, with its own contact function rather than
        # renderPartnerContact(...), is invisible to both. Scan every
        # RENDERERS['c-<id>-*'] screen's own body -- and any scalar COPY
        # property (`key: '...'`, not an array) it references -- for
        # fee-sentence-shaped text (a dollar amount and "referral" in the
        # same sentence), and fail if that screen's track id is not already
        # accounted for above.
        known_track_ids = (
            close_track_ids
            | census_track_ids
            | set(JS_D266_EXEMPT_TRACKS)
            | partner_track_ids
        )
        # gh-2020 REVIEW: FAIL (comment 5780386929) X11/X12: this scalar scan
        # only matched single-quoted `key: '...'` values, so a double-quoted
        # scalar (`key: "..."`) was invisible, and it never looked at COPY
        # ARRAY properties at all -- yet an array rendered through
        # `COPY.<name>.forEach(...)` is how every existing track in this
        # file (the realtor/insurance close screens themselves) shows its
        # fee copy, so a new track using that exact idiom with a different
        # key name was structurally identical to the tracks this checker
        # already trusts, and still fell through. Both gaps close the same
        # way: match every quote style (', ", `) for scalars, and resolve
        # any COPY.<key> reference to its array literal via
        # _extract_array_literal (the same helper layer 2/3 already use for
        # close-copy arrays) before testing it for fee-sentence text.
        copy_scalar_fee_keys = {
            m.group(1)
            for m in re.finditer(
                r"(\w+)\s*:\s*(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"|`((?:[^`\\]|\\.)*)`)",
                text,
            )
            if FEE_SENTENCE_RE.search(_norm(m.group(2) or m.group(3) or m.group(4) or ""))
        }
        _array_fee_cache: dict[str, bool] = {}

        def _copy_array_has_fee(key: str) -> bool:
            if key not in _array_fee_cache:
                arr = _extract_array_literal(text, key)
                _array_fee_cache[key] = bool(
                    arr and FEE_SENTENCE_RE.search(_norm(arr))
                )
            return _array_fee_cache[key]

        reported_fee_tracks: set[str] = set()
        for sm in JS_D266_ANY_SCREEN_RE.finditer(text):
            screen_track_id, screen_body = sm.group(1), sm.group(3)
            if screen_track_id in known_track_ids or screen_track_id in reported_fee_tracks:
                continue
            has_inline_fee = bool(FEE_SENTENCE_RE.search(_norm(screen_body)))
            copy_refs = set(re.findall(r"COPY\.(\w+)\b", screen_body))
            has_copy_ref_fee = any(
                ref in copy_scalar_fee_keys or _copy_array_has_fee(ref)
                for ref in copy_refs
            )
            if has_inline_fee or has_copy_ref_fee:
                reported_fee_tracks.add(screen_track_id)
                failures.append(
                    f"{surface}: c-{screen_track_id}-* renders a referral-fee "
                    f"sentence but is not a discovered close/census track, a "
                    f"renderPartnerContact(...) partner-contact track, or a "
                    f"declared exemption -- add a c-{screen_track_id}-close "
                    f"screen with the D-266 disclaimer, or extend "
                    f"JS_D266_EXEMPT_TRACKS with a written reason "
                    f"(d266_js_fee_sentence_unrecognized_track)"
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
# Scope is root-level *.html and ALL of js/** (was top-level js/*.js only --
# gh-2020 refuter, comment 5779401001, N19: a registered JS surface moved to
# a subfolder, e.g. js/router/discovery.js, was invisible to this scan, the
# same class of gap this function exists to close), excluding js/vendor/
# (third-party bundled library code, never our own funnel copy -- verified
# against its one file, js/vendor/qrcode-generator.js, at the time this
# exclusion was written). Matches this file's existing convention that
# "root-level *.html is only what main publishes TODAY" (see the
# React-parity docstring above): blog/ and guides/ are consumer-education
# content, never a funnel surface, and admin-*.html is internal staff-only
# tooling that can never be partner-facing, so neither is a source of
# D-266 risk worth scanning here.
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
    "hi-1.html": (
        "gh-2152 HI-1: is a partner-enrollment funnel (the match is real "
        "\"referral link\"/\"referral fee\" copy, not a stray comment), but "
        "D-266 does not apply to it -- same per-track exemption already "
        "recorded above for partner-inspectors.html (gh-2155 HI-0b / D-333, "
        "comment 5824245098): home inspectors receive no referral fee or "
        "recruit bonus at all (partner-agreement.html Section 4.3), so "
        "D-266's \"make sure it is lawful for you to accept referral fees\" "
        "warning has nothing to attach to. Dustin's ruling on #2152 (comment "
        "5832300782, approving this page's copy) says so explicitly: \"no "
        "D-266 disclaimer (inspectors take no fee, D-333)\". hi-1.html isn't "
        "folded into D266_PAGES's glob/ALL_PAGES mechanism because it is a "
        "single-purpose ad landing page, not a partner-*.html marketing "
        "page -- same shape as the other STATIC_FUNNEL_EXEMPT entries above."
    ),
}


def _static_funnel_checked_set(root: Path = None) -> set[str]:
    """Every surface this script already verifies, by stem or relative path."""
    root = root or REPO_ROOT
    checked = set(ALL_PAGES) | set(compute_d266_pages(root)) | set(D266_JS_SURFACES)
    checked |= {Path(twin).stem for twin in REACT_TWINS.values()}
    return checked


def find_unmapped_static_funnels(root: Path = None) -> list[str]:
    """Non-React, non-partner-* files that look like a referral-fee funnel
    but are registered nowhere in this script (gh-2020). root is
    parameterized (defaults to REPO_ROOT) so a self-test fixture tree can
    be scanned without touching the real repo."""
    root = root or REPO_ROOT
    checked = _static_funnel_checked_set(root)
    findings = []
    candidates = sorted(root.glob("*.html"))
    js_dir = root / "js"
    if js_dir.is_dir():
        candidates += [
            p
            for p in sorted(js_dir.rglob("*.js"))
            if "vendor" not in p.relative_to(js_dir).parts
        ]
    for path in candidates:
        rel_path = path.relative_to(root).as_posix()
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

    # D-266 disclaimer check uses its own glob-discovered page set (gh-1254,
    # broadened gh-2020 refuter N20/N21/N22) instead of the ALL_PAGES loop
    # above, so a new partner-*.html page, refer-a-friend.html, or any page
    # whose own text carries a referral-fee sentence is visible without
    # editing a hardcoded list.
    d266_pages = compute_d266_pages()
    for page in d266_pages:
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

    # gh-2020: JS-module D-266 surfaces (currently just js/router-discovery.js)
    # and the static-file analogue of find_unmapped_react_funnels().
    js_failures, js_notes = check_js_d266_surfaces()
    failures.extend(js_failures)
    failures.extend(find_unmapped_static_funnels())

    checked_pages = sorted(set(ALL_PAGES) | set(d266_pages))
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
