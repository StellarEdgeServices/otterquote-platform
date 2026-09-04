#!/usr/bin/env python3
"""
Generate programmatic /locations/[county]/[trade]/ SEO landing pages.

Pulls (county, trade, active contractor count) tuples from Supabase and
generates one static page per ELIGIBLE tuple at:
  locations/[county-slug]/[trade-slug]/index.html   (repo root)

Netlify publishes the repo root (netlify.toml: publish = "."), so repo-root
locations/ is what actually serves at /locations/ — same convention as the
contractors/ and partners/ generators (gh-403 publish-root fix; the previous
otterquote-deploy/ output path could never serve at the canonical URLs).

Also updates the repo-root sitemap.xml with generated URLs
(lastmod = generation timestamp).

Usage:
  python tools/generate_location_pages.py [--dry-run]

Eligibility (D-169 carve-out, D-241 guardrails — task 86e1h5hty):
  - trade in {roofing, siding, gutters, windows}
  - contractors.status = 'active' (the canonical live status: the admin
    approval path sets 'active'; no 'approved' value exists in prod — gh-403)
  - contractors.service_counties overlaps the county
    ("Marion-IN" explicit entries; "IN:*" = statewide wildcard, expands
    to all 92 Indiana counties)
  - contractor count >= MIN_CONTRACTORS (2). HARD guardrail, non-negotiable:
    false-advertising and thin-content risk if pages render with thin coverage.

Auto-noindex: if a previously generated page's tuple drops below the
minimum at regeneration time, the page is KEPT on disk but a
<meta name="robots" content="noindex"> tag is injected, and the URL is
removed from the sitemap.

Compliance (enforced by lint in this script):
  - D-104: no "vetted"/screening claims about contractors.
  - D-168: no response-time claims.
  - D-175: brand is "Otter Quotes" (two words) in copy.
  - Required informational pattern on every page:
    "Otter Quotes connects you with contractors who serve [County]"

Notes:
  - Mirrors tools/generate_contractor_pages.py for Supabase access
    (SUPABASE_SERVICE_ROLE_KEY env var or .deploy-secrets) and page/template
    conventions (design-system CSS, GA4, JSON-LD, sitemap entry format).
  - Run from repo root: python tools/generate_location_pages.py
"""

import os
import re
import sys
import json
import html
import hashlib
import pathlib
import datetime
import argparse
import urllib.request
import urllib.parse

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SUPABASE_URL = "https://yeszghaspzwwstvsrioa.supabase.co"
SITE_BASE = "https://otterquote.com"
REPO_ROOT = pathlib.Path(__file__).parent.parent
LOCATIONS_DIR = REPO_ROOT / "locations"
SITEMAP_PATH = REPO_ROOT / "sitemap.xml"

# HARD guardrail (D-241) — do NOT lower. Pages must never render with
# fewer than 2 approved contractors covering the (county, trade) tuple.
MIN_CONTRACTORS = 2

ELIGIBLE_TRADES = ("roofing", "siding", "gutters", "windows")

TRADE_LABELS = {
    "roofing": "Roofing",
    "siding": "Siding",
    "gutters": "Gutters",
    "windows": "Windows",
}

MIN_WORDS = 500  # unique-content floor per page (task acceptance criterion)

# Compliance lint — none of these may appear in rendered page text.
# D-104 (no vetted claims), D-168 (no response-time claims), D-175 (naming).
FORBIDDEN_PHRASES = (
    "vetted",
    "vetting",
    "pre-screened",
    "prescreened",
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
    "OtterQuote",   # D-175: brand copy is "Otter Quotes" (two words)
    "ClaimShield",
)

REQUIRED_PATTERN = "Otter Quotes connects you with contractors who serve"

# ---------------------------------------------------------------------------
# Indiana counties (92) with coarse climate region bands.
# Region drives climate copy only ("northern/central/southern Indiana").
# ---------------------------------------------------------------------------

NORTHERN = (
    "Adams", "Allen", "Benton", "Carroll", "Cass", "DeKalb", "Elkhart",
    "Fulton", "Huntington", "Jasper", "Kosciusko", "LaGrange", "Lake",
    "LaPorte", "Marshall", "Miami", "Newton", "Noble", "Porter", "Pulaski",
    "St. Joseph", "Starke", "Steuben", "Wabash", "Wells", "White", "Whitley",
)
CENTRAL = (
    "Bartholomew", "Blackford", "Boone", "Brown", "Clay", "Clinton",
    "Decatur", "Delaware", "Fayette", "Fountain", "Franklin", "Grant",
    "Hamilton", "Hancock", "Hendricks", "Henry", "Howard", "Jay", "Johnson",
    "Madison", "Marion", "Monroe", "Montgomery", "Morgan", "Owen", "Parke",
    "Putnam", "Randolph", "Rush", "Shelby", "Tippecanoe", "Tipton", "Union",
    "Vermillion", "Vigo", "Warren", "Wayne",
)
SOUTHERN = (
    "Clark", "Crawford", "Daviess", "Dearborn", "Dubois", "Floyd", "Gibson",
    "Greene", "Harrison", "Jackson", "Jefferson", "Jennings", "Knox",
    "Lawrence", "Martin", "Ohio", "Orange", "Perry", "Pike", "Posey",
    "Ripley", "Scott", "Spencer", "Sullivan", "Switzerland", "Vanderburgh",
    "Warrick", "Washington",
)

