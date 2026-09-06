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

HARDENING (gh-1549 CTO comment 5524997596, 2026-09-03 -- filed after the first shipped
version resolved UNMEASURED for 16h47m with nobody reading it, per "a shipped script is
not a mechanism; a firing one is")
  1. SITE ENUMERATION: sites are discovered from `GET /api/v1/sites`, filtered to
     build_settings.repo_url containing "StellarEdgeServices/", instead of a hardcoded
     pair. A hardcoded list is how a third site (otterquote-app, found 32h stale and
     named on no issue anywhere) goes unwatched. See filter_org_sites().
  2. QUEUED_STALE: a third independent signal alongside BEHIND/BUILD_FAILING -- a
     `/builds` entry with done=False, no error, and no deploy_id (never produced a
     deploy), older than --queued-stale-minutes (default 60). This is the #1517 shape
     neither existing signal catches: BUILD_FAILING reads the newest production
     *deploy*, and a build that produced none has nothing for it to fail on. See
     find_queued_stale_build().
  3. AUTO-TOPUP WARN: a WARN line, independent of any site's drift verdict and never
     affecting the exit code, when a Netlify account has auto_topup_enabled=False while
     has_stripe_payment_method=True -- read during the actual #1548 freeze, this was the
     field that carried the signal while every usage-exceeded array stayed `[]`. See
     find_auto_topup_warnings().

BASE-DIRECTORY SITES + NO-CONTENT CANCELS (gh-1549 CTO run cto-2026-09-05T03:07:58Z,
measured 2026-09-05T03:5xZ -- read before "fixing" a red otterquote-app row)
  otterquote-app (app.otterquote.com) builds from otterquote-platform with
  build_settings.base = "react-app". Netlify's default ignore-build rule cancels every
  commit that touches nothing under the base directory, and models that cancel as a
  production deploy with state "error" and error_message "Failed during stage 'checking
  build content for changes': Canceled build due to no content change". Two false alarms
  followed from reading that as a failure:
    - BUILD_FAILING fired on essentially every merge (5/5 recent production deploys
      carried that message; the automated 2026-09-04T12:44Z / 13:31Z / 19:00Z comments
      on gh-1549 are all this), which is how the next real alarm gets ignored.
    - BEHIND counted commits against `main` HEAD, so the row read "7 commits behind"
      while production was correctly at 3424c60b -- the LAST commit touching react-app/;
      the seven later commits touched only supabase/functions, scripts/ and .github/.
  So, for a site with a base directory:
    - "behind" is computed against the LAST `main` commit that touches the base directory
      (GET /repos/{repo}/commits?sha=main&path={base}&per_page=1), never `main` HEAD.
      See fetch_github_last_commit_touching(). A site with no base directory keeps the
      plain `main` HEAD compare -- every commit is buildable content for it.
    - a deploy whose error_message matches BENIGN_DEPLOY_ERROR_SUBSTRINGS is
      SKIPPED_NO_CONTENT: it is Netlify saying "nothing to build", not a build failure.
      It never yields BUILD_FAILING; the verdict falls through to the sha compare, and the
      newest NON-benign production deploy is the one BUILD_FAILING reads (a real error
      followed only by no-content cancels is still unresolved and still alarms). The
      match is on the MESSAGE, never on the site name -- a genuinely broken otterquote-app
      must still alarm.
    - the #1548 usage-exceeded skip stays BUILD_FAILING, loud (its literal message is the
      recorded fixture in netlify-deploy-drift.test.py). Dustin's ruling 2026-09-04 (gh-1549 comment 5545292885): auto-topup stays OFF --
      "Let it stop and alert me." -- so that class is the alarm that replaces the money.

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

  RECONFIRMED 2026-09-04 (gh-1549 dispatch rw-f22-20260904T182711-hxxv), because the same
  404 got mis-read a second time as "the repo doesn't exist": it does. Direct GitHub
  search with a broader-scoped credential (the GitHub MCP server's own token, not the
  Code-lane fine-grained PAT) finds `StellarEdgeServices/otter-crm` -- private,
  `created_at: 2026-07-30`, `pushed_at: 2026-09-03T14:44:35Z` -- and that push timestamp
  and commit sha (`9cf92d30...`) match this detector's own live UNMEASURED read for
  crm.otterquote.com's `published_deploy.commit_ref` exactly (see the automated comment
  on this issue at 2026-09-04T13:31:51Z). The repo is real, is the correct target, and is
  actively deployed; the 404 is the token-scope artifact described above, not a dead
  target. Do not "fix" this by repointing the checker at a different repo/owner/name --
  see fetch_github_main_sha()'s 404 annotation, which now says this inline so a future
  read of a bare UNMEASURED line doesn't reopen the same investigation from zero.

