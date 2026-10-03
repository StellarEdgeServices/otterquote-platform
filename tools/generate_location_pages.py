#!/usr/bin/env python3
"""
Generate programmatic /locations/[county]/[trade]/ SEO landing pages.

D-345 (gh-2422) amended D-241 / D-169 for /locations/ pages. What this
script does now:

  1. Reads the STATE ALLOW-LIST (data/location-pages-state-allowlist.json),
     which the CRO maintains. The list ships EMPTY; with an empty list the
     generator emits nothing and says so. A state is added only after its
     statute search (D-344 trigger a) -- see tools/README-locations-workflow.md.
  2. For every allow-listed state, iterates (county, trade) over ALL of that
     state's counties (data/us-counties.json) x the eligible trades. Page
     discovery does NOT depend on contractors, and this script no longer
     touches Supabase at all, so it runs with no credentials. Each state's
     county-to-climate-region map and climate copy come from
     data/location-state-profiles/XX.json (CRO-authored, no code change);
     a missing or malformed profile is a StateConfigError before any write.
  3. Builds one static page per tuple at
       locations/[county-slug]/[trade-slug]/index.html   (repo root)
     (Netlify publishes the repo root, netlify.toml: publish = ".").
  4. Applies the unique-content floor (below). A page under the floor is NOT
     generated: not written to disk, not added to the sitemap.
  5. Runs the compliance lint (below) on every page that survives the floor.
     A lint failure is a build error (copy bug), not a skip.
  6. Rewrites the location entries in the repo-root sitemap.xml so it lists
     exactly the pages generated this run. Every generated page is indexable;
     this script never injects noindex.

Usage:
  python tools/generate_location_pages.py [--dry-run] [--allowlist PATH]

REMOVED by D-345 (do not reintroduce): the >=2-active-contractors
eligibility check (D-241 guardrail 1, MIN_CONTRACTORS) and the
auto-noindex-below-2 rule (guardrail 3, inject_noindex). A county with zero
contractors can get an indexable page.

UNIQUE-CONTENT FLOOR (D-241 guardrail 2: ">=500 words of unique non-template
content per page", kept by D-345; STRICT reading per the CEO ruling on #2304):
  A page is emitted only if it has >= MIN_WORDS (500) words of content that
  appears on no other page in the same run. strict_unique_counts() measures
  it as: the number of words in the page's visible text that are NOT inside a
  run of 3 or more consecutive words that also appears in the template
  baselines, on one of the page's 5 most similar other pages, or earlier on the
  page itself (order does not matter). Inserted junk only breaks shared text
  into shorter runs; runs of 3+ words still match.
  - The shared template therefore contributes ~0. A page's 500 words must come
    from county-specific content in the state profile's `county_content`
    (per county and trade; see data/location-state-profiles/IN.json _readme).
    Indiana's committed profile has none, so every Indiana page fails the gate
    and nothing is emitted until the CRO writes that content.
  - Identical text on two pages (two counties, or the same county on two
    trades) is shared, so it counts for neither.
  - A run that builds a single page compares it with nothing, so all its
    words count as unique. The gate is meaningful when a state's full
    county x trade set is generated together, which is what the CLI does.
  - Before comparison, tokens are split on hyphens, slashes and underscores;
    tokens containing a digit are dropped; every county name of the state, the
    state name and code, region labels, trade and trade-adjacent words (also as
    parts of longer tokens), number words and ordinals, the NATO alphabet, single
    letters and Roman numerals become fixed placeholders; county_content must be
    Latin-script plain text. See strict_unique_counts for the residual risk.
  - A page under the floor is NOT generated: not written, not sitemapped.
  - Each run prints min/median strict-unique words, plus an informational
    cross-page share-of-unshared-shingles metric.

HARD REFUSAL (D-344): FL, LA and TX are blocked states (BLOCKED_STATES). The
generator refuses them, even if listed in the allow-list or passed via
--allowlist, with an error before anything is written.

COPY RULE (D-345), enforced in the template AND in compliance_lint():
  Otter Quotes creates a scope of work and sends it to local contractors. We
  never say or imply that we HAVE contractors in a county.
  - Every page must contain the exact phrase "send it to local contractors".
  - Banned (case-insensitive): have-contractors phrasing ("our contractors",
    "our network of", "contractors who serve", "contractors serving",
    "contractors in [County] County", "local contractors we",
    "contractors near you", "approved contractors", "contractors available",
    "contractors on the platform", ...). See HAVE_CONTRACTORS_BANS.
  - D-104: no "vetted" / screening claims.
  - D-312: no vendor names (list reused from scripts/vendor-scrub-check.py,
    plus Stripe, Mailgun, Twilio).
  - D-168: no response-time claims.
  - D-175: brand is "Otter Quotes" (two words) in copy.
  The lint is a TRIPWIRE, not a guarantee: it catches honest mistakes and cheap
  evasions (see the block-level R1/R2/R3 rules and APPROVED_SENTENCES below).
  The guarantee is the R-177 legal read of each state's profile and
  county_content before the state is allow-listed.
"""

import re
import sys
import json
import html
import hashlib
import pathlib
import datetime
import argparse
import statistics
import unicodedata
import os
import importlib.util
from html.parser import HTMLParser

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SITE_BASE = "https://otterquote.com"
REPO_ROOT = pathlib.Path(__file__).parent.parent
LOCATIONS_DIR = REPO_ROOT / "locations"
SITEMAP_PATH = REPO_ROOT / "sitemap.xml"
ALLOWLIST_PATH = REPO_ROOT / "data" / "location-pages-state-allowlist.json"
COUNTIES_PATH = REPO_ROOT / "data" / "us-counties.json"

ELIGIBLE_TRADES = ("roofing", "siding", "gutters", "windows")

TRADE_LABELS = {
    "roofing": "Roofing",
    "siding": "Siding",
    "gutters": "Gutters",
    "windows": "Windows",
}

# Singular noun for titles ("Window Bids", not "Windows Bids") and "your X project".
TRADE_NOUN = {
    "roofing": "roofing",
    "siding": "siding",
    "gutters": "gutter",
    "windows": "window",
}

MIN_WORDS = 500  # strict unique-content floor per page (D-241 guardrail 2, kept by D-345)

# D-344 blocked states. Hard-refused in load_allowlist() and generate().
BLOCKED_STATES = ("FL", "LA", "TX")

REQUIRED_PHRASE = "send it to local contractors"

# D-104 (no vetted claims), D-168 (no response-time claims). Plain substrings,
# matched case-insensitively against the normalised page text.
FORBIDDEN_PHRASES = (
    "vetted",
    "vetting",
    "pre-screened",
    "prescreened",
    "screened",
    "licensed and insured",
    "background-checked",
    "background checked",
    "we verify",
    "fully verified",
    "guaranteed response",
    "within 24 hours",
    "within 48 hours",
    "same-day response",
    "fast response",
    "respond within",
    "response time",
)

# D-175: brand copy is "Otter Quotes" (two words). Case-sensitive.
FORBIDDEN_CASE_SENSITIVE = ("OtterQuote", "ClaimShield")

# Nouns used to describe the people we would be (wrongly) claiming to have.
_TRADESPEOPLE = r"(?:contractors?|roofers?|siders?|installers?|pros|professionals|crews?|companies|providers|bidders|vendors|partners)"
_PLURAL_TRADESPEOPLE = r"(?:contractors|roofers|siders|installers|pros|professionals|crews|companies|providers|bidders|vendors|partners)"
# "Contractors are/have been/will be ... ready / lined up / queued up".
_HELPER = r"(?:(?:are|is|were|have|has|have\s+been|will|will\s+be)\s+)?"
_READY = r"(?:ready|standing\s+by|waiting|eager|willing|able|on\s+call|lined\s+up|line\s+up|queued(?:\s+up)?)"

# D-345: phrasing that states or implies Otter Quotes HAS contractors (or
# roofers, pros, ...) in a county. Regexes, matched case-insensitively against
# the normalised text (tags stripped, entities decoded, whitespace collapsed).
# Deliberately specific so that "send it to local contractors" and neutral
# mentions of "contractors" / "local contractors" do not trip them.
HAVE_CONTRACTORS_BANS = (
    rf"\bour\s+(?:\w+\s+){{0,2}}(?:{_TRADESPEOPLE}|network|team|crews?)\b",   # our contractors / our local roofers / our network
    r"\bnetwork\s+of\b",                                                      # a network of ... / our network of
    r"\bcontractors\s+who\s+serve\b",                                         # connects you with contractors who serve X
    r"\bcontractors\s+(?:that|which)\s+serve\b",
    r"\bcontractors\s+serving\b",
    rf"\b{_PLURAL_TRADESPEOPLE}\s+(?:in|near|serving|across|throughout|around|covering|covers?|working\s+in|operating\s+in)\s+[^.<>]{{0,40}}?\bcounty\b",
    rf"\bcounty\s+(?:\w+\s+){{0,2}}{_PLURAL_TRADESPEOPLE}\b",                 # Marion County (roofing) contractors
    rf"\b{_PLURAL_TRADESPEOPLE}\s+{_HELPER}{_READY}\b",                     # contractors are lined up / waiting / queued up
    rf"\b(?:lined|line|queued)\s+up\s+(?:\w+\s+){{0,2}}{_TRADESPEOPLE}\b",      # we've lined up contractors for you
    rf"\botter\s+quotes(?:'s?)?\s+(?:\w+\s+){{0,2}}{_TRADESPEOPLE}\b",          # Otter Quotes' / Otter Quotes's / Otter Quotes contractors
    rf"\b{_PLURAL_TRADESPEOPLE}\s+(?:from|with|at|through)\s+otter\s+quotes\b",
    r"\blocal\s+contractors\s+we\b",                                          # local contractors we work with / have
    r"\bcontractors\s+(?:near|around)\s+you\b",
    r"\bcontractors\s+(?:working|operating|located|based)\s+in\b",
    r"\bapproved\s+contractors?\b",
    r"\bcontractors?\s+(?:are\s+)?available\b",
    r"\bcontractors\s+on\s+(?:the\s+platform|otter\s+quotes)\b",
    rf"\b(?:we|otter\s+quotes)(?:\s+|'ve\s+|'s\s+)(?:have\s+got|has\s+got|got|have|has|employ|employs|use|uses|work\s+with|works\s+with|partner\s+with|partners\s+with)\s+(?:\w+\s+){{0,3}}{_TRADESPEOPLE}\b",
    r"\bconnects?\s+(?:you|homeowners|consumers|customers)\s+with\s+(?:\w+\s+)?(?:contractors|roofers|pros|professionals)\b",
    r"\bplatform\s+coverage\b",
    r"\bcontractor\s+profiles?\b",
    r"\b(?:our|trusted|local)\b[^.]{0,30}\b(?:team|roofers|crews?|pros|network)\b",
    r"\balready\s+bid\s+through\b",
    r"\bhundreds\s+of\b",
)

# Price / savings / speed promises (D-168 and the no-promises rule).
PROMISE_BANS = (
    r"\bsave\s+up\s+to\b",
    r"\d\s*%\s*off\b",
    r"\bfree\s+for\s+homeowners\b",
    r"\bin\s+\d+\s+(?:hours?|days?|minutes?)\b",
    r"\bwithin\s+(?:\d+|an?|one|two|three|four|five|a\s+few|several)\s+(?:business\s+)?(?:hours?|days?|minutes?)\b",
    r"\blowest\s+price",
    r"\byou\s+will\s+(?:get|receive)\s+\w+\s+bids\b",
    r"\bthree\s+(?:\w+\s+)?bids\b",
    r"\bby\s+tomorrow\b",
    r"\bfree\s+for\s+you\b",
    # "guarantee" is checked separately in compliance_lint(): negated forms
    # ("does not / doesn't / cannot guarantee", the disclosure) are allowed.
)