INDIANA_COUNTIES = NORTHERN + CENTRAL + SOUTHERN
assert len(INDIANA_COUNTIES) == 92, f"Expected 92 Indiana counties, got {len(INDIANA_COUNTIES)}"
assert len(set(INDIANA_COUNTIES)) == 92, "Duplicate county in INDIANA_COUNTIES"

COUNTY_REGION = {}
for _c in NORTHERN:
    COUNTY_REGION[_c] = "northern"
for _c in CENTRAL:
    COUNTY_REGION[_c] = "central"
for _c in SOUTHERN:
    COUNTY_REGION[_c] = "southern"

STATE_CODE = "IN"
STATE_NAME = "Indiana"
STATEWIDE_WILDCARD = f"{STATE_CODE}:*"   # "IN:*" — contractor serves every IN county


# ---------------------------------------------------------------------------
# Supabase access (mirrors tools/generate_contractor_pages.py)
# ---------------------------------------------------------------------------

def load_service_key() -> str:
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")
    if key:
        return key
    secrets_path = REPO_ROOT / "tools" / ".deploy-secrets"
    if not secrets_path.exists():
        secrets_path = REPO_ROOT.parent / "Stellar Edge Services" / "OtterQuote" / "Tools" / ".deploy-secrets"
    if secrets_path.exists():
        for line in secrets_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError(
        "SUPABASE_SERVICE_ROLE_KEY not found. Set the env var or ensure .deploy-secrets is present."
    )


def supabase_get(service_key: str, path: str) -> list:
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    req = urllib.request.Request(
        url,
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())


def fetch_approved_contractors(service_key: str) -> list:
    """Fetch approved contractors with service areas and trades.

    Only aggregate counts and (for directory-opted-in contractors) the
    company name + profile slug reach the generated HTML. No PII (D-249).
    """
    fields = "id,company_name,trades,service_counties,status,public_directory_optin"
    # status=eq.active: canonical live-contractor status (admin approval path
    # sets 'active'; prod has NO 'approved' rows — gh-403 status-semantics fix).
    path = f"contractors?select={fields}&status=eq.active&order=company_name.asc"
    return supabase_get(service_key, path)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-") or "x"


def county_slug(county: str) -> str:
    return slugify(f"{county} County {STATE_CODE}")


def safe_jsonld(obj) -> str:
    return json.dumps(obj, indent=2).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def contractor_serves_county(service_counties: list, county: str) -> bool:
    if not service_counties:
        return False
    if STATEWIDE_WILDCARD in service_counties:
        return True
    return f"{county}-{STATE_CODE}" in service_counties


def compute_tuples(contractors: list) -> dict:
    """Return {(county, trade): [contractor dicts]} for eligible trades.

    Wildcard "IN:*" expands to all 92 Indiana counties. Only tuples meeting
    MIN_CONTRACTORS survive into the eligible set (hard D-241 guardrail).
    """
    coverage = {}
    for c in contractors:
        trades = [t for t in (c.get("trades") or []) if t in ELIGIBLE_TRADES]
        counties = c.get("service_counties") or []
        if not trades or not counties:
            continue
        if STATEWIDE_WILDCARD in counties:
            served = list(INDIANA_COUNTIES)
        else:
            served = [
                x[: -len(f"-{STATE_CODE}")]
                for x in counties
                if x.endswith(f"-{STATE_CODE}")
            ]
            served = [x for x in served if x in COUNTY_REGION]
        for county in served:
            for trade in trades:
                coverage.setdefault((county, trade), []).append(c)
    return coverage


def word_count(html_text: str) -> int:
    text = re.sub(r"<script.*?</script>", " ", html_text, flags=re.DOTALL)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    return len([w for w in re.split(r"\s+", text) if w.strip()])


def compliance_lint(html_text: str, page_id: str) -> None:
    lowered = html_text.lower()
    for phrase in FORBIDDEN_PHRASES:
        # D-175 check is case-sensitive on the one-word brand form; the rest
        # are case-insensitive.
        if phrase in ("OtterQuote", "ClaimShield"):
            # allow otterquote.com domain / URLs, forbid the bare brand form in copy
            stripped = re.sub(r"otterquote\.com", "", html_text, flags=re.IGNORECASE)
            stripped = re.sub(r"https?://[^\s\"'<>]+", "", stripped)
            if phrase in stripped:
                raise RuntimeError(f"COMPLIANCE LINT FAIL [{page_id}]: forbidden term '{phrase}' in page copy")
        elif phrase in lowered:
            raise RuntimeError(f"COMPLIANCE LINT FAIL [{page_id}]: forbidden phrase '{phrase}' in page copy")
    if REQUIRED_PATTERN not in html_text:
        raise RuntimeError(f"COMPLIANCE LINT FAIL [{page_id}]: required pattern missing: '{REQUIRED_PATTERN}...'")


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

REGION_LABEL = {
    "northern": "northern Indiana",
    "central": "central Indiana",
    "southern": "southern Indiana",
}

