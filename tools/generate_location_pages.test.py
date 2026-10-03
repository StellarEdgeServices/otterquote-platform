#!/usr/bin/env python3
"""
Self-test for tools/generate_location_pages.py (D-345, gh-2422).

closes-on mapping (issue #2422):
  (a) test_zero_contractor_county_emits_indexable_compliant_page
        allow-listed test state, county with zero contractors -> indexable page,
        >= 500 STRICT-unique words (words on no 8-word shingle shared with another
        page in the run; CEO ruling on #2304), contains "send it to local
        contractors", lint-clean.
  (b) test_thin_county_emits_no_page, test_identical_county_content_fails_both,
      test_indiana_profile_emits_nothing_under_strict_gate
        a county under 500 strict-unique words emits no page and no sitemap entry.
  (c) test_state_not_on_allowlist_emits_no_page
  (d) test_committed_allowlist_is_empty  (+ test_empty_allowlist_emits_nothing)
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


def fixture_content(county, trade, n=520):
    """n genuinely distinct words per (county, trade): no 8-word run repeats
    on any other page, so all n are strict-unique."""
    words = [f"{county.lower()}{trade}{chr(97 + i % 26)}{i}" for i in range(n)]
    return "".join("<p>%s</p>" % " ".join(words[i:i + 52]) for i in range(0, n, 52))


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
            glp.compliance_lint(page, f"{slug}/{trade}")  # must not raise
            self.assertIn('<link rel="canonical"', page)
            self.assertEqual(page.count('application/ld+json'), 3)  # JSON-LD kept
        self.assertGreaterEqual(summary["min_strict_unique_words"], glp.MIN_WORDS)
        sm = self.sitemap.read_text(encoding="utf-8")
        self.assertEqual(sm.count("/locations/"), 3 * 4)
        self.assertIn("https://otterquote.com/locations/alpha-county-zz/roofing/", sm)
        self.assertNotIn("connects homeowners with contractors", page)

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
        self.assertEqual(glp.strict_unique_counts([["x", "y", "z"], ["x", "y", "z"]]), [3, 3])  # < 8 words: no shingles

    # (b) negative: under the unique-word floor ------------------------------
    def test_thin_county_emits_no_page(self):
        profile = glp.load_profile("ZZ", self.fx_profiles)

        def thin_for_ohio(county, trade, generated_on, state):
            real = glp.build_page(county, trade, generated_on, state, profile=profile)
            if county != "Alpha":
                return real
            return (
                "<!DOCTYPE html><html><head><title>t</title></head><body><main>"
                "<p>Otter Quotes creates a scope of work and we send it to local contractors.</p>"
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
        self.assertIn("Window Bids for Ohio County, Indiana Homeowners", page)
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

    # (d) committed allow-list is empty --------------------------------------
    def test_committed_allowlist_is_empty(self):
        data = json.loads((REPO_ROOT / "data" / "location-pages-state-allowlist.json").read_text(encoding="utf-8"))
        self.assertEqual(data["states"], [])
        self.assertEqual(glp.load_allowlist(), [])

    def test_empty_allowlist_emits_nothing(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            summary = glp.generate(glp.load_allowlist(), out_dir=self.out, sitemap_path=self.sitemap)
        self.assertEqual(summary["written"], 0)
        self.assertIn("allow-list is empty", buf.getvalue())
        self.assertFalse(self.out.exists())

    # state support is explicit, never silent --------------------------------
    def test_allowlisted_state_without_profile_is_an_explicit_error(self):
        with self.assertRaises(glp.StateConfigError) as cm:
            self.run_gen(["OH"])  # has county data, no climate profile
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

    def test_committed_profiles_are_only_indiana(self):
        names = sorted(p.name for p in (REPO_ROOT / "data" / "location-state-profiles").glob("*.json"))
        self.assertEqual(names, ["IN.json"])

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
            para_html = "<p>%s</p>" % " ".join("alphaword%d" % i for i in range(40))
            prof["county_content"]["Alpha"] = {t: para_html * 14 for t in glp.ELIGIBLE_TRADES}
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
    GOOD = ("<main><p>Otter Quotes creates a scope of work and we send it to local contractors. "
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
        self.assertNotIn("connects homeowners with contractors", page)
        self.assertNotIn("Contractor Bids", page)
        ld = glp._jsonld_strings(page)
        self.assertIn("send it to local contractors", ld)
        self.assertIn("Roofing Bids — Ohio County, IN", ld)

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
        self.lint_frag("<p>Otter Quotes does not guarantee the availability of any particular contractor.</p>")
        self.lint_frag("<p>Your insurer decides coverage under your policy; ask your adjuster whether it is included.</p>")
        self.lint_frag("<p>We create a scope of work and send it to local contractors, so you can compare any bids you receive.</p>")

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
            "Otter Quotes creates a scope of work and we send it to local contractors.",
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

    def test_lint_allows_negated_guarantee_and_approved_procedural_wording(self):
        for ok in (
            "Otter Quotes does not guarantee the availability of any particular contractor.",
            "Otter Quotes doesn\u2019t guarantee a bid.", "Otter Quotes doesn't guarantee a bid.",
            "We cannot guarantee a result.", "We can't guarantee a result.", "We do not guarantee a result.",
            "Your insurer decides coverage under your policy; ask your adjuster whether it is included.",
            "Insurance coverage decisions are made solely by your insurer under the terms of your policy.",
            '<a href="/blog/x.html">Does Homeowners Insurance Cover Storm Damage?</a>',
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
        self.lint("Contractors compete for the job. A contractor's estimate. Local contractors bid. "
                  "css a:hover { color: red }")


if __name__ == "__main__":
    unittest.main(verbosity=2)