# D-326: no entitlement, coverage outcome, or statement of what an insurer
# must do; nothing interprets a policy. Copy is procedural only.
D326_BANS = (
    r"\byour\s+insurer\s+(?:must|will|has\s+to|is\s+required)\b",
    r"\binsurance\s+(?:will\s+|should\s+|typically\s+)?pays?\b",
    r"\b(?:is|are)\s+covered\b",
    r"\bclaimable\b",
    r"\bbelongs?\s+in\s+(?:the\s+|your\s+)?(?:same\s+)?claim\b",
    r"\blegitimate\s+(?:supplement|claim|scope|repair)\b",
    r"\blegitimately\s+part\b",
    r"\bpolic(?:y|ies)\s+(?:cover|covers|pay|pays)\b",
    # "cover/covers/covered" with insurance as the subject. "coverage" is NOT
    # matched: "your insurer decides coverage under your policy" and the
    # disclosure's "insurance coverage decisions" are the approved procedural
    # wording.
    r"\b(?:insurance|insurer|insurers|policy|policies)\b[^.]{0,40}\bcover(?:s|ed)?\b",
    r"\bentitled\b",
    r"\bmaximi[sz]e\b",
)

# D-312: no vendor names on customer-facing pages. Reuse the list the repo's
# own vendor-scrub meter uses; add the processors named in the D-345 brief.
EXTRA_VENDOR_TOKENS = ("stripe", "mailgun", "twilio")