REGION_CLIMATE = {
    "northern": [
        "Homes in {county} County sit in the northern band of Indiana, where winters run colder and longer than the rest of the state. Freeze-thaw cycling is the quiet destroyer here: moisture works into small gaps, freezes, expands, and pries building materials apart a little further each cycle. Counties near Lake Michigan also pick up lake-effect snow loads that downstate homes rarely see, and spring brings the same severe thunderstorm and hail exposure the whole state shares.",
        "The northern tier of Indiana, where {county} County sits, takes the state's roughest winters. Extended stretches below freezing, heavier snow accumulation, and repeated freeze-thaw swings put year-round stress on every exterior surface of a home. When spring arrives, the region trades snow load for thunderstorm season — wind, hail, and driving rain from April into July are a normal part of the calendar.",
        "Weather works on {county} County homes from two directions. Winter in northern Indiana means sustained cold, snow load, and the freeze-thaw cycling that gradually enlarges every small opening a storm has ever made; spring and summer mean convective storms carrying hail and damaging wind across the region. Exterior systems that shrug off one season often show their weaknesses in the other, which is why local damage assessments look at the whole year, not just the last storm.",
    ],
    "central": [
        "{county} County sits in central Indiana, squarely inside the Midwest's spring hail corridor. Severe thunderstorms tracking across the state from April through July drop hail and straight-line winds on this region nearly every year, and the insurance claims that follow are a routine part of homeownership here. Winters add freeze-thaw cycling that gradually works on any small gap or crack a storm has opened.",
        "Central Indiana, home to {county} County, sees some of the state's most active severe-weather seasons. Spring and early summer bring recurring rounds of thunderstorms capable of producing damaging hail and wind gusts; late fall and winter bring ice, snow, and the freeze-thaw swings that widen every small defect left behind. Exterior damage in this region is often a multi-season story, not a single event.",
        "Severe weather is not an occasional visitor in {county} County — it is a season. The central Indiana storm corridor produces hail and straight-line wind events most years between April and July, and the months that follow are when the damage those storms caused quietly compounds: UV exposure through the summer, moisture through the fall, and freeze-thaw pressure through the winter. Homeowners here learn to treat post-storm inspection as routine maintenance.",
    ],
    "southern": [
        "{county} County lies in southern Indiana, where the climate runs warmer and more humid than the rest of the state. Storm systems riding up the Ohio Valley bring intense rain, wind, and periodic hail, while the longer humid season accelerates moisture-driven wear — rot, mold, and premature material aging — on homes that aren't kept tight. Winters are milder but still deliver enough freeze events to punish unresolved damage.",
        "Southern Indiana's river-valley climate gives {county} County hotter summers, higher humidity, and powerful storm systems moving up from the south and west. Wind and hail events cluster in spring and early summer, and the extended warm season keeps moisture pressure on exterior materials for more months of the year than homeowners further north experience.",
        "In {county} County, the exterior of a home fights humidity as much as it fights storms. Southern Indiana's long warm season keeps moisture working on wood, fasteners, and sealants for most of the year, so storm damage that would stay stable for months in a drier climate deteriorates faster here. The storm systems themselves arrive mostly in spring and early summer, riding the Ohio Valley with wind, hail, and heavy rain.",
    ],
}

SEASONAL = [
    "<p>The repair calendar in {region} has a shape worth planning around. Spring storm season generates the damage; early summer is when adjusters and contractors are busiest; late summer and fall offer the best mix of contractor availability and working weather; and winter narrows the options for exterior work while freeze-thaw cycles compound anything left unrepaired. Homeowners in {county} County who move from documentation to signed contract before mid-fall generally avoid both the post-storm rush and the winter penalty.</p>",
    "<p>Timing matters in {county} County. Damage discovered in May competes with every other storm claim in {region} for adjuster and contractor attention; the same repair scoped in September often schedules faster. What should not wait is documentation — photograph damage as soon as it is safe, file promptly, and let the bidding process run while the queue clears. Policies also carry claim-filing deadlines, so the paperwork clock starts at the storm, not at the repair.</p>",
    "<p>Most exterior repair work in {county} County happens in a window that runs roughly from late spring through late fall. Inside that window, post-storm weeks are the most congested and the most quote-inflated; the weeks after the rush are when competing bids do their best work. Whatever the calendar says, the sequence stays the same: document first, understand your policy second, compare written bids third — and let contractors compete for the job rather than racing to hand it to the first knock on the door.</p>",
    "<p>Storm claims in {region} cluster hard: one hail event can put thousands of {county} County area roofs, gutters, and siding elevations into the repair pipeline in a single afternoon. That clustering is exactly why a competitive bidding process protects homeowners — when demand spikes, single-quote pricing drifts, and the only reliable calibration is a second and third written bid for the identical scope.</p>",
]

