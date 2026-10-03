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

UNIQUE-CONTENT FLOOR (D-241 guardrail 2, KEPT): MIN_WORDS = 500.
  unique_word_count() counts the words of the page's main content with the
  boilerplate that every page shares removed: breadcrumb, call-to-action bar,
  legal disclosure and the homeowner-guide link list (all marked
  data-boilerplate in the template), plus everything outside <main> (nav,
  head, footer, scripts, styles, JSON-LD). What remains is the page-specific
  prose: intro, climate, issue list, expectations, season/timing, how it
  works, FAQ. The earlier implementation counted every word in the HTML
  after stripping tags, which let shared chrome and boilerplate count toward
  the floor.

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

MIN_WORDS = 500  # unique-content floor per page (D-241 guardrail 2, kept by D-345)

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
_TRADESPEOPLE = r"(?:contractors?|roofers?|siders?|installers?|pros|professionals|crews|companies|providers|bidders|vendors|partners)"
_PLURAL_TRADESPEOPLE = r"(?:contractors|roofers|siders|installers|pros|professionals|crews|companies|providers|bidders|vendors|partners)"

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
    rf"\bcounty\s+{_PLURAL_TRADESPEOPLE}\b",                                  # Marion County contractors
    rf"\b{_PLURAL_TRADESPEOPLE}\s+(?:ready|standing\s+by|waiting|eager|willing|able|on\s+call)\b",
    r"\blocal\s+contractors\s+we\b",                                          # local contractors we work with / have
    r"\bcontractors\s+(?:near|around)\s+you\b",
    r"\bcontractors\s+(?:working|operating|located|based)\s+in\b",
    r"\bapproved\s+contractors?\b",
    r"\bcontractors?\s+(?:are\s+)?available\b",
    r"\bcontractors\s+on\s+(?:the\s+platform|otter\s+quotes)\b",
    rf"\b(?:we|otter\s+quotes)\s+(?:have|has|employ|employs|use|uses|work\s+with|works\s+with|partner\s+with|partners\s+with)\s+(?:\w+\s+){{0,3}}{_PLURAL_TRADESPEOPLE}\b",
    r"\bconnects?\s+(?:you|homeowners|consumers|customers)\s+with\s+(?:\w+\s+)?(?:contractors|roofers|pros|professionals)\b",
    r"\bplatform\s+coverage\b",
    r"\bcontractor\s+profiles?\b",
)