USAGE
  NETLIFY_PAT=... GITHUB_PERSONAL_ACCESS_TOKEN=... python scripts/netlify-deploy-drift.py
  python scripts/netlify-deploy-drift.py --json
  python scripts/netlify-deploy-drift.py --file-issue   # on BEHIND/BUILD_FAILING, comment
                                                          # on gh-1549 (the #1295 pattern:
                                                          # the alarm IS the comment)

  Options:
    --self-test     run the built-in fixture suite (no network, no credentials) and
                     exit 0/1. The full suite lives in netlify-deploy-drift.test.py; this
                     is the three-case regression for the base-directory / no-content
                     cancel / real-error shapes so it can run wherever the script is.
    --json          machine-readable {sites: [...], verdict, code, banner}. `banner`
                     carries the exact loud warning text text mode prints for a
                     non-clean run (null when every site is IDENTICAL) -- per gh-1501
                     comment 5509656183 ruling 2c, loudness must not be a function of
                     output format.
    --file-issue    On any site resolving to BEHIND, BUILD_FAILING, or QUEUED_STALE, POST
                     a comment to issue #1549 with the full report. Requires GITHUB_TOKEN
                     or GITHUB_PERSONAL_ACCESS_TOKEN with `issues: write`. Without this
                     flag the script still exits non-zero on a bad result (loud in CI
                     logs) but never touches the issue tracker -- used for local/test
                     invocations so a manual run never spams the thread.
    --queued-stale-minutes N
                     Age threshold in minutes for the QUEUED_STALE signal (default 60).

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
  2  BEHIND, BUILD_FAILING, or QUEUED_STALE for at least one site, and every site was
     measurable
  3  UNMEASURED for at least one site -- could not measure at all. This OUTRANKS 2: a run
     that could not check one site does not get to report the others' clean verdicts as if
     the whole run were trustworthy (same "could not measure outranks drift" ordering as
     edge-function-drift-check.py's report_exit_code()).

  The account-level auto-topup WARN (see HARDENING above) never affects this exit code by
  itself -- it is an advisory line, not a measured per-site verdict.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Site enumeration (gh-1549 CTO comment 5524997596, 2026-09-03): sites are now
# discovered from the Netlify API by build_settings.repo_url instead of hardcoded --
# see fetch_netlify_sites() / filter_org_sites() below. A hardcoded pair is how a
# third site (otterquote-app, discovered 32h stale and named on no issue anywhere)
# gets watched by nobody. As of this writing that enumeration yields:
#   jade-alpaca-b82b5e  (otterquote.com)          repo: otterquote-platform
#   otterquote-app      (app.otterquote.com)      repo: otterquote-platform
#   otter-crm           (crm.otterquote.com)      repo: otter-crm
# ---------------------------------------------------------------------------

REPO_OWNER_FILTER = "StellarEdgeServices/"

ISSUE_REPO = "StellarEdgeServices/otterquote-platform"
ALARM_ISSUE_NUMBER = 1549

NETLIFY_TOKEN_ENV_VAR = "NETLIFY_PAT"
GITHUB_TOKEN_ENV_VAR = "GITHUB_PERSONAL_ACCESS_TOKEN"

TIMEOUT_SECONDS = 20

DEFAULT_QUEUED_STALE_MINUTES = 60

# Verdicts.
IDENTICAL = "IDENTICAL"
BEHIND = "BEHIND"
BUILD_FAILING = "BUILD_FAILING"
QUEUED_STALE = "QUEUED_STALE"
UNMEASURED = "UNMEASURED"

# Verdicts that represent a real, measured problem (as opposed to "could not measure").
FAILING_VERDICTS = {BEHIND, BUILD_FAILING, QUEUED_STALE}

# Netlify deploy states treated as a failing build/deploy attempt. "error" is the
# state observed live on gh-1549 (2026-09-02: 8 consecutive production deploy
# attempts over ~2h, every one state=error skipped=true, while published_deploy
# kept serving the last commit from before the lockout) -- this is exactly the
# #1548 shape this script exists to catch, not a one-off Netlify concurrency skip.
FAILING_DEPLOY_STATES = {"error"}

# Netlify error_message fragments that mean "nothing to build", NOT "the build failed".
# Matched on the message, never on the site name (see BASE-DIRECTORY SITES + NO-CONTENT
# CANCELS in the module docstring). Measured verbatim 2026-09-05 on otterquote-app:
#   "Failed during stage 'checking build content for changes': Canceled build due to no
#    content change"
BENIGN_DEPLOY_ERROR_SUBSTRINGS = ("Canceled build due to no content change",)

# Row-level note for the benign shape -- a display token, not a verdict, so it never
# enters FAILING_VERDICTS and never shadows a real BUILD_FAILING / BEHIND.
SKIPPED_NO_CONTENT = "SKIPPED_NO_CONTENT"


def is_benign_deploy_error(error_message):
    """True when a deploy's error_message is Netlify's no-content cancel (see
    BENIGN_DEPLOY_ERROR_SUBSTRINGS). Pure, never raises."""
    msg = error_message or ""
    return any(frag in msg for frag in BENIGN_DEPLOY_ERROR_SUBSTRINGS)


def select_signal_deploy(deploys):
    """Pure: from a list of production-context deploys, pick the one BUILD_FAILING should
    read -- the NEWEST (by created_at) deploy whose error_message is NOT a benign
    no-content cancel. If every deploy is benign, the newest one is returned so the
    caller still sees its state/message (and evaluate_site() classifies it as
    SKIPPED_NO_CONTENT rather than BUILD_FAILING). Returns (deploy, benign_newer_count):
    benign_newer_count is how many benign cancels were newer than the chosen deploy, for
    the row's detail line. Returns (None, 0) for an empty list."""
    if not deploys:
        return None, 0
    ordered = sorted(deploys, key=lambda d: d.get("created_at") or "", reverse=True)
    benign_newer = 0
    for d in ordered:
        if is_benign_deploy_error(d.get("error_message")):
            benign_newer += 1
            continue
        return d, benign_newer
    return ordered[0], 0


def _plural(n):
    return "commit" if n == 1 else "commits"


def _format_minutes(total_minutes):
    """Human-readable duration for a QUEUED_STALE detail string. The #1517 shape sat
    for up to 14+ days, so this must scale past "N minutes" cleanly rather than
    printing e.g. "20160 min"."""
    total_minutes = int(total_minutes)
    if total_minutes < 60:
        return "%d min" % total_minutes
    hours, minutes = divmod(total_minutes, 60)
    if hours < 24:
        return "%dh%dm" % (hours, minutes)
    days, hours = divmod(hours, 24)
    return "%dd%dh" % (days, hours)


def _parse_iso8601(ts):
    """Best-effort ISO-8601 parse of a Netlify timestamp (e.g. "2026-08-20T19:45:55.000Z").
    Returns None (never raises) on anything unparseable -- an unparseable timestamp
    means "cannot age this build", not "assume it's fine"; callers treat None as
    excluding that build from staleness detection rather than crashing the run."""
    if not ts:
        return None
    s = ts.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        parsed = datetime.datetime.fromisoformat(s)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed


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
        "queued_stale_build_id": None,
        "base_dir": None,
        "base_head_sha": None,
        "main_ahead_of_production": None,
        "no_content_skip": False,
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
    queued_stale_build=None,
    base_dir=None,
    base_head_sha=None,
    main_ahead_of_production=None,
    benign_newer_count=0,
):
    """Pure verdict logic given already-fetched fields. No network, no I/O.

    base_dir / base_head_sha (BASE-DIRECTORY SITES in the module docstring): when the
    site builds from a base directory, `ahead_by` and the IDENTICAL/BEHIND compare are
    against base_head_sha -- the last `main` commit touching that directory -- and
    `main_sha` is reported for context only. When base_dir is None the compare target
    is `main_sha` exactly as before.

    A deploy_error_message matching BENIGN_DEPLOY_ERROR_SUBSTRINGS is SKIPPED_NO_CONTENT,
    never BUILD_FAILING: the verdict falls through to the sha compare and the row carries
    no_content_skip=True so the detail line says why the newest attempt "errored".

    Priority order (gh-1549 CTO comment 5524997596: three independent signals, none
    of which may shadow another into looking clean):
      1. BUILD_FAILING -- see the module docstring's "TWO INDEPENDENT SIGNALS": a
         still-matching published_deploy must never hide a newer deploy attempt
         that is actively erroring.
      2. QUEUED_STALE -- a build stuck in limbo (done=False, no error, no deploy
         produced) for longer than the staleness threshold. This is the #1517
         shape BUILD_FAILING cannot see: BUILD_FAILING reads the newest production
         DEPLOY, and a build that never produced one has no deploy to fail on.
      3. BEHIND / IDENTICAL -- the sha compare, as before.
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
        "queued_stale_build_id": None,
        "base_dir": base_dir or None,
        "base_head_sha": base_head_sha if base_dir else None,
        "main_ahead_of_production": main_ahead_of_production if base_dir else None,
        "no_content_skip": False,
    }

    benign = is_benign_deploy_error(deploy_error_message)
    if benign:
        row["no_content_skip"] = True

    if deploy_state in FAILING_DEPLOY_STATES and not benign:
        detail = deploy_error_message or (
            "deploy state=%s skipped=%s, no error_message provided by the API"
            % (deploy_state, deploy_skipped)
        )
        row["verdict"] = BUILD_FAILING
        row["detail"] = detail
        return row

    if queued_stale_build is not None:
        build_id = queued_stale_build.get("id") or "?"
        age = queued_stale_build.get("_age_minutes") or 0
        created_at = queued_stale_build.get("created_at") or "?"
        row["verdict"] = QUEUED_STALE
        row["detail"] = "build %s stuck %s (queued since %s), never started or failed" % (
            build_id,
            _format_minutes(age),
            created_at,
        )
        row["queued_stale_build_id"] = build_id
        return row

    compare_target = base_head_sha if base_dir else main_sha
    suffix = ""
    if benign or benign_newer_count:
        n = benign_newer_count or 1
        suffix = " (newest %d production deploy %s Netlify's no-content cancel: %s, not a build failure)" % (
            n,
            "attempt was" if n == 1 else "attempts were",
            SKIPPED_NO_CONTENT,
        )

    # ahead_by == 0 with differing shas means the compare target is already an ancestor
    # of what production serves (e.g. the last commit touching the base dir is a branch
    # commit whose merge commit is the one Netlify built) -- nothing is missing.
    if published_commit == compare_target or ahead_by == 0:
        row["verdict"] = IDENTICAL
        if base_dir:
            base_label = base_dir.rstrip("/") + "/"
            if published_commit == compare_target:
                head = "production commit_ref is the last main commit touching base dir %r" % base_label
            else:
                head = "production commit_ref already contains the last main commit touching base dir %r (%s)" % (
                    base_label, (compare_target or "?")[:12])
            past = main_ahead_of_production
            if past is not None:
                head += " -- main HEAD is %d %s past production, none touching the base dir" % (
                    past, _plural(past))
            row["detail"] = head + suffix
        else:
            row["detail"] = "production commit_ref matches main HEAD" + suffix
        return row

    row["verdict"] = BEHIND
    row["detail"] = "%d %s behind, since %s" % (ahead_by, _plural(ahead_by), row["since"])
    if base_dir:
        row["detail"] += " (counted against the last main commit touching base dir %r, not main HEAD)" % (
            base_dir.rstrip("/") + "/"
        )
    row["detail"] += suffix
    return row


def find_queued_stale_build(builds, now, stale_minutes=DEFAULT_QUEUED_STALE_MINUTES):
    """Pure function -- given already-fetched /builds entries, find the oldest build
    matching the #1517 QUEUED_STALE shape: done=False, no error, no deploy_id (never
    produced a deploy), and older than stale_minutes. Returns the matching build dict
    (with an added "_age_minutes" key) or None. No network, no clock reads -- `now`
    is passed in so this is fully testable.

    gh-1549 CTO comment 5524997596 (the live #1517 evidence -- build ids truncated
    here to keep this comment out of the repo's own credential-shape sweep, which
    treats a bare 20+ char hex run as a possible live secret; see the issue comment
    for the full ids):
        6a875972...4b70  done=False  err=  2026-08-20T19:45:55Z  (14+ days)
        6a84b513...39a8  done=False  err=  2026-08-18T19:40:03Z
        6a7e639d...492b  done=False  err=  2026-08-14T00:38:53Z
    "BUILD_FAILING reads the newest production deploy; these produced none, so it
    sees nothing to fail on."
    """
    stale = []
    for b in builds or []:
        if b.get("done") is not False:
            continue
        if b.get("error"):
            continue
        if b.get("deploy_id"):
            continue
        created = _parse_iso8601(b.get("created_at"))
        if created is None:
            continue
        age_minutes = (now - created).total_seconds() / 60.0
        if age_minutes >= stale_minutes:
            b = dict(b)
            b["_age_minutes"] = age_minutes
            stale.append(b)
    if not stale:
        return None
    # Oldest (most-stuck) first -- that is the most alarming single build to report.
    stale.sort(key=lambda b: b["_age_minutes"], reverse=True)
    return stale[0]


# ---------------------------------------------------------------------------
# Site enumeration -- pure filter/map layer (no network). gh-1549 CTO comment
# 5524997596: enumerate by build_settings.repo_url instead of a hardcoded table.
# ---------------------------------------------------------------------------


def _repo_from_repo_url(repo_url):
    """Extract "owner/repo" from a Netlify build_settings.repo_url, e.g.
    "https://github.com/StellarEdgeServices/otterquote-platform" or
    "git@github.com:StellarEdgeServices/otter-crm.git". Returns None for anything
    that doesn't look like a parseable GitHub URL (never raises)."""
    if not repo_url:
        return None
    url = repo_url.strip()
    if url.endswith(".git"):
        url = url[: -len(".git")]
    if "github.com" not in url:
        return None
    tail = url.split("github.com", 1)[1].lstrip(":/")
    parts = [p for p in tail.split("/") if p]
    if len(parts) < 2:
        return None
    return "%s/%s" % (parts[0], parts[1])