TRADE_INTRO = {
    "roofing": [
        "A roof in {county} County works harder than most homeowners realize. It takes direct hail strikes in spring, wind uplift during summer storms, and months of freeze-thaw stress through the winter — and when it fails, the damage rarely stays confined to the shingles.",
        "Roof damage is the most common storm-related insurance claim in Indiana, and {county} County homeowners deal with the full menu: hail bruising, wind-lifted shingles, damaged flashing, and the slow leaks that follow. Knowing what a repair should cost — and getting more than one bid — is the difference between a fair claim outcome and an expensive one.",
        "In {county} County, roofing is where storm season and insurance season meet. Hail and wind events leave damage that is easy to underestimate from the ground, and the repair market that springs up after every major storm makes it genuinely hard to know who to call and what a fair price looks like.",
    ],
    "siding": [
        "Siding takes the brunt of wind-driven hail in {county} County — dents, cracks, and punctures on the exposed elevations of a home are among the most common findings after a spring storm rolls through {region}.",
        "In {county} County, siding damage is frequently discovered months after the storm that caused it. Hail impact marks, wind-creased panels, and cracked corner posts let moisture behind the wall system, and by the time staining or warping shows up inside, the repair scope has grown.",
        "Hail does not need to be large to damage siding. In {region}, storms drop enough marginal-size hail that {county} County homeowners often have legitimate siding claims they never noticed — and matching discontinued siding profiles is one of the most common complications in settling them fairly.",
    ],
    "gutters": [
        "Gutters are the first thing hail hits and the last thing homeowners inspect. In {county} County, dented gutters and downspouts are one of the most reliable indicators that a storm dropped damaging hail — adjusters look at them for exactly that reason.",
        "A gutter system in {county} County has two jobs: move heavy spring rain away from the foundation, and survive the ice load that {region} winters put on every eave. When hail flattens the profile or pulls fasteners loose, both jobs suffer, and the resulting water problems show up at the foundation and fascia long before the gutters themselves look obviously broken.",
        "In {county} County, gutter damage is often the visible tip of a larger storm claim. Hail that dents aluminum gutters has usually also hit the roof above them, which is why a proper storm inspection treats gutters, downspouts, and roof surfaces as one system.",
    ],
    "windows": [
        "Window damage in {county} County ranges from the obvious — cracked glass after a hailstorm — to the subtle: failed seals, fogged double panes, and hail-cratered cladding that lets water into the wall. All of it is claimable when a storm caused it, and all of it gets more expensive the longer it waits.",
        "Storm-damaged windows are one of the most under-claimed items in {region}. {county} County homeowners tend to notice broken glass immediately, but hail damage to frames, cladding, and glazing beads is easy to miss and just as legitimate a repair item.",
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
        "<li><strong>Partial-slope damage</strong> — storms often damage one or two elevations, raising repair-versus-replace questions that competing bids answer honestly.</li>",
        "<li><strong>Decking and underlayment issues</strong> — discovered only at tear-off, and a common source of change orders worth understanding in advance.</li>",
        "<li><strong>Ventilation and code items</strong> — older roofs in the county frequently need code-required upgrades that belong in the claim scope.</li>",
    ],
    "siding": [
        "<li><strong>Hail dents and punctures</strong> — most visible on aluminum and thin vinyl, and concentrated on the storm-facing elevations.</li>",
        "<li><strong>Wind-creased and detached panels</strong> — compromised locking legs that let subsequent weather work panels loose.</li>",
        "<li><strong>Discontinued-profile matching</strong> — a central issue in siding claims when only some elevations are damaged.</li>",
        "<li><strong>Moisture intrusion behind damaged panels</strong> — the hidden cost of postponing repairs through a {region} winter.</li>",
        "<li><strong>Oxidation lines and chalking</strong> — complicate spot repairs on older siding and affect how a fair scope is written.</li>",
        "<li><strong>Cracked corner posts and trim</strong> — small components that drive disproportionate water damage when ignored.</li>",
        "<li><strong>Fastener pull-through in high wind</strong> — panels that look intact but are no longer attached the way the manufacturer intended.</li>",
        "<li><strong>Wrap and sheathing damage</strong> — assessable only during repair, and a legitimate supplement item when found.</li>",
    ],
    "gutters": [
        "<li><strong>Hail-flattened profiles</strong> — dents that reduce water-carrying capacity and mark the whole roof system as storm-hit.</li>",
        "<li><strong>Pulled fasteners and sagging runs</strong> — ice and debris load that separates gutters from fascia over a {region} winter.</li>",
        "<li><strong>Downspout crushing and disconnects</strong> — drainage failures that surface as foundation and grading problems.</li>",
        "<li><strong>Fascia and soffit rot</strong> — the downstream cost of gutter systems that stopped doing their job quietly.</li>",
        "<li><strong>Seam and end-cap leaks</strong> — often storm-initiated, always worse after a freeze cycle.</li>",
        "<li><strong>Improper pitch after impact</strong> — gutters that survived the storm but no longer drain toward the downspouts.</li>",
        "<li><strong>Gutter guards damaged or displaced</strong> — a commonly missed line item in storm scopes.</li>",
        "<li><strong>Overflow staining and landscape erosion</strong> — evidence adjusters and contractors both read when reconstructing what the storm did.</li>",
    ],
    "windows": [
        "<li><strong>Cracked and shattered glazing</strong> — the obvious claim item, priced very differently across window lines and installers.</li>",
        "<li><strong>Hail-damaged frames and cladding</strong> — dents and fractures that compromise weather sealing even when glass survives.</li>",
        "<li><strong>Failed insulated-glass seals</strong> — post-storm fogging between panes that is claimable when the event caused it.</li>",
        "<li><strong>Water intrusion at damaged openings</strong> — interior finish damage that belongs in the same claim as the window.</li>",
        "<li><strong>Screen and hardware damage</strong> — small items that are legitimately part of a storm scope and frequently left off first drafts.</li>",
        "<li><strong>Wind-racked frames</strong> — openings knocked out of square that bind sashes and break seals over the following seasons.</li>",
        "<li><strong>Matching and availability questions</strong> — discontinued window lines raise the same repair-versus-replace questions siding claims see.</li>",
        "<li><strong>Energy-efficiency step-ups</strong> — homeowners choosing between like-for-like replacement and upgraded units need competing bids to price the difference.</li>",
    ],
}

