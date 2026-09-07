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
import hashlib
import importlib.util
import io
import json
import pathlib
import shutil
import sys
import tempfile
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
        {  # otterquote.com -- in-org, git-connected, measured
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
        {  # otter-crm -- in-org, separate repo, measured
            "id": "d1b2efbd-8478-472f-8503-57cbdd5b36db",
            "name": "otter-crm",
            "custom_domain": "crm.otterquote.com",
            "build_settings": {"repo_url": "git@github.com:StellarEdgeServices/otter-crm.git"},
        },
        {  # gh-1734: stohlerroof-bridge -- NOT git-connected (no repo_url), the site the
           # old filter silently dropped. Measured via content-hash instead.
            "id": "d5af3c0f-6fbf-4dbf-b8cd-6c955e775b03",
            "name": "stohlerroof-bridge",
            "custom_domain": "stohlerroof.com",
            "build_settings": {},
        },
        {  # gh-1734: genuine scratch sites -- no custom_domain, no repo_url. OUT OF SCOPE,
           # not silently dropped.
            "id": "b6715ca0-d077-4029-89e3-ec7a0650a728",
            "name": "fantastic-cactus-db1344",
            "build_settings": {},
        },
        {
            "id": "aebc572e-db15-4fcf-81c3-0d44278590f9",
            "name": "fantastic-choux-4f510f",
            "build_settings": {},
        },
        {  # a different org's site sharing this Netlify account -- gh-1734: no longer
           # silently excluded, now UNCLASSIFIED (fails loudly).
            "id": "unrelated-1",
            "name": "some-other-project",
            "custom_domain": "example.com",
            "build_settings": {"repo_url": "https://github.com/SomeoneElse/unrelated-repo"},
        },
        {  # not git-connected, not in SITE_CLASSIFICATION at all -- gh-1734: UNCLASSIFIED,
           # not silently dropped (this is the exact defect class gh-1734 was filed over --
           # a real site that no human has ever classified must not vanish).
            "id": "unrelated-2",
            "name": "manual-drop-site",
            "build_settings": {},
        },
    ]
    filtered = nd.filter_org_sites(raw_sites)
    check("filter_org_sites (gh-1734) returns a row for EVERY raw site -- 8 in, 8 out, "
          "none silently dropped", len(filtered), len(raw_sites))
    check("filter_org_sites keys -- includes every site, git-connected or not, "
          "classified or not", sorted(s["key"] for s in filtered),
          sorted(s["name"] for s in raw_sites))

    by_key = {s["key"]: s for s in filtered}

    check("jade-alpaca-b82b5e -- measured, mode=git", (by_key["jade-alpaca-b82b5e"]["measured"],
          by_key["jade-alpaca-b82b5e"]["mode"]), (True, "git"))
    check("jade-alpaca-b82b5e resolved to the otterquote-platform repo",
          by_key["jade-alpaca-b82b5e"]["repo"], "StellarEdgeServices/otterquote-platform")

    otterquote_app_row = by_key["otterquote-app"]
    check("otterquote-app -- measured, mode=git", (otterquote_app_row["measured"], otterquote_app_row["mode"]),
          (True, "git"))
    check("otterquote-app resolved to the otterquote-platform repo (same repo, different site)",
          otterquote_app_row["repo"], "StellarEdgeServices/otterquote-platform")
    check("filter_org_sites label includes the custom domain",
          "app.otterquote.com" in otterquote_app_row["label"], True)

    check("otter-crm -- measured, mode=git", (by_key["otter-crm"]["measured"], by_key["otter-crm"]["mode"]),
          (True, "git"))
    check("otter-crm resolved to the otter-crm repo (ssh-form repo_url)",
          by_key["otter-crm"]["repo"], "StellarEdgeServices/otter-crm")

    # gh-1734: the core fix -- stohlerroof-bridge is now measured, via content-hash, not
    # dropped by the old "no repo_url -> continue" line.
    bridge_row = by_key["stohlerroof-bridge"]
    check("stohlerroof-bridge -- measured, mode=content-hash (the gh-1734 fix)",
          (bridge_row["measured"], bridge_row["mode"]), (True, "content-hash"))
    check("stohlerroof-bridge content_url derived from its live custom_domain",
          bridge_row["content_url"], "https://stohlerroof.com/")
    check("stohlerroof-bridge carries its baseline_fixture filename",
          bridge_row["baseline_fixture"], "stohlerroof-bridge.json")
    check("stohlerroof-bridge carries a reason (why content-hash, not git)",
          bridge_row["reason"] is not None and "D-174" in bridge_row["reason"], True)
    check("stohlerroof-bridge max_age_days defaults to DEFAULT_NON_GIT_MAX_AGE_DAYS",
          bridge_row["max_age_days"], nd.DEFAULT_NON_GIT_MAX_AGE_DAYS)

    # gh-1734: the two genuine scratch sites are OUT OF SCOPE on their own row, named
    # once, not filtered anonymously forever.
    for scratch_key in ("fantastic-cactus-db1344", "fantastic-choux-4f510f"):
        row = by_key[scratch_key]
        check("%s -- NOT measured, reason recorded on the row" % scratch_key,
              row["measured"], False)
        check("%s -- mode is not 'unclassified' (it IS classified, just out of scope)"
              % scratch_key, row["mode"], None)
        check("%s -- reason literally says OUT OF SCOPE (closes-on's own wording)"
              % scratch_key, row["reason"].startswith("OUT OF SCOPE:"), True)

    # gh-1734 Do item 3: a site with NO SITE_CLASSIFICATION entry at all must fail loudly
    # (UNCLASSIFIED), never silently vanish the way the old filter's `continue` did.
    for unknown_key in ("some-other-project", "manual-drop-site"):
        row = by_key[unknown_key]
        check("%s -- NOT measured (unclassified)" % unknown_key, row["measured"], False)
        check("%s -- mode='unclassified' (fails loudly, does not vanish)" % unknown_key,
              row["mode"], "unclassified")
        check("%s -- reason names the missing classification" % unknown_key,
              "SITE_CLASSIFICATION" in row["reason"], True)

    check("filter_org_sites on empty/None input -> []", nd.filter_org_sites(None), [])

    # gh-1734: a SITE_CLASSIFICATION entry claiming mode=git for a site whose live
    # repo_url does NOT belong to the org (table gone stale, or a name collision) must
    # not be trusted blindly into a git compare against the wrong repo -- it degrades to
    # unclassified instead.
    stale_table = {"drifted-site": {"measured": True, "mode": "git"}}
    stale_raw = [{
        "id": "x", "name": "drifted-site", "custom_domain": "drifted.example.com",
        "build_settings": {"repo_url": "https://github.com/SomeoneElse/not-our-repo"},
    }]
    stale_filtered = nd.filter_org_sites(stale_raw, classification=stale_table)
    check("mode=git entry whose live repo_url is org-mismatched degrades to unclassified, "
          "not a trusted-blind git compare",
          (stale_filtered[0]["measured"], stale_filtered[0]["mode"]), (False, "unclassified"))

    # gh-1734: mode=git entry whose live repo_url is simply missing (site un-linked from
    # git since the table was written) -- same degrade-to-unclassified path.
    unlinked_raw = [{"id": "y", "name": "drifted-site", "build_settings": {}}]
    unlinked_filtered = nd.filter_org_sites(unlinked_raw, classification=stale_table)
    check("mode=git entry whose live repo_url has vanished also degrades to unclassified",
          (unlinked_filtered[0]["measured"], unlinked_filtered[0]["mode"]), (False, "unclassified"))

    # -------------------------------------------------------------------------------
    print("\nresolve_site_rows: gh-1569 fresh-context review fixture, UPDATED for gh-1734 --")
    print("a SUCCESSFUL fetch of sites with no SITE_CLASSIFICATION entry must resolve each")
    print("one to its OWN loud UNMEASURED row (never a silent drop, and never a fabricated")
    print("0/clean pass; PR #1569's reviewer: 'an empty result set is UNMEASURED, never a")
    print("pass' -- gh-1734 sharpens this further: an UNCLASSIFIED site must not even be")
    print("collapsed into a single summary row anymore, since filter_org_sites() no longer")
    print("treats 'not in the table' as 'not present').")
    # -------------------------------------------------------------------------------
    def _unrelated_org_sites_only(req, timeout=20):
        # A non-empty, successfully-fetched site list -- none of it in SITE_CLASSIFICATION.
        return _json_response([
            {"id": "x1", "name": "someone-elses-blog",
             "build_settings": {"repo_url": "https://github.com/SomeoneElse/blog"}},
            {"id": "x2", "name": "no-repo-at-all", "build_settings": {}},
        ])

    nd.urllib.request.urlopen = _unrelated_org_sites_only
    try:
        rows = nd.resolve_site_rows("fake-netlify-token", "fake-github-token")
        check("non-empty fetch, neither site classified -> one row PER site (gh-1734: "
              "never collapsed, never dropped)", len(rows), 2)
        check("every row is UNMEASURED, not a fabricated pass",
              all(r["verdict"] == nd.UNMEASURED for r in rows), True)
        check("each row's detail names ITS OWN site and the missing classification",
              all("SITE_CLASSIFICATION" in r["detail"] for r in rows), True)
        check("rows are keyed to the actual sites, not a generic enumeration placeholder",
              sorted(r["key"] for r in rows), ["no-repo-at-all", "someone-elses-blog"])
        code = nd.report_exit_code(rows)
        check("resolve_site_rows -> report_exit_code is 3 (UNMEASURED), NOT 0 (the actual bug)",
              code, 3)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # Contrast case: enumeration fetch fails outright (no token) -- still exactly one
    # UNMEASURED row (there is nothing to classify per-site; the fetch itself failed),
    # via the other branch of resolve_site_rows.
    rows = nd.resolve_site_rows(None, "fake-github-token")
    check("no NETLIFY_PAT -> resolve_site_rows still returns exactly one UNMEASURED row",
          (len(rows), rows[0]["verdict"]), (1, nd.UNMEASURED))
    check("that row's detail names the enumeration failure, not the per-site case",
          "could not enumerate sites" in rows[0]["detail"], True)

    # gh-1734: a genuinely empty Netlify account (fetch succeeds, returns literally zero
    # sites) is still the one remaining case collapsed to a single explanatory UNMEASURED
    # row -- there is nothing to iterate per-site.
    def _zero_sites(req, timeout=20):
        return _json_response([])

    nd.urllib.request.urlopen = _zero_sites
    try:
        rows = nd.resolve_site_rows("fake-netlify-token", "fake-github-token")
        check("Netlify account with zero sites -> exactly one UNMEASURED row",
              (len(rows), rows[0]["verdict"]), (1, nd.UNMEASURED))
        check("that row's detail says the account itself is empty",
              "zero sites" in rows[0]["detail"], True)
        check("zero-sites case -> report_exit_code is 3, not a silent 0/pass",
              nd.report_exit_code(rows), 3)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # -------------------------------------------------------------------------------
    print("\nresolve_site_rows dispatch by mode -- git / content-hash / out-of-scope all")
    print("route correctly, and OUT_OF_SCOPE never turns an otherwise-clean run non-zero")
    print("(gh-1734 Do items 1-3, end to end through resolve_site_rows/report_exit_code)")
    # -------------------------------------------------------------------------------
    def _six_site_router(req, timeout=20):
        url = req.full_url
        if "api.netlify.com" in url and url.endswith("/sites?page=1&per_page=100"):
            return _json_response([
                {"id": "git-1", "name": "clean-git-site", "custom_domain": "clean.example.com",
                 "build_settings": {"repo_url": "https://github.com/StellarEdgeServices/otterquote-platform"}},
                {"id": "bridge-1", "name": "oos-classification-demo-bridge",
                 "custom_domain": "demo-bridge.example.com", "build_settings": {}},
                {"id": "scratch-1", "name": "oos-classification-demo-scratch", "build_settings": {}},
            ])
        if "api.netlify.com" in url and "/deploys" in url:
            return _json_response([{"state": "ready", "created_at": "2026-09-01T00:00:00Z",
                                     "error_message": None}])
        if "api.netlify.com" in url and "/builds" in url:
            return _json_response([])
        if "api.netlify.com" in url and "git-1" in url:
            return _json_response({"published_deploy": {"commit_ref": "a" * 40,
                                                          "published_at": "2026-09-01T00:00:00Z"}})
        if "api.netlify.com" in url and "bridge-1" in url:
            return _json_response({"published_deploy": {"commit_ref": None,
                                                          "published_at": "2026-09-01T00:00:00Z"}})
        if "api.github.com" in url and "/commits/main" in url:
            return _json_response({"sha": "a" * 40})
        if "demo-bridge.example.com" in url:
            return _FakeResponse(b"<html>demo bridge content</html>")
        raise AssertionError("unexpected URL in six-site dispatch test: %s" % url)

    demo_classification = {
        "clean-git-site": {"measured": True, "mode": "git"},
        "oos-classification-demo-bridge": {
            "measured": True, "mode": "content-hash",
            "baseline_fixture": "__demo_bridge_test_only.json",
            "max_age_days": 9999,  # avoid PUBLISH_STALE in this dispatch-only test
        },
        "oos-classification-demo-scratch": {
            "measured": False, "reason": "OUT OF SCOPE: dispatch-test fixture, not a real site",
        },
    }
    demo_fixtures_dir = pathlib.Path(tempfile.mkdtemp(prefix="nd-dispatch-test-"))
    demo_fixture_path = demo_fixtures_dir / "__demo_bridge_test_only.json"
    demo_fixture_path.write_text(
        json.dumps({"expected_sha256": hashlib.sha256(b"<html>demo bridge content</html>").hexdigest()})
    )
    real_site_classification = nd.SITE_CLASSIFICATION
    real_fixtures_dir = nd.FIXTURES_DIR
    nd.SITE_CLASSIFICATION = demo_classification
    nd.FIXTURES_DIR = demo_fixtures_dir
    nd.urllib.request.urlopen = _six_site_router
    try:
        rows = nd.resolve_site_rows("fake-netlify-token", "fake-github-token")
        by_demo_key = {r["key"]: r for r in rows}
        check("dispatch: git-mode site routes through check_site -> IDENTICAL",
              by_demo_key["clean-git-site"]["verdict"], nd.IDENTICAL)
        check("dispatch: content-hash-mode site routes through check_non_git_site -> "
              "CONTENT_VERIFIED", by_demo_key["oos-classification-demo-bridge"]["verdict"],
              nd.CONTENT_VERIFIED)
        check("dispatch: measured=False site -> OUT_OF_SCOPE, never touches the network",
              by_demo_key["oos-classification-demo-scratch"]["verdict"], nd.OUT_OF_SCOPE)
        code = nd.report_exit_code(rows)
        check("all-clean-or-out-of-scope run -> exit 0 (OUT_OF_SCOPE never fails a run)",
              code, 0)
    finally:
        nd.urllib.request.urlopen = real_urlopen
        nd.SITE_CLASSIFICATION = real_site_classification
        nd.FIXTURES_DIR = real_fixtures_dir
        shutil.rmtree(demo_fixtures_dir, ignore_errors=True)

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
    print("\ngh-1734: OUT_OF_SCOPE -- display convention, exit-code neutrality, banner exclusion")
    # -------------------------------------------------------------------------------
    oos_row = nd.out_of_scope_row(
        {"key": "fantastic-cactus-db1344", "label": "fantastic-cactus-db1344.netlify.app (fantastic-cactus-db1344)"},
        "OUT OF SCOPE: no custom_domain, no repo_url -- scratch site",
    )
    check("out_of_scope_row verdict is OUT_OF_SCOPE", oos_row["verdict"], nd.OUT_OF_SCOPE)
    check("out_of_scope_row is not UNMEASURED (chose not to measure, didn't fail to)",
          oos_row["verdict"] != nd.UNMEASURED, True)
    check("out_of_scope_row is not a FAILING_VERDICTS member",
          oos_row["verdict"] in nd.FAILING_VERDICTS, False)
    check("display_verdict(OUT_OF_SCOPE) uses the issue's own literal wording",
          nd.display_verdict(oos_row),
          "OUT OF SCOPE: OUT OF SCOPE: no custom_domain, no repo_url -- scratch site")

    check("OUT_OF_SCOPE alongside only-clean sites -> exit 0, never fails a run by itself",
          nd.report_exit_code([identical_row, oos_row]), 0)
    check("OUT_OF_SCOPE alongside a real failure -> exit 2 (the real failure still counts)",
          nd.report_exit_code([behind_row, oos_row]), 2)

    # The loud banner/issue-comment listings must not drag an explained non-measurement
    # into "here's what's wrong" just because some OTHER site on the run is failing.
    banner = nd._banner_lines([behind_row, oos_row], 2)
    check("OUT_OF_SCOPE never appears in the alarm banner's per-site listing",
          any(oos_row["label"] in line for line in banner), False)
    check("the real BEHIND row DOES appear in the same banner",
          any(behind_row["label"] in line for line in banner), True)
    issue_body = nd.render_issue_comment_body([behind_row, oos_row], 2)
    check("OUT_OF_SCOPE never appears in the --file-issue comment body either",
          oos_row["label"] in issue_body, False)

    # gh-1734: evaluate_non_git_site's CONTENT_VERIFIED is likewise excluded from both
    # loud listings, the same as IDENTICAL is for git sites.
    cv_row = nd.evaluate_non_git_site(
        {"key": "stohlerroof-bridge", "label": "stohlerroof.com (stohlerroof-bridge)"},
        content_sha256="a" * 64, expected_sha256="a" * 64,
        published_at=datetime.datetime(2026, 9, 1, tzinfo=datetime.timezone.utc),
        now=datetime.datetime(2026, 9, 5, tzinfo=datetime.timezone.utc),
        max_age_days=90,
    )
    check("evaluate_non_git_site with matching hash and fresh age -> CONTENT_VERIFIED",
          cv_row["verdict"], nd.CONTENT_VERIFIED)
    check("CONTENT_VERIFIED is a CLEAN_VERDICTS member (excluded from loud listings)",
          cv_row["verdict"] in nd.CLEAN_VERDICTS, True)
    banner2 = nd._banner_lines([behind_row, cv_row], 2)
    check("CONTENT_VERIFIED never appears in the alarm banner either",
          any(cv_row["label"] in line for line in banner2), False)

    # -------------------------------------------------------------------------------
    print("\ngh-1734: evaluate_non_git_site -- pure verdict logic for a non-git site")
    print("(stohlerroof-bridge). No `main` to diff -- the two signals are CONTENT hash and")
    print("deploy AGE, either independently non-passing, both reported when both fire.")
    # -------------------------------------------------------------------------------
    NG_SITE = {"key": "stohlerroof-bridge", "label": "stohlerroof.com (stohlerroof-bridge)"}
    NG_BASELINE = "b" * 64
    NG_NOW = datetime.datetime(2026, 9, 7, tzinfo=datetime.timezone.utc)
    NG_FRESH = NG_NOW - datetime.timedelta(days=10)
    NG_STALE = NG_NOW - datetime.timedelta(days=138)  # the real live stohlerroof-bridge age

    # (1) PASSING: content matches baseline, deploy is fresh.
    r = nd.evaluate_non_git_site(NG_SITE, NG_BASELINE, NG_BASELINE, NG_FRESH, NG_NOW, 90)
    check("matching content + fresh age -> CONTENT_VERIFIED", r["verdict"], nd.CONTENT_VERIFIED)
    check("CONTENT_VERIFIED detail names both the hash match and the age",
          "matches baseline" in r["detail"] and "10 days old" in r["detail"], True)
    check("CONTENT_VERIFIED row carries age_days", r["age_days"], 10)

    # (2) NEGATIVE CONTROL A: content changed, deploy fresh -> CONTENT_CHANGED regardless of age.
    r = nd.evaluate_non_git_site(NG_SITE, "c" * 64, NG_BASELINE, NG_FRESH, NG_NOW, 90)
    check("changed content, fresh age -> CONTENT_CHANGED (fresh age does not hide a real change)",
          r["verdict"], nd.CONTENT_CHANGED)
    check("CONTENT_CHANGED display is a real, non-passing verdict",
          nd.display_verdict(r).startswith("CONTENT_CHANGED ("), True)
    check("CONTENT_CHANGED is a FAILING_VERDICTS member", r["verdict"] in nd.FAILING_VERDICTS, True)

    # (3) NEGATIVE CONTROL B: content matches, deploy AGED past threshold (the real live
    #     stohlerroof-bridge shape as of gh-1734: published 2026-04-21, measured 2026-09-07).
    r = nd.evaluate_non_git_site(NG_SITE, NG_BASELINE, NG_BASELINE, NG_STALE, NG_NOW, 90)
    check("matching content, aged past threshold -> PUBLISH_STALE (the real live shape)",
          r["verdict"], nd.PUBLISH_STALE)
    check("PUBLISH_STALE detail says the hash still matches -- it's the age alone alarming",
          "content hash still matches baseline" in r["detail"], True)
    check("PUBLISH_STALE is a FAILING_VERDICTS member", r["verdict"] in nd.FAILING_VERDICTS, True)

    # (4) NEGATIVE CONTROL C: both content changed AND aged -- neither signal is shadowed.
    r = nd.evaluate_non_git_site(NG_SITE, "c" * 64, NG_BASELINE, NG_STALE, NG_NOW, 90)
    check("both content changed and aged -> CONTENT_CHANGED (reports both facts)",
          r["verdict"], nd.CONTENT_CHANGED)
    check("combined detail names BOTH the content mismatch and the age",
          "does not match baseline" in r["detail"] and "days old" in r["detail"] and "AND" in r["detail"],
          True)

    # Age exactly AT the threshold is not yet stale (">", not ">=") -- a boundary check.
    r = nd.evaluate_non_git_site(NG_SITE, NG_BASELINE, NG_BASELINE, NG_NOW - datetime.timedelta(days=90),
                                  NG_NOW, 90)
    check("age exactly at the threshold (90 days) -> still CONTENT_VERIFIED, not yet stale",
          r["verdict"], nd.CONTENT_VERIFIED)
    r = nd.evaluate_non_git_site(NG_SITE, NG_BASELINE, NG_BASELINE, NG_NOW - datetime.timedelta(days=91),
                                  NG_NOW, 90)
    check("age one day past the threshold (91 days) -> PUBLISH_STALE",
          r["verdict"], nd.PUBLISH_STALE)

    # No expected_sha256 configured (fixture missing/unloaded) -- content_changed can't be
    # evaluated (None means "can't compare", not "matches"); age alone can still fire.
    r = nd.evaluate_non_git_site(NG_SITE, "d" * 64, None, NG_FRESH, NG_NOW, 90)
    check("no baseline to compare against -> content_changed is never asserted True from "
          "a None baseline (falls through to the age check)", r["verdict"], nd.CONTENT_VERIFIED)

    # No published_at at all (couldn't parse the timestamp) -- age can't be evaluated;
    # a matching hash alone is still CONTENT_VERIFIED, never mis-reported as stale.
    r = nd.evaluate_non_git_site(NG_SITE, NG_BASELINE, NG_BASELINE, None, NG_NOW, 90)
    check("no published_at -> age_days is None, never fabricated as stale",
          (r["verdict"], r["age_days"]), (nd.CONTENT_VERIFIED, None))

    # -------------------------------------------------------------------------------
    print("\ngh-1734: fetch_url_content / _load_content_baseline -- fetch-layer helpers for")
    print("a non-git site, same fail-loud discipline as every other fetch in this script")
    # -------------------------------------------------------------------------------
    data, reason = nd.fetch_url_content("https://example.invalid/", timeout=5)
    # (No real network assertion here -- covered by the mocked check_non_git_site tests
    # below. This just exercises the no-crash path for an unreachable host.)
    check("fetch_url_content never raises, always returns a (data, reason) tuple",
          isinstance(reason, str), True)

    sha, reason = nd._load_content_baseline(None)
    check("_load_content_baseline with no fixture filename -> None, names the gap",
          (sha, "no baseline_fixture configured" in reason), (None, True))

    sha, reason = nd._load_content_baseline("does-not-exist.json", fixtures_dir=HERE)
    check("_load_content_baseline with a missing fixture file -> None, not a crash",
          sha, None)
    check("missing-fixture reason names the failure", "could not read baseline fixture" in reason, True)

    tmp_fixtures = pathlib.Path(tempfile.mkdtemp(prefix="nd-fixture-test-"))
    try:
        (tmp_fixtures / "malformed.json").write_text("not valid json {{{")
        sha, reason = nd._load_content_baseline("malformed.json", fixtures_dir=tmp_fixtures)
        check("_load_content_baseline with malformed JSON -> None, not a crash", sha, None)

        (tmp_fixtures / "no-hash-field.json").write_text(json.dumps({"note": "oops, no hash"}))
        sha, reason = nd._load_content_baseline("no-hash-field.json", fixtures_dir=tmp_fixtures)
        check("_load_content_baseline with no expected_sha256 field -> None",
              (sha, "no expected_sha256" in reason), (None, True))

        (tmp_fixtures / "good.json").write_text(json.dumps({"expected_sha256": "f" * 64}))
        sha, reason = nd._load_content_baseline("good.json", fixtures_dir=tmp_fixtures)
        check("_load_content_baseline with a valid fixture -> the pinned hash",
              (sha, reason), ("f" * 64, "ok"))
    finally:
        shutil.rmtree(tmp_fixtures, ignore_errors=True)

    # -------------------------------------------------------------------------------
    print("\ngh-1734: check_non_git_site end-to-end (mocked) -- CONTENT_VERIFIED,")
    print("CONTENT_CHANGED, PUBLISH_STALE, and every fetch-layer UNMEASURED path")
    # -------------------------------------------------------------------------------
    NG_CONTENT = b"<html>the real stohlerroof.com disclosure content</html>"
    NG_CONTENT_SHA = hashlib.sha256(NG_CONTENT).hexdigest()

    ng_tmp_fixtures = pathlib.Path(tempfile.mkdtemp(prefix="nd-ng-e2e-"))
    (ng_tmp_fixtures / "e2e-bridge.json").write_text(json.dumps({"expected_sha256": NG_CONTENT_SHA}))

    NG_TEST_SITE = {
        "key": "stohlerroof-bridge", "label": "stohlerroof.com (stohlerroof-bridge)",
        "repo": None,
        "site_id": "d5af3c0f-6fbf-4dbf-b8cd-6c955e775b03",
        "content_url": "https://stohlerroof.com/",
        "baseline_fixture": "e2e-bridge.json",
        "max_age_days": 90,
    }

    def _ng_router(published_at, content=NG_CONTENT):
        def _router(req, timeout=20):
            url = req.full_url
            if "api.netlify.com" in url:
                return _json_response({"published_deploy": {"commit_ref": None,
                                                              "published_at": published_at}})
            if "stohlerroof.com" in url:
                return _FakeResponse(content)
            raise AssertionError("unexpected URL in check_non_git_site e2e test: %s" % url)
        return _router

    fixed_e2e_now = datetime.datetime(2026, 9, 7, 13, 0, 0, tzinfo=datetime.timezone.utc)

    nd.urllib.request.urlopen = _ng_router("2026-08-28T00:00:00Z")  # 10 days old
    try:
        row = nd.check_non_git_site(NG_TEST_SITE, "fake-netlify-token", now=fixed_e2e_now,
                                     fixtures_dir=ng_tmp_fixtures)
        check("check_non_git_site e2e: matching content, fresh age -> CONTENT_VERIFIED",
              row["verdict"], nd.CONTENT_VERIFIED)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    nd.urllib.request.urlopen = _ng_router("2026-08-28T00:00:00Z", content=b"<html>changed!</html>")
    try:
        row = nd.check_non_git_site(NG_TEST_SITE, "fake-netlify-token", now=fixed_e2e_now,
                                     fixtures_dir=ng_tmp_fixtures)
        check("check_non_git_site e2e: changed content, fresh age -> CONTENT_CHANGED",
              row["verdict"], nd.CONTENT_CHANGED)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # Real stohlerroof-bridge published_at (2026-04-21T13:31:10Z, per the live gh-1734
    # measurement) against fixed_e2e_now (2026-09-07T13:00:00Z, ~31 min earlier in the
    # day) -> (now - published_at).days floors to 138, not 139 -- confirmed live on the
    # PR's actual pasted run, not a guess.
    nd.urllib.request.urlopen = _ng_router("2026-04-21T13:31:10Z")  # 138 days old
    try:
        row = nd.check_non_git_site(NG_TEST_SITE, "fake-netlify-token", now=fixed_e2e_now,
                                     fixtures_dir=ng_tmp_fixtures)
        check("check_non_git_site e2e: matching content, published 2026-04-21 (138 days) "
              "-> PUBLISH_STALE (this IS stohlerroof-bridge's real recorded live shape)",
              row["verdict"], nd.PUBLISH_STALE)
        check("PUBLISH_STALE row carries the real age", row["age_days"], 138)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # Fetch-layer UNMEASURED paths -- Netlify site fetch fails.
    def _ng_netlify_500(req, timeout=20):
        raise urllib.error.HTTPError(url=req.full_url, code=500, msg="Internal Server Error",
                                       hdrs=None, fp=None)
    nd.urllib.request.urlopen = _ng_netlify_500
    try:
        row = nd.check_non_git_site(NG_TEST_SITE, "fake-netlify-token", now=fixed_e2e_now,
                                     fixtures_dir=ng_tmp_fixtures)
        check("check_non_git_site: Netlify site fetch failure -> UNMEASURED, not a crash",
              row["verdict"], nd.UNMEASURED)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # No NETLIFY_PAT -> UNMEASURED, same as check_site()'s fail-loud discipline.
    row = nd.check_non_git_site(NG_TEST_SITE, None, now=fixed_e2e_now, fixtures_dir=ng_tmp_fixtures)
    check("check_non_git_site with no NETLIFY_PAT -> UNMEASURED", row["verdict"], nd.UNMEASURED)

    # Page fetch fails (site fetch OK, content GET fails) -> UNMEASURED.
    def _ng_content_404(req, timeout=20):
        url = req.full_url
        if "api.netlify.com" in url:
            return _json_response({"published_deploy": {"commit_ref": None,
                                                          "published_at": "2026-08-28T00:00:00Z"}})
        raise urllib.error.HTTPError(url=url, code=404, msg="Not Found", hdrs=None, fp=None)
    nd.urllib.request.urlopen = _ng_content_404
    try:
        row = nd.check_non_git_site(NG_TEST_SITE, "fake-netlify-token", now=fixed_e2e_now,
                                     fixtures_dir=ng_tmp_fixtures)
        check("check_non_git_site: published-page fetch failure -> UNMEASURED",
              row["verdict"], nd.UNMEASURED)
        check("UNMEASURED detail names the page fetch failure",
              "published-page fetch failed" in row["detail"], True)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # Missing baseline fixture -> UNMEASURED (never silently treated as "matches").
    nd.urllib.request.urlopen = _ng_router("2026-08-28T00:00:00Z")
    try:
        no_fixture_site = dict(NG_TEST_SITE, baseline_fixture="does-not-exist.json")
        row = nd.check_non_git_site(no_fixture_site, "fake-netlify-token", now=fixed_e2e_now,
                                     fixtures_dir=ng_tmp_fixtures)
        check("check_non_git_site: missing baseline fixture -> UNMEASURED, never treated "
              "as a silent match", row["verdict"], nd.UNMEASURED)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # Unparseable / missing published_deploy timestamp -> UNMEASURED.
    def _ng_no_timestamp(req, timeout=20):
        return _json_response({"published_deploy": {"commit_ref": None, "published_at": None}})
    nd.urllib.request.urlopen = _ng_no_timestamp
    try:
        row = nd.check_non_git_site(NG_TEST_SITE, "fake-netlify-token", now=fixed_e2e_now,
                                     fixtures_dir=ng_tmp_fixtures)
        check("check_non_git_site: no parseable published_deploy timestamp -> UNMEASURED",
              row["verdict"], nd.UNMEASURED)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    shutil.rmtree(ng_tmp_fixtures, ignore_errors=True)

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
        check("UNMEASURED detail distinguishes token-scope gap from a dead target",
              "token-scope gap" in row["detail"], True)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # -------------------------------------------------------------------------------
    print("\n_annotate_github_404: only rewrites HTTP 404, leaves every other reason untouched")
    # -------------------------------------------------------------------------------
    check("_annotate_github_404 leaves a non-404 reason unchanged",
          nd._annotate_github_404("HTTP 500 (Internal Server Error) for https://api.github.com/x"),
          "HTTP 500 (Internal Server Error) for https://api.github.com/x")
    check("_annotate_github_404 leaves a network-exception reason unchanged",
          nd._annotate_github_404("URLError: timed out"),
          "URLError: timed out")
    _annotated_404 = nd._annotate_github_404("HTTP 404 (Not Found) for https://api.github.com/x")
    check("_annotate_github_404 preserves the original HTTP 404 text",
          _annotated_404.startswith("HTTP 404 (Not Found) for https://api.github.com/x"), True)
    check("_annotate_github_404 adds the token-scope-gap explanation",
          "token-scope gap" in _annotated_404, True)

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
        posted, detail = nd.post_issue_comment("test body")
        check("post_issue_comment with no token -> returns (False, reason), does not raise", posted, False)
        check("post_issue_comment with no token -> reason names the missing env vars",
              "GITHUB_TOKEN" in detail and nd.GITHUB_TOKEN_ENV_VAR in detail, True)
    finally:
        if saved_gh_token is not None:
            nd.os.environ["GITHUB_TOKEN"] = saved_gh_token
        if saved_pat is not None:
            nd.os.environ[nd.GITHUB_TOKEN_ENV_VAR] = saved_pat

    # -------------------------------------------------------------------------------
    print("\ngh-1721: --file-issue's POST result is no longer a stderr-only side note")
    print("(the swallow: a failed POST used to change nothing about the run's outcome)")
    # -------------------------------------------------------------------------------
    saved_gh_token = nd.os.environ.get("GITHUB_TOKEN")
    saved_pat = nd.os.environ.get(nd.GITHUB_TOKEN_ENV_VAR)
    try:
        nd.os.environ["GITHUB_TOKEN"] = "fake-token-for-test-never-a-real-credential"
        nd.os.environ.pop(nd.GITHUB_TOKEN_ENV_VAR, None)

        # A 403 is exactly the shape gh-1721 measured live: a credential present and
        # accepted by GitHub's auth layer, but lacking the `issues: write` scope.
        def fake_urlopen_403(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 403, "Resource not accessible by "
                                          "personal access token", hdrs=None, fp=None)

        nd.urllib.request.urlopen = fake_urlopen_403
        posted, detail = nd.post_issue_comment("test body")
        check("post_issue_comment on HTTP 403 -> returns (False, ...)", posted, False)
        check("403 detail names the status code (never the token value)",
              "403" in detail and "fake-token-for-test-never-a-real-credential" not in detail, True)

        # The success path: GitHub's real response to a comment POST is the created
        # comment object, including html_url -- captured here as evidence the caller
        # can paste, same convention as the rest of this repo's detectors surfacing a
        # concrete artifact rather than a bare boolean.
        def fake_urlopen_201(req, timeout=None):
            return _json_response({"html_url": "https://github.com/StellarEdgeServices/"
                                                 "otterquote-platform/issues/1549#issuecomment-999"})

        nd.urllib.request.urlopen = fake_urlopen_201
        posted, detail = nd.post_issue_comment("test body")
        check("post_issue_comment on success -> returns (True, ...)", posted, True)
        check("success detail carries the comment's html_url",
              detail, "https://github.com/StellarEdgeServices/otterquote-platform/issues/1549#issuecomment-999")
    finally:
        nd.urllib.request.urlopen = real_urlopen
        if saved_gh_token is not None:
            nd.os.environ["GITHUB_TOKEN"] = saved_gh_token
        else:
            nd.os.environ.pop("GITHUB_TOKEN", None)
        if saved_pat is not None:
            nd.os.environ[nd.GITHUB_TOKEN_ENV_VAR] = saved_pat

    # -------------------------------------------------------------------------------
    print("\ngh-1721: final_exit_code() escalates 2 -> 4 on a failed alarm POST, never")
    print("touches 0/3 -- the fix's actual observable behavior change")
    # -------------------------------------------------------------------------------
    check("code 2, alarm posted -> stays 2", nd.final_exit_code(2, "posted"), 2)
    check("code 2, alarm failed -> escalates to ALARM_POST_FAILED_EXIT (4)",
          nd.final_exit_code(2, "failed"), nd.ALARM_POST_FAILED_EXIT)
    check("code 2, alarm not attempted (None) -> stays 2", nd.final_exit_code(2, None), 2)
    check("code 3 (UNMEASURED), alarm failed -> stays 3, never escalated",
          nd.final_exit_code(3, "failed"), 3)
    check("code 0, alarm failed (can't happen via main(), but the function must not "
          "invent an escalation) -> stays 0", nd.final_exit_code(0, "failed"), 0)

    # -------------------------------------------------------------------------------
    print("\ngh-1721: alarm_post_status/detail surface in both render_json and render_text,")
    print("not just stderr -- loudness must not depend on output format (same principle")
    print("as the existing banner tests, gh-1501 ruling 2c)")
    # -------------------------------------------------------------------------------
    behind_row_for_alarm = nd.evaluate_site(SITE, "b" * 40, "2026-08-11T09:15:22Z", "c" * 40, 3,
                                             "ready", None, False)
    failed_json = json.loads(nd.render_json([behind_row_for_alarm], 2,
                                             alarm_post_status="failed",
                                             alarm_post_detail="HTTP 403 (Forbidden)"))
    check("render_json carries alarm_post_status", failed_json["alarm_post_status"], "failed")
    check("render_json carries alarm_post_detail", failed_json["alarm_post_detail"], "HTTP 403 (Forbidden)")
    check("a failed alarm POST is loud in the JSON banner too",
          "REDUNDANT GITHUB ALARM COMMENT FAILED" in (failed_json["banner"] or ""), True)
    failed_text = nd.render_text([behind_row_for_alarm], 2,
                                  alarm_post_status="failed", alarm_post_detail="HTTP 403 (Forbidden)")
    check("render_text is loud about a failed alarm POST too",
          "REDUNDANT GITHUB ALARM COMMENT FAILED" in failed_text, True)
    check("render_text names the failure detail", "HTTP 403 (Forbidden)" in failed_text, True)

    posted_json = json.loads(nd.render_json([behind_row_for_alarm], 2,
                                             alarm_post_status="posted",
                                             alarm_post_detail="https://github.com/.../999"))
    check("a successful alarm POST is NOT reported as a failure in the banner",
          "REDUNDANT GITHUB ALARM COMMENT FAILED" in (posted_json["banner"] or ""), False)
    not_requested_json = json.loads(nd.render_json([behind_row_for_alarm], 2))
    check("alarm_post_status defaults to None (not requested / no failing verdict)",
          not_requested_json["alarm_post_status"], None)

    # -------------------------------------------------------------------------------
    print("\nBASE-DIRECTORY SITES + NO-CONTENT CANCELS (gh-1549, CTO run cto-2026-09-05T03:07:58Z)")
    print("Recorded live 2026-09-05T04:31Z on otterquote-app (base=react-app): the pre-fix")
    print("detector printed 'BUILD_FAILING (... Canceled build due to no content change)' and")
    print("'7 commits behind' while production was correctly at 3424c60b, the last main")
    print("commit touching react-app/ -- the later commits touched only supabase/functions,")
    print("scripts/ and .github/. Netlify's ignore-build rule cancels those; that is not a")
    print("build failure and not drift.")
    # -------------------------------------------------------------------------------
    NO_CONTENT = ("Failed during stage 'checking build content for changes': "
                  "Canceled build due to no content change")
    CREDIT = "Skipped due to account credit usage exceeded"
    APP_SITE = {"key": "otterquote-app", "label": "app.otterquote.com (otterquote-app)",
                "site_id": "26316673-212a-4f20-a95e-902ece8387c4",
                "repo": "StellarEdgeServices/otterquote-platform"}

    # (1) no-content cancel, production == last main commit touching the base dir -> IDENTICAL
    r = nd.evaluate_site(APP_SITE, "3424c60b608f", "2026-09-05T02:04:49Z", "cd89cfbff617", 0,
                         "error", NO_CONTENT, None, base_dir="react-app",
                         base_head_sha="3424c60b608f", main_ahead_of_production=7)
    check("no-content cancel on a base-dir site -> IDENTICAL (was BUILD_FAILING pre-fix)",
          r["verdict"], nd.IDENTICAL)
    check("no-content cancel is flagged SKIPPED_NO_CONTENT on the row", r["no_content_skip"], True)
    check("no-content cancel detail names main HEAD as past production, not as drift",
          "main HEAD is 7 commits past production, none touching the base dir" in r["detail"], True)
    check("SKIPPED_NO_CONTENT is not a verdict and never in FAILING_VERDICTS",
          nd.SKIPPED_NO_CONTENT in nd.FAILING_VERDICTS, False)
    check("no-content cancel -> exit 0 (clean), the alarm does not cry wolf on every merge",
          nd.report_exit_code([r]), 0)

    # (1b) the base-dir head is a branch commit already merged into what production serves
    #      (GitHub's path-filtered commit list returns the branch commit, not the merge):
    #      compare(published...base_head).ahead_by == 0 -> IDENTICAL, never BEHIND.
    r = nd.evaluate_site(APP_SITE, "3424c60b608f", "2026-09-05T02:04:49Z", "a9a9f690018d", 0,
                         "error", NO_CONTENT, None, base_dir="react-app",
                         base_head_sha="d3787ae09571", main_ahead_of_production=15)
    check("base-dir head already contained in production (ahead_by 0) -> IDENTICAL", r["verdict"], nd.IDENTICAL)
    check("detail says 'already contains' and names the base-dir head",
          "already contains the last main commit touching base dir 'react-app/' (d3787ae09571)" in r["detail"], True)

    # (2) credit-exceeded (#1548) stays BUILD_FAILING, loud -- Dustin's ruling 2026-09-04
    #     (gh-1549 comment 5545292885): auto-topup stays off, "Let it stop and alert me."
    r = nd.evaluate_site(APP_SITE, "3424c60b608f", "2026-09-05T02:04:49Z", "cd89cfbff617", 0,
                         "error", CREDIT, True, base_dir="react-app",
                         base_head_sha="3424c60b608f", main_ahead_of_production=7)
    check("credit-exceeded on a base-dir site -> BUILD_FAILING (not softened by the base-dir logic)",
          r["verdict"], nd.BUILD_FAILING)
    check("credit-exceeded detail is the message verbatim", r["detail"], CREDIT)
    check("credit-exceeded -> exit 2", nd.report_exit_code([r]), 2)
    r = nd.evaluate_site(APP_SITE, "3424c60b608f", "2026-09-05T02:04:49Z", "cd89cfbff617", 7,
                         "error", "Build script returned non-zero exit code: 2", None,
                         base_dir="react-app", base_head_sha="cd89cfbff617")
    check("a REAL build error on otterquote-app still alarms (matched on message, not site name)",
          r["verdict"], nd.BUILD_FAILING)

    # (3) genuinely behind: a later main commit DID touch react-app/ and production did not move
    r = nd.evaluate_site(APP_SITE, "3424c60b608f", "2026-09-05T02:04:49Z", "cd89cfbff617", 2,
                         "error", NO_CONTENT, None, base_dir="react-app",
                         base_head_sha="0123456789ab", main_ahead_of_production=7)
    check("genuinely behind on a base-dir site -> BEHIND", r["verdict"], nd.BEHIND)
    check("BEHIND N is counted against the base-dir head, and says so",
          r["detail"].startswith("2 commits behind, since 2026-09-05 (counted against the last main "
                                 "commit touching base dir 'react-app/', not main HEAD)"), True)
    check("genuinely behind -> exit 2", nd.report_exit_code([r]), 2)
    # No base dir: unchanged behaviour, the #1517 shape.
    r = nd.evaluate_site(SITE, "1" * 40, "2026-08-11T09:15:22Z", "2" * 40, 9, "ready", None, False)
    check("no base dir -> plain main HEAD compare, BEHIND 9 (the #1517 shape)",
          r["detail"], "9 commits behind, since 2026-08-11")

    # select_signal_deploy: the newest NON-benign deploy is the signal.
    d, n = nd.select_signal_deploy([
        {"id": "c1", "state": "error", "created_at": "2026-09-05T04:18:48Z", "error_message": NO_CONTENT},
        {"id": "real", "state": "error", "created_at": "2026-09-05T03:00:00Z", "error_message": CREDIT},
        {"id": "ok", "state": "ready", "created_at": "2026-09-05T02:04:49Z", "error_message": None},
    ])
    check("select_signal_deploy skips newer no-content cancels down to the unresolved real error",
          (d["id"], n), ("real", 1))
    d, n = nd.select_signal_deploy([
        {"id": "c1", "state": "error", "created_at": "2026-09-05T04:18:48Z", "error_message": NO_CONTENT},
        {"id": "ok", "state": "ready", "created_at": "2026-09-05T02:04:49Z", "error_message": None},
    ])
    check("select_signal_deploy: cancel newer than a ready deploy -> the ready one is the signal",
          (d["id"], n), ("ok", 1))
    d, n = nd.select_signal_deploy([
        {"id": "c1", "state": "error", "created_at": "2026-09-05T04:18:48Z", "error_message": NO_CONTENT},
    ])
    check("select_signal_deploy: only benign deploys -> returns the newest benign, count 0",
          (d["id"], n), ("c1", 0))
    check("select_signal_deploy: empty list -> (None, 0)", nd.select_signal_deploy([]), (None, 0))

    # check_site end-to-end for a base-dir site: the router serves the site's
    # build_settings.base, the path-filtered commits list, and both compares.
    def _base_dir_router(published, base_head, main_head, ahead_published_to_base,
                         ahead_published_to_main, deploys):
        def _router(req, timeout=20):
            url = req.full_url
            if "api.netlify.com" in url and "/deploys" in url:
                return _json_response(deploys)
            if "api.netlify.com" in url and "/builds" in url:
                return _json_response([])
            if "api.netlify.com" in url:
                return _json_response({
                    "published_deploy": {"commit_ref": published, "published_at": "2026-09-05T02:04:49Z"},
                    "build_settings": {"base": "react-app", "repo_url":
                                       "https://github.com/StellarEdgeServices/otterquote-platform"},
                })
            if "api.github.com" in url and "/commits?sha=main&path=react-app&per_page=1" in url:
                return _json_response([{"sha": base_head}])
            if "api.github.com" in url and "/commits/main" in url:
                return _json_response({"sha": main_head})
            if "api.github.com" in url and "/compare/%s...%s" % (published, base_head) in url:
                return _json_response({"ahead_by": ahead_published_to_base})
            if "api.github.com" in url and "/compare/%s...%s" % (published, main_head) in url:
                return _json_response({"ahead_by": ahead_published_to_main})
            raise AssertionError("unexpected URL in base-dir test router: %s" % url)
        return _router

    live_deploys = [  # the 2026-09-05T04:31Z shape, verbatim states/messages
        {"state": "error", "created_at": "2026-09-05T04:18:48Z", "error_message": NO_CONTENT},
        {"state": "error", "created_at": "2026-09-05T03:19:31Z", "error_message": NO_CONTENT},
        {"state": "error", "created_at": "2026-09-05T03:12:37Z", "error_message": NO_CONTENT},
        {"state": "ready", "created_at": "2026-09-05T02:04:49Z", "error_message": None},
    ]
    nd.urllib.request.urlopen = _base_dir_router("3424c60b608f", "3424c60b608f", "cd89cfbff617",
                                                 0, 7, live_deploys)
    try:
        row = nd.check_site(APP_SITE, "fake-netlify-token", "fake-github-token")
        check("check_site end-to-end base-dir site, no-content cancels -> IDENTICAL", row["verdict"], nd.IDENTICAL)
        check("check_site end-to-end carries base_dir", row["base_dir"], "react-app")
        check("check_site end-to-end carries the base-dir head", row["base_head_sha"], "3424c60b608f")
        check("check_site end-to-end counts the 3 newer no-content cancels",
              "newest 3 production deploy attempts were" in row["detail"], True)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    nd.urllib.request.urlopen = _base_dir_router("3424c60b608f", "0123456789ab", "cd89cfbff617",
                                                 2, 7, live_deploys)
    try:
        row = nd.check_site(APP_SITE, "fake-netlify-token", "fake-github-token")
        check("check_site end-to-end base-dir site, base dir touched after production -> BEHIND", row["verdict"], nd.BEHIND)
        check("check_site end-to-end BEHIND count is against the base-dir head (2), not main (7)", row["ahead_by"], 2)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    nd.urllib.request.urlopen = _base_dir_router(
        "3424c60b608f", "3424c60b608f", "cd89cfbff617", 0, 7,
        [{"state": "error", "created_at": "2026-09-05T04:18:48Z", "error_message": NO_CONTENT},
         {"state": "error", "created_at": "2026-09-05T03:19:31Z", "error_message": CREDIT},
         {"state": "ready", "created_at": "2026-09-05T02:04:49Z", "error_message": None}])
    try:
        row = nd.check_site(APP_SITE, "fake-netlify-token", "fake-github-token")
        check("check_site end-to-end: credit-exceeded behind a newer no-content cancel still BUILD_FAILING",
              row["verdict"], nd.BUILD_FAILING)
        check("check_site end-to-end: BUILD_FAILING detail is the credit message", row["detail"], CREDIT)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    # The path-filtered commits call failing -> UNMEASURED, never a silent fallback to main HEAD.
    def _base_head_404(req, timeout=20):
        url = req.full_url
        if "/commits?sha=main&path=" in url:
            raise urllib.error.HTTPError(url=url, code=404, msg="Not Found", hdrs=None, fp=None)
        return _base_dir_router("3424c60b608f", "3424c60b608f", "cd89cfbff617", 0, 7, live_deploys)(req, timeout)
    nd.urllib.request.urlopen = _base_head_404
    try:
        row = nd.check_site(APP_SITE, "fake-netlify-token", "fake-github-token")
        check("base-dir head fetch failing -> UNMEASURED (no silent fallback to main HEAD)", row["verdict"], nd.UNMEASURED)
        check("base-dir head UNMEASURED reason names the base dir",
              "base dir 'react-app'" in row["detail"], True)
    finally:
        nd.urllib.request.urlopen = real_urlopen

    check("--self-test built into the script passes", nd.self_test(), 0)

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