def filter_org_sites(raw_sites, owner_prefix=REPO_OWNER_FILTER):
    """Pure filter+map: raw Netlify /api/v1/sites entries -> this script's internal
    site dicts ({key, label, site_id, repo}), keeping only sites whose
    build_settings.repo_url belongs to the given GitHub org. No network, no I/O --
    fully testable. A site with no repo_url (not git-connected) or a repo_url this
    detector can't parse is silently excluded, not UNMEASURED -- it is not a site
    this detector's drift model applies to, not a measurement failure."""
    out = []
    for raw in raw_sites or []:
        build_settings = raw.get("build_settings") or {}
        repo_url = build_settings.get("repo_url")
        if not repo_url or owner_prefix not in repo_url:
            continue
        repo = _repo_from_repo_url(repo_url)
        if not repo:
            continue
        name = raw.get("name") or raw.get("id") or "unknown-site"
        domain = raw.get("custom_domain") or raw.get("default_domain")
        label = "%s (%s)" % (domain, name) if domain and domain != name else name
        out.append(
            {
                "key": name,
                "label": label,
                "site_id": raw.get("id"),
                "repo": repo,
            }
        )
    return out


# ---------------------------------------------------------------------------
# Account-level WARN (gh-1549 CTO comment 5524997596, item 3) -- independent of any
# site's drift verdict, never changes the run's exit code by itself.
# ---------------------------------------------------------------------------