ISSUE_ITEMS_PER_PAGE = 5

# Local-expectations copy is assembled from two independently selected
# paragraph slots (A x B = 9 combinations) rather than fixed pairs.
EXPECTATIONS_A = [
    "<p>Storm repair in {county} County follows a rhythm locals know well: a severe-weather event, a wave of door-knocking crews from out of the area, and then the slower, quieter work of getting damage documented, a claim filed, and a repair done right. The homeowners who come out ahead are consistently the ones who slow the process down at the start — documenting damage before tarps and repairs change the evidence, reading their policy before the first phone call, and getting more than one written bid before signing anything.</p>",
    "<p>Homeowners in {county} County navigating a storm claim juggle three parallel tracks: the insurance process (adjuster inspection, scope, settlement), the contractor process (bids, scheduling, materials), and their own documentation. Keeping those tracks separate is the single most useful habit — your insurer determines what is covered; your contractor determines what the repair actually requires; and written bids are how you reconcile the two when they disagree.</p>",
    "<p>The practical sequence for {county} County homeowners after storm damage: document everything with photos before any cleanup, review your policy's wind/hail provisions and deductible, file promptly if damage is evident, and line up written repair bids so you can evaluate the adjuster's scope against real local pricing. Nothing in that sequence requires committing to a contractor early — and keeping your options open until bids are in hand is exactly what a competitive process is for.</p>",
]

EXPECTATIONS_B = [
    "<p>Local demand also moves in waves. After a widely publicized hail event, every reputable contractor serving {county} County gets busy at once. Competing bids protect you twice in that environment: they keep pricing honest when demand spikes, and they surface scope differences — what one bidder saw that another missed — before the work starts rather than after.</p>",
    "<p>Be appropriately skeptical of anyone who shows up unsolicited after a storm, pressures you to sign an assignment of benefits on the spot, or quotes a price without getting on the roof or examining the damage up close. Indiana sees storm-chasing crews every season, and the reliable defense is unhurried, written, competing bids from contractors who actually serve {county} County year-round.</p>",
    "<p>Expect legitimate contractors to provide itemized written estimates, proof of insurance, and local references on request. Expect the process to take longer after county-wide storm events, when every roofer, sider, and installer in {region} is working the same backlog. Patience plus paperwork beats speed plus pressure, every time.</p>",
]

HOW_IT_WORKS = [
    "<p>Otter Quotes connects you with contractors who serve {county} County. You describe your project once, and contractors on the platform submit competing bids you can compare side by side — scope, price, and terms in one place. The platform is informational and free for homeowners: it organizes the bidding process, and the decision stays entirely yours.</p>",
    "<p>Otter Quotes connects you with contractors who serve {county} County. Instead of calling down a list and repeating your story, you post the project once and receive competing bids from contractors working in your area. Comparing multiple written bids is the most reliable way to understand fair local pricing — especially in the busy weeks after a storm.</p>",
    "<p>Otter Quotes connects you with contractors who serve {county} County. The platform's job is simple: gather your project details once, put them in front of contractors who work in your area, and give you their written bids in one place to compare on scope, price, and terms. No obligation attaches to posting a project, and choosing a contractor — or choosing none of them — remains entirely your call.</p>",
]

