#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/edge-function-drift-remote.py (gh-1700).

This issue's own subject is "a detector that cannot measure presenting as one
that found nothing" (gh-1419) -- so the load-bearing cases here are not just
"does it catch drift", they are the credential/config failure modes that made
otter-crm's gap invisible in the first place. Every case below is fixture- and
fake-driven: no network, no credentials, no real GitHub/Supabase calls.

FIRING + CONTROL, side by side (per the gh-1700 work order):
  - test_project_measured_identical(): a project with no drift reports MEASURED
    / IDENTICAL and stays silent (no alarm) -- the control.
  - test_project_measured_drifted(): the SAME machinery, pointed at a payload
    that DOES drift, reports MEASURED / DRIFTED -- the firing case.
  - test_project_unreadable_reports_unmeasured(): a project whose credential/
    fetch fails reports UNMEASURED, loudly, and is STILL PRESENT in the report
    (never silently dropped) -- proving the exact failure mode this issue is
    about cannot happen here.
  - test_overall_report_shows_passing_and_unreadable_side_by_side(): one run
    with both an IDENTICAL project and an UNMEASURED project in the SAME
    result set, and the aggregate exit code treats UNMEASURED as outranking a
    clean verdict -- the negative control the issue's closing criterion asks
    for ("the same job observed reporting UNMEASURED/failing for a project it
    cannot read... beside the passing run").

Run: python3 scripts/edge-function-drift-remote.test.py
"""

import importlib.util
import pathlib
import shutil
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("drift_remote", HERE / "edge-function-drift-remote.py")
drift_remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drift_remote)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def expect_measured(result, label):
    """Guard rail (gh-1737 review): a happy-path fixture that unexpectedly
    degrades to UNMEASURED (e.g. a future regression re-introduces a real,
    unmocked dependency into check_project()) must fail with a clear, asserted
    message naming the reason -- never crash the test runner with a raw
    `TypeError: 'NoneType' object is not subscriptable` from indexing
    `result["report"]` blind. Returns the report dict on success, or None
    (after recording a FAILURE) so callers can skip the indexing that would
    otherwise crash."""
    if result["status"] != "MEASURED" or result["report"] is None:
        msg = (
            f"expected status=MEASURED with a report, got status={result['status']!r} "
            f"reason={result['reason']!r}"
        )
        print(f"  FAIL  {label}: {msg}")
        FAILURES.append(label)
        return None
    return result["report"]


PROJECT = {
    "name": "otter-crm",
    "github_repo": "StellarEdgeServices/otter-crm",
    "functions_dir": "supabase/functions",
    "project_ref": "lreqwnqvlerdgukpklwb",
    "supabase_token_env": "SUPABASE_CRM_ACCESS_TOKEN",
}

SAMPLE_SOURCE = b"import { serve } from './deps.ts'\nserve(() => new Response('ok'))\n"
DRIFTED_SOURCE = b"import { serve } from './deps.ts'\nserve(() => new Response('DIFFERENT'))\n"


def fake_github_fetch_factory(files: dict):
    """Returns a stand-in for fetch_github_function_tree() that ignores its
    network args and returns a fixed {relpath: bytes} map -- no network."""

    def _fetch(repo, functions_dir, token):
        return dict(files)

    return _fetch


def fake_list_slugs_factory(slugs: list):
    def _list(cli, project_ref):
        return list(slugs)

    return _list


def fake_require_cli():
    """Stand-in for efdc.require_cli() -- returns a fake CLI path without
    touching shutil.which("supabase") or the real filesystem/PATH at all.
    This is what makes the fixture suite hermetic (gh-1737 review): the
    happy-path tests below must pass identically whether or not the Supabase
    CLI is installed on the machine running them."""
    return "/fake/path/to/supabase"


def fake_fetch_all_factory(deployed_files: dict):
    """Returns a stand-in for efdc.fetch_all() that writes `deployed_files`
    ({slug: {relpath: bytes}}) straight to dest_root -- no CLI, no subprocess,
    no Docker, no network."""

    def _fetch_all(cli, project_ref, slugs, dest_root):
        fetched, failed = [], []
        for slug in slugs:
            files = deployed_files.get(slug)
            if files is None:
                failed.append(slug)
                continue
            for rel, data in files.items():
                dest = dest_root / slug / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
            fetched.append(slug)
        return fetched, failed

    return _fetch_all


def run_check(project, github_files, deployed_files, slugs):
    """Drive check_project() end to end with fakes standing in for every
    network call AND the Supabase CLI presence check, and both credential env
    vars present (this exercises the happy-path plumbing; the UNMEASURED tests
    below separately exercise the missing-credential and unreachable-fetch
    paths). `require_cli` is faked here too (gh-1737 review) so this suite
    never touches shutil.which("supabase") -- it must pass identically with
    or without the real CLI on PATH."""
    import os

    fetch = fake_github_fetch_factory(github_files)
    list_slugs = fake_list_slugs_factory(slugs)
    fetch_all = fake_fetch_all_factory(deployed_files)

    os.environ[drift_remote.GITHUB_TOKEN_ENV_VAR] = "fake-gh-token"
    os.environ[project["supabase_token_env"]] = "fake-sbp-token"
    try:
        return drift_remote.check_project(
            project,
            github_fetch=fetch,
            list_slugs=list_slugs,
            fetch_all=fetch_all,
            require_cli=fake_require_cli,
        )
    finally:
        os.environ.pop(drift_remote.GITHUB_TOKEN_ENV_VAR, None)
        os.environ.pop(project["supabase_token_env"], None)


def test_project_measured_identical():
    """CONTROL: no drift -> MEASURED / IDENTICAL, stays silent."""
    github_files = {"stripe-webhook/index.ts": SAMPLE_SOURCE}
    deployed_files = {"stripe-webhook": {"index.ts": SAMPLE_SOURCE}}
    result = run_check(PROJECT, github_files, deployed_files, ["stripe-webhook"])

    check("identical: status", result["status"], "MEASURED")
    report = expect_measured(result, "identical: expected a MEASURED report to index")
    if report is not None:
        check("identical: verdict", report["functions"][0]["verdict"], "IDENTICAL")
    check("identical: overall_exit_code", drift_remote.overall_exit_code([result]), 0)
    md = drift_remote.render_markdown([result])
    check("identical: markdown mentions project", "otter-crm" in md, True)
    check("identical: markdown does not say UNMEASURED", "UNMEASURED" not in md, True)


def test_project_measured_drifted():
    """FIRING: the identical machinery, pointed at a payload that DOES drift,
    must report MEASURED / DRIFTED and a non-zero exit code."""
    github_files = {"stripe-webhook/index.ts": SAMPLE_SOURCE}
    deployed_files = {"stripe-webhook": {"index.ts": DRIFTED_SOURCE}}
    result = run_check(PROJECT, github_files, deployed_files, ["stripe-webhook"])

    check("drifted: status", result["status"], "MEASURED")
    report = expect_measured(result, "drifted: expected a MEASURED report to index")
    if report is not None:
        check("drifted: verdict", report["functions"][0]["verdict"], "DRIFTED")
    check("drifted: overall_exit_code", drift_remote.overall_exit_code([result]), 1)
    md = drift_remote.render_markdown([result])
    check("drifted: markdown flags DRIFTED", "DRIFTED" in md, True)


def test_project_missing_github_token_is_unmeasured():
    """A project with no GH_CROSS_REPO_PAT set is UNMEASURED, loudly, and the
    row is still present -- never silently dropped."""
    import os

    os.environ.pop(drift_remote.GITHUB_TOKEN_ENV_VAR, None)
    os.environ.pop(PROJECT["supabase_token_env"], None)
    result = drift_remote.check_project(PROJECT)

    check("no-github-token: status", result["status"], "UNMEASURED")
    check("no-github-token: reason names the missing var", drift_remote.GITHUB_TOKEN_ENV_VAR in result["reason"], True)
    check("no-github-token: overall_exit_code", drift_remote.overall_exit_code([result]), 2)


def test_project_unreadable_reports_unmeasured():
    """The GitHub fetch itself fails (bad ref / unreadable project, the exact
    shape the issue calls out: 'deliberately point it at a bad ref') ->
    UNMEASURED, and the project is STILL a row in the report, not absent."""
    import os

    def failing_fetch(repo, functions_dir, token):
        raise drift_remote.RemoteFetchError("GitHub API HTTP 404 (Not Found) -- simulated bad ref")

    os.environ[drift_remote.GITHUB_TOKEN_ENV_VAR] = "fake-gh-token"
    os.environ[PROJECT["supabase_token_env"]] = "fake-sbp-token"
    try:
        result = drift_remote.check_project(PROJECT, github_fetch=failing_fetch)
    finally:
        os.environ.pop(drift_remote.GITHUB_TOKEN_ENV_VAR, None)
        os.environ.pop(PROJECT["supabase_token_env"], None)

    check("unreadable: status", result["status"], "UNMEASURED")
    check("unreadable: name still present", result["name"], "otter-crm")
    check("unreadable: reason mentions 404", "404" in result["reason"], True)
    md = drift_remote.render_markdown([result])
    check("unreadable: markdown says UNMEASURED loudly", "UNMEASURED" in md and "FAILURE" in md, True)
    check("unreadable: markdown never reads as clean", "IDENTICAL" not in md, True)


def test_overall_report_shows_passing_and_unreadable_side_by_side():
    """THE NEGATIVE CONTROL the gh-1700 closing criterion asks for: one run,
    one project passing (IDENTICAL) and one project the job cannot read
    (UNMEASURED), BOTH present in the same result set and the same markdown --
    and the aggregate exit code is 2 (UNMEASURED outranks a clean verdict),
    never a clean 0 that would hide the unreadable project behind the passing
    one -- the exact 'green Netlify row hides the gap' shape this issue is
    about, proven not to recur here."""
    passing = {**PROJECT, "name": "otter-crm-readable"}
    unreadable = {**PROJECT, "name": "otter-crm-unreadable", "supabase_token_env": "SUPABASE_UNREADABLE_TOKEN"}

    passing_result = run_check(passing, {"f/index.ts": SAMPLE_SOURCE}, {"f": {"index.ts": SAMPLE_SOURCE}}, ["f"])

    import os

    os.environ.pop("SUPABASE_UNREADABLE_TOKEN", None)  # deliberately never set
    unreadable_result = drift_remote.check_project(unreadable)

    results = [passing_result, unreadable_result]
    check("mixed: both rows present", {r["name"] for r in results}, {"otter-crm-readable", "otter-crm-unreadable"})
    passing_report = expect_measured(passing_result, "mixed: expected passing row's report to index")
    if passing_report is not None:
        check("mixed: passing row is MEASURED/IDENTICAL", passing_report["functions"][0]["verdict"], "IDENTICAL")
    check("mixed: unreadable row is UNMEASURED", unreadable_result["status"], "UNMEASURED")
    check("mixed: aggregate exit code is 2, not 0", drift_remote.overall_exit_code(results), 2)

    md = drift_remote.render_markdown(results)
    check("mixed: markdown names both projects", "otter-crm-readable" in md and "otter-crm-unreadable" in md, True)
    check("mixed: markdown carries the UNMEASURED failure text", "FAILURE" in md, True)


def test_github_fetch_empty_tree_is_unreadable_not_empty_clean():
    """Zero files under functions_dir on main is treated as unmeasurable (same
    convention as list_deployed_slugs()'s 'zero functions is a credential/path
    problem, not a clean empty project'), not as a trivially-passing project.

    gh-1737 review: the prior version of this test injected a fake
    `github_fetch` that raised RemoteFetchError ITSELF, so it only re-proved
    the already-covered "a RemoteFetchError becomes UNMEASURED" path -- it
    never called `fetch_github_function_tree()` at all, so its `if not
    blobs: raise RemoteFetchError(...)` guard could be deleted and this test
    would still pass. This version monkeypatches only the network-calling
    seam, `drift_remote._github_get()`, to return a real-shaped tree payload
    with zero blobs under `functions_dir` -- so `fetch_github_function_tree()`
    itself runs its real prefix-filter and its real `if not blobs:` guard,
    and THAT is what raises. No network, no credentials."""
    import os

    original_github_get = drift_remote._github_get

    def fake_github_get(url, token):
        # A well-formed tree response containing files, but none under
        # PROJECT["functions_dir"] -- exercises the real filter + guard
        # rather than a pre-baked failure.
        return {
            "tree": [
                {"type": "blob", "path": "some-other-dir/unrelated.ts", "sha": "deadbeef"},
                {"type": "tree", "path": PROJECT["functions_dir"], "sha": "cafef00d"},
            ]
        }

    drift_remote._github_get = fake_github_get
    try:
        raised_directly = False
        direct_message = None
        try:
            drift_remote.fetch_github_function_tree(
                PROJECT["github_repo"], PROJECT["functions_dir"], "fake-gh-token"
            )
        except drift_remote.RemoteFetchError as exc:
            raised_directly = True
            direct_message = str(exc)

        check("empty-tree: real fetch_github_function_tree() raises the guard", raised_directly, True)
        if direct_message is not None:
            check("empty-tree: guard message mentions zero files", "zero files" in direct_message, True)

        os.environ[drift_remote.GITHUB_TOKEN_ENV_VAR] = "fake-gh-token"
        os.environ[PROJECT["supabase_token_env"]] = "fake-sbp-token"
        try:
            # Pass the REAL fetch_github_function_tree through check_project()
            # (not a stub) so the full path -- including the guard above --
            # runs through the same seam production code calls.
            result = drift_remote.check_project(
                PROJECT, github_fetch=drift_remote.fetch_github_function_tree
            )
        finally:
            os.environ.pop(drift_remote.GITHUB_TOKEN_ENV_VAR, None)
            os.environ.pop(PROJECT["supabase_token_env"], None)
    finally:
        drift_remote._github_get = original_github_get

    check("empty-tree: status", result["status"], "UNMEASURED")
    check("empty-tree: reason mentions zero files", "zero files" in result["reason"], True)


OOT_PATH = "react-app/app/lib/types.ts"
OOT_INDEX = b"import { T } from '../../../react-app/app/lib/types.ts'\nconsole.log(T)\n"


def run_oot_check(deployed_oot_bytes, main_oot_bytes, fetch_failed_slugs=(), extra_repo=None):
    """check_project() where `fn` was fetched through the Management API fallback: its bundle
    carries `react-app/app/lib/types.ts` from OUTSIDE supabase/functions/ (the
    notify-admin-new-homeowner shape). `main_oot_bytes=None` means main has no such file."""
    import os

    def fetch_all(cli, project_ref, slugs, dest_root):
        fetched, failed = [], []
        for slug in slugs:
            if slug in fetch_failed_slugs:
                failed.append(slug)
                continue
            (dest_root / slug).mkdir(parents=True, exist_ok=True)
            (dest_root / slug / "index.ts").write_bytes(OOT_INDEX)
            if slug == "fn":
                oot = dest_root / "__out_of_tree__" / slug / OOT_PATH
                oot.parent.mkdir(parents=True, exist_ok=True)
                oot.write_bytes(deployed_oot_bytes)
            fetched.append(slug)
        return fetched, failed

    def github_file_fetch(repo, path, token):
        return main_oot_bytes if path == OOT_PATH else None

    github_files = {"fn/index.ts": OOT_INDEX, **(extra_repo or {})}
    os.environ[drift_remote.GITHUB_TOKEN_ENV_VAR] = "fake-gh-token"
    os.environ[PROJECT["supabase_token_env"]] = "fake-sbp-token"
    try:
        return drift_remote.check_project(
            PROJECT,
            github_fetch=fake_github_fetch_factory(github_files),
            list_slugs=fake_list_slugs_factory(sorted({"fn", *fetch_failed_slugs})),
            fetch_all=fetch_all,
            require_cli=fake_require_cli,
            github_file_fetch=github_file_fetch,
        )
    finally:
        os.environ.pop(drift_remote.GITHUB_TOKEN_ENV_VAR, None)
        os.environ.pop(PROJECT["supabase_token_env"], None)


def test_out_of_tree_file_is_compared_through_the_api_fallback():
    """PR #2600 review 3, finding 1. A function fetched through the Management API fallback
    carries a file from outside supabase/functions/. With the old call
    (build_report without repo_root) that file was never compared and the function read
    IDENTICAL, exit 0, while the deployed copy was stale. It must be compared."""
    stale = run_oot_check(b"export const T = 'STALE, NOT WHAT MAIN HAS'\n", b"export const T = 'main'\n")
    report = expect_measured(stale, "oot stale: expected a MEASURED report")
    if report is not None:
        files = {f["path"]: f["status"] for f in report["functions"][0]["files"]}
        check("oot stale: out-of-tree file differs", files.get(OOT_PATH), "differs")
        check("oot stale: verdict DRIFTED, not IDENTICAL", report["functions"][0]["verdict"], "DRIFTED")
    check("oot stale: exit code 1", drift_remote.overall_exit_code([stale]), 1)

    same = run_oot_check(b"export const T = 'main'\n", b"export const T = 'main'\n")
    report = expect_measured(same, "oot same: expected a MEASURED report")
    if report is not None:
        check("oot same: IDENTICAL (control)", report["functions"][0]["verdict"], "IDENTICAL")

    missing = run_oot_check(b"export const T = 'x'\n", None)
    report = expect_measured(missing, "oot missing in main: expected a MEASURED report")
    if report is not None:
        files = {f["path"]: f["status"] for f in report["functions"][0]["files"]}
        check("oot absent from main: missing_in_repo, DRIFTED", (files.get(OOT_PATH), report["functions"][0]["verdict"]),
              ("missing_in_repo", "DRIFTED"))


def test_fetch_failed_function_is_one_could_not_measure_row():
    """PR #2600 review 3, finding 3, remote path: the failed function is one FETCH_FAILED row,
    not also IN_REPO_NEVER_DEPLOYED, and not counted as measured and failing; exit stays 2."""
    result = run_oot_check(b"x", b"x", fetch_failed_slugs=("beta",),
                           extra_repo={"beta/index.ts": SAMPLE_SOURCE})
    report = expect_measured(result, "fetch failed: expected a MEASURED report")
    if report is not None:
        rows = [r["verdict"] for r in report["functions"] if r["slug"] == "beta"]
        check("fetch failed: beta has exactly one row, FETCH_FAILED", rows, ["FETCH_FAILED"])
        check("fetch failed: counts", report["counts"], {"IDENTICAL": 1, "FETCH_FAILED": 1})
    md = drift_remote.render_markdown([result])
    check("fetch failed: not 'never deployed', not 'measured and failing'",
          "IN_REPO_NEVER_DEPLOYED" not in md and "measured and failing" not in md, True)
    check("fetch failed: overall exit code 2", drift_remote.overall_exit_code([result]), 2)


def test_fetch_github_file_404_is_absent_other_errors_are_unmeasured():
    import io
    import urllib.error

    original = drift_remote.urllib.request.urlopen

    def raising(code):
        def _open(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, code, "x", {}, io.BytesIO(b"secret-body"))
        return _open

    try:
        drift_remote.urllib.request.urlopen = raising(404)
        check("404 -> None (main has no such file)", drift_remote.fetch_github_file("o/r", "a/b.ts", "t"), None)
        drift_remote.urllib.request.urlopen = raising(500)
        try:
            drift_remote.fetch_github_file("o/r", "a/b.ts", "t")
            got = "no error"
        except drift_remote.RemoteFetchError as exc:
            got = "RemoteFetchError" if "secret-body" not in str(exc) else "body leaked"
        check("500 -> RemoteFetchError without the response body", got, "RemoteFetchError")
    finally:
        drift_remote.urllib.request.urlopen = original


def main():
    tests = [
        test_project_measured_identical,
        test_project_measured_drifted,
        test_project_missing_github_token_is_unmeasured,
        test_project_unreadable_reports_unmeasured,
        test_overall_report_shows_passing_and_unreadable_side_by_side,
        test_github_fetch_empty_tree_is_unreadable_not_empty_clean,
        test_out_of_tree_file_is_compared_through_the_api_fallback,
        test_fetch_failed_function_is_one_could_not_measure_row,
        test_fetch_github_file_404_is_absent_other_errors_are_unmeasured,
    ]
    for t in tests:
        print(f"-- {t.__name__} --")
        t()
        print()

    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S): {FAILURES}")
        return 1
    print("All edge-function-drift-remote.py tests passed.")
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
