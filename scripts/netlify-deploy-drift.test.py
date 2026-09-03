#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/netlify-deploy-drift.py (gh-1549).

Covers the shape gh-1549 exists to close: a static-site deploy-drift check whose own
failure to measure must never look like a pass, and whose BUILD_FAILING signal (the
#1548 shape -- a still-matching published_deploy hiding a newer erroring attempt) must
never be shadowed by a clean sha compare. No network access and no credentials
required -- every fetch-adjacent path is exercised by monkeypatching urllib.request's
`urlopen`, following the importlib-load pattern this repo already uses for hyphenated
script filenames (scripts/edge-function-drift-check.test.py,
scripts/drift-detector-age.test.py).

Run: python netlify-deploy-drift.test.py
"""

import datetime
import importlib.util
import io
import json
import pathlib
import sys
import urllib.error

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("nd", HERE / "netlify-deploy-drift.py")
nd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nd)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


SITE = {
    "key": "test-site",
    "label": "Test Site",
    "site_id": "site-123",
    "repo": "StellarEdgeServices/test-repo",
}


class _FakeResponse:
    """Minimal context-manager stand-in for urllib.request.urlopen's return value."""

    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _json_response(payload):
    return _FakeResponse(json.dumps(payload).encode("utf-8"))


def main():
    # Captured once, up front, so any section below can monkeypatch
    # nd.urllib.request.urlopen and restore it -- sections are order-independent.
    real_urlopen = nd.urllib.request.urlopen

    # -------------------------------------------------------------------------------
    print("Pure verdict logic (evaluate_site) -- IDENTICAL / BEHIND / BUILD_FAILING")
    # -------------------------------------------------------------------------------
    same_sha = "a" * 40

    r = nd.evaluate_site(
        SITE, same_sha, "2026-09-01T10:00:00.000Z", same_sha, 0, "ready", None, False
    )
    check("matching sha -> IDENTICAL", r["verdict"], nd.IDENTICAL)
    check("IDENTICAL row still carries both shas", (r["published_commit"], r["main_sha"]), (same_sha, same_sha))

    r = nd.evaluate_site(
        SITE, "b" * 40, "2026-08-11T09:15:22.000Z", "c" * 40, 9, "ready", None, False
    )
    check("differing sha, non-error deploy -> BEHIND", r["verdict"], nd.BEHIND)
    check("BEHIND detail carries commit count and since-date",
          r["detail"], "9 commits behind, since 2026-08-11")
    check("BEHIND display matches issue's own format",
          nd.display_verdict(r), "BEHIND (9 commits behind, since 2026-08-11)")

    r = nd.evaluate_site(SITE, "d" * 40, "2026-08-01T00:00:00.000Z", "9" * 40, 1, "ready", None, False)
    check("ahead_by == 1 -> singular 'commit'", "1 commit behind" in r["detail"], True)

    # BUILD_FAILING takes priority even when the sha still matches -- the #1548 shape.
    r = nd.evaluate_site(
        SITE, same_sha, "2026-09-02T18:33:33.000Z", same_sha, 0, "error",
        "Skipped due to account credit usage exceeded", True,
    )
    check("matching sha but newest deploy state=error -> BUILD_FAILING (not IDENTICAL)",
          r["verdict"], nd.BUILD_FAILING)
    check("BUILD_FAILING detail carries the API error_message",
          r["detail"], "Skipped due to account credit usage exceeded")
    check("BUILD_FAILING display", nd.display_verdict(r),
          "BUILD_FAILING (Skipped due to account credit usage exceeded)")

    # BUILD_FAILING also wins over what would otherwise be BEHIND.
    r = nd.evaluate_site(SITE, "e" * 40, "2026-08-11T09:15:22.000Z", "f" * 40, 9, "error", None, True)
    check("error deploy + behind sha -> BUILD_FAILING, not BEHIND", r["verdict"], nd.BUILD_FAILING)

    # No error_message from the API -- still BUILD_FAILING, with a synthesized detail
    # that never invents a message the API didn't actually provide.
    r = nd.evaluate_site(SITE, same_sha, "2026-09-02T20:29:52.000Z", same_sha, 0, "error", None, True)
    check("error deploy with no error_message -> BUILD_FAILING still fires",
          r["verdict"], nd.BUILD_FAILING)
    check("synthesized detail names the missing error_message explicitly",
          "no error_message provided by the API" in r["detail"], True)

    # -------------------------------------------------------------------------------
    print("\nQUEUED_STALE -- third independent signal, priority vs BUILD_FAILING/BEHIND (gh-1549")
    print("CTO comment 5524997596, item 2b -- the #1517 shape neither other signal catches)")
    # -------------------------------------------------------------------------------
    stale_build = {"id": "test-queued-stale-build-1517", "created_at": "2026-08-20T19:45:55Z",
                    "_age_minutes": 20160.0}  # ~14 days, matches #1517's live evidence

    r = nd.evaluate_site(
        SITE, same_sha, "2026-09-01T10:00:00.000Z", same_sha, 0, "ready", None, False,
        queued_stale_build=stale_build,
    )
    check("matching sha, ready deploy, but a stale queued build -> QUEUED_STALE (not IDENTICAL)",
          r["verdict"], nd.QUEUED_STALE)
    check("QUEUED_STALE row records the stuck build id", r["queued_stale_build_id"], stale_build["id"])
    check("QUEUED_STALE detail names the build id and queued-since timestamp",
          stale_build["id"] in r["detail"] and stale_build["created_at"] in r["detail"], True)
    check("QUEUED_STALE display token", nd.display_verdict(r).startswith("QUEUED_STALE ("), True)

    # BUILD_FAILING still wins over QUEUED_STALE when both are present -- a newer,
    # actively erroring deploy attempt is the more urgent finding.
    r = nd.evaluate_site(
        SITE, same_sha, "2026-09-02T18:33:33.000Z", same_sha, 0, "error", "credit exceeded", True,
        queued_stale_build=stale_build,
    )
    check("BUILD_FAILING outranks QUEUED_STALE when both fire", r["verdict"], nd.BUILD_FAILING)

    # QUEUED_STALE wins over what would otherwise be a clean BEHIND-free IDENTICAL.
    r = nd.evaluate_site(
        SITE, "1" * 40, "2026-08-11T00:00:00.000Z", "2" * 40, 3, "ready", None, False,
        queued_stale_build=stale_build,
    )
    check("QUEUED_STALE outranks BEHIND when both would otherwise apply", r["verdict"], nd.QUEUED_STALE)

    # No stale build present (the default/normal case) -- falls through to BEHIND/IDENTICAL
    # exactly as before hardening; queued_stale_build=None must not change prior behavior.
    r = nd.evaluate_site(SITE, same_sha, "2026-09-01T10:00:00.000Z", same_sha, 0, "ready", None, False)
    check("no queued_stale_build -> unaffected, still IDENTICAL", r["verdict"], nd.IDENTICAL)
    check("no queued_stale_build -> row field is None", r["queued_stale_build_id"], None)

    # -------------------------------------------------------------------------------
    print("\nfind_queued_stale_build -- pure age-threshold logic, no network, no real clock")
    # -------------------------------------------------------------------------------
    now = datetime.datetime(2026, 9, 3, 12, 0, 0, tzinfo=datetime.timezone.utc)

    fresh_build = {"id": "fresh", "done": False, "error": None, "deploy_id": None,
                   "created_at": "2026-09-03T11:50:00Z"}  # 10 min old -- under the 60min default
    stuck_build = {"id": "stuck", "done": False, "error": None, "deploy_id": None,
                   "created_at": "2026-09-03T10:00:00Z"}  # 120 min old -- over the default
    errored_build = {"id": "errored", "done": False, "error": "build script failed",
                     "deploy_id": None, "created_at": "2026-08-01T00:00:00Z"}  # has an error -- BUILD_FAILING's job
    done_build = {"id": "done", "done": True, "error": None, "deploy_id": None,
                 "created_at": "2026-08-01T00:00:00Z"}  # finished -- not stuck
    deployed_build = {"id": "deployed", "done": False, "error": None, "deploy_id": "d-123",
                      "created_at": "2026-08-01T00:00:00Z"}  # has a deploy_id -- produced something
    unparseable_build = {"id": "bad-ts", "done": False, "error": None, "deploy_id": None,
                         "created_at": "not-a-timestamp"}

    check("no builds -> None", nd.find_queued_stale_build([], now), None)
    check("only a fresh queued build (under threshold) -> None",
          nd.find_queued_stale_build([fresh_build], now), None)
    check("errored build (done=False, has error) -> excluded, that's BUILD_FAILING's job",
          nd.find_queued_stale_build([errored_build], now), None)
    check("finished build (done=True) -> excluded",
          nd.find_queued_stale_build([done_build], now), None)
    check("build with a deploy_id (produced a deploy) -> excluded",
          nd.find_queued_stale_build([deployed_build], now), None)
    check("unparseable created_at -> excluded, not a crash",
          nd.find_queued_stale_build([unparseable_build], now), None)

    found = nd.find_queued_stale_build([fresh_build, stuck_build], now)
    check("one stale build among a fresh one -> found", found["id"] if found else None, "stuck")
    check("found build carries computed _age_minutes", round(found["_age_minutes"]), 120)

    older_stuck = {"id": "older-stuck", "done": False, "error": None, "deploy_id": None,
                   "created_at": "2026-08-20T00:00:00Z"}
    found = nd.find_queued_stale_build([stuck_build, older_stuck], now)
    check("multiple stale builds -> the OLDEST (most stuck) one is returned",
          found["id"], "older-stuck")

    check("custom stale_minutes threshold respected -- 120min build not stale at a 180min threshold",
          nd.find_queued_stale_build([stuck_build], now, stale_minutes=180), None)

    # -------------------------------------------------------------------------------
    print("\n_format_minutes -- scales past days (the #1517 shape sat 14+ days)")
    # -------------------------------------------------------------------------------
    check("_format_minutes under an hour", nd._format_minutes(45), "45 min")
    check("_format_minutes hours", nd._format_minutes(125), "2h5m")
    check("_format_minutes days", nd._format_minutes(60 * 24 * 14 + 60), "14d1h")

    # -------------------------------------------------------------------------------
    print("\nSite enumeration -- filter_org_sites / _repo_from_repo_url (gh-1549 CTO comment")
    print("5524997596, item 2a: enumerate by build_settings.repo_url, don't hardcode)")
    # -------------------------------------------------------------------------------
    check("_repo_from_repo_url https form",
          nd._repo_from_repo_url("https://github.com/StellarEdgeServices/otterquote-platform"),
          "StellarEdgeServices/otterquote-platform")
    check("_repo_from_repo_url git@ ssh form",
          nd._repo_from_repo_url("git@github.com:StellarEdgeServices/otter-crm.git"),
          "StellarEdgeServices/otter-crm")
    check("_repo_from_repo_url non-github url -> None",
          nd._repo_from_repo_url("https://gitlab.com/someone/somewhere"), None)
    check("_repo_from_repo_url empty -> None", nd._repo_from_repo_url(""), None)
    check("_repo_from_repo_url None -> None", nd._repo_from_repo_url(None), None)

    raw_sites = [
        {  # otterquote.com -- in-org, kept
            "id": "6748a414-1baa-4309-a5f9-f3a7f45e3d94",
            "name": "jade-alpaca-b82b5e",
            "custom_domain": "otterquote.com",
            "build_settings": {"repo_url": "https://github.com/StellarEdgeServices/otterquote-platform"},
        },
        {  # otterquote-app -- same repo, DIFFERENT site (this is the site the hardcoded
           # table missed and that CTO comment 5524997596 found 32h stale)
            "id": "26316673-212a-4f20-a95e-902ece8387c4",
            "name": "otterquote-app",
            "custom_domain": "app.otterquote.com",
            "build_settings": {"repo_url": "https://github.com/StellarEdgeServices/otterquote-platform"},
        },
        {  # otter-crm -- in-org, separate repo, kept
            "id": "d1b2efbd-8478-472f-8503-57cbdd5b36db",
            "name": "otter-crm",
            "custom_domain": "crm.otterquote.com",
            "build_settings": {"repo_url": "git@github.com:StellarEdgeServices/otter-crm.git"},
        },
        {  # a different org's site sharing this Netlify account -- must be excluded
            "id": "unrelated-1",
            "name": "some-other-project",
            "custom_domain": "example.com",
            "build_settings": {"repo_url": "https://github.com/SomeoneElse/unrelated-repo"},
        },
        {  # not git-connected at all -- excluded, not UNMEASURED
            "id": "unrelated-2",
            "name": "manual-drop-site",
            "build_settings": {},
        },
    ]
    filtered = nd.filter_org_sites(raw_sites)
    check("filter_org_sites keeps exactly the 3 in-org sites", len(filtered), 3)
    check("filter_org_sites keys", sorted(s["key"] for s in filtered),
          ["jade-alpaca-b82b5e", "otter-crm", "otterquote-app"])
    otterquote_app_row = next(s for s in filtered if s["key"] == "otterquote-app")
    check("otterquote-app resolved to the otterquote-platform repo (same repo, different site)",
          otterquote_app_row["repo"], "StellarEdgeServices/otterquote-platform")
    check("filter_org_sites label includes the custom domain",
          "app.otterquote.com" in otterquote_app_row["label"], True)
    check("filter_org_sites excludes a different org's site",
          "some-other-project" not in [s["key"] for s in filtered], True)
    check("filter_org_sites excludes a non-git-connected site",
          "manual-drop-site" not in [s["key"] for s in filtered], True)
    check("filter_org_sites on empty/None input -> []", nd.filter_org_sites(None), [])

    # -------------------------------------------------------------------------------
    print("\nresolve_site_rows: gh-1569 fresh-context review fixture -- a SUCCESSFUL fetch")
    print("whose org filter matches ZERO sites must resolve UNMEASURED, never a silent 0/clean")
    print("pass (PR #1569's reviewer: 'that's the exact defect class this repo's own")
    print("detectors keep re-learning -- an empty result set is UNMEASURED, never a pass').")
    # -------------------------------------------------------------------------------
    def _unrelated_org_sites_only(req, timeout=20):
        # A non-empty, successfully-fetched site list -- none of it StellarEdgeServices.
        return _json_response([
            {"id": "x1", "name": "someone-elses-blog",
             "build_settings": {"repo_url": "https://github.com/SomeoneElse/blog"}},
            {"id": "x2", "name": "no-repo-at-all", "build_settings": {}},
        ])

    nd.urllib.request.urlopen = _unrelated_org_sites_only
    try:
        rows = nd.resolve_site_rows("fake-netlify-token", "fake-github-token")
        check("non-empty fetch, filter matches nothing -> exactly one row (never zero)",
              len(rows), 1)
        check("that row is UNMEASURED, not a fabricated pass", rows[0]["verdict"], nd.UNMEASURED)
        check("detail names the fetched count and the org filter",
              "2 site(s)" in rows[0]["detail"] and nd.REPO_OWNER_FILTER in rows[0]["detail"], True)
        code = nd.report_exit_code(rows)
        check("resolve_site_rows -> report_exit_code is 3 (UNMEASURED), NOT 0 (the actual bug)",
              code, 3)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # Contrast case: enumeration fetch fails outright (no token) -- also exactly one
    # UNMEASURED row, via the other branch of resolve_site_rows.
    rows = nd.resolve_site_rows(None, "fake-github-token")
    check("no NETLIFY_PAT -> resolve_site_rows still returns exactly one UNMEASURED row",
          (len(rows), rows[0]["verdict"]), (1, nd.UNMEASURED))
    check("that row's detail names the enumeration failure, not the empty-filter case",
          "could not enumerate sites" in rows[0]["detail"], True)

    # -------------------------------------------------------------------------------
    print("\nAccount-level auto-topup WARN (gh-1549 CTO comment 5524997596, item 3)")
    # -------------------------------------------------------------------------------
    warn_account = {"name": "OtterQuote", "auto_topup_enabled": False, "has_stripe_payment_method": True}
    safe_account_topup_on = {"name": "Safe1", "auto_topup_enabled": True, "has_stripe_payment_method": True}
    safe_account_no_card = {"name": "Safe2", "auto_topup_enabled": False, "has_stripe_payment_method": False}

    warnings = nd.find_auto_topup_warnings([warn_account])
    check("auto_topup off + card on file -> exactly one WARN", len(warnings), 1)
    check("WARN names the account", "OtterQuote" in warnings[0], True)
    check("WARN mentions auto_topup", "auto_topup" in warnings[0].lower() or "auto-topup" in warnings[0].lower(), True)

    check("auto_topup ON -> no warning", nd.find_auto_topup_warnings([safe_account_topup_on]), [])
    check("no payment method on file -> no warning (nothing to freeze against)",
          nd.find_auto_topup_warnings([safe_account_no_card]), [])
    check("mixed accounts -> only the risky one warns",
          len(nd.find_auto_topup_warnings([warn_account, safe_account_topup_on, safe_account_no_card])), 1)
    check("no accounts -> []", nd.find_auto_topup_warnings([]), [])

    # compute_account_warnings: no token -> one WARN naming the missing token, never a crash.
    check("compute_account_warnings with no token -> WARN naming NETLIFY_PAT",
          nd.NETLIFY_TOKEN_ENV_VAR in nd.compute_account_warnings(None)[0], True)

    # -------------------------------------------------------------------------------
    print("\ndisplay_verdict / IDENTICAL has no parenthetical")
    # -------------------------------------------------------------------------------
    r = nd.evaluate_site(SITE, same_sha, "2026-09-01T10:00:00.000Z", same_sha, 0, "ready", None, False)
    check("IDENTICAL display is the bare token", nd.display_verdict(r), "IDENTICAL")

    # -------------------------------------------------------------------------------
    print("\nreport_exit_code -- UNMEASURED outranks BEHIND/BUILD_FAILING outranks IDENTICAL")
    # -------------------------------------------------------------------------------
    identical_row = nd.evaluate_site(SITE, same_sha, "2026-09-01T00:00:00Z", same_sha, 0, "ready", None, False)
    behind_row = nd.evaluate_site(SITE, "1" * 40, "2026-08-11T00:00:00Z", "2" * 40, 3, "ready", None, False)
    queued_stale_row = nd.evaluate_site(
        SITE, same_sha, "2026-09-01T00:00:00Z", same_sha, 0, "ready", None, False,
        queued_stale_build={"id": "x", "created_at": "2026-08-20T00:00:00Z", "_age_minutes": 20160.0},
    )
    unmeasured_row = nd.unmeasured_row(SITE, "no NETLIFY_PAT found in the environment")

    check("all IDENTICAL -> exit 0", nd.report_exit_code([identical_row, identical_row]), 0)
    check("one BEHIND -> exit 2", nd.report_exit_code([identical_row, behind_row]), 2)
    check("one QUEUED_STALE -> exit 2", nd.report_exit_code([identical_row, queued_stale_row]), 2)
    check("one UNMEASURED alongside a clean site -> exit 3 (outranks IDENTICAL)",
          nd.report_exit_code([identical_row, unmeasured_row]), 3)
    check("one UNMEASURED alongside a BEHIND site -> exit 3 (outranks BEHIND)",
          nd.report_exit_code([behind_row, unmeasured_row]), 3)
    check("one UNMEASURED alongside a QUEUED_STALE site -> exit 3 (outranks QUEUED_STALE)",
          nd.report_exit_code([queued_stale_row, unmeasured_row]), 3)

    # gh-1569 fresh-context review on PR #1569: report_exit_code([]) was falling
    # through to 0 (clean) -- {r["verdict"] for r in []} is the empty set, which
    # contains neither UNMEASURED nor a FAILING_VERDICTS member. An empty rows
    # list must never read as a clean pass.
    check("EMPTY rows list -> exit 3, NOT 0 (gh-1569: the untested/unguarded path)",
          nd.report_exit_code([]), 3)

    # -------------------------------------------------------------------------------
    print("\nUNMEASURED fetch paths -- must never resolve to a clean verdict")
    # -------------------------------------------------------------------------------
    data, reason = nd.fetch_netlify_site("site-123", None)
    check("fetch_netlify_site with no token -> data is None", data, None)
    check("fetch_netlify_site with no token -> reason names NETLIFY_PAT",
          nd.NETLIFY_TOKEN_ENV_VAR in reason, True)

    data, reason = nd.fetch_github_main_sha("owner/repo", None)
    check("fetch_github_main_sha with no token -> data is None", data, None)
    check("fetch_github_main_sha with no token -> reason names GITHUB_PERSONAL_ACCESS_TOKEN",
          nd.GITHUB_TOKEN_ENV_VAR in reason, True)

    data, reason = nd.fetch_netlify_sites(None)
    check("fetch_netlify_sites with no token -> data is None", data, None)
    check("fetch_netlify_sites with no token -> reason names NETLIFY_PAT",
          nd.NETLIFY_TOKEN_ENV_VAR in reason, True)

    data, reason = nd.fetch_netlify_builds("site-123", None)
    check("fetch_netlify_builds with no token -> data is None", data, None)
    check("fetch_netlify_builds with no token -> reason names NETLIFY_PAT",
          nd.NETLIFY_TOKEN_ENV_VAR in reason, True)

    data, reason = nd.fetch_netlify_accounts(None)
    check("fetch_netlify_accounts with no token -> data is None", data, None)
    check("fetch_netlify_accounts with no token -> reason names NETLIFY_PAT",
          nd.NETLIFY_TOKEN_ENV_VAR in reason, True)

    real_urlopen = nd.urllib.request.urlopen

    def _raise_network_error(req, timeout=20):
        raise urllib.error.URLError("[Errno -2] Name or service not known")

    nd.urllib.request.urlopen = _raise_network_error
    try:
        data, reason = nd.fetch_netlify_site("site-123", "fake-token-not-real")
        check("network error -> data is None", data, None)
        check("network error -> reason names the failure",
              "URLError" in reason or "Name or service" in reason, True)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    def _raise_http_401(req, timeout=20):
        raise urllib.error.HTTPError(url="https://api.netlify.com/x", code=401, msg="Unauthorized",
                                       hdrs=None, fp=None)

    nd.urllib.request.urlopen = _raise_http_401
    try:
        data, reason = nd.fetch_netlify_site("site-123", "fake-token-not-real")
        check("HTTP 401 -> data is None", data, None)
        check("HTTP 401 -> reason names the status code", "401" in reason, True)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    def _empty_deploys(req, timeout=20):
        return _json_response([])

    nd.urllib.request.urlopen = _empty_deploys
    try:
        data, reason = nd.fetch_netlify_newest_production_deploy("site-123", "fake-token-not-real")
        check("zero production deploys -> data is None (not an empty clean pass)", data, None)
        check("zero production deploys -> reason says so", "zero production" in reason, True)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    def _bad_json(req, timeout=20):
        return _FakeResponse(b"not json {{{")

    nd.urllib.request.urlopen = _bad_json
    try:
        data, reason = nd.fetch_netlify_site("site-123", "fake-token-not-real")
        check("malformed JSON -> data is None, not a crash", data, None)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # -------------------------------------------------------------------------------
    print("\nfetch_netlify_newest_production_deploy picks the NEWEST by created_at, not list order")
    # -------------------------------------------------------------------------------
    def _out_of_order_deploys(req, timeout=20):
        return _json_response([
            {"id": "old", "state": "ready", "created_at": "2026-09-01T00:00:00Z"},
            {"id": "new", "state": "error", "created_at": "2026-09-02T20:29:52Z"},
            {"id": "mid", "state": "ready", "created_at": "2026-09-02T10:00:00Z"},
        ])

    nd.urllib.request.urlopen = _out_of_order_deploys
    try:
        data, reason = nd.fetch_netlify_newest_production_deploy("site-123", "fake-token-not-real")
        check("newest-by-created_at selected regardless of list position", data["id"], "new")
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # -------------------------------------------------------------------------------
    print("\nfetch_netlify_sites paginates rather than silently truncating at 100")
    # -------------------------------------------------------------------------------
    def _paged_sites(req, timeout=20):
        # NOTE: match on "?page=N" (the query-starting param), not "page=N" bare --
        # "per_page=100" itself contains the substring "page=100", which would
        # falsely match a bare "page=1" check on every request regardless of the
        # actual page number.
        url = req.full_url
        if "?page=1" in url:
            return _json_response([{"id": "s%d" % i} for i in range(100)])
        if "?page=2" in url:
            return _json_response([{"id": "s100"}])
        raise AssertionError("unexpected page in test: %s" % url)

    nd.urllib.request.urlopen = _paged_sites
    try:
        data, reason = nd.fetch_netlify_sites("fake-token-not-real")
        check("fetch_netlify_sites follows pagination past a full first page", len(data), 101)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    def _single_short_page(req, timeout=20):
        return _json_response([{"id": "only-one"}])

    nd.urllib.request.urlopen = _single_short_page
    try:
        data, reason = nd.fetch_netlify_sites("fake-token-not-real")
        check("fetch_netlify_sites stops after a short page (no needless extra request)",
              len(data), 1)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # -------------------------------------------------------------------------------
    print("\nfetch_github_ahead_by short-circuits when shas already match (no compare call)")
    # -------------------------------------------------------------------------------
    def _explode_if_called(req, timeout=20):
        raise AssertionError("urlopen should not be called when base_sha == head_sha")

    nd.urllib.request.urlopen = _explode_if_called
    try:
        ahead, reason = nd.fetch_github_ahead_by("owner/repo", same_sha, same_sha, "fake-token")
        check("identical shas -> ahead_by 0 with no network call", ahead, 0)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # -------------------------------------------------------------------------------
    print("\ncheck_site end-to-end: full IDENTICAL, full BEHIND, full BUILD_FAILING, and a")
    print("cross-repo-style 404 mid-pipeline resolving to UNMEASURED (the otter-crm shape)")
    # -------------------------------------------------------------------------------
    def _make_router(site_body, deploys_body, github_commit_body=None, github_compare_body=None,
                      github_status=200, builds_body=None):
        def _router(req, timeout=20):
            url = req.full_url
            if "api.netlify.com" in url and "/deploys" in url:
                return _json_response(deploys_body)
            if "api.netlify.com" in url and "/builds" in url:
                return _json_response(builds_body if builds_body is not None else [])
            if "api.netlify.com" in url:
                return _json_response(site_body)
            if "api.github.com" in url and "/compare/" in url:
                if github_status != 200:
                    raise urllib.error.HTTPError(url=url, code=github_status, msg="Not Found",
                                                   hdrs=None, fp=None)
                return _json_response(github_compare_body)
            if "api.github.com" in url and "/commits/main" in url:
                if github_status != 200:
                    raise urllib.error.HTTPError(url=url, code=github_status, msg="Not Found",
                                                   hdrs=None, fp=None)
                return _json_response(github_commit_body)
            raise AssertionError("unexpected URL in test router: %s" % url)
        return _router

    # Full IDENTICAL path.
    nd.urllib.request.urlopen = _make_router(
        site_body={"published_deploy": {"commit_ref": same_sha, "published_at": "2026-09-01T00:00:00Z"}},
        deploys_body=[{"state": "ready", "created_at": "2026-09-01T00:00:00Z", "error_message": None}],
        github_commit_body={"sha": same_sha},
    )
    try:
        row = nd.check_site(SITE, "fake-netlify-token", "fake-github-token")
        check("check_site end-to-end IDENTICAL", row["verdict"], nd.IDENTICAL)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # Full BEHIND path.
    nd.urllib.request.urlopen = _make_router(
        site_body={"published_deploy": {"commit_ref": "1" * 40, "published_at": "2026-08-11T09:15:22Z"}},
        deploys_body=[{"state": "ready", "created_at": "2026-08-11T09:15:22Z", "error_message": None}],
        github_commit_body={"sha": "2" * 40},
        github_compare_body={"ahead_by": 9},
    )
    try:
        row = nd.check_site(SITE, "fake-netlify-token", "fake-github-token")
        check("check_site end-to-end BEHIND", row["verdict"], nd.BEHIND)
        check("check_site end-to-end BEHIND detail", row["detail"], "9 commits behind, since 2026-08-11")
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # Full BUILD_FAILING path (the #1548 shape: published still ready/matching, newest attempt errors).
    nd.urllib.request.urlopen = _make_router(
        site_body={"published_deploy": {"commit_ref": same_sha, "published_at": "2026-09-02T18:33:33Z"}},
        deploys_body=[
            {"state": "ready", "created_at": "2026-09-02T18:33:33Z", "error_message": None},
            {"state": "error", "created_at": "2026-09-02T20:29:52Z",
             "error_message": "Skipped due to account credit usage exceeded"},
        ],
        github_commit_body={"sha": same_sha},
    )
    try:
        row = nd.check_site(SITE, "fake-netlify-token", "fake-github-token")
        check("check_site end-to-end BUILD_FAILING (newest of 2 deploys picked)",
              row["verdict"], nd.BUILD_FAILING)
        check("check_site end-to-end BUILD_FAILING detail",
              row["detail"], "Skipped due to account credit usage exceeded")
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # Full QUEUED_STALE path (the #1517 shape: published still matches main, newest
    # deploy is "ready", but a build has been queued for hours with no error and no
    # deploy produced).
    fixed_now = datetime.datetime(2026, 9, 3, 12, 0, 0, tzinfo=datetime.timezone.utc)
    nd.urllib.request.urlopen = _make_router(
        site_body={"published_deploy": {"commit_ref": same_sha, "published_at": "2026-09-01T00:00:00Z"}},
        deploys_body=[{"state": "ready", "created_at": "2026-09-01T00:00:00Z", "error_message": None}],
        github_commit_body={"sha": same_sha},
        builds_body=[
            {"id": "test-queued-stale-build-1517", "done": False, "error": None, "deploy_id": None,
             "created_at": "2026-08-20T19:45:55Z"},
        ],
    )
    try:
        row = nd.check_site(SITE, "fake-netlify-token", "fake-github-token", now=fixed_now)
        check("check_site end-to-end QUEUED_STALE (matching sha, ready deploy, stuck build)",
              row["verdict"], nd.QUEUED_STALE)
        check("check_site end-to-end QUEUED_STALE carries the build id",
              row["queued_stale_build_id"], "test-queued-stale-build-1517")
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # Builds fetch itself failing (e.g. HTTP error) -> UNMEASURED, same fail-loud
    # discipline as every other fetch step, never silently skipped.
    def _builds_500(req, timeout=20):
        url = req.full_url
        if "/builds" in url:
            raise urllib.error.HTTPError(url=url, code=500, msg="Internal Server Error", hdrs=None, fp=None)
        if "/deploys" in url:
            return _json_response([{"state": "ready", "created_at": "2026-09-01T00:00:00Z", "error_message": None}])
        return _json_response({"published_deploy": {"commit_ref": same_sha, "published_at": "2026-09-01T00:00:00Z"}})

    nd.urllib.request.urlopen = _builds_500
    try:
        row = nd.check_site(SITE, "fake-netlify-token", "fake-github-token")
        check("builds fetch HTTP error -> UNMEASURED, not a crash", row["verdict"], nd.UNMEASURED)
        check("UNMEASURED detail names the builds fetch failure", "builds fetch failed" in row["detail"], True)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # Cross-repo-style 404 on the GitHub side (otter-crm shape: Netlify reachable,
    # GitHub token lacks access to this site's repo) -> UNMEASURED, not a crash, not IDENTICAL.
    nd.urllib.request.urlopen = _make_router(
        site_body={"published_deploy": {"commit_ref": "3" * 40, "published_at": "2026-08-01T00:00:00Z"}},
        deploys_body=[{"state": "ready", "created_at": "2026-08-01T00:00:00Z", "error_message": None}],
        github_commit_body=None,
        github_status=404,
    )
    try:
        row = nd.check_site(SITE, "fake-netlify-token", "fake-github-token-without-otter-crm-access")
        check("GitHub 404 mid-pipeline -> UNMEASURED, not a crash", row["verdict"], nd.UNMEASURED)
        check("UNMEASURED detail names the GitHub 404", "404" in row["detail"], True)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # -------------------------------------------------------------------------------
    print("\nNever prints a token value")
    # -------------------------------------------------------------------------------
    captured = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = captured
    try:
        rows = [identical_row, behind_row, unmeasured_row]
        print(nd.render_text(rows, nd.report_exit_code(rows)))
        print(nd.render_json(rows, nd.report_exit_code(rows)))
    finally:
        sys.stdout = real_stdout
    check("no fake token value ever appears in rendered output",
          "fake-token-not-real" in captured.getvalue(), False)
    check("no fake github token value ever appears in rendered output",
          "fake-github-token-without-otter-crm-access" in captured.getvalue(), False)

    # -------------------------------------------------------------------------------
    print("\n--json banner parity: loudness must not depend on output format")
    # -------------------------------------------------------------------------------
    clean_rows = [identical_row, identical_row]
    clean_code = nd.report_exit_code(clean_rows)
    clean_json = json.loads(nd.render_json(clean_rows, clean_code))
    check("clean run --json verdict", clean_json["verdict"], "CURRENT")
    check("clean run --json banner is null", clean_json["banner"], None)

    behind_rows = [identical_row, behind_row]
    behind_code = nd.report_exit_code(behind_rows)
    behind_text = nd.render_text(behind_rows, behind_code)
    behind_json = json.loads(nd.render_json(behind_rows, behind_code))
    check("DRIFTED run --json verdict", behind_json["verdict"], "DRIFTED")
    check("DRIFTED run --json banner is byte-identical to the text-mode banner lines",
          behind_json["banner"], "\n".join(nd._banner_lines(behind_rows, behind_code)))
    check("DRIFTED banner text appears in both text and json mode",
          ("NETLIFY PRODUCTION DEPLOY DRIFT" in behind_text)
          and ("NETLIFY PRODUCTION DEPLOY DRIFT" in (behind_json["banner"] or "")), True)

    unmeasured_rows = [identical_row, unmeasured_row]
    unmeasured_code = nd.report_exit_code(unmeasured_rows)
    unmeasured_json = json.loads(nd.render_json(unmeasured_rows, unmeasured_code))
    check("UNMEASURED run --json verdict", unmeasured_json["verdict"], "UNMEASURED")
    check("UNMEASURED run --json banner carries the loud warning",
          "NOT A PASS" in (unmeasured_json["banner"] or ""), True)

    # -------------------------------------------------------------------------------
    print("\nAccount WARN lines are independent of drift verdict / exit code (item 3)")
    # -------------------------------------------------------------------------------
    topup_warning = ['WARN: Netlify account "OtterQuote" has auto_topup disabled with a payment '
                     "method on file -- the next usage-limit depletion freezes every deploy again "
                     "with no notice (the #1548 shape)."]
    clean_json_with_warn = json.loads(nd.render_json(clean_rows, clean_code, warnings=topup_warning))
    check("a clean (CURRENT) run can still carry a WARN", clean_json_with_warn["warnings"], topup_warning)
    check("a WARN never changes the verdict/exit code of a clean run",
          clean_json_with_warn["verdict"], "CURRENT")
    check("no warnings -> json 'warnings' is [] not null/omitted",
          json.loads(nd.render_json(clean_rows, clean_code))["warnings"], [])
    clean_text_with_warn = nd.render_text(clean_rows, clean_code, warnings=topup_warning)
    check("text mode includes the WARN line too", "auto_topup disabled" in clean_text_with_warn, True)

    # -------------------------------------------------------------------------------
    print("\n--file-issue: no token -> skips posting, never crashes")
    # -------------------------------------------------------------------------------
    saved_gh_token = nd.os.environ.get("GITHUB_TOKEN")
    saved_pat = nd.os.environ.get(nd.GITHUB_TOKEN_ENV_VAR)
    try:
        nd.os.environ.pop("GITHUB_TOKEN", None)
        nd.os.environ.pop(nd.GITHUB_TOKEN_ENV_VAR, None)
        posted = nd.post_issue_comment("test body")
        check("post_issue_comment with no token -> returns False, does not raise", posted, False)
    finally:
        if saved_gh_token is not None:
            nd.os.environ["GITHUB_TOKEN"] = saved_gh_token
        if saved_pat is not None:
            nd.os.environ[nd.GITHUB_TOKEN_ENV_VAR] = saved_pat

    # -------------------------------------------------------------------------------
    print("\nRECORDED LIVE FIXTURE -- otterquote-platform, captured 2026-09-02 ~20:30Z")
    print("(gh-1549 dispatch rw-f22-20260902T181106-lnoj: no NETLIFY_PAT was reachable in")
    print("this Code-lane session -- see the script's CROSS-REPO SCOPE GAP note and the")
    print("PR/issue writeup for the credential-store sweep. These are the REAL values read")
    print("directly from the Netlify + GitHub REST APIs at that moment -- via the site's")
    print("public unauthenticated read (jade-alpaca-b82b5e is `public: true`) and the")
    print("session's GITHUB_PERSONAL_ACCESS_TOKEN -- fed through evaluate_site() unmodified.")
    print("This is the mocked/recorded-response demonstration the dispatch calls for when")
    print("no token is available: today's actual #1548 stall, still reproducing live.")
    # -------------------------------------------------------------------------------
    live_row = nd.evaluate_site(
        site={"key": "otterquote-platform",
              "label": "otterquote.com (jade-alpaca-b82b5e)",
              "repo": "StellarEdgeServices/otterquote-platform"},
        published_commit="2cd939eafbd3ef90176a7357f1c3e0b7ff14173c",
        published_at="2026-09-02T18:33:33.497Z",
        main_sha="f3f763a22ace1e6fc886c1f98f549e3af60d7cb7",
        ahead_by=23,  # GitHub compare 2cd939e...f3f763a, ahead_by, captured live
        deploy_state="error",  # newest production deploy id 6a988740f1267e0008ad3dc8
        deploy_error_message=None,  # unauthenticated read; API redacts this field without a token
        deploy_skipped=True,
    )
    print("  verdict:", live_row["verdict"])
    print("  display:", nd.display_verdict(live_row))
    check("recorded live fixture -> BUILD_FAILING (newest deploy erroring wins over BEHIND)",
          live_row["verdict"], nd.BUILD_FAILING)
    check("recorded live fixture is also genuinely BEHIND underneath (23 commits) -- "
          "confirmed by re-deriving via a plain evaluate_site() call with deploy_state=ready",
          nd.evaluate_site(
              site={"key": "otterquote-platform", "label": "x", "repo": "x"},
              published_commit="2cd939eafbd3ef90176a7357f1c3e0b7ff14173c",
              published_at="2026-09-02T18:33:33.497Z",
              main_sha="f3f763a22ace1e6fc886c1f98f549e3af60d7cb7",
              ahead_by=23, deploy_state="ready", deploy_error_message=None, deploy_skipped=False,
          )["verdict"],
          nd.BEHIND)

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print("netlify-deploy-drift: all assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