def _load_vendor_tokens() -> tuple:
    path = REPO_ROOT / "scripts" / "vendor-scrub-check.py"
    spec = importlib.util.spec_from_file_location("vendor_scrub_check", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return tuple(dict.fromkeys(tuple(mod.VENDOR_TOKENS) + EXTRA_VENDOR_TOKENS))


VENDOR_TOKENS = _load_vendor_tokens()

# State profiles live in data/location-state-profiles/XX.json (county-to-climate-
# region map plus the region climate copy), authored by the CRO. A state can be
# allow-listed only if it has (a) a county list in data/us-counties.json and
# (b) a valid profile file; otherwise the run fails with StateConfigError.
PROFILES_DIR = REPO_ROOT / "data" / "location-state-profiles"

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class ComplianceError(RuntimeError):
    """A generated page failed the D-345 / D-104 / D-312 / D-168 / D-175 lint."""


class StateConfigError(RuntimeError):
    """An allow-listed state cannot be generated (bad config, no county data,
    or no state profile). Always explicit; never skipped silently."""


# ---------------------------------------------------------------------------
# Allow-list and county data
# ---------------------------------------------------------------------------

def refuse_blocked_states(states) -> None:
    """D-344: FL, LA and TX are hard-refused wherever they come from."""
    blocked = [str(st).upper() for st in states if str(st).upper() in BLOCKED_STATES]
    if blocked:
        raise StateConfigError(
            f"REFUSED: {', '.join(blocked)} {'is' if len(blocked) == 1 else 'are'} blocked by D-344 "
            f"(blocked states: {', '.join(BLOCKED_STATES)}). The generator will not emit pages for "
            f"these states, even if allow-listed. Nothing was written."
        )


def load_allowlist(path=None) -> list:
    """Return the allow-listed state codes from the CRO-maintained file."""
    path = pathlib.Path(path or ALLOWLIST_PATH)
    if not path.exists():
        raise StateConfigError(f"State allow-list file not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    states = data.get("states") if isinstance(data, dict) else None
    if not isinstance(states, list):
        raise StateConfigError(f'{path}: expected a JSON object with a "states" list')
    refuse_blocked_states([c for c in states if isinstance(c, str)])   # D-344, any case, first
    out = []
    for code in states:
        if not (isinstance(code, str) and re.fullmatch(r"[A-Z]{2}", code)):
            raise StateConfigError(f"{path}: invalid state code {code!r} (expected two capital letters)")
        if code not in out:
            out.append(code)
    refuse_blocked_states(out)
    return out


def load_counties(state: str, counties_path=None) -> list:
    """County names for one state from data/us-counties.json."""
    path = pathlib.Path(counties_path or COUNTIES_PATH)
    data = json.loads(path.read_text(encoding="utf-8"))
    for entry in data.get("states", []):
        if entry.get("code") == state:
            counties = entry.get("counties") or []
            if not counties:
                raise StateConfigError(f"{state}: county list in {path} is empty")
            return list(counties)
    raise StateConfigError(f"{state}: no county data in {path}; cannot generate pages for this state")


# county_content is PLAIN TEXT. These characters can start markup, an entity, a
# CSS rule or an escape, so none may appear: with them gone, no tag, attribute,
# style or entity can reach the page from county_content. (The text is also
# HTML-escaped when rendered; the rule makes a mistake fail loudly at load.)
_PLAIN_TEXT_FORBIDDEN = re.compile(r"[<>&{}\\\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


_INVISIBLE_FILLERS = set("\u2800\u3164\u115f\u1160\u17b4\u17b5\u034f\u180b\u180c\u180d\u180e\u061c")


def _invisible_char(ch: str) -> bool:
    """Characters a reader cannot see (or that change how neighbours render):
    Unicode format characters (zero-width, bidi controls, word joiner, BOM, tag
    characters), control characters other than newline/tab, surrogates,
    private-use and unassigned code points, line/paragraph separators, combining
    marks (incl. variation selectors) and the usual blank "filler" letters."""
    if ch in "\n\r\t":
        return False
    cat = unicodedata.category(ch)
    return (cat.startswith("C") or cat in ("Zl", "Zp", "Mn", "Me") or ch in _INVISIBLE_FILLERS
            or "\ufe00" <= ch <= "\ufe0f" or "\U000e0100" <= ch <= "\U000e01ef")


def _require_latin_script(text: str, bad, where: str) -> None:
    """After NFKC every LETTER must be a Latin letter in Basic Latin, Latin-1
    or Latin Extended-A/B (U+0041..U+024F): accented letters are fine; Cyrillic,
    Greek, Armenian, IPA lookalikes (e.g. U+0251) and other scripts are not.
    That closes the whole homoglyph class for both the gate and the lint. Digits
    and ordinary punctuation (including curly quotes and dashes) are allowed."""
    for ch in unicodedata.normalize("NFKC", text):
        if ch.isalpha() and not (ord(ch) <= 0x24F and unicodedata.name(ch, "").startswith("LATIN")):
            raise bad(f"{where} contains a non-Latin letter {ch!r} (U+{ord(ch):04X}, "
                      f"{unicodedata.name(ch, 'unnamed')}); only Latin-script letters are allowed")


def _require_plain_text(text: str, bad, where: str) -> None:
    m = _PLAIN_TEXT_FORBIDDEN.search(text)
    if m:
        raise bad(f"{where} must be plain text: the character {m.group(0)!r} is not allowed "
                  "(no markup, entities, braces or backslashes; separate paragraphs with a blank line)")
    for ch in text:
        if _invisible_char(ch):
            raise bad(f"{where} contains an invisible or format character (U+{ord(ch):04X}, "
                      f"{unicodedata.category(ch)}); only visible characters are allowed")
    _require_latin_script(text, bad, where)


def _require_no_markup(text: str, bad, where: str) -> None:
    """For profile strings that legitimately contain {county}: no markup, entities,
    backslashes or invisible characters."""
    m = re.search(r"[<>&\\]", text)
    if m:
        raise bad(f"{where} must not contain markup or entities: {m.group(0)!r} is not allowed")
    for ch in text:
        if _invisible_char(ch):
            raise bad(f"{where} contains an invisible or format character (U+{ord(ch):04X})")
    _require_latin_script(text, bad, where)


def render_county_text(text: str) -> str:
    """Plain county_content text -> HTML: paragraphs split on blank lines,
    each HTML-escaped and wrapped in a bare <p> with no attributes."""
    paragraphs = [" ".join(chunk.split()) for chunk in re.split(r"\n\s*\n", text.strip())]
    return "\n    ".join(f"<p>{html.escape(chunk)}</p>" for chunk in paragraphs if chunk)


def load_profile(state: str, profiles_dir=None) -> dict:
    """Load and validate data/location-state-profiles/<state>.json.

    Returns {"name", "county_region", "region_label", "region_climate"}.
    A missing or malformed profile raises StateConfigError (never a silent
    skip, never a traceback from deep inside page building).
    """
    path = pathlib.Path(profiles_dir or PROFILES_DIR) / f"{state}.json"
    if not path.exists():
        raise StateConfigError(
            f"{state}: no state profile at {path}. Climate copy is written per state by the CRO "
            f"and is not invented; add the profile (see tools/README-locations-workflow.md) "
            f"before allow-listing {state}."
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise StateConfigError(f"{state}: profile {path} is not valid JSON: {exc}")

    def bad(msg):
        return StateConfigError(f"{state}: malformed profile {path}: {msg}")

    if not isinstance(data, dict):
        raise bad("top level must be a JSON object")
    if data.get("code") != state:
        raise bad(f'"code" must be "{state}"')
    name = data.get("name")
    if not (isinstance(name, str) and name.strip()):
        raise bad('"name" must be a non-empty string')
    _require_no_markup(name, bad, '"name"')
    regions = data.get("regions")
    if not (isinstance(regions, dict) and regions):
        raise bad('"regions" must be a non-empty object')

    county_region, region_label, region_climate = {}, {}, {}
    for key, reg in regions.items():
        if not isinstance(reg, dict):
            raise bad(f'region "{key}" must be an object')
        label = reg.get("label")
        counties = reg.get("counties")
        climate = reg.get("climate")
        if not (isinstance(label, str) and label.strip()):
            raise bad(f'region "{key}": "label" must be a non-empty string')
        _require_no_markup(label, bad, f'region "{key}" label')
        if not (isinstance(counties, list) and counties and all(isinstance(c, str) and c for c in counties)):
            raise bad(f'region "{key}": "counties" must be a non-empty list of strings')
        if not (isinstance(climate, list) and climate and all(isinstance(c, str) and c.strip() for c in climate)):
            raise bad(f'region "{key}": "climate" must be a non-empty list of strings')
        for text in climate:
            _require_no_markup(text, bad, f'region "{key}" climate paragraph')
            if "{county}" not in text:
                raise bad(f'region "{key}": every climate paragraph must contain the {{county}} placeholder')
            try:
                text.format(county="X")
            except (KeyError, IndexError, ValueError) as exc:
                raise bad(f'region "{key}": climate paragraph has an invalid placeholder ({exc!r}); only {{county}} is allowed')
        for c in counties:
            if c in county_region:
                raise bad(f'county "{c}" appears in more than one region')
            county_region[c] = key
        region_label[key] = label
        region_climate[key] = climate

    county_content = {}
    raw_cc = data.get("county_content", {})
    if not isinstance(raw_cc, dict):
        raise bad('"county_content" must be an object mapping county -> html, or county -> {trade: html}')
    for county, value in raw_cc.items():
        if county not in county_region:
            raise bad(f'county_content: "{county}" is not a county listed in any region')
        if isinstance(value, str):
            if not value.strip():
                raise bad(f'county_content["{county}"] is empty')
            _require_plain_text(value, bad, f'county_content["{county}"]')
            county_content[county] = {t: value for t in ELIGIBLE_TRADES}
        elif isinstance(value, dict):
            for trade, text in value.items():
                if trade not in ELIGIBLE_TRADES:
                    raise bad(f'county_content["{county}"]: unknown trade "{trade}" (use {list(ELIGIBLE_TRADES)})')
                if not (isinstance(text, str) and text.strip()):
                    raise bad(f'county_content["{county}"]["{trade}"] must be a non-empty string')
                _require_plain_text(text, bad, f'county_content["{county}"]["{trade}"]')
            county_content[county] = dict(value)
        else:
            raise bad(f'county_content["{county}"] must be a string or an object keyed by trade')
    return {"name": name, "county_region": county_region,
            "region_label": region_label, "region_climate": region_climate,
            "county_content": county_content}


def validate_states(states: list, counties_path=None, profiles_dir=None) -> dict:
    """Fail loudly, before anything is written, if any state is unsupported.
    Returns {state: profile}."""
    profiles = {}
    for st in states:
        profile = load_profile(st, profiles_dir)
        counties = load_counties(st, counties_path)
        unknown = [c for c in counties if c not in profile["county_region"]]
        if unknown:
            raise StateConfigError(
                f"{st}: counties in the data file with no climate-region mapping in the profile: {unknown}"
            )
        profiles[st] = profile
    return profiles


def discover_tuples(states: list, counties_path=None) -> list:
    """(state, county, trade) for every county of every allow-listed state."""
    out = []
    for st in states:
        for county in load_counties(st, counties_path):
            for trade in ELIGIBLE_TRADES:
                out.append((st, county, trade))
    return out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-") or "x"


def county_slug(county: str, state: str) -> str:
    return slugify(f"{county} County {state}")


def safe_jsonld(obj) -> str:
    return json.dumps(obj, indent=2).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


_HIDDEN_STYLE = re.compile(r"display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0\b|opacity\s*:\s*0\b",
                           re.IGNORECASE)
_HIDDEN_CLASS = re.compile(r"\b(?:sr-only|visually-hidden)\b", re.IGNORECASE)


def _is_hidden(attrs: dict) -> bool:
    """Elements a reader cannot see: hidden attribute, aria-hidden="true",
    or an inline style that hides them. Their words never count."""
    if "hidden" in attrs:
        return True
    if (attrs.get("aria-hidden") or "").strip().lower() == "true":
        return True
    if _HIDDEN_CLASS.search(attrs.get("class") or ""):
        return True
    return bool(_HIDDEN_STYLE.search(attrs.get("style") or ""))


class _UniqueTextParser(HTMLParser):
    """Collect the text inside <main> (scripts, styles, <noscript> and hidden
    elements skipped). Elements
    marked data-boilerplate are NOT skipped: shared text is detected by the
    cross-page shingle measure, not by markup."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_main = 0
        self.skip_stack = []   # tag names currently being skipped (nesting-aware)
        self.words = []

    def handle_starttag(self, tag, attrs):
        if tag in _VOID:
            return
        a = dict(attrs)
        if tag == "main":
            self.in_main += 1
        if self.skip_stack or tag in ("script", "style", "noscript", "template") or _is_hidden(a):
            self.skip_stack.append(tag)

    def handle_endtag(self, tag):
        if tag in _VOID:
            return
        if self.skip_stack and self.skip_stack[-1] == tag:
            self.skip_stack.pop()
        if tag == "main" and self.in_main:
            self.in_main -= 1

    def handle_data(self, data):
        if self.in_main and not self.skip_stack:
            self.words.extend(w for w in data.split() if re.search(r"\w", w))


def _norm_word(word: str) -> str:
    return re.sub(r"^\W+|\W+$", "", word.lower())


def _fold(text: str, casefold: bool = False) -> str:
    """What a reader sees: NFKC, every Unicode Cf (format) character dropped,
    combining marks dropped (NFKD), Cyrillic/Greek lookalikes folded to Latin,
    optionally casefolded. Shared by the lint and the strict gate."""
    text = unicodedata.normalize("NFKC", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) not in ("Mn", "Me", "Cf"))
    text = text.translate(_CONFUSABLES)
    return text.casefold() if casefold else text


_TRADE_TERMS = ("roof", "roofs", "roofing", "roofer", "roofers", "shingle", "shingles", "siding", "sidings",
                "sider", "siders", "gutter", "gutters", "guttering", "downspout", "downspouts", "window",
                "windows", "soffit", "soffits", "fascia", "fascias", "flashing", "flashings", "sash", "sashes",
                "eave", "eaves")
# Short words that sit inside ordinary words ("consider", "leave"): exact match only.
_TRADE_EXACT_ONLY = ("sider", "siders", "eave", "eaves", "sash", "sashes")
_WORD_TOKEN = re.compile(r"[^\W_]+(?:'[^\W_]+)*")   # alphanumeric runs; "_" and "-" separate


def _tokens(text: str) -> list:
    """Folded, lower-cased alphanumeric tokens; a trailing possessive is dropped.
    Hyphens, slashes and underscores separate tokens."""
    out = []
    for tok in _WORD_TOKEN.findall(_fold(text, casefold=True)):
        if tok.endswith("'s"):
            tok = tok[:-2]
        if tok:
            out.append(tok)
    return out


_NUMBER_WORDS = frozenset("""zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen
fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand
million billion dozen first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth
fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth
seventieth eightieth ninetieth hundredth thousandth""".split())
_NATO = frozenset("""alfa alpha bravo charlie delta echo foxtrot golf hotel india juliet juliett kilo lima mike
november oscar papa quebec romeo sierra tango uniform victor whiskey whisky xray yankee zulu""".split())
_ROMAN = re.compile(r"^(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$")


def _generic_placeholder(tok: str):
    """Placeholders that never depend on the page: single letters, number words
    and ordinals, the NATO alphabet, valid Roman numerals. A per-page identity
    token built from these ("two-hundred-thirty-seven", "charlie delta hotel",
    "b k", "XIV") becomes the same placeholder wherever it appears."""
    if len(tok) == 1:
        return "letterword"
    if tok in _NUMBER_WORDS:
        return "numberword"
    if tok in _NATO:
        return "natoword"
    if _ROMAN.match(tok):
        return "romanword"
    return None


class StateMask:
    """Mail-merge masking for a whole run of one state: EVERY county of the state
    (each word of its name and the words run together), the state name and
    code, the region labels, and the trade and trade-adjacent words become fixed
    placeholders, whichever page they appear on. Exact matches always; tokens
    CONTAINING a county or state word of 3+ letters or a trade term are masked
    too (AdamsRoofing, RoofingAdams, Adamsville). County seats are not carried
    by data/us-counties.json or the state profiles, so they are not masked
    (a seat plus a trade word is handled by the alignment measure)."""

    def __init__(self, state_code: str, state_name: str, counties, region_labels=()):
        self.exact = {}
        self.substrings = []
        county_terms = set()
        for county in counties:
            toks = _tokens(county)
            for t in toks + ["".join(toks)]:
                self.exact[t] = "countyname"
                if len(t) >= 3:
                    county_terms.add(t)
        county_terms.add("baseline")                       # synthetic baseline page names
        state_terms = set()
        for t in _tokens(state_name) + _tokens(state_code):
            self.exact[t] = "statename"
            if len(t) >= 3:
                state_terms.add(t)
        for label in region_labels:
            for t in _tokens(label):
                self.exact.setdefault(t, "regionname")
        for t in _TRADE_TERMS:
            self.exact[t] = "tradename"
        for terms, ph in ((county_terms, "countyname"), (state_terms, "statename")):
            for term in sorted(terms, key=len, reverse=True):
                self.substrings.append((term, ph))
        for term in sorted((t for t in _TRADE_TERMS if t not in _TRADE_EXACT_ONLY), key=len, reverse=True):
            self.substrings.append((term, "tradename"))
        self._memo = {}

    def placeholder(self, token: str):
        if token in self._memo:
            return self._memo[token]
        found = self.exact.get(token)
        if not found:
            for term, ph in self.substrings:
                if term in token:
                    found = ph
                    break
        self._memo[token] = found
        return found


def main_words(html_text: str, mask: "StateMask" = None) -> list:
    """Words of the page's <main> visible text as a reader sees them: folded
    (see _fold), lower-cased, split into tokens (hyphens, slashes and
    underscores separate; one list item per token). Tokens containing a digit
    are dropped. Single letters, number words and ordinals, the NATO alphabet and
    valid Roman numerals become placeholders; with a mask, county, state, region
    and trade tokens do too. Scripts and styles are excluded."""
    p = _UniqueTextParser()
    p.feed(html_text)
    out = []
    for chunk in p.words:
        for tok in _tokens(chunk):
            if any(ch.isdigit() for ch in tok):
                continue
            ph = (mask.placeholder(tok) if mask is not None else None) or _generic_placeholder(tok)
            out.append(ph or tok)
    return out


SHINGLE_SIZE = 8
STRICT_BLOCK = 3          # a shared run of this many consecutive words is template, not content
STRICT_NEIGHBOURS = 5     # each page is compared with its K most similar other pages
_POSTING_CAP = 30         # pages listed per 3-word shingle when ranking similarity


def shingles(words: list) -> set:
    """Set of SHINGLE_SIZE-word shingles (lower-cased) of a word list."""
    w = [x.lower() for x in words]
    return {" ".join(w[i:i + SHINGLE_SIZE]) for i in range(max(0, len(w) - SHINGLE_SIZE + 1))}


def _tri(words: list) -> list:
    """The STRICT_BLOCK-word shingle starting at each position."""
    w = [x.lower() for x in words]
    return [" ".join(w[i:i + STRICT_BLOCK]) for i in range(max(0, len(w) - STRICT_BLOCK + 1))]


def strict_unique_counts(word_lists: list, baseline_lists=(), k: int = STRICT_NEIGHBOURS) -> list:
    """The D-345 / D-241 guardrail-2 measure, per page: the number of words of
    the page's visible text that are NOT part of text shared with other pages.

    A word of page P is shared (template, not unique) when it lies inside a run
    of at least STRICT_BLOCK (3) consecutive words that also appears
      (a) in any synthetic template baseline (baseline_lists: template-only pages
          that are compared against but never scored or emitted), or
      (b) on one of P's K most similar OTHER pages (K = STRICT_NEIGHBOURS, found
          through an inverted index of 3-word shingles), or
      (c) earlier on P itself (a repeated paragraph counts once).
    Order does not matter, so shuffled sentences are still shared.

    Why this measure: any k-word shingle measure is beaten by inserting a
    per-page token every k-1 words. Here inserted junk only breaks the shared
    text into shorter runs; runs of 3 or more words still match, so only the
    junk itself (and runs of 1-2 words squeezed between junk) can count.
    Junk tokens made of digits, names, number words, NATO words, single letters
    or Roman numerals are removed or masked before this step (see main_words).
    A page with fewer than STRICT_BLOCK words has no shingles, so all its words
    count.

    RESIDUAL RISK, stated plainly: a junk word drawn from a large shared
    vocabulary (words that do appear on many pages) inserted after every TWO
    real words leaves runs of two between junk tokens; no run reaches 3, and the
    page counts as unique. Measured on 368 Indiana pages with a 773-word shared
    boilerplate and junk from a 2,000-word vocabulary: junk after every 2 real
    words writes 368/368 (strict-unique min 1131, median 1151); after every 3
    writes 0 (min 253, median 257); every 4: 0 (min 190, median 193); every 5:
    0 (min 151). That is visible spam, one token in three nonsense, and
    catching it is the job of the per-state R-177 read of county_content, not
    of this count. Digits, names, number words, NATO words, single letters and
    Roman numerals do not help an attacker: they are dropped or masked first.
    Honest prose keeps most of its words: a page of genuinely different text
    (640 words, shared vocabulary) scores min 639, median 640."""
    from collections import Counter
    tris = [_tri(w) for w in word_lists]
    tri_sets = [set(t) for t in tris]
    baseline_set = set()
    for words in baseline_lists:
        baseline_set.update(_tri(words))
    postings = {}
    for i, sh in enumerate(tri_sets):
        for s in sh:
            lst = postings.setdefault(s, [])
            if len(lst) < _POSTING_CAP:
                lst.append(i)
    counts = []
    for p, words in enumerate(word_lists):
        near = Counter()
        for s in tri_sets[p]:
            for q in postings.get(s, ()):
                if q != p:
                    near[q] += 1
        top = [q for q, _ in sorted(near.items(), key=lambda kv: (-kv[1], kv[0]))[:k]]
        neighbour = set()
        for q in top:
            neighbour |= tri_sets[q]
        covered = [False] * len(words)
        first = set()
        for i, s in enumerate(tris[p]):
            if s in baseline_set or s in neighbour or s in first:
                for j in range(i, i + STRICT_BLOCK):
                    covered[j] = True
            first.add(s)
        counts.append(len(words) - sum(covered))
    return counts


def cross_page_uniqueness(shingle_sets: list) -> list:
    """For each page, the share of its shingles that appear on no other page
    in the run. Informational metric only; it does not gate generation."""
    from collections import Counter
    seen = Counter()
    for s in shingle_sets:
        seen.update(s)
    out = []
    for s in shingle_sets:
        out.append(sum(1 for sh in s if seen[sh] == 1) / len(s) if s else 0.0)
    return out


_INLINE_TAGS = {"br", "a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark",
                "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "font"}
_ATTR_NAMES = {"title", "alt", "placeholder", "content", "value", "label", "srcdoc"}

# Cyrillic / Greek / small-cap lookalikes of the Latin letters that appear in
# the ban terms, folded to ASCII after NFKC. (NFKC itself folds fullwidth,
# ligatures, superscripts, etc.)
_CONFUSABLE_PAIRS = (
    # Cyrillic lower
    ("\u0430", "a"), ("\u0441", "c"), ("\u0435", "e"), ("\u043e", "o"), ("\u0440", "p"), ("\u0445", "x"),
    ("\u0443", "y"), ("\u0456", "i"), ("\u0458", "j"), ("\u0455", "s"), ("\u0501", "d"), ("\u04bb", "h"),
    ("\u051b", "q"), ("\u051d", "w"), ("\u04cf", "l"), ("\u043a", "k"), ("\u043c", "m"), ("\u0442", "t"),
    # Cyrillic upper
    ("\u0410", "A"), ("\u0412", "B"), ("\u0415", "E"), ("\u041a", "K"), ("\u041c", "M"), ("\u041d", "H"),
    ("\u041e", "O"), ("\u0420", "P"), ("\u0421", "C"), ("\u0422", "T"), ("\u0425", "X"), ("\u0406", "I"),
    ("\u0408", "J"), ("\u0405", "S"), ("\u0423", "Y"),
    # Greek lower
    ("\u03bf", "o"), ("\u03b1", "a"), ("\u03bd", "v"), ("\u03b9", "i"), ("\u03c4", "t"), ("\u03c1", "p"),
    ("\u03ba", "k"), ("\u03c5", "u"), ("\u03c7", "x"), ("\u03b5", "e"),
    # Greek upper
    ("\u039f", "O"), ("\u0391", "A"), ("\u0392", "B"), ("\u0395", "E"), ("\u0396", "Z"), ("\u0397", "H"),
    ("\u0399", "I"), ("\u039a", "K"), ("\u039c", "M"), ("\u039d", "N"), ("\u03a1", "P"), ("\u03a4", "T"),
    ("\u03a5", "Y"), ("\u03a7", "X"),
    # Latin lookalikes
    ("\u0131", "i"), ("\u0261", "g"), ("\u1d04", "c"), ("\u1d0f", "o"), ("\u1d1c", "u"), ("\u0280", "r"),
    ("\u1d1b", "t"), ("\u0274", "n"), ("\u1d00", "a"), ("\u026a", "i"), ("\ua731", "s"), ("\u1d07", "e"),
    ("\u1d05", "d"), ("\u029f", "l"), ("\u1d0d", "m"),
)
_CONFUSABLES = {ord(a): b for a, b in _CONFUSABLE_PAIRS}
_CONFUSABLES.update({ord("\u2019"): "'", ord("\u2018"): "'", ord("\u02bc"): "'"})
_HYPHENS = "-\u2010\u2011\u2012\u2013\u2014\u2015\u2212"


class _LintViews(HTMLParser):
    """Split a page into what a reader or crawler sees: visible text,
    text-bearing attribute values, CSS `content:` strings from <style>,
    iframe srcdoc documents, JSON-LD scripts (any <script> whose type
    mentions ld+json, in any attribute order or quoting), and other scripts."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.visible, self.attrs, self.jsonld, self.scripts = [], [], [], []
        self.style_text, self.srcdocs = [], []
        self._kind, self._buf = None, []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if not value:
                continue
            if name == "srcdoc":
                self.srcdocs.append(value)
            if name in _ATTR_NAMES or name.startswith("aria-") or name.startswith("data-"):
                self.attrs.append(value)
        if tag == "script":
            kind = "script"
            for name, value in attrs:
                if name == "type" and value and "ld+json" in value.lower():
                    kind = "ld"
            self._kind, self._buf = kind, []
        elif tag == "style":
            self._kind, self._buf = "style", []
        elif tag not in _INLINE_TAGS:
            self.visible.append("\n")      # block boundary = sentence boundary

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._kind:
            body = "".join(self._buf)
            if self._kind == "ld":
                self.jsonld.append(body)
            elif self._kind == "script":
                self.scripts.append(body)
            elif self._kind == "style":
                self.style_text.extend(_css_content_strings(body))
            self._kind, self._buf = None, []
        elif tag not in _INLINE_TAGS:
            self.visible.append("\n")

    def handle_data(self, data):
        if self._kind:
            self._buf.append(data)
        else:
            self.visible.append(re.sub(r"\s+", " ", data))   # source line breaks are not boundaries


def _css_content_strings(css: str) -> list:
    """Text of every CSS `content:` declaration (adjacent strings joined,
    CSS \\XXXX escapes decoded)."""
    out = []
    for m in re.finditer(r"content\s*:\s*([^;}]*)", css, flags=re.IGNORECASE):
        parts = re.findall(r'"((?:[^"\\]|\\.)*)"|\'((?:[^\'\\]|\\.)*)\'', m.group(1))
        s = "".join(a or b for a, b in parts)

        def esc(mm):
            cp = int(mm.group(1), 16)
            return chr(cp) if cp <= 0x10FFFF else ""
        s = re.sub(r"\\([0-9a-fA-F]{1,6})\s?", esc, s)
        out.append(s.replace("\\", ""))
    return out


def _normalize(text: str, keep_newlines: bool = False) -> str:
    """_fold, then collapse whitespace (keeping newlines as block boundaries
    if asked)."""
    text = _fold(text)
    if keep_newlines:
        text = re.sub(r"[^\S\n]+", " ", text)
        return re.sub(r" ?\n[ \n]*", "\n", text).strip()
    return re.sub(r"\s+", " ", text).strip()


def _dehyphenate(text: str) -> str:
    """Join hyphen-split words ("con-tractors" -> "contractors")."""
    return re.sub(rf"(?<=\w)[{re.escape(_HYPHENS)}](?=\w)", "", text)


def _hyphens_to_spaces(text: str) -> str:
    """Treat a hyphen as a space ("Our-contractors" -> "Our contractors")."""
    return re.sub(rf"[{re.escape(_HYPHENS)}]", " ", text)


def _walk_strings(node, out):
    if isinstance(node, str):
        out.append(node)
    elif isinstance(node, dict):
        for v in node.values():
            _walk_strings(v, out)
    elif isinstance(node, list):
        for v in node:
            _walk_strings(v, out)


def _jsonld_strings(html_text: str) -> str:
    """All string values from the page's JSON-LD blocks, decoded, so the lint
    sees them exactly as a crawler does (raw HTML carries \\uXXXX escapes)."""
    p = _LintViews()
    p.feed(html_text)
    out = []
    for block in p.jsonld:
        try:
            _walk_strings(json.loads(block), out)
        except ValueError:
            raise ComplianceError("JSON-LD block is not valid JSON")
    return " ".join(out)


def lintable_text(html_text: str, _depth: int = 0) -> str:
    """Normalised text the lint matches against: visible text (tags stripped,
    entities decoded) + text-bearing attribute values + CSS content strings +
    iframe srcdoc documents (recursively) + parsed JSON-LD strings + other
    script text, all NFKC-normalised with Cf characters removed and
    confusables folded."""
    p = _LintViews()
    p.feed(html_text)
    ld = []
    for block in p.jsonld:
        try:
            _walk_strings(json.loads(block), ld)
        except ValueError:
            raise ComplianceError("JSON-LD block is not valid JSON")
    scripts = [re.sub(r"<[^>]+>", " ", html.unescape(s)) for s in p.scripts]
    parts = ["".join(p.visible), "\n".join(p.attrs), "\n".join(p.style_text), "\n".join(ld), "\n".join(scripts)]
    if _depth < 3:
        parts.extend(lintable_text(sd, _depth + 1) for sd in p.srcdocs)
    return _normalize("\n".join(parts), keep_newlines=True)


_NEGATED_GUARANTEE = re.compile(
    r"\b(?:does\s+not|do\s+not|did\s+not|doesn't|don't|cannot|can\s+not|can't|will\s+not|won't|not)\s+guarantee\w*",
    re.IGNORECASE)


def _guide_labels() -> list:
    labels = [label for _, label in CORNERSTONE_GUIDES]
    for links in TRADE_EXTRA_LINKS.values():
        labels.extend(label for _, label in links)
    return sorted(set(labels), key=len, reverse=True)


# --- Block-level co-occurrence rules (rounds 7-8) ------------------------------
# Adjacency patterns can always be dodged by one inserted word, a singular noun,
# punctuation or an abbreviation. These rules judge a whole BLOCK (one <p>, <li>,
# heading, attribute value or JSON-LD string): after the exact approved sentences
# are masked out, a block fails if it names a tradesperson AND carries a readiness,
# speed, quality, outcome, ownership or affiliation trigger anywhere. Punctuation
# (. ; : ( ) and arrows) never separates "Contractors" from "ready".
# THIS LINT IS A TRIPWIRE, NOT A GUARANTEE. Blunt rules catch honest mistakes and
# cheap evasions; the guarantee is the R-177 legal read of each state's profile
# and county_content before that state is allow-listed.
_TRADESPERSON = (r"(?:contractors?|roofers?|crews?|pros?|installers?|builders?|tradespeople|tradesperson|"
                 r"tradesm[ae]n|handym[ae]n|siders?|professionals?|bidders?|experts?|specialists?|"
                 r"compan(?:y|ies)|firms?|technicians?|outfits?|teams?|providers?|business(?:es)?|"
                 r"laborers?|labourers?)")
_PRONOUN = r"(?:they|them|their|theirs)"
_R1_WORDS = (
    # readiness / availability / assignment / matching
    r"(?:ready|waiting|waits?|waited|standby|stand(?:s|ing)?\s+by|stand(?:s|ing)?\s+ready|lined\s+up|"
    r"line\s+up|lines\s+up|lining\s+up|queued|queue\s+up|on\s+call|available|assign(?:s|ed|ing|ment)?|"
    r"match(?:es|ed|ing)?|dispatch(?:ed|es)?|on\s+hand|at\s+the\s+ready|booked"
    # speed
    r"|within|same[-\s]day|today|tonight|right\s+away|immediately|shortly|soon|call\s+you|reach\s+out|"
    r"in\s+touch|respond(?:s|ed|ing)?|contact\s+you"
    # quality
    r"|top[-\s]rated|certified|trusted|reputable|best|licensed\s+and\s+insured|qualified|screened|"
    r"pre[-\s]screened|hand[-\s]picked|approved"
    # outcome
    r"|compet(?:e|es|ed|ing|itive)|eager|several|multiple|will\s+bid|would\s+bid|want\s+your\s+job|guaranteed)")
_SPEED_CONTACT = (r"(?:within|same[-\s]day|today|tonight|right\s+away|immediately|shortly|soon|call\s+you|"
                  r"reach\s+out|in\s+touch|respond(?:s|ed|ing)?|contact\s+you)")
_R2_WORDS = (r"(?:we|we'll|we've|we're|our|ours|us|otter\s+quotes|network|platform|affiliated|partners?|vetted|"
             r"members?|joined|(?:dozens|hundreds|thousands|many)\s+of)")
_R3_NETWORK = r"\bnetwork\b"
_R3_OWNER = r"(?:\bwe\b|\bour\b|\bours\b|\bus\b|otter\s+quotes|\bplatform\b)"

_ABBREV_DOT = re.compile(r"\b(St|Ste|Ft|Mt|Mr|Mrs|Ms|Dr|Jr|Sr|No|Co|Inc|Ltd|vs|etc|approx)\.", re.IGNORECASE)


def _drop_abbreviation_dots(text: str) -> str:
    """"St. Joseph" -> "St Joseph", "e.g." -> "eg": an abbreviation's period is
    not a sentence boundary and must not split a pattern."""
    text = re.sub(r"\be\.g\.", "eg", text, flags=re.IGNORECASE)
    text = re.sub(r"\bi\.e\.", "ie", text, flags=re.IGNORECASE)
    return _ABBREV_DOT.sub(lambda m: m.group(1), text)


def _sentence_key(sentence: str) -> str:
    return re.sub(r"\s+", " ", sentence.strip().lower()).strip(" .,;:\"'")


# The ONLY sentences exempt from the lint (the block rules and the adjacency /
# promise bans), compared whole after normalisation, never by pattern. Keep this
# list as short as possible; Ben reads it for R-177.
APPROVED_SENTENCES = frozenset(_sentence_key(x) for x in (
    # CEO wording, issue #2422: "Our statement should be that we create a scope of
    # work and \"send it to local contractors\"." (D-345, 2026-10-02.)
    "We create a scope of work and send it to local contractors.",
    # Existing disclosure, byte-identical to origin/main, D-number to be confirmed
    # by CEO. (Sentence 1 of the disclosure paragraph.)
    "Otter Quotes is an independent, informational platform that connects homeowners with contractors for "
    "property damage repair and exterior improvement projects.",
    # Existing disclosure, byte-identical to origin/main, D-number to be confirmed
    # by CEO. (Sentence 2.)
    "Otter Quotes does not independently verify, endorse, or warrant the quality of any contractor's work, "
    "and does not guarantee the availability of any particular contractor.",
))


def mask_approved(text_with_newlines: str) -> str:
    """Remove the exact APPROVED_SENTENCES from each block (blocks stay
    separated by newlines); everything else is kept verbatim, punctuation
    included, and is still checked."""
    out = []
    for block in text_with_newlines.split("\n"):
        pieces = re.split(r"([.!?]+)", block)       # sentence, delimiter, sentence, delimiter, ...
        kept = []
        for i in range(0, len(pieces), 2):
            sentence = pieces[i]
            delim = pieces[i + 1] if i + 1 < len(pieces) else ""
            if sentence.strip() and _sentence_key(sentence) in APPROVED_SENTENCES:
                continue
            kept.append(sentence + delim)
        out.append(re.sub(r"\s+", " ", "".join(kept)).strip())
    return "\n".join(out)


def sentence_findings(text_with_newlines: str) -> list:
    """(rule, block) for every block that breaks R1 (a tradesperson noun with a
    readiness / speed / quality / outcome word), R2 (a noun with an ownership /
    affiliation word) or R3 (network with a we/our/Otter Quotes/platform word).
    The noun is looked for in the whole block, the triggers only after the
    approved sentences are masked, so text appended to an approved sentence is
    judged against the noun it leans on. they/them/their count as a noun when
    the block or the previous block names a tradesperson, and always with a
    speed/contact word."""
    text = _drop_abbreviation_dots(text_with_newlines)
    out = []
    prev_noun = False
    for block in text.split("\n"):
        full = _sentence_key(block)
        masked = _sentence_key(mask_approved(block))
        noun_views = (full, _dehyphenate(full), _hyphens_to_spaces(full))
        has_noun = any(re.search(rf"\b{_TRADESPERSON}\b", v) for v in noun_views)
        if masked:
            for view in (masked, _dehyphenate(masked), _hyphens_to_spaces(masked)):
                r1 = re.search(rf"\b{_R1_WORDS}\b", view)
                r2 = re.search(rf"\b{_R2_WORDS}\b", view)
                pron = re.search(rf"\b{_PRONOUN}\b", view)
                if has_noun and r1:
                    out.append(("R1 readiness/speed/quality/outcome", full)); break
                if has_noun and r2:
                    out.append(("R2 affiliation/ownership", full)); break
                if pron and (has_noun or prev_noun) and (r1 or r2):
                    out.append(("R1/R2 via they/them/their", full)); break
                if pron and re.search(rf"\b{_SPEED_CONTACT}\b", view):
                    out.append(("R1 via they/them/their with speed/contact", full)); break
                if re.search(_R3_NETWORK, view) and re.search(_R3_OWNER, view):
                    out.append(("R3 network", full)); break
        prev_noun = has_noun
    return out


def compliance_lint(html_text: str, page_id: str) -> None:
    """Raise ComplianceError if the page breaks the D-345 copy rule or the
    D-104 / D-168 / D-175 / D-312 / D-326 bans. Checks run on the normalised
    visible/attribute/CSS/srcdoc/JSON-LD text and on de-hyphenated and
    hyphen-as-space copies of it; the substring and vendor checks also run on the raw markup."""
    full_nl = _drop_abbreviation_dots(lintable_text(html_text))
    raw = _normalize(html.unescape(html_text))
    if REQUIRED_PHRASE not in re.sub(r"\s+", " ", full_nl).lower():
        raise ComplianceError(f'[{page_id}] required phrase missing: "{REQUIRED_PHRASE}"')
    # Everything below runs with the approved sentences masked out (they are the
    # exact, allow-listed wording); every other word on the page is checked.
    text_nl = mask_approved(full_nl)
    text = re.sub(r"\s+", " ", text_nl)
    views = [text, _dehyphenate(text), _hyphens_to_spaces(text)]
    lowered = [v.lower() for v in views]

    for view in lowered + [raw.lower()]:
        for phrase in FORBIDDEN_PHRASES:
            if phrase in view:
                raise ComplianceError(f"[{page_id}] forbidden phrase '{phrase}' in page copy")

    # D-175: the bare one-word brand is forbidden in copy; the otterquote.com
    # domain and URLs are fine.
    for view in views + [raw]:
        stripped = re.sub(r"https?://[^\s\"'<>]+", "", view)
        stripped = re.sub(r"otterquote\.com", "", stripped, flags=re.IGNORECASE)
        for term in FORBIDDEN_CASE_SENSITIVE:
            if term in stripped:
                raise ComplianceError(f"[{page_id}] forbidden term '{term}' in page copy")

    for rule, sentence in sentence_findings(full_nl):
        raise ComplianceError(f"[{page_id}] {rule} (D-345): \"{sentence[:160]}\"")

    labels = _guide_labels()
    for view in views:
        for label, bans, strip_labels in (
            ("have-contractors phrasing (D-345)", HAVE_CONTRACTORS_BANS, False),
            ("price/speed promise", PROMISE_BANS, False),
            ("insurer-obligation / coverage phrasing (D-326)", D326_BANS, True),
        ):
            target = view
            if strip_labels:
                # Titles of existing guide/blog pages are linked as-is and
                # are reviewed separately (R-177); they are not page copy.
                for guide_label in labels:
                    target = target.replace(guide_label, " ")
            for pattern in bans:
                m = re.search(pattern, target, flags=re.IGNORECASE)
                if m:
                    raise ComplianceError(f"[{page_id}] {label}: '{m.group(0)}'")
        m = re.search(r"\bguarantee\w*", _NEGATED_GUARANTEE.sub(" ", view), flags=re.IGNORECASE)
        if m:
            raise ComplianceError(f"[{page_id}] price/speed promise: '{m.group(0)}'")

    # D-312 vendor names. Strip CSS :hover / Tailwind hover: first (not vendor
    # references), then match whole words.
    for view in lowered + [raw.lower()]:
        vendor_text = re.sub(r":hover|hover:", "", view)
        for token in VENDOR_TOKENS:
            if re.search(rf"\b{re.escape(token)}\b", vendor_text):
                raise ComplianceError(f"[{page_id}] vendor name '{token}' in page copy (D-312)")


def section_hash(seed: int, salt: int) -> int:
    """Independent deterministic stream per (page, section). Re-hashing with
    the salt decorrelates section picks across pages — two counties that
    happen to agree on one section won't systematically agree on the rest."""
    return int(hashlib.md5(f"{seed}:{salt}".encode()).hexdigest()[:12], 16)


def variant(seed: int, salt: int, pool: list) -> str:
    """Deterministic variant pick with an independent stream per section."""
    return pool[section_hash(seed, salt) % len(pool)]


def shuffle_items(seed: int, salt: int, items: list) -> list:
    """Deterministic per-page reordering (Fisher-Yates driven by an
    independent hash stream) — same item pool, county-specific selection
    and ordering."""
    out = list(items)
    s = section_hash(seed, salt)
    for i in range(len(out) - 1, 0, -1):
        j = s % (i + 1)
        out[i], out[j] = out[j], out[i]
        s //= (i + 2)
        if s < len(out):
            s = section_hash(seed, salt + 1000 + i)
    return out


def page_seed(county: str, trade: str) -> int:
    return int(hashlib.md5(f"{county}|{trade}".encode()).hexdigest()[:12], 16)


# ---------------------------------------------------------------------------
# Content assembly system
#
# Each section has multiple variants, selected deterministically per
# (county, trade). Climate copy varies by region band; issue copy varies by
# trade; expectation copy varies by both. Combined with live coverage stats
# and per-county interpolation this produces unique >=500-word pages rather
# than a single substituted template.
# ---------------------------------------------------------------------------

SEASONAL = [
    "<p>The repair calendar in {region} has a shape worth planning around. Spring storm season generates the damage; early summer is when adjusters and contractors are busiest; late summer and fall often bring a different mix of contractor schedules and working weather; and winter narrows the options for exterior work while freeze-thaw cycles compound anything left unrepaired. Many homeowners in {county} County aim to move from documentation to a signed contract before mid-fall, ahead of both the post-storm rush and winter.</p>",
    "<p>Timing matters in {county} County. Damage discovered in May joins every other storm claim in {region} in the line for adjuster and contractor attention; the same repair scoped in September may meet a different queue. Documentation is the part that does not depend on the calendar: photograph damage once it is safe and note the date for your adjuster. Ask your insurer whether your policy sets a deadline for reporting damage.</p>",
    "<p>Most exterior repair work in {county} County happens in a window that runs roughly from late spring through late fall. Inside that window, post-storm weeks can be congested, and quotes gathered in a hurry may be harder to compare; the weeks after the rush can be a calmer time to review bids. Whatever the calendar says, the sequence stays the same: document first, understand your policy second, compare any written bids you receive third — and take your time rather than rushing to agree with the first person who knocks on the door.</p>",
    "<p>Storm damage in {region} can arrive in clusters: a single hail event can affect many roofs, gutters, and siding elevations in an area at once. Comparing more than one written bid for the same scope is one way homeowners check pricing when demand spikes.</p>",
]

TRADE_INTRO = {
    "roofing": [
        "A roof in {county} County works harder than most homeowners realize. It takes direct hail strikes in spring, wind uplift during summer storms, and months of freeze-thaw stress through the winter — and when it fails, the damage rarely stays confined to the shingles.",
        "Storm season in {county} County can leave roofs with the full menu of problems: hail bruising, wind-lifted shingles, damaged flashing, and the slow leaks that follow. Getting more than one written bid is one way to understand what a repair may cost.",
        "In {county} County, roofing is where storm season and the repair process meet. Hail and wind events leave damage that is easy to underestimate from the ground, and the repair market that springs up after every major storm makes it genuinely hard to know who to call and what a fair price looks like.",
    ],
    "siding": [
        "Siding takes the brunt of wind-driven hail in {county} County — dents, cracks, and punctures on the exposed elevations of a home are among the most common findings after a spring storm rolls through {region}.",
        "In {county} County, siding damage is frequently discovered months after the storm that caused it. Hail impact marks, wind-creased panels, and cracked corner posts let moisture behind the wall system, and by the time staining or warping shows up inside, the repair scope has grown.",
        "Hail does not need to be large to damage siding. In {region}, storms can drop marginal-size hail that leaves siding damage {county} County homeowners never noticed — and matching discontinued siding profiles is a common complication when scoping repairs.",
    ],
    "gutters": [
        "Gutters are the first thing hail hits and the last thing homeowners inspect. In {county} County, dented gutters and downspouts are often among the first visible signs that a storm dropped hail.",
        "A gutter system in {county} County has two jobs: move heavy spring rain away from the foundation, and survive the ice load that {region} winters put on every eave. When hail flattens the profile or pulls fasteners loose, both jobs suffer, and the resulting water problems show up at the foundation and fascia long before the gutters themselves look obviously broken.",
        "In {county} County, gutter damage is often the visible tip of larger storm damage. Hail that dents aluminum gutters has usually also hit the roof above them, which is why a proper storm inspection treats gutters, downspouts, and roof surfaces as one system.",
    ],
    "windows": [
        "Window damage in {county} County ranges from the obvious — cracked glass after a hailstorm — to the subtle: failed seals, fogged double panes, and hail-cratered cladding that lets water into the wall. Document each kind of damage you find; whether any of it is included is your insurer's decision under your policy. Water getting into a wall tends to add repair scope the longer it waits.",
        "Storm damage to windows is easy to overlook in {region}. {county} County homeowners tend to notice broken glass immediately, but hail damage to frames, cladding, and glazing beads is easy to miss and worth including in your documentation.",
        "In {county} County, replacement windows are both a storm-repair item and an efficiency upgrade. When wind or hail compromises frames and seals, homeowners face a choice between like-for-like replacement and stepping up to modern units — and written bids that price each option can help you compare that choice.",
    ],
}

# Issue items per trade: each page draws 5 items — deterministically chosen
# and ordered from a pool of 8 — so same-region pages differ in both
# selection and sequence, not just phrasing.
TRADE_ISSUE_ITEMS = {
    "roofing": [
        "<li><strong>Hail bruising and granule loss</strong> — impact marks that shorten shingle life even when no leak appears immediately.</li>",
        "<li><strong>Wind-lifted and creased shingles</strong> — broken seal strips let later storms drive rain under the roof surface.</li>",
        "<li><strong>Flashing and penetration damage</strong> — chimneys, vents, and valleys are where most post-storm leaks actually start.</li>",
        "<li><strong>Ice dams and freeze-thaw stress</strong> — winter conditions that turn minor storm damage into interior water stains by February.</li>",
        "<li><strong>Impact damage that hides from the ground</strong> — hail strikes are hard to see without getting on the roof, which is why documentation matters.</li>",
        "<li><strong>Partial-slope damage</strong> — storms often damage one or two elevations, raising repair-versus-replace questions that comparing bids can help you think through.</li>",
        "<li><strong>Decking and underlayment issues</strong> — discovered only at tear-off, and a common source of change orders worth understanding in advance.</li>",
        "<li><strong>Ventilation and code items</strong> — older roofs may need code-related upgrades; ask your adjuster and your contractor how local code items are handled.</li>",
    ],
    "siding": [
        "<li><strong>Hail dents and punctures</strong> — most visible on aluminum and thin vinyl, and concentrated on the storm-facing elevations.</li>",
        "<li><strong>Wind-creased and detached panels</strong> — compromised locking legs that let subsequent weather work panels loose.</li>",
        "<li><strong>Discontinued-profile matching</strong> — a common question when only some elevations are damaged.</li>",
        "<li><strong>Moisture intrusion behind damaged panels</strong> — the hidden cost of postponing repairs through a {region} winter.</li>",
        "<li><strong>Oxidation lines and chalking</strong> — complicate spot repairs on older siding and affect how a fair scope is written.</li>",
        "<li><strong>Cracked corner posts and trim</strong> — small components that drive disproportionate water damage when ignored.</li>",
        "<li><strong>Fastener pull-through in high wind</strong> — panels that look intact but are no longer attached the way the manufacturer intended.</li>",
        "<li><strong>Wrap and sheathing damage</strong> — assessable only during repair; if found, note it and raise it with your adjuster.</li>",
    ],
    "gutters": [
        "<li><strong>Hail-flattened profiles</strong> — dents that reduce water-carrying capacity and often point to damage on the roof above.</li>",
        "<li><strong>Pulled fasteners and sagging runs</strong> — ice and debris load that separates gutters from fascia over a {region} winter.</li>",
        "<li><strong>Downspout crushing and disconnects</strong> — drainage failures that surface as foundation and grading problems.</li>",
        "<li><strong>Fascia and soffit rot</strong> — the downstream cost of gutter systems that stopped doing their job quietly.</li>",
        "<li><strong>Seam and end-cap leaks</strong> — often storm-initiated, always worse after a freeze cycle.</li>",
        "<li><strong>Improper pitch after impact</strong> — gutters that survived the storm but no longer drain toward the downspouts.</li>",
        "<li><strong>Gutter guards damaged or displaced</strong> — an item that is easy to leave off a first scope.</li>",
        "<li><strong>Overflow staining and landscape erosion</strong> — evidence adjusters and contractors both read when reconstructing what the storm did.</li>",
    ],
    "windows": [
        "<li><strong>Cracked and shattered glazing</strong> — the most obvious damage, priced very differently across window lines and installers.</li>",
        "<li><strong>Hail-damaged frames and cladding</strong> — dents and fractures that compromise weather sealing even when glass survives.</li>",
        "<li><strong>Failed insulated-glass seals</strong> — post-storm fogging between panes; document it and ask your adjuster whether it is included.</li>",
        "<li><strong>Water intrusion at damaged openings</strong> — interior finish damage near a damaged opening; document it and mention it to your adjuster.</li>",
        "<li><strong>Screen and hardware damage</strong> — small items that are easy to leave off a first scope; list them in your documentation.</li>",
        "<li><strong>Wind-racked frames</strong> — openings knocked out of square that bind sashes and break seals over the following seasons.</li>",
        "<li><strong>Matching and availability questions</strong> — discontinued window lines raise the same repair-versus-replace questions that come up with siding.</li>",
        "<li><strong>Energy-efficiency step-ups</strong> — homeowners choosing between like-for-like replacement and upgraded units can ask for written bids that price the difference.</li>",
    ],
}

ISSUE_ITEMS_PER_PAGE = 5

# Local-expectations copy is assembled from two independently selected
# paragraph slots (A x B = 9 combinations) rather than fixed pairs.
EXPECTATIONS_A = [
    "<p>Storm repair in {county} County follows a rhythm locals know well: a severe-weather event, a wave of door-knocking crews from out of the area, and then the slower, quieter work of getting damage documented, questions raised with your insurer, and a repair scoped carefully. Many homeowners find it helps to slow the process down at the start — documenting damage before tarps and repairs change the evidence, reading their policy before the first phone call, and getting more than one written bid before signing anything.</p>",
    "<p>Homeowners in {county} County navigating a storm claim juggle three parallel tracks: the insurance process (adjuster inspection, scope, settlement), the contractor process (bids, scheduling, materials), and their own documentation. Keeping those tracks separate is the single most useful habit — your insurer decides coverage under your policy; your contractor determines what the repair actually requires; and written bids give you something concrete to discuss with your adjuster.</p>",
    "<p>The practical sequence for {county} County homeowners after storm damage: document everything with photos before any cleanup, review your policy and ask your insurer how to report damage, and gather written repair bids so you have a written scope and pricing to discuss with your adjuster. Nothing in that sequence requires committing to a contractor early — you can keep your options open while you review any written bids you receive.</p>",
]

EXPECTATIONS_B = [
    "<p>Local demand can also move in waves. After a widely publicized hail event, contractors across a region may get busy at once. If you receive more than one written bid, comparing them gives you a way to check pricing when demand spikes, and can surface scope differences — what one bidder saw that another missed — before the work starts rather than after.</p>",
    "<p>Be appropriately skeptical of anyone who shows up unsolicited after a storm, pressures you to sign paperwork on the spot, or quotes a price without getting on the roof or examining the damage up close. Storm-chasing crews can show up after any major storm, and one practical defense is unhurried, written bids that you can check against each other.</p>",
    "<p>Ask any contractor for an itemized written estimate, proof of insurance, and local references. The process can take longer after county-wide storm events, when every roofer, sider, and installer in {region} is working the same backlog. Patience and paperwork usually serve homeowners better than speed and pressure.</p>",
]

HOW_IT_WORKS = [
    "<p>Here is how Otter Quotes works for {article} {county} County project. You submit your project details once.</p><p>We create a scope of work and send it to local contractors.</p><p>You can then compare any written bids you receive side by side, on scope, price, and terms. The platform is informational, and the decision stays entirely yours.</p>",
    "<p>Instead of calling down a list and repeating your story, you submit your {county} County project once.</p><p>We create a scope of work and send it to local contractors.</p><p>Any bids you receive are written, so you can compare them on scope, price, and terms. Comparing more than one written bid is one way to understand local pricing, especially in the busy weeks after a storm.</p>",
    "<p>The process has four steps. You submit your {county} County project.</p><p>We create a scope of work and send it to local contractors.</p><p>You compare any written bids you receive. You choose a contractor, or none of them, and that choice remains entirely your call. No obligation attaches to submitting a project.</p>",
]

# Four Q&As per trade; each page renders a deterministic selection of two,
# so same-trade pages don't all share an identical FAQ block.
FAQ = {
    "roofing": [
        ("Who decides whether my policy applies to roof damage in {county} County?",
         "Your insurer decides coverage under the terms of your policy. Read your policy, ask your adjuster what is included, and document the damage with dated photos. Our guide on filing a property damage claim walks through the process step by step."),
        ("How many roofing bids should I get?",
         "Many homeowners gather two or three. Comparing bids can surface scope differences and give you a way to check pricing, particularly during post-storm demand spikes."),
        ("Should I repair or replace after partial-slope damage?",
         "Shingle availability and the age of the roof both come into it; ask your adjuster how your policy addresses matching. Written bids that price both paths give you and your adjuster something concrete to discuss."),
        ("Do I need to be home for a roof inspection?",
         "For the exterior portion, usually not — but being present means you see the documented damage yourself and can ask questions of whoever inspects the roof."),
    ],
    "siding": [
        ("Who decides how matching is handled for my siding?",
         "Your insurer decides how matching is handled under your policy, and discontinued profiles can complicate the conversation. Document the damage thoroughly and get written bids that address matching explicitly, so your discussion with your adjuster is grounded in specifics."),
        ("Can hail damage siding without visible holes?",
         "Yes — dents, cracks, and chalk-line disturbances can be signs of hail impact even when panels remain attached. An up-close inspection of storm-facing elevations tells the real story."),
        ("Do all elevations get replaced if one is damaged?",
         "Not automatically. A scope can range from single-elevation repair to full replacement; ask your adjuster how matching is handled, and consider bids that spell out both scopes."),
        ("How soon after a storm should siding be inspected?",
         "Promptly — both because your policy may set a deadline for reporting damage (ask your insurer) and because open impact points let moisture behind the wall system, where damage compounds quietly."),
    ],
    "gutters": [
        ("Should I document dented gutters?",
         "Yes. Hail that dents gutters has often hit the roof too, so gutter dents are worth photographing both as a repair item and as a sign of the storm's severity. Ask your adjuster whether they are included in the scope."),
        ("Should gutters be replaced with a roof?",
         "It can make sense when both were storm-damaged or when roof work requires removing aged gutter runs. Written bids that price the combination let you compare against separate repairs."),
        ("Do gutter guards complicate the repair scope?",
         "They add a line item and occasionally a matching question. Make sure your bids list them, and ask your adjuster whether they are included in the scope."),
        ("What size hail dents aluminum gutters?",
         "Smaller than most people expect — gutters often show impact evidence from hail that left shingles looking intact from the ground, which is why they're a standard inspection point."),
    ],
    "windows": [
        ("What should I do about a fogged window after a storm?",
         "Photograph it promptly, with dates, and note when you first saw it. Whether it is included is your insurer's decision under your policy, so ask your adjuster."),
        ("Should I replace like-for-like or upgrade?",
         "Ask your adjuster how your policy treats replacement and upgrades. Bids that price both options make the decision concrete instead of hypothetical."),
        ("Does a cracked pane mean the whole window needs replacing?",
         "Sometimes only the sash or glass unit needs replacement; sometimes frame damage makes a full unit the sound choice. Bids that separate the options keep the decision in your hands."),
        ("Should I list damaged screens and hardware?",
         "Yes — they are small items, but worth listing in your documentation from the start. Ask your adjuster whether they are included."),
    ],
}

FAQ_PER_PAGE = 2

CORNERSTONE_GUIDES = [
    ("/guides/how-to-file-property-damage-claim.html", "How to File a Property Damage Claim"),
    ("/guides/how-to-choose-contractor.html", "How to Choose a Contractor"),
    ("/guides/how-to-read-contractor-estimate.html", "How to Read a Contractor Estimate"),
    ("/guides/how-to-negotiate-with-insurer.html", "How to Negotiate with Your Insurer"),
]

TRADE_EXTRA_LINKS = {
    "roofing": [
        ("/blog/hail-vs-wind-roof-damage.html", "Hail vs. Wind Roof Damage"),
        ("/blog/roofing-estimate-red-flags.html", "Roofing Estimate Red Flags"),
        ("/blog/storm-chaser-roofing-scams.html", "Storm-Chaser Roofing Scams"),
    ],
    "siding": [
        ("/blog/storm-chaser-roofing-scams.html", "Storm-Chaser Contractor Scams"),
        ("/blog/what-is-scope-of-loss-roofing.html", "What Is a Scope of Loss?"),
    ],
    "gutters": [
        ("/blog/hail-vs-wind-roof-damage.html", "Hail vs. Wind Damage"),
        ("/blog/what-is-recoverable-depreciation-roofing.html", "What Is Recoverable Depreciation?"),
    ],
    "windows": [
        ("/blog/does-homeowners-insurance-cover-roof-damage.html", "Does Homeowners Insurance Cover Storm Damage?"),
        ("/blog/what-is-scope-of-loss-roofing.html", "What Is a Scope of Loss?"),
    ],
}




def build_page(county: str, trade: str, generated_on: str, state: str = "IN", profile: dict = None) -> str:
    profile = profile or load_profile(state)
    state_name = profile["name"]
    region = profile["county_region"][county]
    region_lbl = profile["region_label"][region]
    seed = page_seed(county, trade)
    c_slug = county_slug(county, state)
    t_label = TRADE_LABELS[trade]
    noun = TRADE_NOUN[trade]
    noun_title = noun.capitalize()
    county_esc = html.escape(county, quote=True)
    page_url = f"{SITE_BASE}/locations/{c_slug}/{trade}/"

    intro = variant(seed, 1, TRADE_INTRO[trade]).format(county=county_esc, region=region_lbl, state=state_name)
    climate = variant(seed, 2, profile["region_climate"][region]).format(county=county_esc)
    issue_items = shuffle_items(seed, 3, TRADE_ISSUE_ITEMS[trade])[:ISSUE_ITEMS_PER_PAGE]
    issues = ("<ul>" + "".join(issue_items) + "</ul>").format(region=region_lbl)
    expectations = (
        variant(seed, 4, EXPECTATIONS_A) + variant(seed, 7, EXPECTATIONS_B)
    ).format(county=county_esc, region=region_lbl, state=state_name)
    seasonal = variant(seed, 6, SEASONAL).format(county=county_esc, region=region_lbl)
    article = "an" if county[:1].lower() in "aeiou" else "a"
    how_it_works = variant(seed, 5, HOW_IT_WORKS).format(county=county_esc, article=article)
    county_text = (profile.get("county_content") or {}).get(county, {}).get(trade, "")
    county_notes = (f"<h2>{county_esc} County notes</h2>\n    {render_county_text(county_text)}"
                    if county_text.strip() else "")

    faq_selected = shuffle_items(seed, 8, FAQ[trade])[:FAQ_PER_PAGE]
    faq_pairs = [(q.format(county=county_esc), a) for q, a in faq_selected]
    faq_html = "".join(
        f"<h3>{q}</h3><p>{a}</p>" for q, a in faq_pairs
    )

    guide_links = "".join(
        f'<li><a href="{href}">{label}</a></li>'
        for href, label in CORNERSTONE_GUIDES + TRADE_EXTRA_LINKS.get(trade, [])
    )

    title = f"{noun_title} Bids for {county} County, {state} Homeowners · Otter Quotes"
    meta_desc = (
        f"Help with storm-damaged {t_label.lower()} for homeowners in {county} County, {state_name}. "
        f"We create a scope of work and send it to local contractors. "
        f"Homeowners can compare any written bids they receive."
    )

    # Site-wide organization entity: no areaServed (it would conflict from one
    # state's pages to the next; D-169 geo-neutral). Geography lives on the
    # per-page Service below.
    local_business = {
        "@context": "https://schema.org",
        "@type": "Organization",
        "@id": f"{SITE_BASE}/#organization",
        "name": "Otter Quotes",
        "url": f"{SITE_BASE}/",
        "description": "We create a scope of work and send it to local contractors. Homeowners can compare any written bids they receive.",
    }
    service = {
        "@context": "https://schema.org",
        "@type": "Service",
        "serviceType": f"{noun_title} bid comparison",
        "name": f"{noun_title} Bids — {county} County, {state}",
        "url": page_url,
        "provider": {"@id": f"{SITE_BASE}/#organization"},
        "areaServed": {
            "@type": "AdministrativeArea",
            "name": f"{county} County, {state_name}",
        },
    }
    breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE_BASE}/"},
            {"@type": "ListItem", "position": 2, "name": "Locations", "item": f"{SITE_BASE}/locations/"},
            {"@type": "ListItem", "position": 3, "name": f"{county} County, {state}", "item": f"{SITE_BASE}/locations/{c_slug}/"},
            {"@type": "ListItem", "position": 4, "name": t_label, "item": page_url},
        ],
    }

    page = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/png" href="/img/brand-assets/favicon.png">
