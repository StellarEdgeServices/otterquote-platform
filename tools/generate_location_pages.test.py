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

    def tearDown(self):
        self._tmp.cleanup()

    def run_gen(self, states, **kw):
        return quiet(glp.generate, states, out_dir=self.out, sitemap_path=self.sitemap, **kw)

    # (a) positive -----------------------------------------------------------
    def test_zero_contractor_county_emits_indexable_compliant_page(self):
        # No contractor data is read or passed anywhere: every county is a
        # "zero contractors" county. Marion is the largest; use a small one too.
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
        def thin_for_ohio(county, trade, generated_on, state):
            real = glp.build_page(county, trade, generated_on, state)
            if county != "Ohio":
                return real
            return (
                "<!DOCTYPE html><html><head><title>t</title></head><body><main>"
                "<p>Otter Quotes creates a scope of work and we send it to local contractors.</p>"
                "</main></body></html>"
            )

        summary = self.run_gen(["IN"], build_fn=thin_for_ohio)
        self.assertEqual(sorted(summary["skipped_thin"]),
                         sorted(f"ohio-county-in/{t}" for t in glp.ELIGIBLE_TRADES))
        self.assertFalse((self.out / "ohio-county-in").exists())
        self.assertNotIn("ohio-county-in", self.sitemap.read_text(encoding="utf-8"))
        self.assertTrue((self.out / "marion-county-in" / "roofing" / "index.html").exists())

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
        summary = self.run_gen([])  # IN exists in the data but is not listed
        self.assertEqual(summary["written"], 0)
        self.assertFalse(self.out.exists())
        self.assertEqual(self.sitemap.read_text(encoding="utf-8"), SITEMAP_SEED)

    def test_allowlist_file_driving_generation(self):
        f = self.tmp / "allow.json"
        f.write_text(json.dumps({"states": ["IN"]}), encoding="utf-8")
        self.assertEqual(glp.load_allowlist(f), ["IN"])
        f.write_text(json.dumps({"states": []}), encoding="utf-8")
        self.assertEqual(glp.load_allowlist(f), [])

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
        self.assertEqual(sorted(glp.load_counties("IN")), sorted(glp.INDIANA_COUNTIES))
        self.assertEqual(len(glp.INDIANA_COUNTIES), 92)

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