# Four Q&As per trade; each page renders a deterministic selection of two,
# so same-trade pages don't all share an identical FAQ block.
FAQ = {
    "roofing": [
        ("Does homeowners insurance cover roof damage in {county} County?",
         "Most standard homeowners policies cover sudden storm damage from wind and hail, subject to your deductible and policy terms. Coverage questions are ultimately between you and your insurer — our guide on filing a property damage claim walks through the process step by step."),
        ("How many roofing bids should I get?",
         "At least two, ideally three. Competing bids surface scope differences and keep pricing honest, particularly during post-storm demand spikes when quotes can drift upward."),
        ("Should I repair or replace after partial-slope damage?",
         "It depends on shingle availability, the age of the roof, and how your policy treats matching. Written bids that price both paths give you and your adjuster something concrete to discuss."),
        ("Do I need to be home for a roof inspection?",
         "For the exterior portion, usually not — but being present means you see the documented damage yourself and can ask questions while the contractor is still on site."),
    ],
    "siding": [
        ("Will insurance pay to match my existing siding?",
         "Matching rules vary by policy and state guidance, and discontinued profiles complicate it further. Document the damage thoroughly and get written bids that address matching explicitly, so the scope conversation with your insurer is grounded in specifics."),
        ("Can hail damage siding without visible holes?",
         "Yes — dents, cracks, and chalk-line disturbances all count as damage even when panels remain attached. An up-close inspection of storm-facing elevations tells the real story."),
        ("Do all elevations get replaced if one is damaged?",
         "Not automatically. Outcomes range from single-elevation repair to full replacement depending on matching, policy language, and negotiation — which is why bids that spell out both scopes are valuable."),
        ("How soon after a storm should siding be inspected?",
         "Promptly — both because policies carry filing deadlines and because open impact points let moisture behind the wall system, where damage compounds quietly."),
    ],
    "gutters": [
        ("Are dented gutters worth claiming?",
         "Dented gutters are frequently part of a larger storm claim — hail that damaged gutters has usually hit the roof too. They matter both as a repair item and as evidence of the storm's severity."),
        ("Should gutters be replaced with a roof?",
         "Often yes, when both were storm-damaged or when roof work requires removing aged gutter runs. Written bids that price the combination let you compare against separate repairs."),
        ("Do gutter guards complicate a storm claim?",
         "They add a line item and occasionally a matching question, but damaged guards are legitimately part of the scope. Make sure bids and the adjuster's scope both address them."),
        ("What size hail dents aluminum gutters?",
         "Smaller than most people expect — gutters often show impact evidence from hail that left shingles looking intact from the ground, which is why they're a standard inspection point."),
    ],
    "windows": [
        ("Is a fogged window claimable after a storm?",
         "If the storm caused the seal failure — from impact or wind-racking — it can be a legitimate claim item. Timing and documentation matter, so photograph damage promptly."),
        ("Should I replace like-for-like or upgrade?",
         "Insurance typically pays for like-kind replacement; upgrades are out-of-pocket deltas. Competing bids that price both options make the decision concrete instead of hypothetical."),
        ("Does a cracked pane mean the whole window needs replacing?",
         "Sometimes only the sash or glass unit needs replacement; sometimes frame damage makes a full unit the sound choice. Bids that separate the options keep the decision in your hands."),
        ("Are damaged screens and hardware claimable?",
         "Generally yes when the storm caused the damage — they're small items, but legitimate scope, and worth listing in your documentation from the start."),
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


def coverage_stats_html(county: str, trade: str, coverage: dict) -> str:
    """Live per-county stats — real platform coverage numbers, not filler."""
    count = len(coverage.get((county, trade), []))
    other_rows = []
    for t in ELIGIBLE_TRADES:
        if t == trade:
            continue
        n = len(coverage.get((county, t), []))
        if n >= MIN_CONTRACTORS:
            other_rows.append(
                f'<li><a href="/locations/{county_slug(county)}/{t}/">{TRADE_LABELS[t]} contractors serving {html.escape(county)} County</a> — {n} on the platform</li>'
            )
    others = ""
    if other_rows:
        others = (
            "<p>Coverage in the county extends beyond this trade:</p><ul>"
            + "".join(other_rows)
            + "</ul>"
        )
    return (
        f"<p>As of the most recent platform update, <strong>{count} approved {TRADE_LABELS[trade].lower()} "
        f"contractor{'s' if count != 1 else ''}</strong> on Otter Quotes list {html.escape(county)} County, "
        f"{STATE_NAME} in their service area. That coverage is what makes competing bids possible here: post one "
        f"project, compare multiple written responses.</p>" + others
    )


def profile_links_html(county: str, trade: str, coverage: dict) -> str:
    """Links to public /contractors/[slug]/ profiles (directory opt-in only, D-249)."""
    entries = []
    for c in coverage.get((county, trade), []):
        if not c.get("public_directory_optin"):
            continue
        name = c.get("company_name") or ""
        if not name:
            continue
        entries.append((slugify(name), name))
    if not entries:
        return ""
    items = "".join(
        f'<li><a href="/contractors/{s}/">{html.escape(n, quote=True)}</a></li>'
        for s, n in sorted(set(entries))[:6]
    )
    return (
        "<h2>Contractor profiles serving the county</h2>"
        f"<ul>{items}</ul>"
    )


def build_page(county: str, trade: str, coverage: dict, generated_on: str) -> str:
    region = COUNTY_REGION[county]
    region_lbl = REGION_LABEL[region]
    seed = page_seed(county, trade)
    c_slug = county_slug(county)
    t_label = TRADE_LABELS[trade]
    county_esc = html.escape(county, quote=True)
    page_url = f"{SITE_BASE}/locations/{c_slug}/{trade}/"

    intro = variant(seed, 1, TRADE_INTRO[trade]).format(county=county_esc, region=region_lbl)
    climate = variant(seed, 2, REGION_CLIMATE[region]).format(county=county_esc)
    issue_items = shuffle_items(seed, 3, TRADE_ISSUE_ITEMS[trade])[:ISSUE_ITEMS_PER_PAGE]
    issues = ("<ul>" + "".join(issue_items) + "</ul>").format(region=region_lbl)
    expectations = (
        variant(seed, 4, EXPECTATIONS_A) + variant(seed, 7, EXPECTATIONS_B)
    ).format(county=county_esc, region=region_lbl)
    seasonal = variant(seed, 6, SEASONAL).format(county=county_esc, region=region_lbl)
    how_it_works = variant(seed, 5, HOW_IT_WORKS).format(county=county_esc)
    stats = coverage_stats_html(county, trade, coverage)
    profiles = profile_links_html(county, trade, coverage)

    faq_selected = shuffle_items(seed, 8, FAQ[trade])[:FAQ_PER_PAGE]
    faq_pairs = [(q.format(county=county_esc), a) for q, a in faq_selected]
    faq_html = "".join(
        f"<h3>{q}</h3><p>{a}</p>" for q, a in faq_pairs
    )

    guide_links = "".join(
        f'<li><a href="{href}">{label}</a></li>'
        for href, label in CORNERSTONE_GUIDES + TRADE_EXTRA_LINKS.get(trade, [])
    )

    title = f"{t_label} Contractors Serving {county} County, {STATE_CODE} · Otter Quotes"
    meta_desc = (
        f"Compare competing {t_label.lower()} bids from contractors who serve {county} County, {STATE_NAME}. "
        f"Otter Quotes is a free, informational platform for homeowners — post your project once, review written bids side by side."
    )

    local_business = {
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        "@id": f"{SITE_BASE}/#organization",
        "name": "Otter Quotes",
        "url": f"{SITE_BASE}/",
        "description": "Otter Quotes is an independent platform that connects homeowners with contractors for property damage repair and exterior improvement projects.",
        "areaServed": {"@type": "State", "name": STATE_NAME},
    }
    service = {
        "@context": "https://schema.org",
        "@type": "Service",
        "serviceType": f"{t_label} contractor bidding",
        "name": f"{t_label} Contractor Bids — {county} County, {STATE_CODE}",
        "url": page_url,
        "provider": {"@id": f"{SITE_BASE}/#organization"},
        "areaServed": {
            "@type": "AdministrativeArea",
            "name": f"{county} County, {STATE_NAME}",
        },
    }
    breadcrumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE_BASE}/"},
            {"@type": "ListItem", "position": 2, "name": "Locations", "item": f"{SITE_BASE}/locations/"},
            {"@type": "ListItem", "position": 3, "name": f"{county} County, {STATE_CODE}", "item": f"{SITE_BASE}/locations/{c_slug}/"},
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
  var navHtml = '<nav class="site-nav"><div class="nav-inner"><a class="nav-logo" href="/"><img src="/img/brand-assets/otter-logo-inline.svg" alt="Otter Quotes" height="32"></a><div class="nav-links"><a href="/how-it-works.html">How It Works</a><a href="/contractor-join.html">For Contractors</a><a href="/get-started.html" class="btn btn-primary btn-sm">Get Started</a></div></div></nav>';
  document.write(navHtml);
}})();
</script>

