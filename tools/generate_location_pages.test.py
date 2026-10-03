#!/usr/bin/env python3
"""
Self-test for tools/generate_location_pages.py (D-345, gh-2422).

closes-on mapping (issue #2422):
  (a) test_zero_contractor_county_emits_indexable_compliant_page
        allow-listed test state, county with zero contractors -> indexable page,
        >= 500 STRICT-unique words (words outside any 3-word run shared with another
        page in the run; CEO ruling on #2304), contains "send it to local
        contractors", lint-clean.
  (b) test_thin_county_emits_no_page, test_identical_county_content_fails_both,
      test_indiana_profile_emits_nothing_under_strict_gate
        a county under 500 strict-unique words emits no page and no sitemap entry.
  (c) test_state_not_on_allowlist_emits_no_page
  (d) test_committed_allowlist_states_have_committed_profiles  (+ test_empty_allowlist_emits_nothing,
        which uses an injected empty allow-list)
  (e) test_lint_rejects_*  (our contractors / vetted / connects you with
        contractors who serve / vendor name / missing required phrase)

The closes-on tests use a FIXTURE state ("ZZ", county file and profile written
to a temp dir), so they do not depend on Indiana's copy. Indiana's real profile
is exercised separately (test_indiana_*).

All output goes to a temp dir; nothing is written into the repo.
Run: python3 tools/generate_location_pages.test.py
"""

import contextlib
import importlib.util
import io
import json
import pathlib
import re
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("glp", HERE / "generate_location_pages.py")
glp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(glp)

REPO_ROOT = HERE.parent
# Fixture state: county data + a minimal CRO-style profile, written to temp dirs.
FIXTURE_CLIMATE = (
    "{county} County sits in the fixture state's %s band. Winters bring freeze-thaw cycling that works on small "
    "gaps in roofing, siding, gutters, and windows, while spring storms bring hail and damaging wind across the "
    "region. Homeowners here deal with the same seasonal pattern each year: damage arrives in spring and early "
    "summer, repairs cluster in the warm months, and anything left unrepaired is tested again by the next winter. "
    "Paying attention to the calendar, documenting damage early, and comparing written bids gives homeowners in "
    "{county} County the most control over how a storm claim turns out."
)


import random as _random


def _make_vocab(size, seed):
    """Pseudo-words built from consonant-vowel syllables (no digits). Tokens are SHARED across
    pages, as ordinary vocabulary is; none contains a fixture county, state or trade word."""
    rnd = _random.Random(seed)
    bad = ("alpha", "beta", "gamma", "zedland", "roof", "siding", "gutter", "window", "shingle", "downspout")
    out, seen = [], set()
    while len(out) < size:
        w = "".join(rnd.choice("bdfgklmnprstvz") + rnd.choice("aeiou") for _ in range(rnd.choice((3, 4))))
        if w not in seen and not any(x in w for x in bad):
            seen.add(w)
            out.append(w)
    return out


VOCAB = _make_vocab(800, 7)


def fixture_content(county, trade, n=700):
    """n words of distinct per-(county, trade) text drawn at random from a shared vocabulary: every
    8-word run is unique to its page, but individual words recur across pages, as in real prose.
    PLAIN TEXT, blank-line paragraphs."""
    rnd = _random.Random(f"{county}|{trade}")
    words = [rnd.choice(VOCAB) for _ in range(n)]
    return "\n\n".join(" ".join(words[i:i + 50]) for i in range(0, n, 50))


FIXTURE_COUNTIES = {"states": [{"code": "ZZ", "name": "Zedland", "counties": ["Alpha", "Beta", "Gamma"]}]}
FIXTURE_PROFILE = {
    "code": "ZZ",
    "name": "Zedland",
    "regions": {
        "north": {"label": "northern Zedland", "counties": ["Alpha", "Beta"], "climate": [FIXTURE_CLIMATE % "northern"]},
        "south": {"label": "southern Zedland", "counties": ["Gamma"], "climate": [FIXTURE_CLIMATE % "southern"]},
    },
    "county_content": {
        c: {t: fixture_content(c, t) for t in ("roofing", "siding", "gutters", "windows")}
        for c in ("Alpha", "Beta", "Gamma")
    },
}

SITEMAP_SEED = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    "  <url>\n    <loc>https://otterquote.com/</loc>\n  </url>\n"
    "</urlset>\n"
)


def quiet(fn, *a, **kw):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **kw)


class GeneratorTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = pathlib.Path(self._tmp.name)
        self.out = self.tmp / "locations"
        self.sitemap = self.tmp / "sitemap.xml"
        self.sitemap.write_text(SITEMAP_SEED, encoding="utf-8")
        self.fx_counties = self.tmp / "us-counties.json"
        self.fx_counties.write_text(json.dumps(FIXTURE_COUNTIES), encoding="utf-8")
        self.fx_profiles = self.tmp / "profiles"
        self.fx_profiles.mkdir()
        (self.fx_profiles / "ZZ.json").write_text(json.dumps(FIXTURE_PROFILE), encoding="utf-8")

    def tearDown(self):
        self._tmp.cleanup()

    def run_gen(self, states, **kw):
        return quiet(glp.generate, states, out_dir=self.out, sitemap_path=self.sitemap, **kw)

    def run_fx(self, states=("ZZ",), **kw):
        return self.run_gen(list(states), counties_path=self.fx_counties, profiles_dir=self.fx_profiles, **kw)

    def write_profile(self, mutate, name="ZZ"):
        prof = json.loads(json.dumps(FIXTURE_PROFILE))
        mutate(prof)
        (self.fx_profiles / f"{name}.json").write_text(json.dumps(prof), encoding="utf-8")

    # (a) positive -----------------------------------------------------------
    def test_zero_contractor_county_emits_indexable_compliant_page(self):
        # No contractor data exists anywhere in this flow: every county is a
        # "zero contractors" county. Fixture state, fixture profile.
        summary = self.run_fx()
        self.assertEqual(summary["written"], 3 * 4)
        self.assertEqual(summary["skipped_thin"], [])
        for county, trade in (("Alpha", "roofing"), ("Gamma", "windows")):
            slug = glp.county_slug(county, "ZZ")
            page = (self.out / slug / trade / "index.html").read_text(encoding="utf-8")
            self.assertNotRegex(page, r'(?i)<meta[^>]+name="robots"')
            self.assertNotIn("noindex", page.lower())
            self.assertIn("send it to local contractors", page)
            self.assertIn("Alpha County notes" if county == "Alpha" else "Gamma County notes", page)
            notes = page.split("County notes</h2>")[1].split("<h2>")[0]
            self.assertRegex(notes, r"^\s*<p>")
            self.assertNotRegex(notes.replace("<p>", "").replace("</p>", ""), r"[<>]")   # bare <p> only
            glp.compliance_lint(page, f"{slug}/{trade}")  # must not raise
            self.assertIn('<link rel="canonical"', page)
            self.assertEqual(page.count('application/ld+json'), 3)  # JSON-LD kept
        self.assertGreaterEqual(summary["min_strict_unique_words"], glp.MIN_WORDS)
        sm = self.sitemap.read_text(encoding="utf-8")
        self.assertEqual(sm.count("/locations/"), 3 * 4)
        self.assertIn("https://otterquote.com/locations/alpha-county-zz/roofing/", sm)

    def test_indiana_profile_emits_nothing_under_strict_gate(self):
        # Indiana's committed profile has no county_content, so every page is
        # template text shared with other pages: all fail the strict gate.
        summary = self.run_gen(["IN"])
        self.assertEqual(summary["written"], 0)
        self.assertEqual(len(summary["skipped_thin"]), 92 * 4)
        self.assertLess(summary["min_strict_unique_words"], glp.MIN_WORDS)
        self.assertLess(summary["median_strict_unique_words"], glp.MIN_WORDS)
        self.assertFalse(self.out.exists())
        self.assertEqual(self.sitemap.read_text(encoding="utf-8"), SITEMAP_SEED)

    def test_every_indiana_template_page_passes_the_lint(self):
        # The gate skips Indiana pages before linting, so lint the template
        # output directly: this guards the shared copy against every ban.
        prof = glp.load_profile("IN")
        for c in glp.load_counties("IN"):
            for t in glp.ELIGIBLE_TRADES:
                glp.compliance_lint(glp.build_page(c, t, "2026-01-01", "IN", profile=prof), f"{c}/{t}")

    def test_strict_unique_counts_only_unshared_words(self):
        a = ["a%d" % i for i in range(30)] + ["shared%d" % i for i in range(20)]
        b = ["b%d" % i for i in range(40)] + ["shared%d" % i for i in range(20)]
        ca, cb = glp.strict_unique_counts([a, b])
        # the 20 shared words (all inside shared 8-word shingles) do not count;
        # the 7 words before them ride in shingles that mix unique and shared
        # words, so they stay unique.
        self.assertEqual((ca, cb), (30, 40))
        self.assertEqual(glp.strict_unique_counts([a]), [50])           # compared with nothing
        self.assertEqual(glp.strict_unique_counts([a, a]), [0, 0])      # identical pages
        self.assertEqual(glp.strict_unique_counts([["x", "y"], ["x", "y"]]), [2, 2])  # < 3 words: no shingles

    # (b) negative: under the unique-word floor ------------------------------
    def test_thin_county_emits_no_page(self):
        profile = glp.load_profile("ZZ", self.fx_profiles)

        def thin_for_ohio(county, trade, generated_on, state):
            real = glp.build_page(county, trade, generated_on, state, profile=profile)
            if county != "Alpha":
                return real
            return (
                "<!DOCTYPE html><html><head><title>t</title></head><body><main>"
                "<p>We create a scope of work and send it to local contractors.</p>"
                "</main></body></html>"
            )

        summary = self.run_fx(build_fn=thin_for_ohio)
        self.assertEqual(sorted(summary["skipped_thin"]),
                         sorted(f"alpha-county-zz/{t}" for t in glp.ELIGIBLE_TRADES))
        self.assertFalse((self.out / "alpha-county-zz").exists())
        self.assertNotIn("alpha-county-zz", self.sitemap.read_text(encoding="utf-8"))
        self.assertTrue((self.out / "beta-county-zz" / "roofing" / "index.html").exists())

    def test_identical_county_content_fails_both(self):
        def same(prof):
            prof["county_content"]["Beta"] = json.loads(json.dumps(prof["county_content"]["Alpha"]))
        self.write_profile(same)
        summary = self.run_fx()
        failed = sorted(summary["skipped_thin"])
        self.assertEqual(failed, sorted(f"{c}-county-zz/{t}" for c in ("alpha", "beta") for t in glp.ELIGIBLE_TRADES))
        self.assertEqual(summary["written"], 4)  # Gamma still passes
        self.assertTrue((self.out / "gamma-county-zz" / "roofing" / "index.html").exists())
        self.assertFalse((self.out / "alpha-county-zz").exists())
        self.assertFalse((self.out / "beta-county-zz").exists())

    def test_same_text_on_every_trade_of_a_county_is_shared_and_fails(self):
        def one_string(prof):
            prof["county_content"]["Gamma"] = fixture_content("gamma", "all")  # str: used for every trade
        self.write_profile(one_string)
        summary = self.run_fx()
        self.assertEqual(sorted(summary["skipped_thin"]),
                         sorted(f"gamma-county-zz/{t}" for t in glp.ELIGIBLE_TRADES))
        self.assertEqual(summary["written"], 8)

    def test_boilerplate_and_template_text_never_count(self):
        # Large text shared by every page (nav-like or boilerplate) counts for none of them.
        pad = " ".join("pad%d" % i for i in range(2000))
        page = lambda tail: ("<html><body><main><p>%s</p><p>%s send it to local contractors</p></main></body></html>"
                             % (pad, tail))
        counts = glp.strict_unique_counts([glp.main_words(page("one")), glp.main_words(page("two"))])
        self.assertLess(max(counts), 10)

    # (c) negative: state not on the allow-list ------------------------------
    def test_state_not_on_allowlist_emits_no_page(self):
        summary = self.run_fx(states=[])  # ZZ has data + profile but is not listed
        self.assertEqual(summary["written"], 0)
        self.assertFalse(self.out.exists())
        self.assertEqual(self.sitemap.read_text(encoding="utf-8"), SITEMAP_SEED)

    def test_allowlist_file_driving_generation(self):
        f = self.tmp / "allow.json"
        f.write_text(json.dumps({"states": ["IN"]}), encoding="utf-8")
        self.assertEqual(glp.load_allowlist(f), ["IN"])
        f.write_text(json.dumps({"states": []}), encoding="utf-8")
        self.assertEqual(glp.load_allowlist(f), [])

    # sitemap safety: a non-repo out_dir never touches the repo sitemap -------
    def test_non_repo_out_dir_leaves_repo_sitemap_byte_identical(self):
        repo_sitemap = REPO_ROOT / "sitemap.xml"
        before = repo_sitemap.read_bytes()
        out = self.tmp / "elsewhere" / "locations"
        quiet(glp.generate, [], out_dir=out)
        quiet(glp.generate, ["ZZ"], out_dir=out, counties_path=self.fx_counties, profiles_dir=self.fx_profiles)
        self.assertEqual(repo_sitemap.read_bytes(), before)
        own = self.tmp / "elsewhere" / "sitemap.xml"
        self.assertTrue(own.exists())
        self.assertEqual(own.read_text(encoding="utf-8").count("/locations/"), 3 * 4)
        self.assertEqual(glp.resolve_sitemap_path(out), own)
        self.assertEqual(glp.resolve_sitemap_path(glp.LOCATIONS_DIR), glp.SITEMAP_PATH)

    def test_generated_page_labels_and_jsonld_shape(self):
        prof = glp.load_profile("IN")
        page = glp.build_page("Ohio", "windows", "2026-01-01", "IN", profile=prof)
        self.assertIn("Comparing Window Bids in Ohio County, Indiana", page)
        self.assertNotIn("Windows Bids", page)
        blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', page, flags=re.DOTALL)
        docs = [json.loads(b) for b in blocks]
        org = [d for d in docs if d["@type"] == "Organization"][0]
        self.assertNotIn("areaServed", org)
        self.assertEqual(org["@id"], "https://otterquote.com/#organization")
        self.assertFalse([d for d in docs if d["@type"] == "LocalBusiness"])
        svc = [d for d in docs if d["@type"] == "Service"][0]
        self.assertIn("areaServed", svc)
        for d in docs:
            self.assertNotIn("their written bids", json.dumps(d))

    def test_no_outcome_promise_in_generated_copy(self):
        prof = glp.load_profile("IN")
        for trade in glp.ELIGIBLE_TRADES:
            page = glp.build_page("Ohio", trade, "2026-01-01", "IN", profile=prof)
            for bad in ("their written bids", "bids that come back", "compare the written bids",
                        "most common storm-related insurance claim"):
                self.assertNotIn(bad, page)

    def test_cross_page_uniqueness_metric(self):
        a = ["w%d" % i for i in range(30)]
        b = a[:15] + ["x%d" % i for i in range(15)]
        sa, sb = glp.shingles(a), glp.shingles(b)
        shares = glp.cross_page_uniqueness([sa, sb])
        self.assertTrue(0 < shares[0] < 1 and 0 < shares[1] < 1)
        self.assertEqual(glp.cross_page_uniqueness([sa]), [1.0])
        summary = self.run_fx()
        self.assertIsNotNone(summary["min_unshared_shingles"])
        self.assertLessEqual(summary["min_unshared_shingles"], summary["median_unshared_shingles"])

    def test_generated_pages_link_only_to_existing_locations_urls(self):
        # R1 (review of #2482): every internal /locations/ href and every JSON-LD URL under
        # /locations/ must be the page's own canonical or another generated page.
        self.run_fx()
        pages = sorted(self.out.glob("*/*/index.html"))
        self.assertGreater(len(pages), 0)
        urls = {f"{glp.SITE_BASE}/locations/{p.parent.parent.name}/{p.parent.name}/" for p in pages}
        def walk(o):
            if isinstance(o, dict):
                for v in o.values():
                    yield from walk(v)
            elif isinstance(o, list):
                for v in o:
                    yield from walk(v)
            elif isinstance(o, str):
                yield o
        for p in pages:
            own = f"{glp.SITE_BASE}/locations/{p.parent.parent.name}/{p.parent.name}/"
            html_text = p.read_text(encoding="utf-8")
            found = []
            for h in re.findall(r'href="([^"]*)"', html_text):
                if h.startswith("/locations") or h.startswith(glp.SITE_BASE + "/locations"):
                    found.append(h if h.startswith("http") else glp.SITE_BASE + h)
            for blk in re.findall(r'<script type="application/ld\+json">(.*?)</script>', html_text, re.S):
                for sv in walk(json.loads(blk)):
                    if sv.startswith(glp.SITE_BASE + "/locations"):
                        found.append(sv)
            self.assertIn(own, found)  # canonical / breadcrumb self-reference is present
            for u in found:
                with self.subTest(page=str(p.relative_to(self.out)), url=u):
                    self.assertIn(u, urls)

    def test_service_jsonld_name_equals_h1_and_nav_logo_file_exists(self):
        # Legal-read carry-forward (#2422 5965730069 item 1): Service name == visible H1.
        # Nav logo: the <img> in the page's nav script must point at a file that exists in the repo.
        self.run_fx()
        pages = sorted(self.out.glob("*/*/index.html"))
        self.assertGreater(len(pages), 0)
        import html as _html
        for p in pages:
            text = p.read_text(encoding="utf-8")
            h1 = _html.unescape(re.search(r"<h1>(.*?)</h1>", text, re.S).group(1)).strip()
            names = []
            for blk in re.findall(r'<script type="application/ld\+json">(.*?)</script>', text, re.S):
                d = json.loads(blk)
                if isinstance(d, dict) and d.get("@type") == "Service":
                    names.append(d["name"])
            with self.subTest(page=str(p.relative_to(self.out))):
                self.assertEqual(names, [h1])
                for src in re.findall(r'<img src="(/img/[^"]+)"', text):
                    self.assertTrue((REPO_ROOT / src.lstrip("/")).is_file(), src)

    # (d) committed allow-list states have committed profiles --------------------------------------
    def test_committed_allowlist_states_have_committed_profiles(self):
        # Invariant (replaces the launch-day "allow-list is empty" pin): every state on the
        # committed allow-list loads, has a committed profile, and is not a D-344 blocked state.
        data = json.loads((REPO_ROOT / "data" / "location-pages-state-allowlist.json").read_text(encoding="utf-8"))
        states = glp.load_allowlist()
        self.assertEqual(states, [s.strip().upper() for s in data["states"]])
        for st in states:
            with self.subTest(st):
                self.assertTrue((REPO_ROOT / "data" / "location-state-profiles" / f"{st}.json").is_file())
                glp.load_profile(st)  # raises StateConfigError if malformed
                self.assertNotIn(st, ("FL", "LA", "TX"))

    def test_committed_generated_pages_belong_to_allowlisted_states(self):
        # Invariant: no page is committed under locations/ for a state that is not on the allow-list.
        allowed = {s.lower() for s in glp.load_allowlist()}
        loc = REPO_ROOT / "locations"
        if loc.is_dir():
            for d in sorted(p for p in loc.iterdir() if p.is_dir()):
                with self.subTest(d.name):
                    self.assertIn(d.name.rsplit("-", 1)[-1], allowed)

    def test_empty_allowlist_emits_nothing(self):
        # Injected empty allow-list file (not the committed one).
        empty = self.tmp / "empty-allow.json"
        empty.write_text(json.dumps({"states": []}), encoding="utf-8")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            summary = glp.generate(glp.load_allowlist(empty), out_dir=self.out, sitemap_path=self.sitemap)
        self.assertEqual(summary["written"], 0)
        self.assertIn("allow-list is empty", buf.getvalue())
        self.assertFalse(self.out.exists())

    # state support is explicit, never silent --------------------------------
    def test_allowlisted_state_without_profile_is_an_explicit_error(self):
        with self.assertRaises(glp.StateConfigError) as cm:
            # OH has county data; the injected profiles dir holds only the ZZ fixture, so OH has no profile.
            self.run_gen(["OH"], profiles_dir=self.fx_profiles)
        self.assertIn("no state profile", str(cm.exception))
        self.assertFalse(self.out.exists())

    def test_allowlisted_state_without_county_data_is_an_explicit_error(self):
        f = self.tmp / "counties.json"
        f.write_text(json.dumps({"states": [{"code": "AL", "counties": ["Autauga"]}]}), encoding="utf-8")
        with self.assertRaises(glp.StateConfigError) as cm:
            self.run_gen(["IN"], counties_path=f)
        self.assertIn("no county data", str(cm.exception))

    def test_bad_allowlist_code_is_rejected(self):
        f = self.tmp / "allow.json"
        f.write_text(json.dumps({"states": ["indiana"]}), encoding="utf-8")
        with self.assertRaises(glp.StateConfigError):
            glp.load_allowlist(f)

    def test_indiana_profile_matches_county_data(self):
        prof = glp.load_profile("IN")
        self.assertEqual(sorted(glp.load_counties("IN")), sorted(prof["county_region"]))
        self.assertEqual(len(prof["county_region"]), 92)
        self.assertEqual(prof["name"], "Indiana")
        self.assertEqual(set(prof["region_label"]), {"northern", "central", "southern"})

    def test_committed_profiles_are_well_formed_and_match_their_filename(self):
        # Invariant (replaces "only IN.json"): every committed profile loads; load_profile enforces code == filename.
        for p in sorted((REPO_ROOT / "data" / "location-state-profiles").glob("*.json")):
            with self.subTest(p.name):
                glp.load_profile(p.stem)  # raises StateConfigError if malformed or if "code" != filename

    def test_malformed_profiles_are_explicit_errors_before_any_write(self):
        cases = {
            "not json": None,
            "wrong code": lambda p: p.update(code="QQ"),
            "no name": lambda p: p.pop("name"),
            "no regions": lambda p: p.update(regions={}),
            "empty climate": lambda p: p["regions"]["north"].update(climate=[]),
            "climate lacks {county}": lambda p: p["regions"]["north"].update(climate=["no placeholder here"]),
            "bad placeholder": lambda p: p["regions"]["north"].update(climate=["{county} {nope}"]),
            "county in two regions": lambda p: p["regions"]["south"].update(counties=["Gamma", "Alpha"]),
            "county unmapped": lambda p: p["regions"]["south"].update(counties=["Gamma"]) or p["regions"]["north"].update(counties=["Alpha"]),
        }
        for label, mutate in cases.items():
            with self.subTest(label):
                if mutate is None:
                    (self.fx_profiles / "ZZ.json").write_text("{not json", encoding="utf-8")
                else:
                    self.write_profile(mutate)
                with self.assertRaises(glp.StateConfigError):
                    self.run_fx()
                self.assertFalse(self.out.exists())

    def test_malformed_county_content_is_an_explicit_error(self):
        cases = {
            "unknown county": lambda p: p["county_content"].update(Nowhere="<p>x</p>"),
            "unknown trade": lambda p: p["county_content"]["Alpha"].update(plumbing="<p>x</p>"),
            "empty string": lambda p: p["county_content"].update(Alpha="  "),
            "empty trade text": lambda p: p["county_content"]["Alpha"].update(roofing=""),
            "wrong type": lambda p: p["county_content"].update(Alpha=5),
            "not an object": lambda p: p.update(county_content=["x"]),
        }
        for label, mutate in cases.items():
            with self.subTest(label):
                self.write_profile(mutate)
                with self.assertRaises(glp.StateConfigError):
                    self.run_fx()
                self.assertFalse(self.out.exists())

    def test_first_level_repo_dir_or_repo_root_out_dir_is_refused(self):
        repo_sitemap = REPO_ROOT / "sitemap.xml"
        before = repo_sitemap.read_bytes()
        under = REPO_ROOT / "preview-locations-test"
        self.assertFalse(under.exists())
        for out in (under, REPO_ROOT):
            with self.subTest(out=str(out)):
                with self.assertRaises(glp.StateConfigError) as cm:
                    quiet(glp.generate, ["ZZ"], out_dir=out, counties_path=self.fx_counties,
                          profiles_dir=self.fx_profiles)
                self.assertIn("REFUSED", str(cm.exception))
                with self.assertRaises(glp.StateConfigError):
                    quiet(glp.generate, [], out_dir=out)
                self.assertEqual(repo_sitemap.read_bytes(), before)
        self.assertFalse(under.exists())
        # an explicit sitemap path is honoured (and the repo sitemap still untouched)
        own = self.tmp / "own-sitemap.xml"
        quiet(glp.generate, ["ZZ"], out_dir=self.tmp / "o3" / "locations", sitemap_path=own,
              counties_path=self.fx_counties, profiles_dir=self.fx_profiles)
        self.assertEqual(own.read_text(encoding="utf-8").count("/locations/"), 12)
        self.assertEqual(repo_sitemap.read_bytes(), before)

    # round 5 --------------------------------------------------------------------
    def test_explicit_sitemap_path_equal_to_repo_sitemap_is_refused_unless_repo_locations(self):
        repo_sitemap = REPO_ROOT / "sitemap.xml"
        before = repo_sitemap.read_bytes()
        with self.assertRaises(glp.StateConfigError) as cm:
            quiet(glp.generate, ["ZZ"], out_dir=self.tmp / "o" / "locations", sitemap_path=repo_sitemap,
                  counties_path=self.fx_counties, profiles_dir=self.fx_profiles)
        self.assertNotIn(str(repo_sitemap), str(cm.exception))   # message does not point at the repo file
        self.assertNotIn("Pass an explicit", str(cm.exception))
        self.assertFalse((self.tmp / "o").exists())
        self.assertEqual(repo_sitemap.read_bytes(), before)
        # a path that merely RESOLVES to it (relative / dotted) is refused too
        sneaky = REPO_ROOT / "tools" / ".." / "sitemap.xml"
        with self.assertRaises(glp.StateConfigError):
            glp.resolve_sitemap_path(self.tmp / "o" / "locations", sneaky)
        # allowed when out_dir is the repo's locations/ (resolve only: nothing is written)
        self.assertEqual(glp.resolve_sitemap_path(glp.LOCATIONS_DIR, repo_sitemap), repo_sitemap)

    def test_explicit_sitemap_inside_repo_tree_is_refused_unless_repo_locations(self):
        out = self.tmp / "o" / "locations"
        for inside in (REPO_ROOT / "tools" / "sitemap.xml", REPO_ROOT / "locations" / "sitemap.xml",
                       REPO_ROOT / "data" / "x" / "sm.xml"):
            with self.subTest(inside=str(inside)):
                with self.assertRaises(glp.StateConfigError):
                    glp.resolve_sitemap_path(out, inside)
        self.assertEqual(glp.resolve_sitemap_path(out, self.tmp / "ok.xml"), self.tmp / "ok.xml")
        # with out_dir == the repo's locations/, an explicit path is accepted (resolve only)
        self.assertEqual(glp.resolve_sitemap_path(glp.LOCATIONS_DIR, REPO_ROOT / "tools" / "sitemap.xml"),
                         REPO_ROOT / "tools" / "sitemap.xml")

    def test_hardlink_to_the_repo_sitemap_is_refused(self):
        import os
        # A directory on the same filesystem as the repo but OUTSIDE the repo tree
        # (its parent), so only the hardlink check, not the inside-repo check, can refuse.
        try:
            link = pathlib.Path(tempfile.mkdtemp(dir=str(REPO_ROOT.parent)))
        except OSError as exc:
            self.skipTest(f"no writable directory beside the repo: {exc}")
        try:
            hl = link / "sitemap.xml"
            try:
                os.link(REPO_ROOT / "sitemap.xml", hl)
            except OSError as exc:
                self.skipTest(f"cannot hardlink on this filesystem: {exc}")
            before = (REPO_ROOT / "sitemap.xml").read_bytes()
            with self.assertRaises(glp.StateConfigError):
                glp.resolve_sitemap_path(self.tmp / "o" / "locations", hl)
            # derived hardlink: a sitemap.xml next to out_dir that is the repo file
            out = link / "locations"
            with self.assertRaises(glp.StateConfigError):
                glp.resolve_sitemap_path(out)
            self.assertEqual((REPO_ROOT / "sitemap.xml").read_bytes(), before)
        finally:
            for f in link.iterdir():
                f.unlink()
            link.rmdir()

    def test_derived_sitemap_inside_the_repo_tree_is_refused(self):
        for out in (REPO_ROOT / "tools" / "x" / "locations",      # -> tools/x/sitemap.xml
                    REPO_ROOT / "locations" / "sub",              # -> locations/sitemap.xml
                    REPO_ROOT / "tools" / "locations",            # -> tools/sitemap.xml
                    REPO_ROOT):
            with self.subTest(out=str(out)):
                with self.assertRaises(glp.StateConfigError):
                    glp.resolve_sitemap_path(out)
        # outside the repo tree is fine
        self.assertEqual(glp.resolve_sitemap_path(self.tmp / "z" / "locations"), self.tmp / "z" / "sitemap.xml")

    def test_single_county_state_without_county_content_emits_nothing(self):
        solo_counties = self.tmp / "solo-counties.json"
        solo_counties.write_text(json.dumps({"states": [{"code": "ZZ", "counties": ["Solo"]}]}), encoding="utf-8")
        def solo_profile(with_content):
            prof = json.loads(json.dumps(FIXTURE_PROFILE))
            prof["regions"] = {"north": {"label": "northern Zedland", "counties": ["Solo"],
                                         "climate": [FIXTURE_CLIMATE % "northern"]}}
            prof["county_content"] = ({"Solo": {t: fixture_content("Solo", t) for t in glp.ELIGIBLE_TRADES}}
                                      if with_content else {})
            (self.fx_profiles / "ZZ.json").write_text(json.dumps(prof), encoding="utf-8")
        solo_profile(False)
        summary = self.run_gen(["ZZ"], counties_path=solo_counties, profiles_dir=self.fx_profiles)
        self.assertEqual(summary["written"], 0)
        self.assertLess(summary["min_strict_unique_words"], 100)   # template counted as shared
        self.assertFalse(self.out.exists())
        solo_profile(True)                                         # real county content still passes
        summary = self.run_gen(["ZZ"], counties_path=solo_counties, profiles_dir=self.fx_profiles)
        self.assertEqual(summary["written"], 4)

    def test_repeated_paragraph_counts_once(self):
        para = ["w%d" % i for i in range(52)]
        page = para * 14
        self.assertLess(glp.strict_unique_counts([page, ["other"] * 9])[0], 120)
        self.assertEqual(glp.strict_unique_counts([para * 1, ["other"] * 9])[0], 52)

        def repeated(prof):
            para = " ".join(VOCAB[100:140])
            prof["county_content"]["Alpha"] = {t: "\n\n".join([para] * 14) for t in glp.ELIGIBLE_TRADES}
        self.write_profile(repeated)
        summary = self.run_fx()
        self.assertIn("alpha-county-zz/roofing", summary["skipped_thin"])

    def test_hidden_text_never_counts_and_is_rejected_in_county_content(self):
        words = " ".join("hid%d" % i for i in range(100))
        for wrapper in ('<div hidden>%s</div>', '<div aria-hidden="true">%s</div>',
                        '<p style="display:none">%s</p>', '<p style="color:red; visibility: hidden">%s</p>',
                        '<noscript>%s</noscript>', '<div hidden><div><span>%s</span></div></div>'):
            with self.subTest(wrapper=wrapper):
                page = "<main><p>visible words here</p>%s</main>" % (wrapper % words)
                self.assertEqual(glp.main_words(page), ["visible", "words", "here"])
        for bad in ('<div hidden>x</div>', '<p style="display:none">x</p>', '<p style="visibility:hidden">x</p>',
                    '<p style="font-size:0">x</p>', '<span class="sr-only">x</span>',
                    '<span class="Visually-Hidden">x</span>', '<p style="position:absolute;left:-9999px">x</p>',
                    '<p style="clip: rect(0,0,0,0)">x</p>', '<p style="COLOR:#FFF">x</p>',
                    '<p style="color: #ffffff">x</p>'):
            with self.subTest(bad=bad):
                self.write_profile(lambda p: p["county_content"]["Alpha"].update(roofing=bad))
                with self.assertRaises(glp.StateConfigError):
                    self.run_fx()
                self.assertFalse(self.out.exists())

    # round 7: county_content is plain text ---------------------------------------
    HIDDEN_STYLES = (
        "font-size:0px", "color:transparent", "text-indent:-9999px", "opacity:.01",
        "color:rgb(255,255,255)", "color:hsl(0,0%,100%)", "color:#FEFEFE",
        "position:absolute;top:-9999px", "position:absolute;left:-999em", "transform:scale(0)",
        "width:0;height:0", "max-height:0;overflow:auto", "filter:opacity(0)", "clip-path:inset(50%)",
        "font-size:1px", "dis\\play:none", "color&#58;white", "display:none", "visibility:hidden",
    )

    def test_county_content_with_hidden_styles_is_rejected_at_load_and_writes_nothing(self):
        for style in self.HIDDEN_STYLES:
            for form in ('<p style="%s">hidden words</p>', '<span class="x" style=\'%s\'>hidden words</span>',
                         "<div style=%s>hidden words</div>"):
                payload = form % style
                with self.subTest(payload=payload):
                    self.write_profile(lambda p, payload=payload: p["county_content"]["Alpha"].update(roofing=payload))
                    with self.assertRaises(glp.StateConfigError):
                        self.run_fx()
                    self.assertFalse(self.out.exists())
        # the same property text WITHOUT markup is plain words (escaped, harmless), except where it
        # carries a forbidden character; entity-encoded and backslash-escaped forms are rejected outright
        for forbidden in ("color&#58;white", "dis\\play:none", "{display:none}", "a < b", "a > b", "tom & jerry"):
            with self.subTest(forbidden=forbidden):
                self.write_profile(lambda p, f=forbidden: p["county_content"]["Alpha"].update(roofing=f))
                with self.assertRaises(glp.StateConfigError):
                    self.run_fx()

    def test_county_content_ordinary_words_are_accepted_and_escaped(self):
        text = "Hidden hail damage is common after storms. It's often missed.\n\nA second paragraph about \"permits\"."
        self.write_profile(lambda p: p["county_content"]["Alpha"].update(roofing=text))
        prof = glp.load_profile("ZZ", self.fx_profiles)
        page = glp.build_page("Alpha", "roofing", "x", "ZZ", profile=prof)
        notes = page.split("County notes</h2>")[1].split("<h2>")[0]
        self.assertEqual(notes.count("<p>"), 2)
        self.assertIn("Hidden hail damage is common after storms.", notes)
        self.assertNotRegex(notes, r"<(?!/?p>)")             # no tag but bare <p>
        self.assertEqual(glp.main_words(page).count("hidden"), 1)   # ordinary word counts as a word

    def test_county_content_rejects_markup_free_but_forbidden_characters(self):
        for bad in ("braces {x}", "back\\slash", "null\x00byte", "bell\x07"):
            with self.subTest(bad=bad):
                self.write_profile(lambda p, b=bad: p["county_content"]["Alpha"].update(roofing=b))
                with self.assertRaises(glp.StateConfigError):
                    self.run_fx()

    def test_lint_failure_on_any_page_leaves_zero_pages_and_no_sitemap_change(self):
        profile = glp.load_profile("ZZ", self.fx_profiles)

        def bad_last(county, trade, generated_on, state):
            page = glp.build_page(county, trade, generated_on, state, profile=profile)
            if (county, trade) == ("Gamma", "windows"):          # the very last page built
                page = page.replace("</main>", "<p>Our contractors will call.</p></main>")
            return page

        with self.assertRaises(glp.ComplianceError):
            self.run_fx(build_fn=bad_last)
        self.assertFalse(self.out.exists())
        self.assertEqual(self.sitemap.read_text(encoding="utf-8"), SITEMAP_SEED)

    def test_article_agrees_with_county_name(self):
        prof = glp.load_profile("IN")
        seen = set()
        for county, trade in (("Allen", "roofing"), ("Elkhart", "siding"), ("Ohio", "gutters"), ("Union", "windows"),
                              ("Marion", "roofing"), ("Lake", "siding")):
            for t in glp.ELIGIBLE_TRADES:
                page = glp.build_page(county, t, "x", "IN", profile=prof)
                self.assertNotRegex(page, r"\ba [AEIOUaeiou]\w* County project")
                self.assertNotRegex(page, r"\ban [^AEIOUaeiou\s]\w* County project")
                if f"works for an {county} County project" in page:
                    seen.add(county)
        self.assertTrue(seen & {"Allen", "Elkhart", "Ohio", "Union"})

    def test_blocked_states_are_refused_in_any_case(self):
        for st in ("tx", "Fl", "lA"):
            with self.subTest(st):
                with self.assertRaises(glp.StateConfigError) as cm:
                    self.run_fx(states=(st,))
                self.assertIn("D-344", str(cm.exception))
                self.assertNotIn("no state profile", str(cm.exception))
                f = self.tmp / "allow-lc.json"
                f.write_text(json.dumps({"states": [st]}), encoding="utf-8")
                with self.assertRaises(glp.StateConfigError) as cm:
                    glp.load_allowlist(f)
                self.assertIn("D-344", str(cm.exception))

    def test_round8_invisible_characters_rejected_in_county_content(self):
        for ch in ("\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u202a", "\u202c", "\u202e", "\u2060",
                   "\u2062", "\u2064", "\u206f", "\ufeff", "\U000e0041", "\ufe0f", "\U000e0100", "\u034f",
                   "\u00ad", "\u2800", "\u3164", "\u0301", "\u2028", "\ue000", "\x7f", "\u180e"):
            with self.subTest(ch=hex(ord(ch))):
                self.write_profile(lambda p, c=ch: p["county_content"]["Alpha"].update(roofing=f"wor{c}d text"))
                with self.assertRaises(glp.StateConfigError):
                    self.run_fx()
                self.assertFalse(self.out.exists())
        # visible non-ASCII text is fine
        self.write_profile(lambda p: p["county_content"]["Alpha"].update(
            roofing="Caf\u00e9 \u2014 it\u2019s \u201cquoted\u201d \u2026"))
        glp.load_profile("ZZ", self.fx_profiles)

    def test_round8_profile_strings_with_markup_are_rejected(self):
        for mutate in (lambda p: p["regions"]["north"].update(label="northern <b>Zedland</b>"),
                       lambda p: p["regions"]["north"].update(climate=["{county} <i>x</i>"]),
                       lambda p: p["regions"]["north"].update(climate=["{county} a &amp; b"]),
                       lambda p: p["regions"]["north"].update(climate=["{county} wor\u200bd"]),
                       lambda p: p.update(name="Zed<script>")):
            self.write_profile(mutate)
            with self.assertRaises(glp.StateConfigError):
                self.run_fx()
            self.assertFalse(self.out.exists())

    @staticmethod
    def boilerplate_words(n=650):
        return list(VOCAB[:n])

    def zw_page(self, county, trade, generated_on, state):
        """A page whose 650-word boilerplate is identical everywhere except that a zero-width
        space is inserted inside words at page-specific positions. Bypasses the profile on purpose."""
        words = self.boilerplate_words()
        k = (sum(map(ord, county + trade)) % 5) + 1
        varied = [w[:k] + "\u200b" + w[k:] if i % 3 == 0 else w for i, w in enumerate(words)]
        body = " ".join(varied)
        return ("<!DOCTYPE html><html><head><title>t</title></head><body><main>"
                "<p>We create a scope of work and send it to local contractors.</p><p>%s</p></main></body></html>"
                % body)

    def test_round8_zero_width_varied_boilerplate_writes_zero_pages(self):
        summary = self.run_fx(build_fn=self.zw_page)
        self.assertEqual(summary["written"], 0)
        self.assertFalse(self.out.exists())
        self.assertEqual(self.sitemap.read_text(encoding="utf-8"), SITEMAP_SEED)
        # the words as the gate sees them are identical across pages
        a = glp.main_words(self.zw_page("Alpha", "roofing", "x", "ZZ"))
        b = glp.main_words(self.zw_page("Beta", "siding", "x", "ZZ"))
        self.assertEqual(a, b)
        # combining-mark and homoglyph variation fold away too
        self.assertEqual(glp.main_words("<main>r\u00e9ady \u0440aint</main>"), glp.main_words("<main>ready paint</main>"))

    def merge_profile(self, token_for):
        """Same 650-word boilerplate for every county and trade, with a mail-merge token every 6 words."""
        base = self.boilerplate_words()

        def text(county, trade):
            out = []
            for i, w in enumerate(base):
                out.append(w)
                if i % 6 == 5:
                    out.append(token_for(county, trade))
            return " ".join(out)

        def mutate(prof):
            prof["county_content"] = {c: {t: text(c, t) for t in glp.ELIGIBLE_TRADES}
                                      for c in ("Alpha", "Beta", "Gamma")}
        self.write_profile(mutate)

    def test_round8_mail_merge_tokens_do_not_make_boilerplate_unique(self):
        cases = {
            "county-trade compound": lambda c, t: f"{c}-{t}",
            "county-trade compound with trade label": lambda c, t: f"{c}-{t.capitalize()}",
            "county alone": lambda c, t: c,
            "county possessive": lambda c, t: f"{c}'s",
            "trade alone": lambda c, t: t,
            "trade singular synonym": lambda c, t: {"roofing": "roof", "siding": "sider", "gutters": "gutter",
                                                     "windows": "window"}[t],
            "county and trade separate": lambda c, t: f"{c} {t}",
            "county and trade underscore/slash": lambda c, t: f"{c}_{t}/{c}",
            "state name": lambda c, t: "Zedland",
            "all three": lambda c, t: f"Zedland-{c}-{t}",
        }
        for label, fn in cases.items():
            with self.subTest(label):
                self.merge_profile(fn)
                if self.out.exists():
                    import shutil
                    shutil.rmtree(self.out)
                summary = self.run_fx()
                self.assertEqual(summary["written"], 0, label)
                self.assertFalse(self.out.exists())
        # control: genuinely different per-county and per-trade text still passes
        self.write_profile(lambda p: None)
        summary = self.run_fx()
        self.assertEqual(summary["written"], 12)
        self.assertGreaterEqual(summary["min_strict_unique_words"], glp.MIN_WORDS)

    def test_round8_page_mask_unit(self):
        mask = glp.StateMask("ZZ", "Zedland", ["St. Joseph", "Adams"], ["northern Zedland"])
        self.assertEqual(glp.main_words("<main>St. Joseph-roofing joseph's Zedland windows ZZ northern</main>", mask),
                         ["countyname", "countyname", "tradename", "countyname", "statename", "tradename",
                          "statename", "regionname"])

    GATE_COUNTIES = ("Alpha", "Beta", "Gamma")

    def junk_profile(self, junk_fn, every=7, n=773):
        """Same n-word visible boilerplate on every county x trade page (which alone writes 0
        pages), with one junk token per `every` words. junk_fn(county, trade, k, page_index)."""
        base = list(VOCAB[:n]) if n <= len(VOCAB) else [VOCAB[i % len(VOCAB)] for i in range(n)]
        index = {(c, t): i for i, (c, t) in enumerate((c, t) for c in self.GATE_COUNTIES for t in glp.ELIGIBLE_TRADES)}

        def text(c, t):
            out, k = [], 0
            for i, w in enumerate(base):
                out.append(w)
                if i % every == every - 1:
                    out.append(junk_fn(c, t, k, index[(c, t)]))
                    k += 1
            return " ".join(out)

        def mutate(prof):
            prof["county_content"] = {c: {t: text(c, t) for t in glp.ELIGIBLE_TRADES} for c in self.GATE_COUNTIES}
        self.write_profile(mutate)

    def assert_writes_nothing(self, label):
        import shutil
        if self.out.exists():
            shutil.rmtree(self.out)
        summary = self.run_fx()
        self.assertEqual(summary["written"], 0, label)
        self.assertFalse(self.out.exists(), label)

    def test_round9_per_page_junk_tokens_write_zero_pages(self):
        rnd = _random.Random(9)
        letters = "bcdfghjklmnpqrstvwxz"
        cases = {
            "page index every 7 words": (lambda c, t, k, i: str(i), 7),
            "page index every 4 words": (lambda c, t, k, i: str(i), 4),
            "random 4-digit number": (lambda c, t, k, i: str(rnd.randrange(1000, 10000)), 7),
            "date 2026-MM-DD": (lambda c, t, k, i: "2026-%02d-%02d" % (1 + (i + k) % 12, 1 + (i * 3 + k) % 28), 7),
            "county+trade joined, no separator": (lambda c, t, k, i: f"{c}{t.capitalize()}", 7),
            "trade+county joined (reverse)": (lambda c, t, k, i: f"{t.capitalize()}{c}", 7),
            "county + 'ville' join": (lambda c, t, k, i: f"{c}ville", 7),
            "county lower+trade lower joined": (lambda c, t, k, i: f"{c.lower()}{t}", 4),
            "random letter strings": (lambda c, t, k, i: "".join(rnd.choice(letters) for _ in range(7)), 7),
            "letters+digits ids": (lambda c, t, k, i: f"id{i}x{k}", 5),
        }
        for label, (fn, every) in cases.items():
            with self.subTest(label):
                self.junk_profile(fn, every=every)
                self.assert_writes_nothing(label)

    def test_round9_old_routes_still_hold(self):
        # zero-width characters, separated tokens and repetition
        self.run_fx()   # sanity: the fixture itself writes pages
        self.junk_profile(lambda c, t, k, i: f"{c} {t}")                       # separated county and trade
        self.assert_writes_nothing("separated tokens")
        self.junk_profile(lambda c, t, k, i: f"{c}-{t}", every=6)              # hyphen compound
        self.assert_writes_nothing("hyphen compound")
        self.write_profile(lambda p: p["county_content"]["Alpha"].update(
            roofing="\n\n".join([" ".join(VOCAB[100:140])] * 14)))            # repetition
        self.assertIn("alpha-county-zz/roofing", self.run_fx()["skipped_thin"])
        page = glp.main_words(self.zw_page("Alpha", "roofing", "x", "ZZ"))
        self.assertEqual(page, glp.main_words(self.zw_page("Beta", "siding", "x", "ZZ")))

    def test_round9_homoglyphs_outside_the_fold_table_are_rejected_at_load(self):
        glyphs = {"armenian o": "\u0585", "armenian u": "\u057d", "armenian n": "\u0578", "armenian h": "\u0570",
                  "armenian c": "\u0581", "armenian z": "\u0566", "latin alpha": "\u0251", "latin iota": "\u0269",
                  "cyrillic ge": "\u0433", "cyrillic u": "\u04af", "cyrillic we": "\u051d", "greek omicron": "\u03bf",
                  "cyrillic a": "\u0430", "latin small capital": "\u1d0f", "fullwidth-ok-but-ipa": "\u0261"}
        for label, ch in glyphs.items():
            with self.subTest(label):
                self.write_profile(lambda p, c=ch: p["county_content"]["Alpha"].update(roofing=f"R{c}ofers wait"))
                with self.assertRaises(glp.StateConfigError):
                    self.run_fx()
                self.assertFalse(self.out.exists())
        # the same letters in labels, climate and the state name
        for mutate in (lambda p: p["regions"]["north"].update(label="n\u0585rthern"),
                       lambda p: p["regions"]["north"].update(climate=["{county} sits h\u0585re"]),
                       lambda p: p.update(name="Z\u0435dland")):
            self.write_profile(mutate)
            with self.assertRaises(glp.StateConfigError):
                self.run_fx()
        # accented Latin letters, digits and typographic punctuation are fine
        self.write_profile(lambda p: p["county_content"]["Alpha"].update(
            roofing="Caf\u00e9 \u00fcber na\u00efve \u00f8re \u00df \u00ff 1969 \u2019 \u201c \u201d \u2013 \u2014"))
        glp.load_profile("ZZ", self.fx_profiles)
        self.assertEqual(glp.load_profile("IN")["name"], "Indiana")      # the shipped profile still loads

    def test_round9_token_rules_unit(self):
        mask = glp.StateMask("ZZ", "Zedland", ["Adams", "Wells"], ["north"])
        self.assertEqual(glp.main_words("<main>AdamsRoofing RoofingAdams Adamsville ZedlandNorth consider "
                                        "insider Wells</main>", mask),
                         ["countyname", "countyname", "countyname", "statename", "consider", "insider", "countyname"])
        # digit tokens dropped; single letters become placeholders
        self.assertEqual(glp.main_words("<main>a1 bb 2026-03-14 c 4x7 dd</main>"), ["bb", "letterword", "dd"])

    def test_round10_tokenisation_and_generic_masks(self):
        mask = glp.StateMask("ZZ", "Zedland", ["Adams"], ["north"])
        # hyphens, slashes and underscores separate tokens
        self.assertEqual(glp.main_words("<main>eta-beta/gamma_delta</main>", mask),
                         ["eta", "beta", "gamma", "natoword"])
        self.assertEqual(glp.main_words("<main>two-hundred-thirty-seven twentieth first Charlie delta hotel b k XIV mix</main>",
                                        mask),
                         ["numberword"] * 4 + ["numberword", "numberword", "natoword", "natoword", "natoword",
                                               "letterword", "letterword", "romanword", "romanword"])
        self.assertEqual(glp.main_words("<main>Allen-flashing soffit fascia sash shingles</main>", mask),
                         ["allen", "tradename", "tradename", "tradename", "tradename", "tradename"])
        self.assertEqual(glp.main_words("<main>consider leave</main>", mask), ["consider", "leave"])

    def test_round10_alignment_measure_unit(self):
        base = list(VOCAB[:60])
        # junk every 4 words: runs of 3 still match -> only the junk counts
        pages = [[w for i, w in enumerate(base) for w in ([w] + (["junk%s%d" % (c, i)] if i % 3 == 2 else []))]
                 for c in "abc"]
        pages = [[t.replace("junk", "zq") for t in pg] for pg in pages]
        counts = glp.strict_unique_counts(pages)
        self.assertTrue(all(c <= len(pg) // 4 + 2 for c, pg in zip(counts, pages)), counts)
        # order does not matter: shuffled sentences are still shared
        sentences = [base[i:i + 12] for i in range(0, 60, 12)]
        a = [w for sent in sentences for w in sent]
        b = [w for sent in reversed(sentences) for w in sent]
        self.assertEqual(glp.strict_unique_counts([a, b]), [0, 0])
        # a baseline holding the text makes a lone page's copy of it shared
        self.assertEqual(glp.strict_unique_counts([a], baseline_lists=[b]), [0])
        self.assertEqual(glp.strict_unique_counts([a]), [60])

    def test_round9_genuine_text_still_writes_pages_at_indiana_scale(self):
        """92 counties x 4 trades of genuinely distinct per-page text drawn from a shared vocabulary:
        all 368 pages are written; min/median strict-unique words are recorded."""
        import tempfile as _tf
        counties = glp.load_counties("IN")
        vocab = _make_vocab(3000, 11)
        base = json.loads((REPO_ROOT / "data" / "location-state-profiles" / "IN.json").read_text(encoding="utf-8"))
        rnd = _random.Random(3)

        def text():
            words = [rnd.choice(vocab) for _ in range(640)]
            return "\n\n".join(" ".join(words[i:i + 50]) for i in range(0, 640, 50))
        base["county_content"] = {c: {t: text() for t in glp.ELIGIBLE_TRADES} for c in counties}
        d = pathlib.Path(_tf.mkdtemp(dir=str(self.tmp)))
        (d / "IN.json").write_text(json.dumps(base), encoding="utf-8")
        summary = quiet(glp.generate, ["IN"], out_dir=self.tmp / "in-out" / "locations",
                        profiles_dir=d, dry_run=True)
        self.assertEqual(summary["written"], 368)
        self.assertGreaterEqual(summary["min_strict_unique_words"], glp.MIN_WORDS)
        print("\n[round 9 control] Indiana-scale genuine text: written %d, strict-unique min %s / median %s"
              % (summary["written"], summary["min_strict_unique_words"], summary["median_strict_unique_words"]),
              file=sys.stderr)

    # round 10: insertion-tolerant measure ----------------------------------------------
    NUM = ("zero one two three four five six seven eight nine ten eleven twelve").split()

    @classmethod
    def spelled(cls, i):
        words = []
        if i >= 100:
            words += [cls.NUM[i // 100], "hundred"]
            i %= 100
        if i >= 20:
            words += [["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"][i // 10 - 2]]
            i %= 10
            if i:
                words.append(cls.NUM[i])
        elif i or not words:
            words.append(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
                          "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"][i])
        return words

    ADJ = ("flashing", "soffit", "fascia", "sash")
    NATO_WORDS = "alfa bravo charlie delta echo foxtrot golf hotel india juliet".split()

    def test_round10_identity_tokens_from_ordinary_words_write_zero_pages(self):
        cases = {
            "hyphenated spelled index every 7": (lambda c, t, k, i: "-".join(self.spelled(i * 17 + 3)), 7),
            "spelled index every 4": (lambda c, t, k, i: " ".join(self.spelled(i * 17 + 3)), 4),
            "NATO index every 5": (lambda c, t, k, i: " ".join(self.NATO_WORDS[int(d)] for d in str(i * 7 + 11)), 5),
            "spaced letter code every 5": (lambda c, t, k, i: f"{chr(97 + i % 26)} {chr(97 + (i * 5) % 26)}", 5),
            "neighbouring county+trade word every 7": (lambda c, t, k, i: f"Allen-{self.ADJ[(i + k) % 4]}", 7),
            "neighbouring county+trade pair every 6": (lambda c, t, k, i: f"Allen-{self.ADJ[(i + k) % 4]} Wayne-{self.ADJ[(i + k + 1) % 4]}", 6),
            "3-letter abbreviation pair every 6": (lambda c, t, k, i: f"{c[:3]}-{self.ADJ[k % 4]} {t[:3]}-{self.ADJ[(k + 2) % 4]}", 6),
            "county seat + trade word every 6": (lambda c, t, k, i: f"Fort Wayne {self.ADJ[(i + k) % 4]}", 6),
            "roman numeral every 5": (lambda c, t, k, i: ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"][i % 12], 5),
        }
        for label, (fn, every) in cases.items():
            with self.subTest(label):
                self.junk_profile(fn, every=every)
                self.assert_writes_nothing(label)

    def test_round10_older_attacks_still_write_zero_pages(self):
        base = list(VOCAB[:780])

        def shuffled(prof_fn):
            self.write_profile(lambda p: p.update(county_content={
                c: {t: prof_fn(c, t) for t in glp.ELIGIBLE_TRADES} for c in self.GATE_COUNTIES}))
            self.assert_writes_nothing("attack")
        # sentence shuffle: 39 sentences of 20 words, order shuffled per page
        sentences = [base[i:i + 20] for i in range(0, 780, 20)]

        def shuffle_text(c, t):
            rnd = _random.Random(f"{c}{t}")
            order = list(range(len(sentences)))
            rnd.shuffle(order)
            return "\n\n".join(" ".join(sentences[i]) for i in order)
        shuffled(shuffle_text)
        # synonym rotation: every 20th word swapped among three stand-ins, rotated per page
        def rotate_text(c, t):
            r = sum(map(ord, c + t))
            return " ".join((VOCAB[790 + (i + r) % 3] if i % 20 == 0 else w) for i, w in enumerate(base))
        shuffled(rotate_text)
        # the same boilerplate on every page with a different paragraph order and per-page numbers
        shuffled(lambda c, t: "\n\n".join(" ".join(base[j:j + 60] + [str(sum(map(ord, c + t)) + j)])
                                            for j in range(0, 780, 60)))

    def test_round10_density_boundary_is_documented_honestly(self):
        """Junk drawn from a shared 2,000-word vocabulary, one junk token after every N real words.
        N=3 and N=4 are caught (runs of 3+ real words still align). N=2 (runs of two real words
        between junk tokens, one token in three is junk) is the documented residual: no run reaches
        the 3-word block, so the page counts as unique. Visible spam, for the per-state R-177 read."""
        import shutil
        vocab = _make_vocab(2000, 21)
        rnd = _random.Random(4)
        for every in (5, 4, 3):
            with self.subTest(every=every):
                self.junk_profile(lambda c, t, k, i: rnd.choice(vocab), every=every)
                self.assert_writes_nothing(f"junk after every {every} real words")
        self.junk_profile(lambda c, t, k, i: rnd.choice(vocab), every=2)
        if self.out.exists():
            shutil.rmtree(self.out)
        summary = self.run_fx()
        # DOCUMENTED RESIDUAL: nothing in the gate catches this; see strict_unique_counts().
        self.assertEqual(summary["written"], 12)

    def test_round10_honest_single_county_four_trades_writes_four(self):
        solo = self.tmp / "solo10.json"
        solo.write_text(json.dumps({"states": [{"code": "ZZ", "counties": ["Solo"]}]}), encoding="utf-8")
        prof = json.loads(json.dumps(FIXTURE_PROFILE))
        prof["regions"] = {"north": {"label": "northern Zedland", "counties": ["Solo"],
                                     "climate": [FIXTURE_CLIMATE % "northern"]}}
        prof["county_content"] = {"Solo": {t: fixture_content("Solo", t) for t in glp.ELIGIBLE_TRADES}}
        (self.fx_profiles / "ZZ.json").write_text(json.dumps(prof), encoding="utf-8")
        summary = self.run_gen(["ZZ"], counties_path=solo, profiles_dir=self.fx_profiles)
        self.assertEqual(summary["written"], 4)
        self.assertGreaterEqual(summary["min_strict_unique_words"], glp.MIN_WORDS)
        # the same boilerplate on all four trade pages writes none
        shared = fixture_content("Solo", "roofing")
        prof["county_content"] = {"Solo": {t: shared for t in glp.ELIGIBLE_TRADES}}
        (self.fx_profiles / "ZZ.json").write_text(json.dumps(prof), encoding="utf-8")
        import shutil
        shutil.rmtree(self.out)
        self.assertEqual(self.run_gen(["ZZ"], counties_path=solo, profiles_dir=self.fx_profiles)["written"], 0)

    # round 11: global document frequency; strict character allow-list --------------------
    def test_round11_text_on_many_pages_counts_as_shared_fixture_scale(self):
        """Each ~40-word paragraph appears verbatim on 7 of the 12 pages (more than the five
        'nearest' pages an earlier version compared with); every page is 20+ such paragraphs. All shared,
        so no page is written."""
        rnd = _random.Random(11)
        paras = [" ".join(rnd.choice(VOCAB) for _ in range(40)) for _ in range(34)]
        order = [(c, t) for c in self.GATE_COUNTIES for t in glp.ELIGIBLE_TRADES]

        def text(c, t):
            pidx = order.index((c, t))
            return "\n\n".join(para for j, para in enumerate(paras) if (pidx - j) % 12 < 7)
        self.write_profile(lambda prof: prof.update(county_content={
            c: {t: text(c, t) for t in glp.ELIGIBLE_TRADES} for c in self.GATE_COUNTIES}))
        self.assertGreaterEqual(len(text("Alpha", "roofing").split()), 500)
        self.assert_writes_nothing("each paragraph on 7 of 12 pages")

    def test_round11_literal_repetition_across_19_pages_at_indiana_scale(self):
        """The refuter's design: the real 92-county Indiana list, each ~40-word paragraph verbatim on 19
        pages, 20 such paragraphs per page. Written pages: 0."""
        import tempfile as _tf
        counties = glp.load_counties("IN")
        base = json.loads((REPO_ROOT / "data" / "location-state-profiles" / "IN.json").read_text(encoding="utf-8"))
        vocab = _make_vocab(3000, 13)
        rnd = _random.Random(2)
        pairs = [(c, t) for c in counties for t in glp.ELIGIBLE_TRADES]        # 368 pages
        n_par = len(pairs) * 20 // 19
        paras = [" ".join(rnd.choice(vocab) for _ in range(40)) for _ in range(n_par)]
        # paragraph j is placed on 19 pages; every page gets 20 of them
        pages = {pr: [] for pr in pairs}
        for j, para in enumerate(paras):
            for k in range(19):
                pages[pairs[(j * 19 + k) % len(pairs)]].append(para)
        self.assertTrue(all(len(v) >= 19 for v in pages.values()))
        base["county_content"] = {c: {t: "\n\n".join(pages[(c, t)]) for t in glp.ELIGIBLE_TRADES} for c in counties}
        d = pathlib.Path(_tf.mkdtemp(dir=str(self.tmp)))
        (d / "IN.json").write_text(json.dumps(base), encoding="utf-8")
        summary = quiet(glp.generate, ["IN"], out_dir=self.tmp / "r11" / "locations", profiles_dir=d, dry_run=True)
        self.assertEqual(summary["written"], 0)
        print("\n[round 11] 19-page literal repetition, Indiana scale: written %d, strict-unique min %s / median %s"
              % (summary["written"], summary["min_strict_unique_words"], summary["median_strict_unique_words"]),
              file=sys.stderr)

    def test_round11_latin_lookalikes_and_separators_are_refused_everywhere(self):
        bad_chars = {
            "U+01C0 latin click": "\u01c0", "U+0196 latin iota": "\u0196", "U+0237 dotless j": "\u0237",
            "U+0138 kra": "\u0138", "U+00D0 ETH": "\u00d0", "U+00F0 eth": "\u00f0", "U+0110 D stroke": "\u0110",
            "U+0189 african D": "\u0189", "U+00DE THORN": "\u00de", "U+00FE thorn": "\u00fe",
            "U+0142 l stroke": "\u0142", "U+0251": "\u0251", "U+1D159 null notehead": "\U0001d159",
            "U+00A0 nbsp": "\u00a0", "U+2000 en quad": "\u2000", "U+2003 em space": "\u2003",
            "U+200A hair space": "\u200a", "U+202F narrow nbsp": "\u202f", "U+00B7 middle dot": "\u00b7",
            "U+02D9 dot above": "\u02d9", "U+00D7 times": "\u00d7", "U+00F7 divide": "\u00f7",
            "U+00B4 acute accent (Sk)": "\u00b4", "U+00AC not (Sm)": "\u00ac", "U+0301 combining": "\u0301",
            "U+0903 spacing mark (Mc)": "\u0903", "U+20DD enclosing (Me)": "\u20dd", "U+2028 line sep": "\u2028",
            "U+0661 arabic digit": "\u0661",
        }
        for label, ch in bad_chars.items():
            with self.subTest(label):
                word = f"ro{ch}f"
                for mutate in (lambda pf, w=word: pf["county_content"]["Alpha"].update(roofing=f"a {w} b"),
                               lambda pf, w=word: pf["regions"]["north"].update(label=f"north{w}"),
                               lambda pf, w=word: pf["regions"]["north"].update(climate=["{county} " + w]),
                               lambda pf, w=word: pf.update(name=f"Zed{w}")):
                    self.write_profile(mutate)
                    with self.assertRaises(glp.StateConfigError):
                        self.run_fx()
                    self.assertFalse(self.out.exists())
        # allowed: ASCII punctuation, typographic marks and Latin-1 letters (not eth/thorn)
        self.write_profile(lambda pf: pf["county_content"]["Alpha"].update(
            roofing="Plain, ASCII: (ok) \"x\" 'y' - ! ? ; # % \u2019 \u2018 \u201c \u201d \u2013 \u2014 \u2026 "
                    "\u00c0 \u00c9 \u00d1 \u00d6 \u00dc \u00df \u00e0 \u00e9 \u00f1 \u00f6 \u00fc \u00ff"))
        glp.load_profile("ZZ", self.fx_profiles)
        self.assertEqual(glp.load_profile("IN")["name"], "Indiana")

    # D-344 blocked states ----------------------------------------------------
    def test_blocked_states_are_refused_everywhere(self):
        for st in ("FL", "LA", "TX"):
            with self.subTest(st):
                f = self.tmp / f"allow-{st}.json"
                f.write_text(json.dumps({"states": [st]}), encoding="utf-8")
                with self.assertRaises(glp.StateConfigError) as cm:
                    glp.load_allowlist(f)
                self.assertIn("D-344", str(cm.exception))
                # also refused when generate() is called directly, even next to a valid state
                with self.assertRaises(glp.StateConfigError):
                    self.run_fx(states=("ZZ", st))
                self.assertFalse(self.out.exists())
                self.assertEqual(self.sitemap.read_text(encoding="utf-8"), SITEMAP_SEED)

    def test_cli_refuses_blocked_state_before_writing(self):
        import subprocess
        f = self.tmp / "allow-TX.json"
        f.write_text(json.dumps({"states": ["TX"]}), encoding="utf-8")
        out = self.tmp / "cli-out" / "locations"
        r = subprocess.run([sys.executable, str(HERE / "generate_location_pages.py"), "--allowlist", str(f),
                            "--out-dir", str(out)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("REFUSED", r.stderr)
        self.assertIn("D-344", r.stderr)
        self.assertFalse(out.exists())
        self.assertFalse((self.tmp / "cli-out").exists())

    def test_missing_profile_is_an_explicit_error(self):
        (self.fx_profiles / "ZZ.json").unlink()
        with self.assertRaises(glp.StateConfigError) as cm:
            self.run_fx()
        self.assertIn("no state profile", str(cm.exception))

    def test_run_reports_min_and_median_strict_unique_words(self):
        summary = self.run_fx()
        self.assertGreaterEqual(summary["min_strict_unique_words"], glp.MIN_WORDS)
        self.assertGreaterEqual(summary["median_strict_unique_words"], summary["min_strict_unique_words"])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            glp.generate(["ZZ"], out_dir=self.tmp / "o2", sitemap_path=self.sitemap,
                         counties_path=self.fx_counties, profiles_dir=self.fx_profiles)
        self.assertRegex(buf.getvalue(), r"Strict-unique words per page \(floor 500;[^)]*\): min \d+, median \d+")

    def test_no_contractor_or_supabase_dependency_remains(self):
        for dead in ("MIN_CONTRACTORS", "inject_noindex", "NOINDEX_TAG", "supabase_get",
                     "fetch_approved_contractors", "compute_tuples", "coverage_stats_html",
                     "profile_links_html", "load_service_key", "REQUIRED_PATTERN"):
            self.assertFalse(hasattr(glp, dead), dead)


class LintTests(unittest.TestCase):
    GOOD = ("<main><p>We create a scope of work and send it to local contractors. "
            "Compare the bids.</p></main>")

    def lint(self, extra=""):
        glp.compliance_lint(self.GOOD.replace("</main>", f"<p>{extra}</p></main>"), "t/t")

    def test_baseline_passes(self):
        self.lint()

    # (e) required rejections
    def test_lint_rejects_our_contractors(self):
        with self.assertRaises(glp.ComplianceError):
            self.lint("Our contractors will reach out.")

    def test_lint_rejects_vetted(self):
        with self.assertRaises(glp.ComplianceError):
            self.lint("Every bidder is Vetted.")

    def test_lint_rejects_connects_you_with_contractors_who_serve(self):
        with self.assertRaises(glp.ComplianceError):
            self.lint("Otter Quotes connects you with contractors who serve Ohio County.")

    def test_lint_rejects_connects_homeowners_with_contractors(self):
        for bad in ("Otter Quotes connects homeowners with contractors.",
                    "Otter Quotes connects you with contractors."):
            with self.subTest(bad=bad):
                with self.assertRaises(glp.ComplianceError):
                    self.lint(bad)

    def test_lint_scans_jsonld_including_escaped_text(self):
        # The banned phrase hides in a JSON-LD string, with a \u escape so a
        # raw-HTML substring match alone would miss it.
        ld = '{"description": "Our\\u0020contractors will call", "@type": "Service"}'
        page = self.GOOD.replace("<main>", '<script type="application/ld+json">%s</script><main>' % ld)
        with self.assertRaises(glp.ComplianceError):
            glp.compliance_lint(page, "t/t")

    def test_generated_jsonld_and_disclosure_use_approved_framing(self):
        prof = glp.load_profile("IN")
        page = glp.build_page("Ohio", "roofing", "2026-01-01", "IN", profile=prof)
        self.assertNotIn("Contractor Bids", page)
        ld = glp._jsonld_strings(page)
        self.assertIn("send it to local contractors", ld)
        self.assertIn("Comparing Roofing Bids in Ohio County, Indiana", ld)

    # the rest of the have-contractors list
    def test_lint_rejects_other_have_contractors_phrasing(self):
        for bad in (
            "Our network of roofers is large.",
            "Contractors serving Marion County are ready.",
            "Find contractors in Marion County today.",
            "These are local contractors we work with.",
            "Contractors near you are waiting.",
            "Approved contractors only.",
            "Contractors available this week.",
            "Contractors on the platform will bid.",
            "We have roofing contractors in your area.",
            "Platform coverage in Ohio County",
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(glp.ComplianceError):
                    self.lint(bad)

    # robustness: each of these used to pass and must fail ---------------------
    def lint_frag(self, fragment):
        glp.compliance_lint(self.GOOD.replace("</main>", fragment + "</main>"), "t/t")

    def test_lint_rejects_markup_and_entity_bypasses(self):
        for bad in (
            "<p>Our <em>local</em> contractors</p>",
            "<p>Our&nbsp;contractors</p>",
            "<p>&#79;ur contractors</p>",
            "<p>Our roofers cover Marion County</p>",
            "<p>We have roofers in Marion County</p>",
            "<p>Local pros in Marion County</p>",
            "<p>A network of Marion County contractors</p>",
            "<p>Otter Quotes partners with roofers across the state</p>",
            "<p>Contractors ready to bid in Marion County</p>",
            "<p>Our\u200b contractors</p>",
            "<p>O<b>ur</b> <i>contractors</i></p>",
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(glp.ComplianceError):
                    self.lint_frag(bad)

    def test_lint_rejects_banned_text_in_attributes(self):
        for bad in ('<img src="/x.png" alt="Our contractors">',
                    '<a href="/x" title="Vetted pros">link</a>',
                    '<meta name="description" content="Contractors serving Marion County">',
                    '<div aria-label="Our network of roofers"></div>'):
            with self.subTest(bad=bad):
                with self.assertRaises(glp.ComplianceError):
                    self.lint_frag(bad)

    def test_lint_parses_jsonld_tolerantly(self):
        for tag in ("<script data-x=\"1\" TYPE='application/ld+json' >",
                    '<script  type = "application/ld+json"  id="a">',
                    '<script id="a" class="b" type="application/LD+JSON">'):
            with self.subTest(tag=tag):
                page = self.GOOD.replace(
                    "<main>", tag + '{"description": "Our contractors will call"}</script><main>')
                with self.assertRaises(glp.ComplianceError):
                    glp.compliance_lint(page, "t/t")
        bad_json = self.GOOD.replace("<main>", '<script type="application/ld+json">{not json</script><main>')
        with self.assertRaises(glp.ComplianceError):
            glp.compliance_lint(bad_json, "t/t")

    def test_lint_rejects_d104_promises_and_d326_phrasing(self):
        for bad in (
            "&#118;etted pros", "Vet&shy;ted pros", "All bidders are screened.", "Licensed and insured crews.",
            "Save up to 20% on your roof.", "Get 15% off.", "It is free for homeowners.",
            "A bid in 24 hours.", "Bids within 3 days.", "Bids within a few days.", "We guarantee savings.",
            "Your insurer must pay for this.", "Insurance will pay for the roof.", "Storm damage is covered.",
            "Hail dents are claimable.", "This belongs in the claim.", "A legitimate supplement item.",
            "It is legitimately part of the scope.", "Insurance typically pays for like-kind replacement.",
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(glp.ComplianceError):
                    self.lint_frag("<p>%s</p>" % bad)

    def test_lint_allows_the_disclosure_and_required_copy(self):
        self.lint_frag("<p>Otter Quotes does not independently verify, endorse, or warrant the quality of any "
                       "contractor's work, and does not guarantee the availability of any particular contractor.</p>")
        self.lint_frag("<p>Your insurer decides coverage under your policy; ask your adjuster whether it is included.</p>")
        self.lint_frag("<p>We create a scope of work and send it to local contractors.</p>")
        self.lint_frag("<p>Local contractors set their own prices.</p>")
        self.lint_frag("<p>Ask contractors about permits.</p>")

    # round-4 hardening ---------------------------------------------------------
    def assert_fails(self, fragment):
        with self.assertRaises(glp.ComplianceError, msg=fragment):
            self.lint_frag(fragment)

    def test_lint_rejects_unicode_tricks(self):
        for bad in (
            "<p>\uff2f\uff55\uff52 contractors</p>",               # fullwidth Our
            "<p>\u041eur contractors</p>",                          # Cyrillic O
            "<p>Our c\u043entractors</p>",                          # Cyrillic o
            "<p>Our \u03bfr \u0441ontractors</p>",                  # Greek/Cyrillic mix
            "<p>Our\u2060 contractors</p>",                         # word joiner (Cf)
            "<p>O\u202eur contractors</p>",                         # bidi override (Cf)
            "<p>Our\U000e0041 contractors</p>",                     # tag character (Cf)
            "<p>Our cont\u00adractors</p>",                         # soft hyphen (Cf)
            "<p>V\u0435tted pros</p>",                              # Cyrillic e in "vetted"
        ):
            with self.subTest(bad=bad):
                self.assert_fails(bad)

    def test_lint_reads_css_content_srcdoc_and_hyphen_splits(self):
        for bad in (
            '<style>.a::after{content:"Our contractors"}</style>',
            '<style>.a::after{content:"\\4f ur contractors"}</style>',        # CSS escape for O
            '<style>.a::before{content:"Our " "contractors"}</style>',
            '<iframe srcdoc="&lt;p&gt;Our contractors&lt;/p&gt;"></iframe>',
            "<p>Our con-tractors</p>",
            "<p>con\u2010tractors who serve Marion County</p>",
            "<p>Our\u2011contractors</p>",
        ):
            with self.subTest(bad=bad):
                self.assert_fails(bad)

    def test_lint_rejects_the_round4_bans(self):
        for bad in (
            # D-326
            "Your insurance covers hail damage.", "The policy covered the roof.", "Insurers cover wind losses.",
            "You are entitled to a new roof.", "Maximize your claim.", "Maximise the payout.",
            # promises
            "Lowest price in town.", "You will get three bids.", "Get three written bids.",
            "Bids by tomorrow.", "It is free for you.", "We guarantee savings.", "Guaranteed results.",
            # have-contractors
            "Trusted local team.", "Our local pros.", "Local roofers handle it.", "Trusted pros nearby.",
            "Contractors who already bid through Otter Quotes.", "Hundreds of contractors compete.",
            # round 5
            "We've got contractors lined up.", "We\u2019ve got roofers waiting.", "We have got crews ready.",
            "Otter Quotes has got contractors in your area.", "Contractors lined up for your job.",
            "Roofers line up to bid.",
        ):
            with self.subTest(bad=bad):
                self.assert_fails("<p>%s</p>" % bad)

    def test_lint_rejects_round6_have_contractors_variants(self):
        for bad in (
            "<p>Contractors are lined up.</p>",
            "<p>We've lined up contractors for you.</p>",
            "<p>Otter Quotes' contractors are lined up</p>",
            "<p>Otter Quotes\u2019 contractors are lined up</p>",
            "<p>Otter Quotes's roofers will handle it.</p>",
            "<p>The Otter Quotes contractors in Marion.</p>",
            "<p>Otter Quotes contractors bid on your job.</p>",
            "<p>Contractors from Otter Quotes bid on your job.</p>",
            "<p>Contractors are queued up.</p>",
            "<p>Plenty of contractors are lined up for your project.</p>",
            "<p>Contractors have lined up.</p>",
            "<p>Roofing contractors are waiting.</p>",
            "<p>Otter Quotes has got a crew queued up for you.</p>",
            "<p>We have got a crew.</p>",
            "<p>Local contractors will line up to bid on your job.</p>",
            "<p>Contractors have been standing by.</p>",
            '<img alt="Marion County roofing contractors">',
            "<p>Marion County local roofing contractors</p>",
        ):
            with self.subTest(bad=bad):
                self.assert_fails(bad)

    def test_lint_still_allows_the_approved_lines_and_every_indiana_page(self):
        for ok in (
            "We create a scope of work and send it to local contractors.",
            "Otter Quotes does not independently verify, endorse, or warrant the quality of any contractor's work, "
            "and does not guarantee the availability of any particular contractor.",
            "Ask any contractor for an itemized written estimate, proof of insurance, and local references.",
            "Comparing bids can help; you decide whether to hire any contractor.",
        ):
            with self.subTest(ok=ok):
                self.lint_frag("<p>%s</p>" % ok)
        prof = glp.load_profile("IN")
        for c in glp.load_counties("IN"):
            for tr in glp.ELIGIBLE_TRADES:
                glp.compliance_lint(glp.build_page(c, tr, "x", "IN", profile=prof), f"{c}/{tr}")

    # round 7: sentence-level rules --------------------------------------------------
    def test_sentence_rules_reject_readiness_affiliation_and_matching(self):
        for bad in (
            # blocker 1 / 2: punctuation, inserted words, singular nouns, other verbs
            "Queued up: local contractors.", "Contractors are already lined up.", "Contractors are now ready",
            "Contractors are all ready", "Contractors here are ready", "Contractors are just waiting.",
            "Contractors in your area are ready", "Your roofer is ready.", "Your contractor is ready",
            "A crew is ready", "A local pro is ready", "A roofer is waiting for you.",
            "Contractors stand ready.", "Contractors on standby.", "Contractors (ready to bid)",
            "Contractors: ready.", "Contractors \u2192 ready", "Contractors -> ready", "Contractors; ready",
            # blocker 3: ownership / affiliation / matching
            "the contractors we work with", "Contractors on our platform", "Otter Quotes' network",
            "Otter Quotes\u2019s network", "contractors affiliated with Otter Quotes",
            "A contractor is assigned to your job.", "We'll match you with a roofer.",
            "We match homeowners with contractors", "Get matched with local contractors",
            "Many local contractors use Otter Quotes", "Dozens of contractors", "Hundreds of roofers",
            "Thousands of crews", "Contractors who are members", "Our partners bid on every job",
            "Roofers dispatched to your address", "Installers on hand", "A builder is booked for you",
            "Tradespeople are available", "Siding pros at the ready",
        ):
            with self.subTest(bad=bad):
                self.assert_fails("<p>%s</p>" % bad)
        for bad_attr in ('<img alt="Contractors are ready">', '<a title="Contractors on our platform">x</a>',
                         '<meta name="description" content="We match you with a roofer">'):
            with self.subTest(bad_attr=bad_attr):
                self.assert_fails(bad_attr)

    def test_sentence_rules_allow_neutral_contractor_sentences_and_only_exact_approved_ones(self):
        for ok in ("Local contractors set their own prices.", "Ask contractors about permits.",
                   "Ask any contractor for an itemized written estimate, proof of insurance, and local references.",
                   "We create a scope of work and send it to local contractors.",
                   "We create a scope of work and send it to local contractors"):
            with self.subTest(ok=ok):
                self.lint_frag("<p>%s</p>" % ok)
        # not allow-listed by pattern: any change to the approved sentence is judged on its own words
        for bad in ("Otter Quotes creates a scope of work and we send it to local contractors who are ready.",
                    "Otter Quotes creates a scope of work and we send it to local contractors in Marion County.",
                    "We send it to local contractors.",
                    "Otter Quotes creates a scope of work for your roofing project and we send it to local contractors."):
            with self.subTest(bad=bad):
                self.assert_fails("<p>%s</p>" % bad)
        self.assertEqual(len(glp.APPROVED_SENTENCES), 3)

    def test_only_blocks_holding_an_approved_sentence_need_the_allow_list(self):
        prof = glp.load_profile("IN")
        saved = glp.APPROVED_SENTENCES
        try:
            glp.APPROVED_SENTENCES = frozenset()
            tripping = set()
            for county in ("Allen", "Ohio", "Marion", "St. Joseph"):
                for trade in glp.ELIGIBLE_TRADES:
                    page = glp.build_page(county, trade, "x", "IN", profile=prof)
                    for _rule, block in glp.sentence_findings(
                            glp._drop_abbreviation_dots(glp.lintable_text(page))):
                        tripping.add(block)
        finally:
            glp.APPROVED_SENTENCES = saved
        self.assertTrue(tripping)
        for block in tripping:     # every such block contains one of the three approved sentences
            self.assertTrue(any(a in block for a in saved), block)
        # and with the real allow-list nothing trips anywhere
        for county in glp.load_counties("IN")[:10]:
            for trade in glp.ELIGIBLE_TRADES:
                self.assertEqual(glp.sentence_findings(glp._drop_abbreviation_dots(
                    glp.lintable_text(glp.build_page(county, trade, "x", "IN", profile=prof)))), [])

    # D-registry / disclosure text: byte-identical to origin/main ---------------------
    MAIN_DISCLOSURE = (
        '    <p class="disclosure">\n'
        '      Otter Quotes is an independent, informational platform that connects homeowners with contractors for property damage repair and exterior improvement projects.\n'
        "      Otter Quotes does not independently verify, endorse, or warrant the quality of any contractor's work, and does not guarantee the availability of any particular contractor.\n"
        '      Insurance coverage decisions are made solely by your insurer under the terms of your policy.\n'
        '      Page generated 2026-01-01.\n'
        '    </p>'
    )

    def test_disclosure_is_byte_identical_to_origin_main(self):
        prof = glp.load_profile("IN")
        for trade in glp.ELIGIBLE_TRADES:
            page = glp.build_page("Ohio", trade, "2026-01-01", "IN", profile=prof)
            self.assertIn(self.MAIN_DISCLOSURE, page)
            start = page.index('    <p class="disclosure"')
            end = page.index("</p>", start) + 4
            self.assertEqual(page[start:end], self.MAIN_DISCLOSURE)

    def test_connects_homeowners_phrase_is_allowed_only_as_the_exact_disclosure_sentence(self):
        for bad in ("Otter Quotes connects homeowners with contractors.",
                    "Otter Quotes is an independent, informational platform that connects homeowners with "
                    "contractors for property damage repair and exterior improvement projects in Marion County.",
                    "Otter Quotes is an independent, informational platform that connects homeowners with "
                    "contractors for property damage repair and exterior improvement projects. Contractors are ready."):
            with self.subTest(bad=bad):
                self.assert_fails("<p>%s</p>" % bad)
        self.lint_frag("<p>Otter Quotes is an independent, informational platform that connects homeowners with "
                       "contractors for property damage repair and exterior improvement projects.</p>")

    REMOVED_LINK_TARGETS = (
        "/guides/how-to-negotiate-with-insurer.html",
        "/blog/does-homeowners-insurance-cover-roof-damage.html",
        "/blog/what-is-recoverable-depreciation-roofing.html",
    )

    def test_no_generated_page_links_to_a_ruled_out_guide(self):
        prof = glp.load_profile("IN")
        for target in self.REMOVED_LINK_TARGETS:
            self.assertNotIn(target, [h for h, _ in glp.CORNERSTONE_GUIDES])
            for links in glp.TRADE_EXTRA_LINKS.values():
                self.assertNotIn(target, [h for h, _ in links])
        for trade in glp.ELIGIBLE_TRADES:
            page = glp.build_page("Ohio", trade, "2026-01-01", "IN", profile=prof)
            for target in self.REMOVED_LINK_TARGETS:
                self.assertNotIn(target, page)

    def test_every_guide_anchor_equals_its_target_h1(self):
        import html as _html
        prof = glp.load_profile("IN")
        seen = set()
        for trade in glp.ELIGIBLE_TRADES:
            page = glp.build_page("Ohio", trade, "2026-01-01", "IN", profile=prof)
            anchors = re.findall(r'<a href="(/(?:guides|blog)/[^"]+)">(.*?)</a>', page)
            self.assertGreaterEqual(len(anchors), 3)
            for href, label in anchors:
                target = REPO_ROOT / href.lstrip("/")
                self.assertTrue(target.is_file(), "link target missing from repo: " + href)
                h1s = re.findall(r"<h1\b[^>]*>(.*?)</h1>", target.read_text(encoding="utf-8"), re.S)
                self.assertEqual(len(h1s), 1, href)
                h1 = _html.unescape(re.sub(r"<[^>]+>", "", h1s[0]))
                self.assertEqual(_html.unescape(label), h1, href)
                seen.add(href)
        self.assertTrue(seen)

    # round 8 ---------------------------------------------------------------------------
    def test_round8_block_rules_reject_every_refuter_string(self):
        for bad in (
            # abbreviations must not split a sentence
            "Roofers in St. Joseph County are ready to bid on your job.",
            "Contractors near Ft. Wayne are waiting for your scope.",
            "Many roofers, e.g. the ones we work with, bid on scopes here.",
            "Roofers in Mt. Vernon, Co. Marion, i.e. nearby, are ready.",
            # pronoun carry-over and fragments
            "Your scope goes out to local contractors. They are ready to bid today.",
            "Roofers. Ready. Now.", "Contractors... ready.",
            "They'll call you within the hour.",
            # nouns beyond contractor/roofer
            "Local experts are ready to bid.", "Roofing specialists in your area are standing by.",
            "Roofing companies in your area are ready to bid.", "Local firms are ready to bid on your scope.",
            "Experienced technicians are available today.", "Seasoned roofing outfits are eager to bid on your home.",
            "Experts we trust review your scope.", "Specialists from our list bid on your scope.",
            "Contractors who've joined bid on your scope.", "Our businesses are ready.", "Handymen are on call.",
            "Laborers are lined up.",
            # quality, speed, outcome
            "Top-rated contractors bid on your project.", "Certified contractors bid on your project.",
            "Trusted contractors bid on your project.", "Reputable roofers bid on your project.",
            "Qualified installers bid on your project.", "Hand-picked pros bid on your project.",
            "A local roofer will call you within the hour.", "Get same-day bids from local contractors.",
            "Contractors will reach out to you right away.", "Roofers will be in touch shortly.",
            "Contractors respond immediately.", "Several contractors will bid on your project.",
            "Multiple roofers will bid.", "Contractors compete for your job.", "Local contractors want your job.",
            "Contractors who are screened bid.", "Approved roofers bid.",
            # combining marks
            "R\u00e9ady contractors", "Contractors are re\u0301ady",
        ):
            with self.subTest(bad=bad):
                self.assert_fails("<p>%s</p>" % bad)

    def test_round8_block_rules_see_through_the_approved_sentence(self):
        a1 = "We create a scope of work and send it to local contractors."
        for bad in (a1 + " Ready today.", a1 + " Bids within the hour.", a1 + " Several will bid.",
                    "Ready today. " + a1):
            with self.subTest(bad=bad):
                self.assert_fails("<p>%s</p>" % bad)
        # the approved sentence in its own block, next to ordinary text in other blocks, is fine
        self.lint_frag("<p>%s</p><p>You compare any written bids you receive.</p>" % a1)
        # pronoun in a block after a noun block counts; after a noun-free block it does not
        self.assert_fails("<p>Local contractors set their own prices.</p><p>They are ready.</p>")
        self.lint_frag("<p>Adjusters visit after storms.</p><p>They set their own schedules.</p>")

    def test_lint_allows_negated_guarantee_and_approved_procedural_wording(self):
        for ok in (
            "Otter Quotes does not independently verify, endorse, or warrant the quality of any contractor's work, "
            "and does not guarantee the availability of any particular contractor.",
            "Otter Quotes doesn\u2019t guarantee a bid.", "Otter Quotes doesn't guarantee a bid.",
            "We cannot guarantee a result.", "We can't guarantee a result.", "We do not guarantee a result.",
            "Your insurer decides coverage under your policy; ask your adjuster whether it is included.",
            "Insurance coverage decisions are made solely by your insurer under the terms of your policy.",
            '<a href="/blog/x.html">%s</a>' % glp.TRADE_EXTRA_LINKS["roofing"][0][1],
        ):
            with self.subTest(ok=ok):
                self.lint_frag("<p>%s</p>" % ok if not ok.startswith("<a") else ok)

    def test_lint_rejects_vendor_names_and_other_bans(self):
        for bad in ("Powered by Hover.", "Sign with DocuSign.", "Pay with Stripe.", "Via Mailgun.",
                    "Texts by Twilio.", "OtterQuote helps.", "We offer a fast response.",
                    "Respond within the hour."):
            with self.subTest(bad=bad):
                with self.assertRaises(glp.ComplianceError):
                    self.lint(bad)

    def test_lint_requires_the_phrase(self):
        with self.assertRaises(glp.ComplianceError):
            glp.compliance_lint("<main><p>Otter Quotes helps homeowners.</p></main>", "t/t")

    def test_lint_does_not_false_positive_on_the_required_copy(self):
        self.lint("A contractor's estimate. Local contractors set their own prices. css a:hover { color: red }")


if __name__ == "__main__":
    unittest.main(verbosity=2)
