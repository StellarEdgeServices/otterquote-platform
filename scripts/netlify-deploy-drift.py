#!/usr/bin/env python3
"""
netlify-deploy-drift.py -- OtterQuote Netlify PRODUCTION-deploy-vs-`main` drift detector (gh-1549)

The static-site half of gh-1295's detector family ("a merge is not a deploy, and this
system has no mechanism that notices the difference"). gh-1295's own detector
(scripts/edge-function-drift-check.py) covers Edge Functions only. This one covers the
two Netlify-hosted static sites, filed after TWO same-shaped incidents in one day with no
alarm on either:

  - #1548 -- otterquote.com (site jade-alpaca-b82b5e) returned
    "Skipped due to account credit usage exceeded" for every production deploy from
    18:35Z onward. Branch/preview deploys kept succeeding, so a "did a deploy happen"
    check would have passed. Discovered at 19:05Z by a `curl` that happened to look for
    a just-merged string.
  - #1517 -- otter-crm production sat 22 days / 9 commits behind `main`; four
    git-triggered builds since 08-14 all `Canceled build`.

THE TWO INDEPENDENT SIGNALS (do not collapse into one bare sha compare)
  1. BEHIND: the currently PUBLISHED production deploy's commit_ref lags the repo's
     `main` HEAD. This is the #1517 shape.
  2. BUILD_FAILING: the NEWEST production-context deploy attempt (which may be more
     recent than the currently published one) has state "error". This is the #1548
     shape specifically: production was still serving a `ready` deploy from BEFORE the
     credit lockout, so a bare "is published_deploy.commit_ref == main?" check computed
     against an old-but-still-matching published commit would pass clean while every
     deploy attempt since has been silently erroring. A detector that reads only
     published_deploy misses this exact incident.
  BUILD_FAILING is reported independently of, and does not require, a BEHIND verdict --
  a broken deploy pipeline is worth alarming on even in the accidental window where the
  last-published commit still happens to equal `main`.

FAIL-LOUD, NOT FAIL-QUIET (same convention as drift-detector-age.py / credential-sweep.py
/ edge-function-drift-check.py; gh-1419: UNMEASURED MUST FAIL AS LOUDLY AS DRIFTED).
Being unable to measure a site is UNMEASURED, never IDENTICAL. No token, no network, an
HTTP error, an empty/malformed response, or a missing field all resolve to UNMEASURED for
that site and it is never silently skipped from the run's overall exit code.

CROSS-REPO SCOPE GAP (found running this detector live, 2026-09-02 -- read before adding
a third site or "fixing" a red otter-crm row)
  otter-crm is a SEPARATE private repo (StellarEdgeServices/otter-crm), not a directory
  inside otterquote-platform. The Code-lane GITHUB_PERSONAL_ACCESS_TOKEN available while
  building this is a fine-grained PAT scoped to otterquote-platform only --
  `GET /repos/StellarEdgeServices/otter-crm/commits/main` returned 404 with that token
  (fine-grained PATs 404 rather than 403 outside their granted repos, to avoid leaking
  which repos exist). The default `secrets.GITHUB_TOKEN` a workflow gets for free is
  scoped to the repo the workflow RUNS in (otterquote-platform) and cannot read a
  different private repo at all, regardless of fine-grained scoping. Until a secret with
  read access to BOTH repos exists, the otter-crm row will report UNMEASURED (github side)
  even though the Netlify side of that row is reachable -- this is an owner/unblock item,
  not a bug in this script. See RUN result below for the live measurement.

USAGE
  NETLIFY_PAT=... GITHUB_PERSONAL_ACCESS_TOKEN=... python scripts/netlify-deploy-drift.py
  python scripts/netlify-deploy-drift.py --json
  python scripts/netlify-deploy-drift.py --file-issue   # on BEHIND/BUILD_FAILING, comment
                                                          # on gh-1549 (the #1295 pattern:
                                                          # the alarm IS the comment)

  Options:
    --json          machine-readable {sites: [...], verdict, code, banner}. `banner`
                     carries the exact loud warning text text mode prints for a
                     non-clean run (null when every site is IDENTICAL) -- per gh-1501
                     comment 5509656183 ruling 2c, loudness must not be a function of
                     output format.
    --file-issue    On any site resolving to BEHIND or BUILD_FAILING, POST a comment to
                     issue #1549 with the full report. Requires GITHUB_TOKEN or
                     GITHUB_PERSONAL_ACCESS_TOKEN with `issues: write`. Without this flag
                     the script still exits non-zero on a bad result (loud in CI logs) but
                     never touches the issue tracker -- used for local/test invocations so
                     a manual run never spams the thread.

AUTH
  NETLIFY_PAT                    Netlify Personal Access Token. Per gh-1549's filing
                                  issue: lives in Doppler otterquote/prd, verified live
                                  (200 on /api/v1/user) 2026-09-02. Read from the
                                  environment only, never printed -- R-089.
  GITHUB_PERSONAL_ACCESS_TOKEN   Same env var name/convention as drift-detector-age.py.
                                  Needs read access to BOTH
                                  StellarEdgeServices/otterquote-platform AND
                                  StellarEdgeServices/otter-crm -- see CROSS-REPO SCOPE
                                  GAP above.
  GITHUB_TOKEN or
  GITHUB_PERSONAL_ACCESS_TOKEN   Either is accepted for --file-issue's comment POST
                                  (same fallback order as scripts/check-legal-surface-
                                  links.py's file_or_update_issue()).
  No credential value is ever printed, logged, or included in any exception message this
  script emits.

EXIT
  0  IDENTICAL for every site
  2  BEHIND or BUILD_FAILING for at least one site, and every site was measurable
  3  UNMEASURED for at least one site -- could not measure at all. This OUTRANKS 2: a run
     that could not check one site does not get to report the others' clean verdicts as if
     the whole run were trustworthy (same "could not measure outranks drift" ordering as
     edge-function-drift-check.py's report_exit_code()).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# ---------------------------------------------------------------------------
# Site table (gh-1549 issue body, verbatim site ids)
# ---------------------------------------------------------------------------

SITES = [
    {
        "key": "otterquote-platform",
        "label": "otterquote.com (jade-alpaca-b82b5e)",
        "site_id": "6748a414-1baa-4309-a5f9-f3a7f45e3d94",
        "repo": "StellarEdgeServices/otterquote-platform",
    },
    {
        "key": "otter-crm",
        "label": "otter-crm",
        "site_id": "d1b2efbd-8478-472f-8503-57cbdd5b36db",
        "repo": "StellarEdgeServices/otter-crm",
    },
]

ISSUE_REPO = "StellarEdgeServices/otterquote-platform"
ALARM_ISSUE_NUMBER = 1549

NETLIFY_TOKEN_ENV_VAR = "NETLIFY_PAT"
GITHUB_TOKEN_ENV_VAR = "GITHUB_PERSONAL_ACCESS_TOKEN"

TIMEOUT_SECONDS = 20

# Verdicts.
IDENTICAL = "IDENTICAL"
BEHIND = "BEHIND"
BUILD_FAILING = "BUILD_FAILING"
UNMEASURED = "UNMEASURED"

# Verdicts that represent a real, measured problem (as opposed to "could not measure").
FAILING_VERDICTS = {BEHIND, BUILD_FAILING}

# Netlify deploy states treated as a failing build/deploy attempt. "error" is the
# state observed live on gh-1549 (2026-09-02: 8 consecutive production deploy
# attempts over ~2h, every one state=error skipped=true, while published_deploy
# kept serving the last commit from before the lockout) -- this is exactly the
# #1548 shape this script exists to catch, not a one-off Netlify concurrency skip.
FAILING_DEPLOY_STATES = {"error"}


def _plural(n):
    return "commit" if n == 1 else "commits"


# ---------------------------------------------------------------------------
# Pure verdict layer -- no network, no clock. Given already-fetched data, decide.
# ---------------------------------------------------------------------------


def unmeasured_row(site, reason):
    return {
        "key": site["key"],
        "label": site["label"],
        "repo": site["repo"],
        "verdict": UNMEASURED,
        "detail": reason,
        "published_commit": None,
        "main_sha": None,
        "ahead_by": None,
        "since": None,
        "deploy_state": None,
        "deploy_error_message": None,
        "deploy_skipped": None,
    }


def evaluate_site(
    site,
    published_commit,
    published_at,
    main_sha,
    ahead_by,
    deploy_state,
    deploy_error_message,
    deploy_skipped,
):
    """Pure verdict logic given already-fetched fields. No network, no I/O.

    BUILD_FAILING is checked FIRST and independently of the sha compare -- see the
    module docstring's "TWO INDEPENDENT SIGNALS": a still-matching published_deploy
    must never hide a newer deploy attempt that is actively erroring.
    """
    row = {
        "key": site["key"],
        "label": site["label"],
        "repo": site["repo"],
        "published_commit": published_commit,
        "main_sha": main_sha,
        "ahead_by": ahead_by,
        "since": (published_at or "")[:10] or None,
        "deploy_state": deploy_state,
        "deploy_error_message": deploy_error_message,
        "deploy_skipped": deploy_skipped,
    }

    if deploy_state in FAILING_DEPLOY_STATES:
        detail = deploy_error_message or (
            "deploy state=%s skipped=%s, no error_message provided by the API"
            % (deploy_state, deploy_skipped)
        )
        row["verdict"] = BUILD_FAILING
        row["detail"] = detail
        return row

    if published_commit == main_sha:
        row["verdict"] = IDENTICAL
        row["detail"] = "production commit_ref matches main HEAD"
        return row

    row["verdict"] = BEHIND
    row["detail"] = "%d %s behind, since %s" % (ahead_by, _plural(ahead_by), row["since"])
    return row


def display_verdict(row):
    """The single human-readable verdict token, matching the gh-1549 issue's own
    display convention: IDENTICAL / BEHIND (N commits, since <date>) /
    BUILD_FAILING (<error>) / UNMEASURED (<reason>)."""
    v = row["verdict"]
    if v == IDENTICAL:
        return IDENTICAL
    return "%s (%s)" % (v, row["detail"])


def report_exit_code(rows):
    """0 clean | 2 measured problem | 3 could not measure.

    UNMEASURED outranks BEHIND/BUILD_FAILING: a run that could not check one site
    does not get to report the others' clean results as if the whole run were
    trustworthy -- same ordering as edge-function-drift-check.py's
    report_exit_code() ("'Could not measure' outranks 'drift'").
    """
    verdicts = {r["verdict"] for r in rows}
    if UNMEASURED in verdicts:
        return 3
    if verdicts & FAILING_VERDICTS:
        return 2
    return 0


def _banner_lines(rows, code):
    """Loud warning lines for a non-clean run (code != 0), or None when every site
    is IDENTICAL. Both text mode and --json build the banner from this single
    source so the loudness is never a function of output format (gh-1501 comment
    5509656183, ruling 2c)."""
    if code == 0:
        return None

    lines = ["  " + "!" * 70]
    if code == 3:
        lines += [
            "  >> UNMEASURED IS NOT A PASS. <<",
            "  At least one site could not be checked at all -- that is the exact blind",
            "  state #1548 and #1517 exposed: no alarm because nothing was measuring, not",
            "  because nothing was wrong. This is UNKNOWN, not verified-healthy.",
        ]
    else:
        lines += [
            "  >> NETLIFY PRODUCTION DEPLOY DRIFT. <<",
            "  At least one site's production deploy does not match `main`, or its build",
            "  pipeline is erroring. See the per-site detail below. Do not silently",
            "  redeploy everything -- diagnose the specific site (Netlify credit/billing,",
            "  cancelled builds, a stuck queue) the way #1548 and #1517 were each",
            "  diagnosed individually.",
        ]
    for r in rows:
        if r["verdict"] != IDENTICAL:
            lines.append("     %s: %s" % (r["label"], display_verdict(r)))
    lines.append("  " + "!" * 70)
    return lines


def render_text(rows, code):
    lines = ["NETLIFY PRODUCTION DEPLOY DRIFT   repo=%s" % ISSUE_REPO, ""]
    for r in rows:
        lines.append("  %-40s %s" % (r["label"], display_verdict(r)))
        if r["published_commit"] or r["main_sha"]:
            lines.append(
                "    production=%s  main=%s"
                % ((r["published_commit"] or "?")[:12], (r["main_sha"] or "?")[:12])
            )
    lines.append("")
    banner = _banner_lines(rows, code)
    if banner:
        lines.extend(banner)
    else:
        lines.append("Every site's production deploy is byte-for-commit identical to `main`.")
    return "\n".join(lines)


def render_json(rows, code):
    banner = _banner_lines(rows, code)
    verdict_names = {0: "CURRENT", 2: "DRIFTED", 3: "UNMEASURED"}
    return json.dumps(
        {
            "repo": ISSUE_REPO,
            "verdict": verdict_names[code],
            "code": code,
            "sites": rows,
            "banner": "\n".join(banner) if banner else None,
        },
        indent=2,
    )


# ---------------------------------------------------------------------------
# Issue comment (--file-issue), same shape as scripts/check-legal-surface-links.py's
# file_or_update_issue() -- the alarm is the comment, per the #1295 pattern.
# ---------------------------------------------------------------------------


def render_issue_comment_body(rows, code):
    lines = [
        "Automated Netlify production-deploy drift check (`scripts/netlify-deploy-drift.py`, gh-1549) "
        "found a problem:\n",
    ]
    for r in rows:
        if r["verdict"] != IDENTICAL:
            lines.append("- **%s** (`%s`): %s" % (r["label"], r["repo"], display_verdict(r)))
    lines.append(
        "\nDo not fix by redeploying everything blind -- diagnose the specific site "
        "(Netlify credit/billing, a cancelled build, a stuck queue) per #1548 / #1517."
    )
    return "\n".join(lines)


def post_issue_comment(body, timeout=TIMEOUT_SECONDS):
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get(GITHUB_TOKEN_ENV_VAR)
    if not token:
        print(
            "!! --file-issue requested but no GITHUB_TOKEN / %s in environment -- skipping comment"
            % GITHUB_TOKEN_ENV_VAR,
            file=sys.stderr,
        )
        return False
    req = urllib.request.Request(
        "https://api.github.com/repos/%s/issues/%d/comments" % (ISSUE_REPO, ALARM_ISSUE_NUMBER),
        data=json.dumps({"body": body}).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "User-Agent": "otterquote-netlify-drift-detector",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()
    except Exception as exc:  # noqa: BLE001 -- posting the comment must never crash the run
        print("!! failed to post comment on #%d: %s" % (ALARM_ISSUE_NUMBER, exc), file=sys.stderr)
        return False
    print("Posted drift report to issue #%d." % ALARM_ISSUE_NUMBER, file=sys.stderr)
    return True


# ---------------------------------------------------------------------------
# Fetch layer -- the only part that touches the network.
# ---------------------------------------------------------------------------


def _get_json(url, token, accept_github=False, timeout=TIMEOUT_SECONDS):
    """Shared GET-and-parse-JSON helper. Returns (data_or_None, reason)."""
    headers = {"User-Agent": "otterquote-netlify-drift-detector"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if accept_github:
        headers["Accept"] = "application/vnd.github+json"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        # Deliberately do not echo the response body -- may carry request metadata,
        # never anything an UNMEASURED reader needs beyond the status code.
        return None, "HTTP %s (%s) for %s" % (exc.code, exc.reason, url)
    except Exception as exc:  # noqa: BLE001 -- any failure here is UNMEASURED, not a crash
        return None, "%s: %s" % (type(exc).__name__, exc)
    try:
        return json.loads(raw), "ok"
    except Exception as exc:  # noqa: BLE001
        return None, "response from %s was not valid JSON: %s" % (url, exc)


def fetch_netlify_site(site_id, token):
    if not token:
        return None, "no %s found in the environment" % NETLIFY_TOKEN_ENV_VAR
    return _get_json("https://api.netlify.com/api/v1/sites/%s" % site_id, token)


def fetch_netlify_newest_production_deploy(site_id, token):
    if not token:
        return None, "no %s found in the environment" % NETLIFY_TOKEN_ENV_VAR
    data, reason = _get_json(
        "https://api.netlify.com/api/v1/sites/%s/deploys?production=true&per_page=10" % site_id,
        token,
    )
    if data is None:
        return None, reason
    if not isinstance(data, list) or not data:
        return None, "Netlify API reachable but returned zero production-context deploys"
    newest = max(data, key=lambda d: d.get("created_at") or "")
    return newest, "ok"


def fetch_github_main_sha(repo, token):
    if not token:
        return None, "no %s found in the environment" % GITHUB_TOKEN_ENV_VAR
    data, reason = _get_json(
        "https://api.github.com/repos/%s/commits/main" % repo, token, accept_github=True
    )
    if data is None:
        return None, reason
    sha = data.get("sha")
    if not sha:
        return None, "GitHub API response for %s commits/main had no sha" % repo
    return sha, "ok"


def fetch_github_ahead_by(repo, base_sha, head_sha, token):
    if base_sha == head_sha:
        return 0, "ok"  # identical -- no compare call needed
    if not token:
        return None, "no %s found in the environment" % GITHUB_TOKEN_ENV_VAR
    data, reason = _get_json(
        "https://api.github.com/repos/%s/compare/%s...%s" % (repo, base_sha, head_sha),
        token,
        accept_github=True,
    )
    if data is None:
        return None, reason
    ahead_by = data.get("ahead_by")
    if ahead_by is None:
        return None, "GitHub compare response for %s had no ahead_by" % repo
    return ahead_by, "ok"


def check_site(site, netlify_token, github_token):
    site_data, reason = fetch_netlify_site(site["site_id"], netlify_token)
    if site_data is None:
        return unmeasured_row(site, "Netlify site fetch failed: %s" % reason)

    published = site_data.get("published_deploy") or {}
    published_commit = published.get("commit_ref")
    published_at = published.get("published_at") or published.get("created_at")
    if not published_commit:
        return unmeasured_row(
            site, "site has no published_deploy.commit_ref (never deployed to production?)"
        )

    deploy_data, reason = fetch_netlify_newest_production_deploy(site["site_id"], netlify_token)
    if deploy_data is None:
        return unmeasured_row(site, "Netlify deploys fetch failed: %s" % reason)

    main_sha, reason = fetch_github_main_sha(site["repo"], github_token)
    if main_sha is None:
        return unmeasured_row(site, "GitHub main HEAD fetch failed: %s" % reason)

    ahead_by, reason = fetch_github_ahead_by(site["repo"], published_commit, main_sha, github_token)
    if ahead_by is None:
        return unmeasured_row(site, "GitHub compare failed: %s" % reason)

    return evaluate_site(
        site=site,
        published_commit=published_commit,
        published_at=published_at,
        main_sha=main_sha,
        ahead_by=ahead_by,
        deploy_state=deploy_data.get("state"),
        deploy_error_message=deploy_data.get("error_message"),
        deploy_skipped=deploy_data.get("skipped"),
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--file-issue", action="store_true")
    args = parser.parse_args()

    netlify_token = os.environ.get(NETLIFY_TOKEN_ENV_VAR, "").strip() or None
    github_token = os.environ.get(GITHUB_TOKEN_ENV_VAR, "").strip() or None

    rows = [check_site(site, netlify_token, github_token) for site in SITES]
    code = report_exit_code(rows)

    if args.json:
        print(render_json(rows, code))
    else:
        print(render_text(rows, code))

    if args.file_issue and any(r["verdict"] in FAILING_VERDICTS for r in rows):
        post_issue_comment(render_issue_comment_body(rows, code))

    return code


if __name__ == "__main__":
    sys.exit(main())