<main>
  <div class="loc-hero">
    <div class="breadcrumb">
      <a href="/">Home</a> &rsaquo; <a href="/locations/">Locations</a> &rsaquo; {county_esc} County, {STATE_CODE} &rsaquo; {t_label}
    </div>
    <div style="padding: var(--sp-8) var(--sp-6) 0;">
      <h1>{t_label} Contractors Serving {county_esc} County, {STATE_NAME}</h1>
      <p style="color:var(--slate); max-width:640px; margin:0 auto;">Compare competing written bids from {t_label.lower()} contractors working in {county_esc} County — informational, free for homeowners, and built around your insurance claim.</p>
    </div>
  </div>

  <div class="loc-body">

    <p>{intro}</p>

    <h2>The {region_lbl} climate and your {t_label.lower()}</h2>
    <p>{climate}</p>

    <h2>Common {t_label.lower()} issues in {county_esc} County</h2>
    {issues}

    <h2>What to expect locally</h2>
    {expectations}

    <h2>Season and timing</h2>
    {seasonal}

    <h2>Platform coverage in {county_esc} County</h2>
    {stats}

    {profiles}

    <h2>How Otter Quotes works here</h2>
    {how_it_works}

    <h2>Frequently asked questions</h2>
    {faq_html}

    <h2>Homeowner guides</h2>
    <ul>
{guide_links}
    </ul>

    <div class="cta-bar">
      <p>Ready to compare bids from contractors serving {county_esc} County?</p>
      <a href="/get-started.html" class="btn btn-primary btn-lg">Start Your Project with Otter Quotes</a>
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
  <p><a href="/terms.html" style="color:var(--amber)">Terms</a> &bull; <a href="/privacy.html" style="color:var(--amber)">Privacy</a></p>
</footer>