# Price / savings / speed promises (D-168 and the no-promises rule).
PROMISE_BANS = (
    r"\bsave\s+up\s+to\b",
    r"\d\s*%\s*off\b",
    r"\bfree\s+for\s+homeowners\b",
    r"\bin\s+\d+\s+(?:hours?|days?|minutes?)\b",
    r"\bwithin\s+(?:\d+|an?|one|two|three|four|five|a\s+few|several)\s+(?:business\s+)?(?:hours?|days?|minutes?)\b",
    r"(?<!not )\bguarantee\w*",     # "does not guarantee the availability..." (disclosure) is allowed
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

def load_allowlist(path=None) -> list:
    """Return the allow-listed state codes from the CRO-maintained file."""
    path = pathlib.Path(path or ALLOWLIST_PATH)
    if not path.exists():
        raise StateConfigError(f"State allow-list file not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    states = data.get("states") if isinstance(data, dict) else None
    if not isinstance(states, list):
        raise StateConfigError(f'{path}: expected a JSON object with a "states" list')
    out = []
    for code in states:
        if not (isinstance(code, str) and re.fullmatch(r"[A-Z]{2}", code)):
            raise StateConfigError(f"{path}: invalid state code {code!r} (expected two capital letters)")
        if code not in out:
            out.append(code)
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
        if not (isinstance(counties, list) and counties and all(isinstance(c, str) and c for c in counties)):
            raise bad(f'region "{key}": "counties" must be a non-empty list of strings')
        if not (isinstance(climate, list) and climate and all(isinstance(c, str) and c.strip() for c in climate)):
            raise bad(f'region "{key}": "climate" must be a non-empty list of strings')
        for text in climate:
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
    return {"name": name, "county_region": county_region,
            "region_label": region_label, "region_climate": region_climate}


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


class _UniqueTextParser(HTMLParser):
    """Collect text inside <main>, skipping script/style and any element
    marked data-boilerplate (and everything nested in it)."""

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
        if self.skip_stack or tag in ("script", "style") or "data-boilerplate" in a:
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


def unique_words(html_text: str) -> list:
    """Words of page-specific prose: <main> text minus data-boilerplate
    blocks (see module docstring for the definition)."""
    p = _UniqueTextParser()
    p.feed(html_text)
    return p.words


def unique_word_count(html_text: str) -> int:
    return len(unique_words(html_text))


SHINGLE_SIZE = 8


def shingles(words: list) -> set:
    """Set of SHINGLE_SIZE-word shingles (lower-cased) of a word list."""
    w = [x.lower() for x in words]
    return {" ".join(w[i:i + SHINGLE_SIZE]) for i in range(max(0, len(w) - SHINGLE_SIZE + 1))}


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


_INLINE_TAGS = {"a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark",
                "q", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "font"}
_ATTR_NAMES = {"title", "alt", "placeholder", "content", "value", "label"}
_INVISIBLE = re.compile("[­​-‍⁠﻿]")


class _LintViews(HTMLParser):
    """Split a page into what a reader or crawler sees: visible text,
    text-bearing attribute values, JSON-LD scripts (any <script> whose type
    mentions ld+json, in any attribute order or quoting), and other scripts."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.visible, self.attrs, self.jsonld, self.scripts = [], [], [], []
        self._kind, self._buf = None, []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if value and (name in _ATTR_NAMES or name.startswith("aria-") or name.startswith("data-")):
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
            self.visible.append(" ")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._kind:
            body = "".join(self._buf)
            if self._kind == "ld":
                self.jsonld.append(body)
            elif self._kind == "script":
                self.scripts.append(body)
            self._kind, self._buf = None, []
        elif tag not in _INLINE_TAGS:
            self.visible.append(" ")

    def handle_data(self, data):
        if self._kind:
            self._buf.append(data)
        else:
            self.visible.append(data)


def _normalize(text: str) -> str:
    text = _INVISIBLE.sub("", text)
    return re.sub(r"[\s ]+", " ", text).strip()


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


def lintable_text(html_text: str) -> str:
    """Normalised text the lint matches against: visible text (tags stripped,
    entities decoded, nbsp and zero-width characters handled) + text-bearing
    attribute values + parsed JSON-LD strings + other script text."""
    p = _LintViews()
    p.feed(html_text)
    ld = []
    for block in p.jsonld:
        try:
            _walk_strings(json.loads(block), ld)
        except ValueError:
            raise ComplianceError("JSON-LD block is not valid JSON")
    scripts = [re.sub(r"<[^>]+>", " ", html.unescape(s)) for s in p.scripts]
    return _normalize(" ".join(["".join(p.visible), " ".join(p.attrs), " ".join(ld), " ".join(scripts)]))


def compliance_lint(html_text: str, page_id: str) -> None:
    """Raise ComplianceError if the page breaks the D-345 copy rule or the
    D-104 / D-168 / D-175 / D-312 / D-326 bans. Every check runs on the
    normalised visible/attribute/JSON-LD text and, for the substring and
    vendor checks, also on the raw markup."""
    text = lintable_text(html_text)
    raw = _normalize(html.unescape(html_text))
    lowered = text.lower()

    if REQUIRED_PHRASE not in lowered:
        raise ComplianceError(f'[{page_id}] required phrase missing: "{REQUIRED_PHRASE}"')

    for view in (lowered, raw.lower()):
        for phrase in FORBIDDEN_PHRASES:
            if phrase in view:
                raise ComplianceError(f"[{page_id}] forbidden phrase '{phrase}' in page copy")

    # D-175: the bare one-word brand is forbidden in copy; the otterquote.com
    # domain and URLs are fine.
    for view in (text, raw):
        stripped = re.sub(r"https?://[^\s\"'<>]+", "", view)
        stripped = re.sub(r"otterquote\.com", "", stripped, flags=re.IGNORECASE)
        for term in FORBIDDEN_CASE_SENSITIVE:
            if term in stripped:
                raise ComplianceError(f"[{page_id}] forbidden term '{term}' in page copy")

    for label, bans in (("have-contractors phrasing (D-345)", HAVE_CONTRACTORS_BANS),
                        ("price/speed promise", PROMISE_BANS),
                        ("insurer-obligation / coverage phrasing (D-326)", D326_BANS)):
        for pattern in bans:
            m = re.search(pattern, text, flags=re.IGNORECASE)
            if m:
                raise ComplianceError(f"[{page_id}] {label}: '{m.group(0)}'")

    # D-312 vendor names. Strip CSS :hover / Tailwind hover: first (not vendor
    # references), then match whole words.
    for view in (lowered, raw.lower()):
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
    "<p>Timing matters in {county} County. Damage discovered in May competes with every other storm claim in {region} for adjuster and contractor attention; the same repair scoped in September may meet a different queue. Documentation is the part that does not depend on the calendar: photograph damage as soon as it is safe and note the date for your adjuster. Ask your insurer whether your policy sets a deadline for reporting damage.</p>",
    "<p>Most exterior repair work in {county} County happens in a window that runs roughly from late spring through late fall. Inside that window, post-storm weeks are the most congested and the most quote-inflated; the weeks after the rush are a calmer time to compare bids. Whatever the calendar says, the sequence stays the same: document first, understand your policy second, compare written bids third — and let contractors compete for the job rather than racing to hand it to the first knock on the door.</p>",
    "<p>Storm claims in {region} cluster hard: one hail event can put thousands of {county} County area roofs, gutters, and siding elevations into the repair pipeline in a single afternoon. Comparing more than one written bid for the same scope is one way homeowners check pricing when demand spikes.</p>",
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
        "In {county} County, replacement windows are both a storm-repair item and an efficiency upgrade. When wind or hail compromises frames and seals, homeowners face a choice between like-for-like replacement and stepping up to modern units — and competing bids are the only reliable way to price that choice.",
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
        "<li><strong>Energy-efficiency step-ups</strong> — homeowners choosing between like-for-like replacement and upgraded units need competing bids to price the difference.</li>",
    ],
}

ISSUE_ITEMS_PER_PAGE = 5

# Local-expectations copy is assembled from two independently selected
# paragraph slots (A x B = 9 combinations) rather than fixed pairs.
EXPECTATIONS_A = [
    "<p>Storm repair in {county} County follows a rhythm locals know well: a severe-weather event, a wave of door-knocking crews from out of the area, and then the slower, quieter work of getting damage documented, questions raised with your insurer, and a repair scoped carefully. Many homeowners find it helps to slow the process down at the start — documenting damage before tarps and repairs change the evidence, reading their policy before the first phone call, and getting more than one written bid before signing anything.</p>",
    "<p>Homeowners in {county} County navigating a storm claim juggle three parallel tracks: the insurance process (adjuster inspection, scope, settlement), the contractor process (bids, scheduling, materials), and their own documentation. Keeping those tracks separate is the single most useful habit — your insurer decides coverage under your policy; your contractor determines what the repair actually requires; and written bids give you something concrete to discuss with your adjuster.</p>",
    "<p>The practical sequence for {county} County homeowners after storm damage: document everything with photos before any cleanup, review your policy and ask your insurer how to report damage, and line up written repair bids so you have a written scope and pricing to discuss with your adjuster. Nothing in that sequence requires committing to a contractor early — and keeping your options open until bids are in hand is exactly what a competitive process is for.</p>",
]

EXPECTATIONS_B = [
    "<p>Local demand also moves in waves. After a widely publicized hail event, every reputable contractor in {region} gets busy at once. Competing bids protect you twice in that environment: they give you a way to check pricing when demand spikes, and they can surface scope differences — what one bidder saw that another missed — before the work starts rather than after.</p>",
    "<p>Be appropriately skeptical of anyone who shows up unsolicited after a storm, pressures you to sign paperwork on the spot, or quotes a price without getting on the roof or examining the damage up close. {state} sees storm-chasing crews every season, and one practical defense is unhurried, written bids that you can check against each other.</p>",
    "<p>Ask any contractor for an itemized written estimate, proof of insurance, and local references. The process can take longer after county-wide storm events, when every roofer, sider, and installer in {region} is working the same backlog. Patience and paperwork usually serve homeowners better than speed and pressure.</p>",
]

HOW_IT_WORKS = [
    "<p>Here is how Otter Quotes works for a {county} County project. You submit your project details once. Otter Quotes creates a scope of work from them, and we send it to local contractors. You can then compare any written bids you receive side by side, on scope, price, and terms. The platform is informational, and the decision stays entirely yours.</p>",
    "<p>Instead of calling down a list and repeating your story, you submit your {county} County project once. Otter Quotes builds the scope of work and we send it to local contractors; any bids you receive are written, so you can compare them on scope, price, and terms. Comparing more than one written bid is one way to understand local pricing, especially in the busy weeks after a storm.</p>",
    "<p>The process has four steps: you submit your {county} County project, Otter Quotes creates a scope of work, we send it to local contractors, and you compare any written bids you receive. No obligation attaches to submitting a project, and choosing a contractor, or choosing none of them, remains entirely your call.</p>",
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
         "For the exterior portion, usually not — but being present means you see the documented damage yourself and can ask questions while the contractor is still on site."),
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
    how_it_works = variant(seed, 5, HOW_IT_WORKS).format(county=county_esc)

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
        f"Help with storm-damaged {t_label.lower()} for homeowners in {county} County, {state_name}: "
        f"Otter Quotes creates a scope of work for your project and we send it to local contractors, "
        f"so you can compare any written bids you receive side by side."
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
        "description": "Otter Quotes is an independent platform for property damage repair and exterior improvement projects. Otter Quotes creates a scope of work and we send it to local contractors, so homeowners can compare any written bids they receive.",
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
      <p style="color:var(--slate); max-width:640px; margin:0 auto;">Otter Quotes creates a scope of work for your {noun} project and we send it to local contractors. You compare any written bids you receive, and the decision stays yours.</p>
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

    <p class="disclosure" data-boilerplate>
      Otter Quotes is an independent, informational platform for property damage repair and exterior improvement projects. Otter Quotes creates a scope of work and we send it to local contractors.
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


def resolve_sitemap_path(out_dir, sitemap_path=None) -> pathlib.Path:
    """Which sitemap a run may write. The repo-root sitemap.xml is used ONLY
    when out_dir is the repo's locations/ directory. Any other out_dir gets
    its own sitemap.xml next to it (never the repo's), unless the caller
    passes an explicit path."""
    if sitemap_path is not None:
        return pathlib.Path(sitemap_path)
    out_dir = pathlib.Path(out_dir)
    if out_dir.resolve() == LOCATIONS_DIR.resolve():
        return SITEMAP_PATH
    return out_dir.parent / "sitemap.xml"


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

def generate(states, out_dir=None, sitemap_path=None, counties_path=None,
             dry_run=False, build_fn=None, generated_on=None, profiles_dir=None) -> dict:
    """Generate pages for the given allow-listed states.

    build_fn(county, trade, generated_on, state) -> html lets tests inject
    thin or non-compliant content. Returns a summary dict.
    """
    out_dir = pathlib.Path(out_dir or LOCATIONS_DIR)
    sitemap_path = resolve_sitemap_path(out_dir, sitemap_path)
    generated_on = generated_on or datetime.date.today().isoformat()
    summary = {"states": list(states), "tuples": 0, "written": 0, "skipped_thin": [], "paths": [],
               "min_unique_words": None, "median_unique_words": None,
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

    counts = []
    shingle_sets = []
    for state, county, trade in tuples:
        c_slug = county_slug(county, state)
        page_id = f"{c_slug}/{trade}"
        page_html = build_fn(county, trade, generated_on, state)

        words = unique_words(page_html)
        wc = len(words)
        counts.append(wc)
        shingle_sets.append(shingles(words))
        if wc < MIN_WORDS:
            print(f"  SKIPPED (thin, {wc} < {MIN_WORDS} unique words): {page_id}")
            summary["skipped_thin"].append(page_id)
            continue
        compliance_lint(page_html, page_id)
        if not page_html.rstrip().endswith("</html>"):
            raise RuntimeError(f"INTEGRITY FAIL [{page_id}]: generated HTML does not end with </html>")

        page_dir = out_dir / c_slug / trade
        page_path = page_dir / "index.html"
        if dry_run:
            print(f"  [DRY RUN] Would write {page_path} ({wc} unique words)")
        else:
            page_dir.mkdir(parents=True, exist_ok=True)
            page_path.write_text(page_html, encoding="utf-8", newline="\n")
            print(f"  Written: {page_path} ({wc} unique words)")
        summary["written"] += 1
        summary["paths"].append((c_slug, trade))

    if counts:
        summary["min_unique_words"] = min(counts)
        summary["median_unique_words"] = statistics.median(counts)
        print(f"Unique words per page (floor {MIN_WORDS}): min {summary['min_unique_words']}, "
              f"median {summary['median_unique_words']:g} over {len(counts)} pages")
        shares = cross_page_uniqueness(shingle_sets)
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
                             "gets its own sitemap.xml next to it and never touches the repo sitemap.")
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
    print(f"  Skipped (< {MIN_WORDS} unique words): {len(summary['skipped_thin'])}")
    if summary["min_unique_words"] is not None:
        print(f"  Unique words min / median:  {summary['min_unique_words']} / {summary['median_unique_words']:g}")
        print(f"  Unshared shingles min / median: {summary['min_unshared_shingles']:.1%} / {summary['median_unshared_shingles']:.1%}")


if __name__ == "__main__":
    main()