def find_auto_topup_warnings(accounts):
    """Pure function -- one WARN line per Netlify account with auto_topup_enabled
    False while has_stripe_payment_method is True.

    "auto_topup_enabled == False on a Pro account with has_stripe_payment_method ==
    True is a standing alarm condition, not a state... the next depletion freezes
    every deploy again with no notice." (CTO comment 5524997596, item 3 -- read
    during the actual #1548 16h47m freeze, where usages_exceeded /
    sites_with_usage_exceeded / configurable_limits_exceeded were all `[]` the whole
    time; this is the field that actually carried the signal.)
    """
    warnings = []
    for acct in accounts or []:
        if acct.get("auto_topup_enabled") is False and acct.get("has_stripe_payment_method") is True:
            name = acct.get("name") or acct.get("slug") or acct.get("id") or "unknown account"
            warnings.append(
                'WARN: Netlify account "%s" has auto_topup disabled with a payment method '
                "on file -- the next usage-limit depletion freezes every deploy again with "
                "no notice (the #1548 shape)." % name
            )
    return warnings


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

    An EMPTY rows list is UNMEASURED too, not a vacuous clean pass (gh-1569 fresh-
    context review on PR #1569): `{r["verdict"] for r in []}` is the empty set,
    which contains neither UNMEASURED nor any FAILING_VERDICTS member, so the
    naive version of this function fell through to `return 0` for zero rows --
    the same defect class this repo's other detectors already guard against
    (an empty result set means "found nothing", never "found nothing wrong").
    Guarded here as a backstop regardless of caller; resolve_site_rows() is the
    primary fix and returns a descriptive UNMEASURED row explaining *why* there
    were zero sites, so this branch should not fire in the normal CLI path.
    """
    if not rows:
        return 3
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
            "  At least one site's production deploy does not match `main`, its build",
            "  pipeline is erroring, or a build has been queued for over an hour with no",
            "  deploy and no error. See the per-site detail below. Do not silently",
            "  redeploy everything -- diagnose the specific site (Netlify credit/billing,",
            "  cancelled builds, a stuck queue) the way #1548 and #1517 were each",
            "  diagnosed individually.",
        ]
    for r in rows:
        if r["verdict"] != IDENTICAL:
            lines.append("     %s: %s" % (r["label"], display_verdict(r)))
    lines.append("  " + "!" * 70)
    return lines


def render_text(rows, code, warnings=None):
    lines = ["NETLIFY PRODUCTION DEPLOY DRIFT   repo=%s" % ISSUE_REPO, ""]
    for r in rows:
        lines.append("  %-40s %s" % (r["label"], display_verdict(r)))
        if r["published_commit"] or r["main_sha"]:
            line = "    production=%s  main=%s" % (
                (r["published_commit"] or "?")[:12],
                (r["main_sha"] or "?")[:12],
            )
            if r.get("base_dir"):
                line += "  base=%s/  last-main-commit-touching-base=%s" % (
                    r["base_dir"].rstrip("/"),
                    (r.get("base_head_sha") or "?")[:12],
                )
            lines.append(line)
            if r["verdict"] == IDENTICAL and (r.get("base_dir") or r.get("no_content_skip")):
                lines.append("    %s" % r["detail"])
    lines.append("")
    banner = _banner_lines(rows, code)
    if banner:
        lines.extend(banner)
    else:
        lines.append("Every site's production deploy is byte-for-commit identical to `main`.")
    if warnings:
        # Account-level WARNs (gh-1549 item 3) are independent of drift verdicts and
        # never change `code` -- printed after the drift banner, never folded into it.
        lines.append("")
        lines.extend(warnings)
    return "\n".join(lines)


def render_json(rows, code, warnings=None):
    banner = _banner_lines(rows, code)
    verdict_names = {0: "CURRENT", 2: "DRIFTED", 3: "UNMEASURED"}
    return json.dumps(
        {
            "repo": ISSUE_REPO,
            "verdict": verdict_names[code],
            "code": code,
            "sites": rows,
            "banner": "\n".join(banner) if banner else None,
            "warnings": list(warnings) if warnings else [],
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
    # The newest NON-benign deploy is the signal (see select_signal_deploy); a copy is
    # returned carrying how many newer no-content cancels were skipped over.
    chosen, benign_newer = select_signal_deploy(data)
    chosen = dict(chosen)
    chosen["_benign_newer_count"] = benign_newer
    return chosen, "ok"


def _annotate_github_404(reason):
    """A GitHub 404 while fetching a site's configured repo is, per this script's
    CROSS-REPO SCOPE GAP note (module docstring, 2026-09-02, reconfirmed 2026-09-04),
    almost always a token-scope artifact and NOT evidence the repo is missing or
    misconfigured: GitHub's fine-grained PATs and repo-scoped GITHUB_TOKEN both
    return 404 rather than 403 for a repo outside their grant, specifically so an
    unauthorized caller cannot learn a private repo exists by seeing a 403 instead of
    a 404. That ambiguity is exactly what made the same otter-crm 404 get re-diagnosed
    as "the repo doesn't exist" a second time (gh-1549 dispatch 2026-09-04) even though
    it had already been confirmed real, private, and actively deployed. Say so inline
    so the next reader doesn't reopen that investigation from zero -- the fix for this
    shape is a credential with read access to the target repo, never a repo-pointer
    change in this script."""
    if reason.startswith("HTTP 404"):
        return (
            reason + " -- likely a cross-repo token-scope gap (fine-grained PATs and "
            "repo-scoped GITHUB_TOKEN 404 rather than 403 outside their grant), NOT "
            "evidence the repo is missing -- see CROSS-REPO SCOPE GAP in this script's "
            "module docstring before treating this as a dead target"
        )
    return reason


def fetch_github_main_sha(repo, token):
    if not token:
        return None, "no %s found in the environment" % GITHUB_TOKEN_ENV_VAR
    data, reason = _get_json(
        "https://api.github.com/repos/%s/commits/main" % repo, token, accept_github=True
    )
    if data is None:
        return None, _annotate_github_404(reason)
    sha = data.get("sha")
    if not sha:
        return None, "GitHub API response for %s commits/main had no sha" % repo
    return sha, "ok"


def fetch_github_last_commit_touching(repo, path, token, branch="main"):
    """The sha of the newest commit on `branch` that touches `path` (a directory or
    file) -- GET /repos/{repo}/commits?sha={branch}&path={path}&per_page=1. This is
    the compare target for a base-directory site: Netlify does not build commits
    that touch nothing under the base directory, so "behind main HEAD" is not a
    defect for such a site while "behind the last commit that touched the base
    directory" is. Returns (sha_or_None, reason)."""
    if not token:
        return None, "no %s found in the environment" % GITHUB_TOKEN_ENV_VAR
    data, reason = _get_json(
        "https://api.github.com/repos/%s/commits?sha=%s&path=%s&per_page=1"
        % (repo, urllib.parse.quote(branch, safe=""), urllib.parse.quote(path.strip("/"), safe="")),
        token,
        accept_github=True,
    )
    if data is None:
        return None, _annotate_github_404(reason)
    if not isinstance(data, list) or not data or not (data[0] or {}).get("sha"):
        return None, "GitHub API returned no commit on %s touching %r for %s" % (branch, path, repo)
    return data[0]["sha"], "ok"


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
        return None, _annotate_github_404(reason)
    ahead_by = data.get("ahead_by")
    if ahead_by is None:
        return None, "GitHub compare response for %s had no ahead_by" % repo
    return ahead_by, "ok"


def fetch_netlify_builds(site_id, token):
    if not token:
        return None, "no %s found in the environment" % NETLIFY_TOKEN_ENV_VAR
    return _get_json("https://api.netlify.com/api/v1/sites/%s/builds?per_page=20" % site_id, token)


_MAX_SITE_PAGES = 20  # guard, not a real-world expected count -- see fetch_netlify_sites


def fetch_netlify_sites(token, timeout=TIMEOUT_SECONDS):
    """Enumerate every site the token's Netlify account can see. Paginates -- a
    single-page call silently truncating as the account grows would reintroduce a
    smaller version of the exact bug this replaces (a hardcoded, stale site list)."""
    if not token:
        return None, "no %s found in the environment" % NETLIFY_TOKEN_ENV_VAR
    all_sites = []
    page = 1
    while True:
        data, reason = _get_json(
            "https://api.netlify.com/api/v1/sites?page=%d&per_page=100" % page,
            token,
            timeout=timeout,
        )
        if data is None:
            return None, reason
        if not isinstance(data, list):
            return None, "Netlify /sites response was not a list"
        all_sites.extend(data)
        if len(data) < 100:
            break
        page += 1
        if page > _MAX_SITE_PAGES:
            return None, "Netlify /sites pagination exceeded %d pages without terminating" % _MAX_SITE_PAGES
    return all_sites, "ok"


def fetch_netlify_accounts(token, timeout=TIMEOUT_SECONDS):
    if not token:
        return None, "no %s found in the environment" % NETLIFY_TOKEN_ENV_VAR
    return _get_json("https://api.netlify.com/api/v1/accounts", token, timeout=timeout)


def compute_account_warnings(netlify_token):
    """WARN lines for the run (gh-1549 item 3). Never raises, never affects the
    run's exit code -- a failure to even check account posture becomes a WARN line
    naming the failure, not a silent skip and not a fatal UNMEASURED (this is a
    billing-posture advisory, not a drift measurement)."""
    if not netlify_token:
        return [
            "WARN: could not check Netlify account auto-topup posture: no %s found in the "
            "environment" % NETLIFY_TOKEN_ENV_VAR
        ]
    accounts, reason = fetch_netlify_accounts(netlify_token)
    if accounts is None:
        return ["WARN: could not check Netlify account auto-topup posture: %s" % reason]
    return find_auto_topup_warnings(accounts)


def check_site(site, netlify_token, github_token, now=None, queued_stale_minutes=DEFAULT_QUEUED_STALE_MINUTES):
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

    builds_data, reason = fetch_netlify_builds(site["site_id"], netlify_token)
    if builds_data is None:
        return unmeasured_row(site, "Netlify builds fetch failed: %s" % reason)

    main_sha, reason = fetch_github_main_sha(site["repo"], github_token)
    if main_sha is None:
        return unmeasured_row(site, "GitHub main HEAD fetch failed: %s" % reason)

    # Base-directory sites (BASE-DIRECTORY SITES in the module docstring): the compare
    # target is the last main commit touching the base dir, read from the Netlify
    # site's own build_settings.base -- the same field Netlify's ignore rule uses.
    base_dir = ((site_data.get("build_settings") or {}).get("base") or "").strip().strip("/") or None
    base_head_sha = None
    main_ahead_of_production = None
    compare_target = main_sha
    if base_dir:
        base_head_sha, reason = fetch_github_last_commit_touching(site["repo"], base_dir, github_token)
        if base_head_sha is None:
            return unmeasured_row(
                site, "GitHub last-commit-touching base dir %r fetch failed: %s" % (base_dir, reason)
            )
        compare_target = base_head_sha
        # Context-only number for the detail line ("main HEAD is N past production");
        # a failure here never fails the measurement -- the row just omits it.
        main_ahead_of_production, _ctx_reason = fetch_github_ahead_by(
            site["repo"], published_commit, main_sha, github_token
        )

    ahead_by, reason = fetch_github_ahead_by(site["repo"], published_commit, compare_target, github_token)
    if ahead_by is None:
        return unmeasured_row(site, "GitHub compare failed: %s" % reason)

    queued_stale_build = find_queued_stale_build(
        builds_data,
        now or datetime.datetime.now(datetime.timezone.utc),
        stale_minutes=queued_stale_minutes,
    )

    return evaluate_site(
        site=site,
        published_commit=published_commit,
        published_at=published_at,
        main_sha=main_sha,
        ahead_by=ahead_by,
        deploy_state=deploy_data.get("state"),
        deploy_error_message=deploy_data.get("error_message"),
        deploy_skipped=deploy_data.get("skipped"),
        queued_stale_build=queued_stale_build,
        base_dir=base_dir,
        base_head_sha=base_head_sha,
        main_ahead_of_production=main_ahead_of_production,
        benign_newer_count=deploy_data.get("_benign_newer_count") or 0,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


_ENUMERATION_SITE = {
    "key": "site-enumeration",
    "label": "Netlify site enumeration (all sites)",
    "repo": ISSUE_REPO,
}


def resolve_site_rows(netlify_token, github_token, queued_stale_minutes=DEFAULT_QUEUED_STALE_MINUTES):
    """Enumerate sites and check each one -- or return a single explanatory
    UNMEASURED row when there is nothing to check. Never returns an empty list.

    gh-1569 fresh-context review (PR #1569): a SUCCESSFUL fetch whose org filter
    matches zero sites was flowing straight into `report_exit_code([])`, which
    returns 0 (clean) for an empty rows list -- an untested, unguarded path. A
    genuinely empty Netlify account is indistinguishable from a broken filter (a
    typo'd REPO_OWNER_FILTER, a Netlify-side account/team scoping change, a token
    swapped to one with visibility into a different account), so this must be
    UNMEASURED, never a silent pass. Same defect class this repo's other
    detectors already guard against: an empty result set is UNMEASURED, not a
    pass, because "found nothing wrong" and "found nothing" are not the same
    fact. Two distinct empty-result shapes, both handled here so `main()` (and
    any other caller) cannot skip this by construction:
      1. The enumeration fetch itself failed outright (no token, network, a bad
         response) -- fetch_netlify_sites() already returns None for this.
      2. The fetch succeeded but filter_org_sites() matched nothing.
    """
    raw_sites, reason = fetch_netlify_sites(netlify_token)
    if raw_sites is None:
        return [unmeasured_row(_ENUMERATION_SITE, "could not enumerate sites: %s" % reason)]

    sites = filter_org_sites(raw_sites)
    if not sites:
        return [
            unmeasured_row(
                _ENUMERATION_SITE,
                "Netlify fetch succeeded (%d site(s) returned) but zero matched the %r org "
                "filter -- a genuinely empty account is indistinguishable from a broken "
                "filter or a wrong-scope token, so this is UNMEASURED, not a clean pass"
                % (len(raw_sites), REPO_OWNER_FILTER),
            )
        ]

    return [
        check_site(site, netlify_token, github_token, queued_stale_minutes=queued_stale_minutes)
        for site in sites
    ]


def self_test():
    """Three-case regression for the 2026-09-05 fixes, runnable anywhere the script is
    (no network, no token): no-content cancel -> IDENTICAL; a real error (#1517's bare
    "Canceled build" bulk-sweep, and a build-script failure) -> BUILD_FAILING; genuinely
    behind -> BEHIND N. The values are the ones measured live on otterquote-app /
    otter-crm (gh-1549), not hand-imagined shapes. The #1548 usage-exceeded message is
    the recorded fixture in scripts/netlify-deploy-drift.test.py (the full suite), which
    CI runs on every change to this file."""
    site = {"key": "otterquote-app", "label": "app.otterquote.com (otterquote-app)",
            "repo": "StellarEdgeServices/otterquote-platform"}
    no_content = ("Failed during stage 'checking build content for changes': "
                  "Canceled build due to no content change")
    failures = []

    def expect(label, actual, wanted):
        ok = actual == wanted
        print("  %s  %s: %r" % ("PASS" if ok else "FAIL", label, actual))
        if not ok:
            failures.append(label)

    # 1. No-content cancel (measured 2026-09-05T04:31Z): production 3424c60b == last main
    #    commit touching react-app/; main HEAD cd89cfbf is 7 commits past production; newest
    #    deploy is the no-content cancel modelled as state=error.
    r = evaluate_site(site, "3424c60b608f", "2026-09-05T02:04:49Z", "cd89cfbff617", 0,
                      "error", no_content, None, base_dir="react-app",
                      base_head_sha="3424c60b608f", main_ahead_of_production=7)
    expect("no-content cancel on a base-dir site -> IDENTICAL", r["verdict"], IDENTICAL)
    expect("no-content cancel is flagged SKIPPED_NO_CONTENT, not BUILD_FAILING", r["no_content_skip"], True)
    expect("no-content cancel never enters FAILING_VERDICTS", r["verdict"] in FAILING_VERDICTS, False)
    # 2. A REAL error stays loud (Dustin: "Let it stop and alert me."). (a) otter-crm's
    #    bulk-swept "Canceled build" (#1517, 2026-08-24, verbatim) -- the bare message is
    #    NOT the benign no-content cancel and must still alarm; (b) a build-script failure.
    r = evaluate_site(site, "9cf92d30836a", "2026-09-03T11:23:11Z", "9cf92d30836a", 0,
                      "error", "Canceled build", None)
    expect("bare 'Canceled build' (#1517 bulk-sweep) -> BUILD_FAILING, not benign", r["verdict"], BUILD_FAILING)
    expect("bare 'Canceled build' detail is the message", r["detail"], "Canceled build")
    r = evaluate_site(site, "3424c60b608f", "2026-09-05T02:04:49Z", "cd89cfbff617", 0,
                      "error", "Build script returned non-zero exit code: 2", None,
                      base_dir="react-app", base_head_sha="3424c60b608f", main_ahead_of_production=7)
    expect("real build error on a base-dir site -> BUILD_FAILING (message-matched, not site-matched)",
           r["verdict"], BUILD_FAILING)
    # 3. Genuinely behind on a base-dir site: a later main commit DID touch react-app/,
    #    the newest deploy attempt is still a no-content cancel (or anything benign),
    #    production has not moved -> BEHIND N, counted against the base-dir head.
    r = evaluate_site(site, "3424c60b608f", "2026-09-05T02:04:49Z", "cd89cfbff617", 2,
                      "error", no_content, None, base_dir="react-app",
                      base_head_sha="deadbeef0001", main_ahead_of_production=1)
    expect("genuinely behind on a base-dir site -> BEHIND", r["verdict"], BEHIND)
    expect("BEHIND N counts against the base-dir head", r["detail"].startswith("2 commits behind, since 2026-09-05"), True)
    # 3b. Genuinely behind, no base dir (the #1517 shape) -> BEHIND 9.
    r = evaluate_site(site, "1" * 40, "2026-08-11T09:15:22Z", "2" * 40, 9, "ready", None, None)
    expect("genuinely behind, no base dir -> BEHIND 9", r["detail"], "9 commits behind, since 2026-08-11")
    # 4. Newest deploy benign but an older REAL error is unresolved -> the real one is the signal.
    d, n = select_signal_deploy([
        {"id": "c1", "state": "error", "created_at": "2026-09-05T04:18:48Z", "error_message": no_content},
        {"id": "real", "state": "error", "created_at": "2026-09-05T03:00:00Z",
         "error_message": "Canceled build"},
        {"id": "ok", "state": "ready", "created_at": "2026-09-05T02:04:49Z", "error_message": None},
    ])
    expect("select_signal_deploy skips newer no-content cancels to the real error", (d["id"], n), ("real", 1))
    d, n = select_signal_deploy([
        {"id": "c1", "state": "error", "created_at": "2026-09-05T04:18:48Z", "error_message": no_content},
        {"id": "c0", "state": "error", "created_at": "2026-09-05T03:19:31Z", "error_message": no_content},
    ])
    expect("select_signal_deploy with only benign deploys returns the newest benign one", (d["id"], n), ("c1", 0))

    if failures:
        print("SELF-TEST FAILED: %d assertion(s): %s" % (len(failures), ", ".join(failures)))
        return 1
    print("netlify-deploy-drift --self-test: all assertions passed.")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--file-issue", action="store_true")
    parser.add_argument(
        "--queued-stale-minutes",
        type=int,
        default=DEFAULT_QUEUED_STALE_MINUTES,
        help="Age threshold in minutes for the QUEUED_STALE signal (default: %(default)s)",
    )
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    netlify_token = os.environ.get(NETLIFY_TOKEN_ENV_VAR, "").strip() or None
    github_token = os.environ.get(GITHUB_TOKEN_ENV_VAR, "").strip() or None

    rows = resolve_site_rows(netlify_token, github_token, queued_stale_minutes=args.queued_stale_minutes)
    code = report_exit_code(rows)
    warnings = compute_account_warnings(netlify_token)

    if args.json:
        print(render_json(rows, code, warnings=warnings))
    else:
        print(render_text(rows, code, warnings=warnings))

    if args.file_issue and any(r["verdict"] in FAILING_VERDICTS for r in rows):
        post_issue_comment(render_issue_comment_body(rows, code))

    return code


if __name__ == "__main__":
    sys.exit(main())