</body>
</html>
"""
    return page


# ---------------------------------------------------------------------------
# Auto-noindex for stale pages (count dropped below MIN_CONTRACTORS)
# ---------------------------------------------------------------------------

NOINDEX_TAG = '<meta name="robots" content="noindex">'


def existing_page_paths() -> list:
    if not LOCATIONS_DIR.exists():
        return []
    return sorted(LOCATIONS_DIR.glob("*/*/index.html"))


def inject_noindex(path: pathlib.Path, dry_run: bool) -> bool:
    """Keep the page but mark it noindex. Returns True if file changed."""
    text = path.read_text(encoding="utf-8")
    if re.search(r'<meta\s+name="robots"\s+content="[^"]*noindex[^"]*"\s*/?>', text, flags=re.IGNORECASE):
        return False
    new_text = text.replace(
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' + NOINDEX_TAG,
        1,
    )
    if new_text == text:
        # Fallback: inject right after <head>
        new_text = text.replace("<head>", "<head>\n" + NOINDEX_TAG, 1)
    if new_text == text:
        print(f"  WARNING: could not inject noindex into {path}")
        return False
    if dry_run:
        print(f"  [DRY RUN] Would inject noindex: {path}")
    else:
        path.write_text(new_text, encoding="utf-8")
        print(f"  Noindexed (coverage below {MIN_CONTRACTORS}): {path}")
    return True


# ---------------------------------------------------------------------------
# Sitemap (mirrors generate_contractor_pages.update_sitemap; targets
# the repo-root sitemap.xml, lastmod = generation timestamp)
# ---------------------------------------------------------------------------

def update_sitemap(eligible_paths: list, generated_on: str, dry_run: bool) -> None:
    sitemap_text = SITEMAP_PATH.read_text(encoding="utf-8")
    original = sitemap_text

    # Remove existing locations/ entries (so we regenerate cleanly; also
    # drops URLs that just went noindex — noindexed pages stay on disk but
    # leave the sitemap).
    sitemap_text = re.sub(
        r"\s*<url>\s*<loc>https://otterquote\.com/locations/[^<]*</loc>.*?</url>",
        "",
        sitemap_text,
        flags=re.DOTALL,
    )

    if eligible_paths:
        new_entries = "\n".join(
            f"""  <url>
    <loc>{SITE_BASE}/locations/{cs}/{ts}/</loc>
    <lastmod>{generated_on}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>"""
            for cs, ts in sorted(eligible_paths)
        )
        sitemap_text = sitemap_text.replace("</urlset>", f"\n{new_entries}\n</urlset>")

    if sitemap_text == original:
        print("Sitemap unchanged — no location entries to add or remove.")
        return

    if dry_run:
        print(f"[DRY RUN] Would update {SITEMAP_PATH} with {len(eligible_paths)} location URLs")
    else:
        SITEMAP_PATH.write_text(sitemap_text, encoding="utf-8")
        print(f"Updated {SITEMAP_PATH} — {len(eligible_paths)} location URLs")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Generate /locations/[county]/[trade]/ SEO pages")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without writing files")
    args = parser.parse_args()

    generated_on = datetime.date.today().isoformat()

    print("Loading Supabase service key...")
    service_key = load_service_key()

    print("Fetching approved contractors...")
    contractors = fetch_approved_contractors(service_key)
    print(f"Found {len(contractors)} approved contractors")

    coverage = compute_tuples(contractors)
    all_tuples = sorted(coverage.keys())
    eligible = [t for t in all_tuples if len(coverage[t]) >= MIN_CONTRACTORS]
    below_min = [t for t in all_tuples if len(coverage[t]) < MIN_CONTRACTORS]

    print(f"Coverage tuples (any count): {len(all_tuples)}")
    print(f"Eligible tuples (count >= {MIN_CONTRACTORS}, HARD guardrail): {len(eligible)}")
    if below_min:
        print(f"Below-minimum tuples suppressed by guardrail: {len(below_min)}")

    eligible_set = set()
    eligible_paths = []
    pages_written = 0

    for county, trade in eligible:
        c_slug = county_slug(county)
        page_html = build_page(county, trade, coverage, generated_on)

        page_id = f"{c_slug}/{trade}"
        wc = word_count(page_html)
        if wc < MIN_WORDS:
            raise RuntimeError(f"CONTENT GUARDRAIL FAIL [{page_id}]: {wc} words < {MIN_WORDS} minimum")
        compliance_lint(page_html, page_id)
        if not page_html.rstrip().endswith("</html>"):
            raise RuntimeError(f"INTEGRITY FAIL [{page_id}]: generated HTML does not end with </html>")

        out_dir = LOCATIONS_DIR / c_slug / trade
        out_path = out_dir / "index.html"
        if args.dry_run:
            print(f"  [DRY RUN] Would write {out_path} ({wc} words, {len(coverage[(county, trade)])} contractors)")
        else:
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path.write_text(page_html, encoding="utf-8", newline="\n")
            print(f"  Written: {out_path} ({wc} words, {len(coverage[(county, trade)])} contractors)")
        pages_written += 1
        eligible_set.add((c_slug, trade))
        eligible_paths.append((c_slug, trade))

    # Auto-noindex previously generated pages whose tuple fell below minimum.
    noindexed = 0
    for path in existing_page_paths():
        c_slug = path.parent.parent.name
        t_slug = path.parent.name
        if (c_slug, t_slug) not in eligible_set:
            if inject_noindex(path, args.dry_run):
                noindexed += 1

    # Sitemap: eligible pages in, stale/noindexed pages out.
    update_sitemap(eligible_paths, generated_on, args.dry_run)

    print()
    print(f"Done{' (dry run)' if args.dry_run else ''}.")
    print(f"  Eligible tuples:  {len(eligible)}")
    print(f"  Pages generated:  {pages_written}")
    print(f"  Pages noindexed:  {noindexed}")
    print(f"  Guardrail:        count >= {MIN_CONTRACTORS} approved contractors per (county, trade) — hard, non-negotiable")


if __name__ == "__main__":
    main()