<title>{html.escape(title, quote=True)}</title>
<meta name="description" content="{html.escape(meta_desc, quote=True)}">
<link rel="canonical" href="{page_url}">
<meta property="og:title" content="{html.escape(title, quote=True)}">
<meta property="og:description" content="{html.escape(meta_desc, quote=True)}">
<meta property="og:type" content="website">
<meta property="og:url" content="{page_url}">
<meta property="og:site_name" content="Otter Quotes">

<!-- GA4 -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-D1Y1TLGEFY"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments)}}
  gtag('js', new Date());
  gtag('config', 'G-D1Y1TLGEFY');
</script>

<script type="application/ld+json">{safe_jsonld(local_business)}</script>
<script type="application/ld+json">{safe_jsonld(service)}</script>
<script type="application/ld+json">{safe_jsonld(breadcrumb)}</script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/design-system.css">
<link rel="stylesheet" href="/css/nav.css">

<style>
.loc-hero {{
  padding: var(--sp-12) var(--sp-6) var(--sp-8);
  background: radial-gradient(ellipse at 50% 0%, rgba(224,123,0,0.06) 0%, transparent 60%);
  text-align: center;
}}
.loc-hero h1 {{ font-size: clamp(1.5rem, 4vw, 2.3rem); margin-bottom: var(--sp-3); }}
.loc-body {{ max-width: 820px; margin: 0 auto; padding: var(--sp-8) var(--sp-6) var(--sp-10); }}
.loc-body h2 {{ margin: var(--sp-8) 0 var(--sp-3); font-size: 1.25rem; }}
.loc-body h3 {{ margin: var(--sp-5) 0 var(--sp-2); font-size: 1.05rem; }}
.loc-body p, .loc-body li {{ color: var(--slate); line-height: 1.75; }}
.loc-body p {{ margin-bottom: var(--sp-3); }}
.loc-body ul {{ margin: 0 0 var(--sp-4) 1.2rem; }}
.loc-body li {{ margin-bottom: var(--sp-2); }}
.loc-body a {{ color: var(--amber); }}
.breadcrumb {{ font-size: 0.85rem; color: var(--gray); padding: var(--sp-4) 0 0; text-align: center; }}
.breadcrumb a {{ color: var(--amber); text-decoration: none; }}
.cta-bar {{ text-align: center; padding: var(--sp-10) 0 var(--sp-6); border-top: 1px solid rgba(255,255,255,0.06); }}
.cta-bar p {{ color: var(--slate); margin-bottom: var(--sp-6); }}
.disclosure {{
  font-size: 0.82rem; color: var(--gray); text-align: center;
  padding: var(--sp-4) var(--sp-6) var(--sp-10); max-width: 700px;
  margin: 0 auto; line-height: 1.6;
}}
</style>
</head>
<body>

