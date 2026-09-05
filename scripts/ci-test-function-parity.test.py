#!/usr/bin/env python3
"""
Unit tests for scripts/ci-test-function-parity.py (gh-1584).

Loaded via importlib.util (not a plain `import`) because the module's
filename contains hyphens, following the pattern already used by
scripts/edge-function-drift-check.test.py and
scripts/drift-detector-age.test.py for the same reason.

No network access and no credentials required: the Management API fetch is
exercised only through a stubbed `fetcher` callable, never through a real
urlopen.

Run: python scripts/ci-test-function-parity.test.py
"""

import importlib.util
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("parity", HERE / "ci-test-function-parity.py")
parity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parity)


class ExtractFunctionsFromTextTests(unittest.TestCase):
    """Regex extraction on fixture strings -- no filesystem, no network."""

    def test_url_path_form(self):
        text = "const url = `${SUPABASE_URL}/functions/v1/validate-contract-template`;"
        self.assertEqual(parity.extract_functions_from_text(text), {"validate-contract-template"})

    def test_invoke_single_quote_form(self):
        text = "await supabase.functions.invoke('mint-test-session', { body });"
        self.assertEqual(parity.extract_functions_from_text(text), {"mint-test-session"})

    def test_invoke_double_quote_form(self):
        text = 'await supabase.functions.invoke("send-adjuster-email", { body });'
        self.assertEqual(parity.extract_functions_from_text(text), {"send-adjuster-email"})

    def test_multiple_references_in_one_file(self):
        text = """
        const a = `${SUPABASE_URL}/functions/v1/validate-contract-template`;
        const b = supabase.functions.invoke('notify-contractors');
        const c = `${SUPABASE_URL}/functions/v1/create-docusign-envelope`;
        """
        self.assertEqual(
            parity.extract_functions_from_text(text),
            {"validate-contract-template", "notify-contractors", "create-docusign-envelope"},
        )

    def test_duplicate_references_deduplicated(self):
        text = (
            "`${SUPABASE_URL}/functions/v1/validate-contract-template`; "
            "`${SUPABASE_URL}/functions/v1/validate-contract-template`;"
        )
        self.assertEqual(parity.extract_functions_from_text(text), {"validate-contract-template"})

    def test_no_references_returns_empty_set(self):
        text = "const x = 1; // nothing to see here"
        self.assertEqual(parity.extract_functions_from_text(text), set())

    def test_unrelated_functions_path_not_matched(self):
        # A comment referencing the source tree, not a call -- must not match
        # a bare "/functions/" with no "/v1/<name>" shape.
        text = "// see supabase/functions/notify-contractors/index.ts"
        self.assertEqual(parity.extract_functions_from_text(text), set())


class CollectReferencedFunctionsTests(unittest.TestCase):
    """collect_referenced_functions walks real files -- exercised against a temp tree."""

    def test_scans_mjs_ts_js_and_skips_node_modules(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "seed").mkdir()
            (root / "flows").mkdir()
            (root / "node_modules" / "somelib").mkdir(parents=True)

            (root / "seed" / "seed.mjs").write_text(
                "`${SUPABASE_URL}/functions/v1/validate-contract-template`;", encoding="utf-8"
            )
            (root / "flows" / "bid.spec.ts").write_text(
                "supabase.functions.invoke('mint-test-session');", encoding="utf-8"
            )
            (root / "flows" / "helper.js").write_text(
                "supabase.functions.invoke(\"notify-contractors\");", encoding="utf-8"
            )
            # Should be ignored: wrong extension and node_modules.
            (root / "seed" / "fixture.json").write_text(
                "{\"url\": \"/functions/v1/should-not-be-found\"}", encoding="utf-8"
            )
            (root / "node_modules" / "somelib" / "index.mjs").write_text(
                "`${SUPABASE_URL}/functions/v1/vendored-function`;", encoding="utf-8"
            )

            found = parity.collect_referenced_functions(root)
            self.assertEqual(
                found, {"validate-contract-template", "mint-test-session", "notify-contractors"}
            )

    def test_missing_e2e_root_returns_empty_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = pathlib.Path(tmp) / "does-not-exist"
            self.assertEqual(parity.collect_referenced_functions(missing), set())


class RunExitPathTests(unittest.TestCase):
    """The three exit paths (0 / 2 / 3), driven through `run()` with a stubbed fetcher."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        (self.root / "seed").mkdir()
        (self.root / "seed" / "seed.mjs").write_text(
            "`${SUPABASE_URL}/functions/v1/validate-contract-template`;\n"
            "supabase.functions.invoke('mint-test-session');",
            encoding="utf-8",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_exit_0_when_all_referenced_functions_deployed(self):
        def stub_fetcher(project_ref, token):
            return ["validate-contract-template", "mint-test-session", "some-other-function"]

        code = parity.run(self.root, "zsdvaqilfdclwosmiheh", "sbp_fake_token", fetcher=stub_fetcher)
        self.assertEqual(code, 0)

    def test_exit_2_when_a_referenced_function_is_missing(self):
        def stub_fetcher(project_ref, token):
            return ["validate-contract-template"]  # mint-test-session absent

        code = parity.run(self.root, "zsdvaqilfdclwosmiheh", "sbp_fake_token", fetcher=stub_fetcher)
        self.assertEqual(code, 2)

    def test_exit_3_when_token_is_missing(self):
        def stub_fetcher(project_ref, token):
            self.fail("fetcher must not be called when the token is missing")

        code = parity.run(self.root, "zsdvaqilfdclwosmiheh", "", fetcher=stub_fetcher)
        self.assertEqual(code, 3)

    def test_exit_3_when_management_api_unreachable(self):
        def stub_fetcher(project_ref, token):
            raise parity.FetchError("Management API unreachable: [Errno -2] Name or service not known")

        code = parity.run(self.root, "zsdvaqilfdclwosmiheh", "sbp_fake_token", fetcher=stub_fetcher)
        self.assertEqual(code, 3)

    def test_exit_3_when_management_api_returns_error_status(self):
        def stub_fetcher(project_ref, token):
            raise parity.FetchError("Management API returned HTTP 401", status=401)

        code = parity.run(self.root, "zsdvaqilfdclwosmiheh", "sbp_bad_token", fetcher=stub_fetcher)
        self.assertEqual(code, 3)

    def test_exit_0_with_no_references_and_no_deployed_functions(self):
        with tempfile.TemporaryDirectory() as empty_tmp:
            def stub_fetcher(project_ref, token):
                return []

            code = parity.run(pathlib.Path(empty_tmp), "zsdvaqilfdclwosmiheh", "sbp_fake_token", fetcher=stub_fetcher)
            self.assertEqual(code, 0)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
