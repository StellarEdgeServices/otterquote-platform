#!/usr/bin/env python3
"""
Self-test for tools/generate_location_pages.py (D-345, gh-2422).

closes-on mapping (issue #2422):
  (a) test_zero_contractor_county_emits_indexable_compliant_page
        allow-listed test state, county with zero contractors -> indexable page,
        >= 500 unique words, contains "send it to local contractors", lint-clean.
  (b) test_thin_county_emits_no_page
        a county under 500 unique words emits no page and no sitemap entry.
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
FIXTURE_COUNTIES = {"states": [{"code": "ZZ", "name": "Zedland", "counties": ["Alpha", "Beta", "Gamma"]}]}
FIXTURE_PROFILE = {
    "code": "ZZ",
    "name": "Zedland",
    "regions": {
        "north": {"label": "northern Zedland", "counties": ["Alpha", "Beta"], "climate": [FIXTURE_CLIMATE % "northern"]},
        "south": {"label": "southern Zedland", "counties": ["Gamma"], "climate": [FIXTURE_CLIMATE % "southern"]},
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
            self.assertGreaterEqual(glp.unique_word_count(page), glp.MIN_WORDS)
            self.assertIn("send it to local contractors", page)
            glp.compliance_lint(page, f"{slug}/{trade}")  # must not raise
            self.assertIn('<link rel="canonical"', page)
            self.assertEqual(page.count('application/ld+json'), 3)  # JSON-LD kept
        sm = self.sitemap.read_text(encoding="utf-8")
        self.assertEqual(sm.count("/locations/"), 3 * 4)
        self.assertIn("https://otterquote.com/locations/alpha-county-zz/roofing/", sm)
        self.assertNotIn("connects homeowners with contractors", page)

    def test_indiana_profile_generates_every_page(self):
        summary = self.run_gen(["IN"])
        self.assertEqual(summary["written"], 92 * 4)
        self.assertEqual(summary["skipped_thin"], [])
        for county, trade in (("Ohio", "roofing"), ("Marion", "windows")):
            slug = glp.county_slug(county, "IN")
            page = (self.out / slug / trade / "index.html").read_text(encoding="utf-8")
            self.assertNotRegex(page, r'(?i)<meta[^>]+name="robots"')
            self.assertNotIn("noindex", page.lower())
            self.assertGreaterEqual(glp.unique_word_count(page), glp.MIN_WORDS)
            self.assertIn("send it to local contractors", page)
            glp.compliance_lint(page, f"{slug}/{trade}")  # must not raise
            self.assertIn('<link rel="canonical"', page)
            self.assertEqual(page.count('application/ld+json'), 3)  # JSON-LD kept
        sm = self.sitemap.read_text(encoding="utf-8")
        self.assertEqual(sm.count("/locations/"), 92 * 4)
        self.assertIn("https://otterquote.com/locations/ohio-county-in/roofing/", sm)

    def test_every_generated_page_clears_floor_and_lint(self):
        # The full IN x 4 set is generated above under the same checks
        # (generate() lints every page and raises on failure); here assert the
        # minimum unique-word count across all pages for the record.
        lo = min(
            glp.unique_word_count(glp.build_page(c, t, "2026-01-01", "IN"))
            for c in glp.load_counties("IN") for t in glp.ELIGIBLE_TRADES
        )
        self.assertGreaterEqual(lo, glp.MIN_WORDS)

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

    def test_boilerplate_does_not_count_toward_floor(self):
        # A page padded only with boilerplate (breadcrumb/cta/disclosure/guides
        # blocks, or content outside <main>) must stay under the floor.
        pad = " ".join(["word"] * 2000)
        page = (
            "<html><body><nav>%s</nav><main><div data-boilerplate><p>%s</p></div>"
            "<p>send it to local contractors</p></main><footer>%s</footer></body></html>"
            % (pad, pad, pad)
        )
        self.assertLess(glp.unique_word_count(page), 10)

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

    def test_missing_profile_is_an_explicit_error(self):
        (self.fx_profiles / "ZZ.json").unlink()
        with self.assertRaises(glp.StateConfigError) as cm:
            self.run_fx()
        self.assertIn("no state profile", str(cm.exception))

    def test_run_reports_min_and_median_unique_words(self):
        summary = self.run_fx()
        self.assertGreaterEqual(summary["min_unique_words"], glp.MIN_WORDS)
        self.assertGreaterEqual(summary["median_unique_words"], summary["min_unique_words"])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            glp.generate(["ZZ"], out_dir=self.tmp / "o2", sitemap_path=self.sitemap,
                         counties_path=self.fx_counties, profiles_dir=self.fx_profiles)
        self.assertRegex(buf.getvalue(), r"Unique words per page \(floor 500\): min \d+, median \d+")

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