<script>
(function() {{
  var navHtml = '<nav class="site-nav"><div class="nav-inner"><a class="nav-logo" href="/"><img src="/img/brand-assets/otter-logo-inline.svg" alt="Otter Quotes" height="32"></a><div class="nav-links"><a href="/how-it-works.html">How It Works</a><a href="/contractor-join.html">For Contractors</a><a href="/start.html" class="btn btn-primary btn-sm">Get Started</a></div></div></nav>';
  document.write(navHtml);
}})();
</script>

<main>
  <div class="loc-hero">
    <div class="breadcrumb" data-boilerplate>
      <a href="/">Home</a> &rsaquo; <a href="/locations/">Locations</a> &rsaquo; {county_esc} County, {state} &rsaquo; {t_label}
    </div>
    <div style="padding: var(--sp-8) var(--sp-6) 0;">
      <h1>{noun_title} Bids for {county_esc} County, {state_name} Homeowners</h1>
      <p style="color:var(--slate); max-width:640px; margin:0 auto;">We create a scope of work and send it to local contractors.</p>
      <p style="color:var(--slate); max-width:640px; margin:0 auto;">You compare any written bids you receive for your {noun} project, and the decision stays yours.</p>
    </div>
  </div>

  <div class="loc-body">

    <p>{intro}</p>

    <h2>The {region_lbl} climate and your {t_label.lower()}</h2>
    <p>{climate}</p>

    <h2>Common {noun} issues in {county_esc} County</h2>
    {issues}

    <h2>What to expect locally</h2>
    {expectations}

    <h2>Season and timing</h2>
    {seasonal}

    {county_notes}

    <h2>How Otter Quotes works here</h2>
    {how_it_works}

    <h2>Frequently asked questions</h2>
    {faq_html}

    <div data-boilerplate>
    <h2>Homeowner guides</h2>
    <ul>
{guide_links}
    </ul>
    </div>

    <div class="cta-bar" data-boilerplate>
      <p>Ready to start your {county_esc} County project?</p>
      <a href="/start.html" class="btn btn-primary btn-lg">Start Your Project with Otter Quotes</a>
    </div>

    <p class="disclosure">
      Otter Quotes is an independent, informational platform that connects homeowners with contractors for property damage repair and exterior improvement projects.
      Otter Quotes does not independently verify, endorse, or warrant the quality of any contractor's work, and does not guarantee the availability of any particular contractor.
      Insurance coverage decisions are made solely by your insurer under the terms of your policy.
      Page generated {generated_on}.
    </p>

  </div>
</main>

<footer style="text-align:center; padding: var(--sp-8); color: var(--gray); font-size:0.85rem; border-top: 1px solid rgba(255,255,255,0.06);">
  <p>&copy; {datetime.date.today().year} Stellar Edge Services, LLC &mdash; Otter Quotes</p>
  <p><a href="/terms.html" style="color:var(--amber)">Terms</a> &bull; <a href="/privacy.html" style="color:var(--amber)">Privacy</a> &bull; <a href="/privacy.html#do-not-sell-or-share" style="color:var(--amber)">Do Not Sell or Share My Personal Information</a></p>
</footer>

</body>
</html>
"""
    return page


# ---------------------------------------------------------------------------
# Sitemap (mirrors generate_contractor_pages.update_sitemap; targets
# the repo-root sitemap.xml, lastmod = generation timestamp)
# ---------------------------------------------------------------------------

EMPTY_SITEMAP = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    "</urlset>\n"
)


def _inside_repo(path: pathlib.Path) -> bool:
    try:
        path.resolve().relative_to(REPO_ROOT.resolve())
        return True
    except ValueError:
        return False


def resolve_sitemap_path(out_dir, sitemap_path=None) -> pathlib.Path:
    """Which sitemap a run may write.

    The repo's own sitemap.xml, and any location inside the repo tree that is
    derived rather than chosen, are used ONLY when out_dir is the repo's
    locations/ directory (then: the repo-root sitemap.xml).

    - Explicit sitemap_path: honoured, except that the repo's sitemap.xml (or a
      hardlink to it) and any path inside the repo tree are refused unless
      out_dir is locations/.
    - Derived (no sitemap_path): next to out_dir (its parent). Refused when
      out_dir is the repo root or when that location is anywhere inside the
      repo tree (tools/sitemap.xml, locations/sitemap.xml, ./sitemap.xml...);
      a location outside the repo tree is fine.
    Refusals raise StateConfigError before anything is written."""
    out_dir = pathlib.Path(out_dir)
    is_repo_locations = out_dir.resolve() == LOCATIONS_DIR.resolve()

    def is_repo_sitemap(path: pathlib.Path) -> bool:
        if path.resolve() == SITEMAP_PATH.resolve():
            return True
        try:   # a hardlink (or any other alias) of the repo sitemap
            return path.exists() and os.path.samefile(path, SITEMAP_PATH)
        except OSError:
            return False

    if sitemap_path is not None:
        explicit = pathlib.Path(sitemap_path)
        if not is_repo_locations and (is_repo_sitemap(explicit) or _inside_repo(explicit)):
            raise StateConfigError(
                "REFUSED: that sitemap path is the repository's sitemap.xml or inside the repository tree; "
                "a sitemap there is written only when the output directory is the repo's locations/ "
                "directory. Use a sitemap path outside the repository. Nothing was written."
            )
        return explicit
    if is_repo_locations:
        return SITEMAP_PATH
    derived = out_dir.parent / "sitemap.xml"
    if out_dir.resolve() == REPO_ROOT.resolve() or _inside_repo(derived) or is_repo_sitemap(derived):
        raise StateConfigError(
            f"REFUSED: out_dir {out_dir} would put its sitemap inside the repository tree ({derived}). "
            f"Pass an explicit --sitemap PATH outside the repository, or use an out_dir whose parent "
            f"directory is outside the repository. Nothing was written."
        )
    return derived


def update_sitemap(generated_paths: list, generated_on: str, dry_run: bool, sitemap_path=None) -> None:
    """Rewrite the /locations/ entries so they list exactly the pages
    generated this run (and nothing else)."""
    sitemap_path = pathlib.Path(sitemap_path or SITEMAP_PATH)
    if sitemap_path.exists():
        sitemap_text = sitemap_path.read_text(encoding="utf-8")
    else:
        sitemap_text = EMPTY_SITEMAP
    original = sitemap_text

    sitemap_text = re.sub(
        r"\s*<url>\s*<loc>https://otterquote\.com/locations/[^<]*</loc>.*?</url>",
        "",
        sitemap_text,
        flags=re.DOTALL,
    )

    if generated_paths:
        new_entries = "\n".join(
            f"""  <url>
    <loc>{SITE_BASE}/locations/{cs}/{ts}/</loc>
    <lastmod>{generated_on}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>"""
            for cs, ts in sorted(generated_paths)
        )
        sitemap_text = sitemap_text.replace("</urlset>", f"\n{new_entries}\n</urlset>")

    if sitemap_text == original:
        print("Sitemap unchanged: no location entries to add or remove.")
        return

    if dry_run:
        print(f"[DRY RUN] Would update {sitemap_path} with {len(generated_paths)} location URLs")
    else:
        sitemap_path.write_text(sitemap_text, encoding="utf-8")
        print(f"Updated {sitemap_path}: {len(generated_paths)} location URLs")


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

TEMPLATE_BASELINES = 60   # synthetic template-only pages per trade (see template_baseline_words)


_BASELINE_CACHE = {}   # (state, date, profile) -> word lists; baselines are deterministic


def template_baseline_words(states, profiles: dict, generated_on: str, masks: dict) -> list:
    """Word lists of synthetic, template-only pages (state profile, NO
    county_content) that are compared against but never scored or emitted.

    They make the shared template text count as shared even in a run of one
    county (a one-county state, a narrowed generate() call). TEMPLATE_BASELINES
    pages per trade, spread round-robin over the profile's regions, with fixed
    names, so every template variant and every region's climate copy is
    rendered by several of them."""
    out = []
    for st in states:
        profile = dict(profiles[st])
        profile["county_content"] = {}
        key = (st, generated_on, json.dumps({k: profile[k] for k in sorted(profile)}, sort_keys=True),
               tuple(sorted(masks[st].exact.items())))
        cached = _BASELINE_CACHE.get(key)
        if cached is None:
            regions = sorted(profile["region_label"])
            names = {f"Baseline{n:02d}": regions[n % len(regions)] for n in range(TEMPLATE_BASELINES)}
            profile["county_region"] = {**profile["county_region"], **names}
            cached = [main_words(build_page(name, trade, generated_on, st, profile=profile), masks[st])
                      for trade in ELIGIBLE_TRADES for name in names]
            _BASELINE_CACHE[key] = cached
        out.extend(cached)
    return out


def generate(states, out_dir=None, sitemap_path=None, counties_path=None,
             dry_run=False, build_fn=None, generated_on=None, profiles_dir=None) -> dict:
    """Generate pages for the given allow-listed states.

    Every page of the run is built first; the strict unique-content gate
    (strict_unique_counts) needs the whole run to tell shared text from unique
    text. Pages under MIN_WORDS are skipped; the rest are linted and written.

    build_fn(county, trade, generated_on, state) -> html lets tests inject
    thin or non-compliant content. Returns a summary dict.
    """
    refuse_blocked_states(states)
    out_dir = pathlib.Path(out_dir or LOCATIONS_DIR)
    sitemap_path = resolve_sitemap_path(out_dir, sitemap_path)
    generated_on = generated_on or datetime.date.today().isoformat()
    summary = {"states": list(states), "tuples": 0, "written": 0, "skipped_thin": [], "paths": [],
               "min_strict_unique_words": None, "median_strict_unique_words": None,
               "min_unshared_shingles": None, "median_unshared_shingles": None}

    if not states:
        print("State allow-list is empty: no pages emitted. "
              "A state is added only after its D-344 statute search (see tools/README-locations-workflow.md).")
        update_sitemap([], generated_on, dry_run, sitemap_path)
        return summary

    profiles = validate_states(states, counties_path, profiles_dir)
    if build_fn is None:
        def build_fn(county, trade, generated_on, state):
            return build_page(county, trade, generated_on, state, profile=profiles[state])

    tuples = discover_tuples(states, counties_path)
    summary["tuples"] = len(tuples)
    print(f"Allow-listed states: {', '.join(states)}; (county, trade) tuples: {len(tuples)}")

    masks = {st: StateMask(st, profiles[st]["name"], load_counties(st, counties_path),
                           list(profiles[st]["region_label"].values()) + list(profiles[st]["region_label"]))
             for st in states}
    built, page_states = [], []
    for state, county, trade in tuples:
        built.append((county_slug(county, state), trade, build_fn(county, trade, generated_on, state)))
        page_states.append(state)
    word_lists = [main_words(page_html, masks[st]) for (_, _, page_html), st in zip(built, page_states)]
    baseline_lists = template_baseline_words(states, profiles, generated_on, masks)
    strict = strict_unique_counts(word_lists, baseline_lists)

    # Pass 1: gate. Pass 2: lint EVERY passing page before any file is written,
    # so a lint failure leaves zero pages and no sitemap change. Pass 3: write.
    passing = []
    for (c_slug, trade, page_html), wc in zip(built, strict):
        page_id = f"{c_slug}/{trade}"
        if wc < MIN_WORDS:
            print(f"  SKIPPED (thin, {wc} < {MIN_WORDS} strict-unique words): {page_id}")
            summary["skipped_thin"].append(page_id)
            continue
        passing.append((c_slug, trade, page_html, wc))
    for c_slug, trade, page_html, _wc in passing:
        page_id = f"{c_slug}/{trade}"
        compliance_lint(page_html, page_id)
        if not page_html.rstrip().endswith("</html>"):
            raise RuntimeError(f"INTEGRITY FAIL [{page_id}]: generated HTML does not end with </html>")
    for c_slug, trade, page_html, wc in passing:
        page_dir = out_dir / c_slug / trade
        page_path = page_dir / "index.html"
        if dry_run:
            print(f"  [DRY RUN] Would write {page_path} ({wc} strict-unique words)")
        else:
            page_dir.mkdir(parents=True, exist_ok=True)
            page_path.write_text(page_html, encoding="utf-8", newline="\n")
            print(f"  Written: {page_path} ({wc} strict-unique words)")
        summary["written"] += 1
        summary["paths"].append((c_slug, trade))

    if strict:
        summary["min_strict_unique_words"] = min(strict)
        summary["median_strict_unique_words"] = statistics.median(strict)
        print(f"Strict-unique words per page (floor {MIN_WORDS}; words on no shared {SHINGLE_SIZE}-word shingle): "
              f"min {summary['min_strict_unique_words']}, median {summary['median_strict_unique_words']:g} "
              f"over {len(strict)} pages")
        shares = cross_page_uniqueness([shingles(w) for w in word_lists])
        summary["min_unshared_shingles"] = min(shares)
        summary["median_unshared_shingles"] = statistics.median(shares)
        print(f"Cross-page uniqueness ({SHINGLE_SIZE}-word shingles on no other page in this run; "
              f"informational, not a gate): min {summary['min_unshared_shingles']:.1%}, "
              f"median {summary['median_unshared_shingles']:.1%}")

    update_sitemap(summary["paths"], generated_on, dry_run, sitemap_path)
    return summary


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Generate /locations/[county]/[trade]/ SEO pages")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without writing files")
    parser.add_argument("--allowlist", default=None,
                        help="Path to the state allow-list JSON (default: data/location-pages-state-allowlist.json)")
    parser.add_argument("--out-dir", default=None,
                        help="Where to write pages (default: the repo's locations/). A non-default out-dir "
                             "gets its own sitemap.xml next to it and never touches the repo sitemap; "
                             "out-dir at the repo root or directly under it requires --sitemap.")
    parser.add_argument("--sitemap", default=None, help="Explicit sitemap path (default: see --out-dir)")
    args = parser.parse_args()

    try:
        states = load_allowlist(args.allowlist)
        summary = generate(states, out_dir=args.out_dir, sitemap_path=args.sitemap, dry_run=args.dry_run)
    except (StateConfigError, ComplianceError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    print()
    print(f"Done{' (dry run)' if args.dry_run else ''}.")
    print(f"  Allow-listed states:       {len(summary['states'])}")
    print(f"  Tuples considered:         {summary['tuples']}")
    print(f"  Pages generated:           {summary['written']}")
    print(f"  Skipped (< {MIN_WORDS} strict-unique words): {len(summary['skipped_thin'])}")
    if summary["min_strict_unique_words"] is not None:
        print(f"  Strict-unique words min / median: {summary['min_strict_unique_words']} / "
              f"{summary['median_strict_unique_words']:g}")
        print(f"  Unshared shingles min / median:   {summary['min_unshared_shingles']:.1%} / "
              f"{summary['median_unshared_shingles']:.1%}")


if __name__ == "__main__":
    main()
