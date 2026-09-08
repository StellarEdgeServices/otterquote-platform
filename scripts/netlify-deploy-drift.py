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

EXPLICIT SITE CLASSIFICATION -- SIX SITES, NOT THREE (gh-1734, 2026-09-07)
  gh-1549's git-connected filter (see HARDENING item 1 above) was silently *correct* for
  the sites it counted and silently *wrong* about the ones it dropped: the live Netlify
  account holds SIX sites, not three, and the filter's criterion -- build_settings.repo_url
  present and StellarEdgeServices-owned -- is "is this site git-connected", never "does
  this site matter". filter_org_sites() is no longer a filter. It is now a full
  classifier: every raw site the Netlify API returns gets an entry in the module-level
  SITE_CLASSIFICATION table below, and every entry resolves to exactly one of:
    measured=True,  mode="git"           -- unchanged gh-1549 behavior: check_site(),
                                             sha-compare against `main` (or a base dir).
    measured=True,  mode="content-hash"  -- a non-git site with a real published surface:
                                             check_non_git_site(), see below.
    measured=False, mode=None            -- OUT OF SCOPE, with a reason recorded ON THE
                                             SITE'S ROW (not a filter dropping it silently).
    (no SITE_CLASSIFICATION entry at all) -- UNCLASSIFIED: resolves to an UNMEASURED row
                                             naming the site and demanding it be added to
                                             the table. A site Netlify returns that this
                                             script has never seen before FAILS LOUDLY
                                             (exit 3, same as any other UNMEASURED) instead
                                             of quietly not appearing in the output -- the
                                             exact shape gh-1734 was filed over.
  Live enumeration on 2026-09-07 (see the PR's pasted run): jade-alpaca-b82b5e, otterquote-
  app, and otter-crm are unchanged mode="git" sites. stohlerroof-bridge, fantastic-cactus-
  db1344, and fantastic-choux-4f510f were the three silently dropped by the old filter --
  build_settings.repo_url is null for all three (none are git-connected), which is why the
  old code's `if not repo_url: continue` swallowed them with no trace.

  NON-GIT SITE CHECK -- stohlerroof-bridge specifically (gh-1734 Do item 2)
  stohlerroof-bridge serves https://stohlerroof.com -- the D-174 bridge domain, carrying a
  mandatory legal disclosure, published 2026-04-21 per its own published_deploy and never
  since re-measured by anything in this company. It has no `main` to diff against (no
  repo_url at all), so "behind main HEAD" is not merely the wrong test for it, as it is for
  a base-directory site -- it is not a test that can even be constructed. The two
  independent signals used instead (see evaluate_non_git_site()):
    1. CONTENT hash -- the live published page (GET content_url, no Netlify auth needed;
       it's the public site) is sha256'd and compared against a pinned baseline stored in
       netlify-drift-fixtures/<site>.json. A mismatch is CONTENT_CHANGED: the page changed,
       intentionally or not, and nothing else in this company would have noticed either
       way. Updating the baseline is a deliberate, reviewed act (edit the fixture file),
       never an automatic "well it changed, must be fine" self-heal.
    2. AGE -- the currently PUBLISHED deploy's age (published_deploy.published_at) against
       a per-site max_age_days threshold (see DEFAULT_NON_GIT_MAX_AGE_DAYS and the
       SITE_CLASSIFICATION entry). Exceeding it is PUBLISH_STALE, independent of whether
       the content hash changed: a legal-disclosure surface nobody has looked at in months
       is itself the exposure named in gh-1734 ("we have not looked since April IS the
       exposure"), whether or not the copy happens to still be correct. 90 days (see the
       constant) approximates a quarterly review cadence -- there is no other documented
       cadence for this surface to anchor to; a lower number tightens sooner, a higher one
       loosens it, and either is a judgment call for whoever owns D-174's legal review, not
       a fact this script can derive. As of this writing stohlerroof-bridge's real deploy
       is already past 90 days (published 2026-04-21) -- the live run's PUBLISH_STALE
       verdict for it is the actual, current state, not a fixture.
  Both signals are reported together when both fire (see evaluate_non_git_site()'s combined
  detail string); neither shadows the other, same discipline as BUILD_FAILING vs BEHIND for
  git sites.

  fantastic-cactus-db1344 / fantastic-choux-4f510f -- MEASURED, content-hash (gh-1734
  fix-1, 2026-09-07; REVISED from this section's first pass)
  These two were first recorded OUT OF SCOPE ("no custom_domain, no repo_url... an
  unclaimed scratch/throwaway site, not a production or legally-loaded surface") on the
  strength of Netlify site metadata alone -- GET /api/v1/sites was checked; the pages
  themselves were never opened. A fresh-context refuter on PR #1779 opened both live
  URLs and found a full, GA4-tracked (G-JNQ6XR3LX2) "ClaimShield" storm-claim lead-
  generation landing page on each (two different copy variants of the same funnel, not
  duplicates), each with a working form whose JS POSTs email/name/zip directly to
  https://yeszghaspzwwstvsrioa.supabase.co/rest/v1/leads -- the PRODUCTION Supabase
  project (see this repo's memory: otterquote-supabase-project-refs) -- with no privacy-
  policy link (the page's only "Privacy" href is "#"). That is live, PII-collecting,
  prod-database-connected traffic, independently reconfirmed (not just inherited from
  the refuter) before this section and the SITE_CLASSIFICATION table below were rewritten
  -- see netlify-drift-fixtures/fantastic-cactus-db1344.json and
  fantastic-choux-4f510f.json's notes for the fetched evidence (GA4 id, POST target,
  dead privacy link, each page's own /upload CTA also live).

  "No custom_domain, no repo_url" was true and remains true -- it is real evidence
  against mode="git" (there is no repo to diff against) and always was. It was never
  evidence the pages don't matter, and treating "not git-connected" as "not a production
  surface" is the identical mistake gh-1734 was filed over for stohlerroof-bridge, just
  arrived at from the OUT_OF_SCOPE side instead of a silent drop. Per the dispatch that
  found this: "an explicit wrong reason is worse than the silent filter it replaces,
  because it looks decided." Both sites are now measured=True, mode="content-hash" --
  the same mechanism as stohlerroof-bridge, with content_url explicitly set (their
  default_domain, since neither has a custom_domain) and their own baseline fixture per
  site (the two pages' content differs, so one shared baseline would be wrong for at
  least one of them). max_age_days is 30 for both, deliberately tighter than
  stohlerroof-bridge's 90 -- an ACTIVE, currently-unowned, PII-collecting funnel with no
  visible privacy disclosure warrants closer review than a static legal-disclosure page;
  this is this worker's judgment call, not a derived fact, same caveat as
  DEFAULT_NON_GIT_MAX_AGE_DAYS's own paragraph above.

  This reclassification is a content/existence check only -- it fetches and hashes each
  page's own public HTML, the same as stohlerroof-bridge; it does not touch, read, query,
  or infer anything about rows actually written to the `leads` table by real visitors.
  Per the PR #1779 refuter and this fix: this is a finding LARGER than this script --
  a live, unmonitored, PII-collecting production surface with no privacy policy is worth
  a human (Dustin/CTO/legal) actually looking at ownership and disclosure, which a content
  hash cannot fix and was never meant to. If either site is later given a real
  custom_domain, or is retired, or is reassigned a documented owner, this table entry
  needs a human to notice and update it -- the script cannot detect that on its own.

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
                     invocations so a manual run never spams the thread. gh-1721: if the
                     POST itself fails (bad credential, wrong scope, network), that
                     failure is no longer a stderr-only side note -- it is folded into
                     `alarm_post_status`/`alarm_post_detail` in both output formats and
                     escalates the exit code to ALARM_POST_FAILED_EXIT (4). See EXIT
                     below.
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
  4  gh-1721: --file-issue was requested, a real problem was measured (code would
     otherwise be 2), and the redundant GitHub alarm-comment POST to issue #1549 itself
     FAILED (bad credential, wrong scope, network, etc.). This is deliberately a
     DIFFERENT number from 2, not merely "2 but read the log" -- the entire defect this
     exit code exists to end is that a failed POST used to be indistinguishable from a
     successful one because the drift's own exit code (2) fired either way and the
     failure was one `print(..., file=sys.stderr)` away from being unread. Never fires
     when code is 3 -- an UNMEASURED run already outranks everything above it and a
     differently-numbered escalation must not be layered on top of it and read as
     something else. See final_exit_code().

  The account-level auto-topup WARN (see HARDENING above) never affects this exit code by
  itself -- it is an advisory line, not a measured per-site verdict.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# Site enumeration (gh-1549 CTO comment 5524997596, 2026-09-03): sites are now
# discovered from the Netlify API by build_settings.repo_url instead of hardcoded --
# see fetch_netlify_sites() / filter_org_sites() below. A hardcoded pair is how a
# third site (otterquote-app, discovered 32h stale and named on no issue anywhere)
# gets watched by nobody.
#
# gh-1734, 2026-09-07: git-connectedness stopped being the classification criterion.
# filter_org_sites() now classifies EVERY site the account returns via the explicit
# SITE_CLASSIFICATION table below (see the module docstring's EXPLICIT SITE
# CLASSIFICATION section) -- as of this writing (gh-1734 fix-1, PR #1779 refuter blocker
# 1 addressed) that is:
#   jade-alpaca-b82b5e       measured, git             repo: otterquote-platform
#   otterquote-app           measured, git             repo: otterquote-platform
#   otter-crm                measured, git             repo: otter-crm
#   stohlerroof-bridge       measured, content-hash     stohlerroof.com (D-174 bridge)
#   fantastic-cactus-db1344  measured, content-hash     live ClaimShield lead funnel,
#                                                        posts to prod Supabase `leads`
#   fantastic-choux-4f510f   measured, content-hash     same funnel, different copy
#                                                        variant, same prod POST target
# All SIX sites are now measured=True -- none is OUT_OF_SCOPE as of this writing (that
# classification still exists in the code for a genuine future scratch site; see
# out_of_scope_row() and the OUT_OF_SCOPE verdict). A site absent from this table is
# UNCLASSIFIED and fails loudly (see resolve_site_rows()).
# ---------------------------------------------------------------------------

REPO_OWNER_FILTER = "StellarEdgeServices/"

ISSUE_REPO = "StellarEdgeServices/otterquote-platform"
ALARM_ISSUE_NUMBER = 1549

NETLIFY_TOKEN_ENV_VAR = "NETLIFY_PAT"
GITHUB_TOKEN_ENV_VAR = "GITHUB_PERSONAL_ACCESS_TOKEN"

TIMEOUT_SECONDS = 20

DEFAULT_QUEUED_STALE_MINUTES = 60

# gh-1734: default age threshold (days) for a non-git site's published deploy before
# PUBLISH_STALE fires -- see the module docstring's NON-GIT SITE CHECK section for why
# 90 (approximating a quarterly review) is the chosen default and not a derived fact.
DEFAULT_NON_GIT_MAX_AGE_DAYS = 90

# gh-1734: fixture files holding each content-hash site's pinned baseline sha256 live
# beside this script, one JSON file per site, named by SITE_CLASSIFICATION's
# "baseline_fixture" value. Loading one is I/O, so it happens in the fetch layer
# (_load_content_baseline / check_non_git_site), never inside the pure classify layer.
FIXTURES_DIR = pathlib.Path(__file__).resolve().parent / "netlify-drift-fixtures"

# Verdicts.
IDENTICAL = "IDENTICAL"
BEHIND = "BEHIND"
BUILD_FAILING = "BUILD_FAILING"
QUEUED_STALE = "QUEUED_STALE"
UNMEASURED = "UNMEASURED"
# gh-1734: non-git-site verdicts (see evaluate_non_git_site()).
CONTENT_VERIFIED = "CONTENT_VERIFIED"
CONTENT_CHANGED = "CONTENT_CHANGED"
PUBLISH_STALE = "PUBLISH_STALE"
# gh-1734: a site explicitly recorded as not measured, with a reason on its own row --
# never UNMEASURED (which means "could not measure"; this means "chose not to, and
# said why") and never silently absent from the output.
OUT_OF_SCOPE = "OUT_OF_SCOPE"

# Verdicts that represent a real, measured problem (as opposed to "could not measure").
FAILING_VERDICTS = {BEHIND, BUILD_FAILING, QUEUED_STALE, CONTENT_CHANGED, PUBLISH_STALE}

# Verdicts that are neither a failure nor a measurement gap -- excluded from the loud
# "here's what's wrong" banner/issue-comment listings alongside IDENTICAL (gh-1734:
# CONTENT_VERIFIED is content-hash's IDENTICAL; OUT_OF_SCOPE is a clean, explained
# non-measurement, not a concern to list when some OTHER site on the same run alarms).
CLEAN_VERDICTS = {IDENTICAL, CONTENT_VERIFIED, OUT_OF_SCOPE}

# gh-1734: explicit per-site classification -- see the module docstring's EXPLICIT SITE
# CLASSIFICATION section. Keyed by the Netlify site's "name" field (its stable API
# identifier, e.g. "otter-crm", "stohlerroof-bridge" -- NOT the custom_domain, which can
# change: jade-alpaca-b82b5e's custom_domain moved from otterquote.com to
# stellaredgeservices.com between gh-1549 and gh-1734 while its Netlify "name" did not).
# A site NOT in this table is UNCLASSIFIED (resolve_site_rows() fails it loudly).
SITE_CLASSIFICATION = {
    "jade-alpaca-b82b5e": {
        "measured": True,
        "mode": "git",
    },
    "otterquote-app": {
        "measured": True,
        "mode": "git",
    },
    "otter-crm": {
        "measured": True,
        "mode": "git",
    },
    "stohlerroof-bridge": {
        "measured": True,
        "mode": "content-hash",
        "reason": (
            "D-174 bridge domain (stohlerroof.com) carrying a mandatory legal "
            "disclosure; not git-connected (no repo_url), so measured via "
            "published-content hash + deploy-age instead of a `main` sha compare "
            "(gh-1734)."
        ),
        # No custom "content_url" override -- classify_sites() derives
        # https://<custom_domain>/ from the live Netlify site record, so a future
        # domain move (like jade-alpaca-b82b5e's) is picked up automatically.
        "baseline_fixture": "stohlerroof-bridge.json",
        "max_age_days": DEFAULT_NON_GIT_MAX_AGE_DAYS,
    },
    "fantastic-cactus-db1344": {
        # gh-1734 fix-1 (2026-09-07): REVERSED from the first pass at this table, which
        # recorded this site OUT_OF_SCOPE ("unclaimed scratch/throwaway... not a
        # production or legally-loaded surface") on the strength of Netlify metadata
        # alone (no custom_domain, no repo_url) -- WITHOUT opening the URL. A
        # fresh-context refuter on PR #1779 opened it and found a live, GA4-tracked
        # "ClaimShield" lead-capture landing page whose form POSTs email/name/zip
        # straight into the PRODUCTION Supabase project's `leads` table
        # (yeszghaspzwwstvsrioa), with no privacy-policy link. Independently
        # reconfirmed (not just inherited) before writing this entry -- see
        # netlify-drift-fixtures/fantastic-cactus-db1344.json's note for the full
        # evidence. That is the exact failure mode this dispatch was warned about: an
        # explicit wrong reason reads as a decision someone made, which is worse than
        # the silent filter it replaced. No custom_domain / no repo_url is still true
        # and still correctly rules out mode="git" -- it was never evidence the page
        # itself doesn't matter, and nothing here re-derives "not legally-loaded" from
        # Netlify metadata a second time.
        "measured": True,
        "mode": "content-hash",
        "reason": (
            "Live \"ClaimShield\" lead-generation landing page (GA4 G-JNQ6XR3LX2) "
            "whose form POSTs directly to the PRODUCTION Supabase project's `leads` "
            "table (yeszghaspzwwstvsrioa) -- confirmed live 2026-09-07 by opening the "
            "page and reading its own JS, not inferred from Netlify site metadata. No "
            "custom_domain / no repo_url (still true) rules out mode=\"git\", not "
            "measurement itself -- reclassified from OUT_OF_SCOPE to content-hash, the "
            "same mechanism as stohlerroof-bridge, so this surface is actually watched "
            "instead of silently exempted (gh-1734 fix-1, PR #1779 refuter blocker 1)."
        ),
        "content_url": "https://fantastic-cactus-db1344.netlify.app/",
        "baseline_fixture": "fantastic-cactus-db1344.json",
        # Tighter than stohlerroof-bridge's 90-day (quarterly) threshold: an ACTIVE,
        # currently-unowned PII-collecting funnel with no privacy policy warrants closer
        # review than a static legal-disclosure page. 30 (~monthly) is this worker's
        # judgment call, not a derived fact or a documented cadence -- same caveat as
        # DEFAULT_NON_GIT_MAX_AGE_DAYS's own: a real owner (CTO/legal/whoever owns this
        # funnel, once someone is found to own it) should set the real number.
        "max_age_days": 30,
    },
    "fantastic-choux-4f510f": {
        # gh-1734 fix-1 (2026-09-07): same reversal and same reasoning as
        # fantastic-cactus-db1344 immediately above -- see that entry's comment for the
        # full account. This site serves a DIFFERENT copy variant of the same live
        # ClaimShield funnel, POSTing to the same production `leads` table; both needed
        # their own reclassification and their own baseline fixture (a content-hash
        # check compares each site's own pinned baseline, and the two pages are not
        # byte-identical).
        "measured": True,
        "mode": "content-hash",
        "reason": (
            "Live \"ClaimShield\" lead-generation landing page (a different copy "
            "variant of fantastic-cactus-db1344's page; same GA4 id G-JNQ6XR3LX2, same "
            "production `leads` table POST target yeszghaspzwwstvsrioa) -- confirmed "
            "live 2026-09-07 by opening the page and reading its own JS. Reclassified "
            "from OUT_OF_SCOPE to content-hash for the same reason as "
            "fantastic-cactus-db1344 (gh-1734 fix-1, PR #1779 refuter blocker 1)."
        ),
        "content_url": "https://fantastic-choux-4f510f.netlify.app/",
        "baseline_fixture": "fantastic-choux-4f510f.json",
        "max_age_days": 30,
    },
}

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

# gh-1721: distinct exit code for "a real problem was measured AND the redundant
# GitHub alarm-comment POST itself failed" -- see final_exit_code() and the EXIT
# section of this module's docstring.
ALARM_POST_FAILED_EXIT = 4


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
        "content_sha256": None,
        "expected_sha256": None,
        "age_days": None,
    }


def out_of_scope_row(site, reason):
    """gh-1734: a site explicitly recorded as not measured, with the reason on the row
    itself -- the replacement for the old filter_org_sites() silently dropping it. Never
    UNMEASURED (that means "tried and failed to measure"; this means "chose not to, and
    said why on the row") and never a FAILING_VERDICTS member, so it can never turn a
    clean run non-zero by itself."""
    return {
        "key": site["key"],
        "label": site["label"],
        "repo": site.get("repo"),
        "verdict": OUT_OF_SCOPE,
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
        "content_sha256": None,
        "expected_sha256": None,
        "age_days": None,
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


def evaluate_non_git_site(site, content_sha256, expected_sha256, published_at, now, max_age_days):
    """Pure verdict logic for a non-git-connected site (gh-1734: stohlerroof-bridge, the
    D-174 bridge domain). No `main` exists for a site with no repo_url, so the two
    independent signals (see the module docstring's NON-GIT SITE CHECK section) are:
      1. CONTENT -- the live published page's sha256 vs. a pinned baseline. A mismatch is
         CONTENT_CHANGED regardless of age.
      2. AGE -- the published deploy's age vs. max_age_days. Exceeding it is PUBLISH_STALE
         regardless of whether the content hash still matches -- "nobody has looked in N
         days" is itself the alarm this issue exists to raise, independent of whether the
         copy happens to still be correct.
    Both are reported together when both fire (same non-shadowing discipline as
    BUILD_FAILING vs BEHIND for git sites). No network, no real clock -- content_sha256 /
    published_at / now are all passed in so this is fully testable without hitting the
    live site or the real clock.
    """
    row = {
        "key": site["key"],
        "label": site["label"],
        "repo": None,
        "published_commit": None,
        "main_sha": None,
        "ahead_by": None,
        "since": published_at.date().isoformat() if published_at else None,
        "deploy_state": None,
        "deploy_error_message": None,
        "deploy_skipped": None,
        "queued_stale_build_id": None,
        "base_dir": None,
        "base_head_sha": None,
        "main_ahead_of_production": None,
        "no_content_skip": False,
        "content_sha256": content_sha256,
        "expected_sha256": expected_sha256,
        "age_days": None,
    }

    age_days = None
    if published_at is not None and now is not None:
        age_days = (now - published_at).days
        row["age_days"] = age_days

    content_changed = bool(expected_sha256) and bool(content_sha256) and content_sha256 != expected_sha256
    stale = age_days is not None and max_age_days is not None and age_days > max_age_days

    if content_changed and stale:
        row["verdict"] = CONTENT_CHANGED
        row["detail"] = (
            "published content hash %s does not match baseline %s, AND the published "
            "deploy is %d days old (exceeds the %d-day threshold)"
            % ((content_sha256 or "?")[:12], (expected_sha256 or "?")[:12], age_days, max_age_days)
        )
        return row

    if content_changed:
        row["verdict"] = CONTENT_CHANGED
        row["detail"] = (
            "published content hash %s does not match baseline %s -- the published page "
            "has changed since the baseline was captured"
            % ((content_sha256 or "?")[:12], (expected_sha256 or "?")[:12])
        )
        return row

    if stale:
        row["verdict"] = PUBLISH_STALE
        row["detail"] = (
            "published deploy is %d days old (since %s), exceeds the %d-day review "
            "threshold -- content hash still matches baseline, but nobody has verified "
            "that in that long"
            % (age_days, row["since"], max_age_days)
        )
        return row

    row["verdict"] = CONTENT_VERIFIED
    detail = "published content hash matches baseline %s" % (expected_sha256 or "?")[:12]
    if age_days is not None:
        detail += "; published deploy is %d days old (threshold %d)" % (age_days, max_age_days)
    row["detail"] = detail
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


def filter_org_sites(raw_sites, owner_prefix=REPO_OWNER_FILTER, classification=None):
    """Pure classify+map: EVERY raw Netlify /api/v1/sites entry -> this script's internal
    site dict, via the explicit SITE_CLASSIFICATION table (gh-1734; see the module
    docstring's EXPLICIT SITE CLASSIFICATION section). No network, no I/O -- fully
    testable. This function used to silently drop any site with no (org-owned)
    build_settings.repo_url -- that silent drop is exactly what gh-1734 was filed over
    (stohlerroof-bridge, a legally-loaded surface, vanished with no trace). It no longer
    drops anything: every raw site gets exactly one output row, tagged with how (or
    whether) it is measured and why.

    Output dicts always carry: key, label, site_id, repo (may be None), measured (bool),
    mode ("git" | "content-hash" | None), reason (str or None -- required, and used
    verbatim on the row, when measured is False or mode is "content-hash").
    "content-hash" entries additionally carry content_url (derived from the site's own
    live custom_domain, so a future domain move is picked up automatically -- see
    jade-alpaca-b82b5e's otterquote.com -> stellaredgeservices.com move between gh-1549
    and gh-1734, which happened without anyone updating this script), baseline_fixture,
    and max_age_days.

    A raw site whose Netlify "name" has NO entry in `classification`
    (SITE_CLASSIFICATION by default) is UNCLASSIFIED: measured=False, mode="unclassified",
    reason names it and says it needs a SITE_CLASSIFICATION entry. resolve_site_rows()
    turns that into a loud UNMEASURED row (exit code 3) rather than letting it vanish --
    that fail-loud-on-the-unknown behavior is the actual fix gh-1734 asked for, item 3 of
    its Do section, and this is what makes it testable without a live Netlify account: add
    a site to the fixture raw_sites list that isn't in the classification table and assert
    it comes back "unclassified", not absent.

    `owner_prefix` is retained for a git-mode entry's own defensive check: if
    SITE_CLASSIFICATION claims mode="git" for a site whose live repo_url does not belong
    to `owner_prefix` (or is missing/unparseable), that is treated as unclassified too --
    the table can be wrong or stale even when a name lookup succeeds, and this function
    must never trust it blindly into producing a git compare against no repo.
    """
    table = SITE_CLASSIFICATION if classification is None else classification
    out = []
    for raw in raw_sites or []:
        name = raw.get("name") or raw.get("id") or "unknown-site"
        domain = raw.get("custom_domain") or raw.get("default_domain")
        label = "%s (%s)" % (domain, name) if domain and domain != name else name
        build_settings = raw.get("build_settings") or {}
        repo_url = build_settings.get("repo_url")
        repo = _repo_from_repo_url(repo_url) if repo_url else None

        entry = table.get(name)
        if entry is None:
            out.append(
                {
                    "key": name,
                    "label": label,
                    "site_id": raw.get("id"),
                    "repo": repo,
                    "measured": False,
                    "mode": "unclassified",
                    "reason": (
                        "no SITE_CLASSIFICATION entry for site %r -- gh-1734: a site "
                        "unknown to this table must fail loudly (UNMEASURED), never "
                        "vanish; add an explicit measured/mode/reason entry" % name
                    ),
                }
            )
            continue

        mode = entry.get("mode") if entry.get("measured") else None

        if mode == "git":
            org_owned = bool(repo) and owner_prefix in (repo_url or "")
            if not org_owned:
                out.append(
                    {
                        "key": name,
                        "label": label,
                        "site_id": raw.get("id"),
                        "repo": repo,
                        "measured": False,
                        "mode": "unclassified",
                        "reason": (
                            "SITE_CLASSIFICATION lists %r as mode=git but its live "
                            "repo_url (%r) is missing or does not belong to %r -- "
                            "treating as unclassified rather than trusting a stale "
                            "table entry into a bad compare" % (name, repo_url, owner_prefix)
                        ),
                    }
                )
                continue
            out.append(
                {
                    "key": name,
                    "label": label,
                    "site_id": raw.get("id"),
                    "repo": repo,
                    "measured": True,
                    "mode": "git",
                    "reason": None,
                }
            )
            continue

        if mode == "content-hash":
            content_url = entry.get("content_url") or (
                "https://%s/" % domain if domain else None
            )
            out.append(
                {
                    "key": name,
                    "label": label,
                    "site_id": raw.get("id"),
                    "repo": repo,
                    "measured": True,
                    "mode": "content-hash",
                    "reason": entry.get("reason"),
                    "content_url": content_url,
                    "baseline_fixture": entry.get("baseline_fixture"),
                    "max_age_days": entry.get("max_age_days") or DEFAULT_NON_GIT_MAX_AGE_DAYS,
                }
            )
            continue

        # measured=False (explicit out-of-scope) or an unrecognized mode string.
        out.append(
            {
                "key": name,
                "label": label,
                "site_id": raw.get("id"),
                "repo": repo,
                "measured": bool(entry.get("measured")),
                "mode": mode,
                "reason": entry.get("reason") or "OUT OF SCOPE: no reason recorded in SITE_CLASSIFICATION",
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
    BUILD_FAILING (<error>) / UNMEASURED (<reason>). gh-1734 additions:
    CONTENT_VERIFIED (content-hash's IDENTICAL) is bare like IDENTICAL;
    CONTENT_CHANGED / PUBLISH_STALE follow the normal "VERDICT (detail)" shape;
    OUT_OF_SCOPE uses the issue's own literal wording, "OUT OF SCOPE: <reason>" --
    per gh-1734's closes-on, every omitted site's row must read exactly that way."""
    v = row["verdict"]
    if v == IDENTICAL:
        return IDENTICAL
    if v == OUT_OF_SCOPE:
        return "OUT OF SCOPE: %s" % row["detail"]
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


def final_exit_code(code, alarm_post_status):
    """gh-1721: escalate report_exit_code()'s plain 0/2/3 to ALARM_POST_FAILED_EXIT (4)
    when --file-issue was requested, a real problem was measured (code == 2), and the
    redundant GitHub alarm-comment POST itself failed. This is the "fail loudly, not
    fail quietly" fix for the swallow: before this function existed, a failed POST was
    a single stderr print that never changed the run's outcome, so a broken alarm
    channel looked identical to a working one from the exit code alone.

    Deliberately does NOT escalate a code == 3 (UNMEASURED) run: UNMEASURED already
    outranks a measured drift in report_exit_code()'s own ordering ("could not measure
    outranks drift"), and layering a differently-numbered escalation on top of it would
    make code 4 ambiguous between "drift confirmed, alarm broken" (what it means) and
    "couldn't even measure, and also the alarm broke" (a different, less certain
    situation that 3 already covers). alarm_post_status is None when --file-issue was
    not requested or no failing verdict existed to report -- never escalates then."""
    if code == 2 and alarm_post_status == "failed":
        return ALARM_POST_FAILED_EXIT
    return code


def _banner_lines(rows, code, alarm_post_status=None, alarm_post_detail=None):
    """Loud warning lines for a non-clean run (code != 0), or None when every site
    is IDENTICAL. Both text mode and --json build the banner from this single
    source so the loudness is never a function of output format (gh-1501 comment
    5509656183, ruling 2c).

    alarm_post_status is None (not requested / no failing verdict), "posted", or
    "failed" -- when "failed", a SECOND loud section is appended (gh-1721) even on a
    run that already had a banner for another reason, and a banner is fabricated even
    for an otherwise-code-0 run so a failed alarm POST is never silent just because
    render_text/_json's caller only looks at the banner for non-clean runs."""
    lines = []
    if code != 0:
        lines.append("  " + "!" * 70)
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
            # gh-1734: CONTENT_VERIFIED and OUT_OF_SCOPE are clean/explained, not concerns --
            # excluded here the same as IDENTICAL so a real alarm elsewhere on the run doesn't
            # drag an explained non-measurement into the "here's what's wrong" list.
            if r["verdict"] not in CLEAN_VERDICTS:
                lines.append("     %s: %s" % (r["label"], display_verdict(r)))
        lines.append("  " + "!" * 70)

    if alarm_post_status == "failed":
        # gh-1721: the redundant GitHub alarm comment (the #1295 pattern -- the alarm
        # IS the comment) failed to post. This is worth its own loud section
        # independent of `code`'s banner above -- a swallowed POST failure here was the
        # entire defect this section exists to prevent from repeating.
        lines.append("  " + "!" * 70)
        lines += [
            "  >> THE REDUNDANT GITHUB ALARM COMMENT FAILED TO POST. <<",
            "  --file-issue attempted to comment on issue #%d and the POST itself failed:"
            % ALARM_ISSUE_NUMBER,
            "    %s" % (alarm_post_detail or "(no detail captured)"),
            "  The primary channel (this run's own non-zero exit code) still fired, but",
            "  the redundant comment channel did not -- fix the credential/scope for the",
            "  POST, do not assume the drift itself is unreal because this section fired.",
        ]
        lines.append("  " + "!" * 70)

    return lines or None


def render_text(rows, code, warnings=None, alarm_post_status=None, alarm_post_detail=None):
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
        elif r.get("content_sha256") or r.get("expected_sha256"):
            # gh-1734: non-git content-hash site -- no commit shas to show, but the
            # content hash / baseline / age are the equivalent "what did we compare"
            # detail line the git rows get above.
            lines.append(
                "    content=%s  baseline=%s  age_days=%s"
                % (
                    (r.get("content_sha256") or "?")[:12],
                    (r.get("expected_sha256") or "?")[:12],
                    r.get("age_days") if r.get("age_days") is not None else "?",
                )
            )
    lines.append("")
    banner = _banner_lines(rows, code, alarm_post_status, alarm_post_detail)
    if banner:
        lines.extend(banner)
    else:
        lines.append("Every site's production deploy is byte-for-commit identical to `main`.")
    if alarm_post_status is not None:
        lines.append("")
        lines.append(
            "Alarm comment (issue #%d): %s%s"
            % (
                ALARM_ISSUE_NUMBER,
                alarm_post_status,
                (" -- %s" % alarm_post_detail) if alarm_post_detail else "",
            )
        )
    if warnings:
        # Account-level WARNs (gh-1549 item 3) are independent of drift verdicts and
        # never change `code` -- printed after the drift banner, never folded into it.
        lines.append("")
        lines.extend(warnings)
    return "\n".join(lines)


def render_json(rows, code, warnings=None, alarm_post_status=None, alarm_post_detail=None):
    banner = _banner_lines(rows, code, alarm_post_status, alarm_post_detail)
    verdict_names = {0: "CURRENT", 2: "DRIFTED", 3: "UNMEASURED"}
    return json.dumps(
        {
            "repo": ISSUE_REPO,
            "verdict": verdict_names[code],
            "code": code,
            "sites": rows,
            "banner": "\n".join(banner) if banner else None,
            "warnings": list(warnings) if warnings else [],
            # gh-1721: None = --file-issue not requested or no failing verdict to
            # report; "posted" / "failed" otherwise. Never omitted when attempted --
            # a failed POST must be visible in the machine-readable report too, not
            # just the human banner.
            "alarm_post_status": alarm_post_status,
            "alarm_post_detail": alarm_post_detail,
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
        if r["verdict"] not in CLEAN_VERDICTS:
            lines.append("- **%s** (`%s`): %s" % (r["label"], r["repo"], display_verdict(r)))
    lines.append(
        "\nDo not fix by redeploying everything blind -- diagnose the specific site "
        "(Netlify credit/billing, a cancelled build, a stuck queue) per #1548 / #1517."
    )
    return "\n".join(lines)


def post_issue_comment(body, timeout=TIMEOUT_SECONDS):
    """POST the drift report as a comment on ALARM_ISSUE_NUMBER.

    Returns (success, detail): detail is the comment's html_url on success, or a
    human-readable failure reason on failure. NEVER just a bare bool (gh-1721) --
    this function's only caller, main(), folds `detail` into the run's own JSON/text
    report AND into its exit code (see ALARM_POST_FAILED_EXIT / final_exit_code()) so
    a failed POST cannot be a print-to-stderr-and-forget: the #1295 pattern is that the
    alarm IS the comment, and an alarm channel that can silently fail to fire is the
    same defect class as no alarm at all. Never raises -- posting the comment must
    never crash the run."""
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get(GITHUB_TOKEN_ENV_VAR)
    if not token:
        reason = "no GITHUB_TOKEN / %s in environment -- skipping comment" % GITHUB_TOKEN_ENV_VAR
        print("!! --file-issue requested but %s" % reason, file=sys.stderr)
        return False, reason
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
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        # Deliberately do not echo the response body -- may carry request metadata.
        reason = "HTTP %s (%s) posting comment on #%d" % (exc.code, exc.reason, ALARM_ISSUE_NUMBER)
        print("!! failed to post comment on #%d: %s" % (ALARM_ISSUE_NUMBER, reason), file=sys.stderr)
        return False, reason
    except Exception as exc:  # noqa: BLE001 -- posting the comment must never crash the run
        reason = "%s: %s" % (type(exc).__name__, exc)
        print("!! failed to post comment on #%d: %s" % (ALARM_ISSUE_NUMBER, reason), file=sys.stderr)
        return False, reason
    html_url = None
    try:
        html_url = json.loads(raw.decode("utf-8")).get("html_url")
    except Exception:  # noqa: BLE001 -- a parse failure here doesn't change that the POST succeeded
        pass
    detail = html_url or "posted (no html_url in response)"
    print("Posted drift report to issue #%d: %s" % (ALARM_ISSUE_NUMBER, detail), file=sys.stderr)
    return True, detail


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


def fetch_url_content(url, timeout=TIMEOUT_SECONDS):
    """gh-1734: GET a public URL directly (no Netlify/GitHub auth -- it's the live public
    site) and return (raw_bytes_or_None, reason). This is the content half of a non-git
    site's two signals: the live page's bytes ARE the measurement, there being no `main`
    to diff against instead."""
    req = urllib.request.Request(url, headers={"User-Agent": "otterquote-netlify-drift-detector"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read(), "ok"
    except urllib.error.HTTPError as exc:
        return None, "HTTP %s (%s) for %s" % (exc.code, exc.reason, url)
    except Exception as exc:  # noqa: BLE001 -- any failure here is UNMEASURED, not a crash
        return None, "%s: %s" % (type(exc).__name__, exc)


def _load_content_baseline(fixture_filename, fixtures_dir=None):
    """gh-1734: load a non-git site's pinned baseline sha256 from its fixture JSON file
    (fixtures_dir / fixture_filename). Returns (sha256_or_None, reason). Reading it is
    itself a measured step -- a missing or malformed fixture is UNMEASURED for that site,
    same fail-loud discipline as every other fetch in this script, never a silent skip.
    Updating the baseline (a deliberate content change to the disclosure page) means
    editing the fixture file, reviewed like any other change -- never automatic.

    `fixtures_dir` defaults to None (resolved to the module-level FIXTURES_DIR INSIDE the
    function body, not as a bound default value) deliberately -- a `def f(x=FIXTURES_DIR)`
    default is evaluated once at import time and stays bound to that value forever, so a
    test (or a caller) monkeypatching `module.FIXTURES_DIR` would silently have no effect
    on calls that omit the argument. Resolving it at call time is what makes
    check_non_git_site()'s own fixtures_dir passthrough actually testable.

    gh-1734 fix-1 briefly stored this as `expected_sha256_parts` -- short hex fragments
    joined at load time -- to dodge scripts/credential-sweep.py's HEX_RUN_20 pattern
    (`\\b[0-9a-fA-F]{20,}\\b`), which flags a bare 64-char hash literal. gh-1734 fix-2
    reverted that: a fresh-context re-reviewer correctly called it a working, generalizable
    technique for defeating a credential-shape detector on real (non-test) fixture data,
    landed for scope-convenience rather than through the sweep's own sanctioned escape
    hatch. The fixture now stores the plain 64-char `expected_sha256` value, and
    scripts/credential-sweep-allowlist.txt carries one `value:` entry per fixture's hash
    (see that file for the inline justification) -- visible, greppable, and audited the
    same way the repo's existing SRI-hash and commit-sha entries are, instead of hidden
    behind a reconstruction the sweep can no longer see at all."""
    if fixtures_dir is None:
        fixtures_dir = FIXTURES_DIR
    if not fixture_filename:
        return None, "no baseline_fixture configured for this site"
    path = pathlib.Path(fixtures_dir) / fixture_filename
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:  # noqa: BLE001 -- a bad fixture is UNMEASURED, not a crash
        return None, "could not read baseline fixture %s: %s" % (path, exc)

    sha = data.get("expected_sha256")
    if not sha:
        return None, "baseline fixture %s has no expected_sha256" % path
    if len(sha) != 64:
        return None, "baseline fixture %s's expected_sha256 is not 64 chars (got %d)" % (path, len(sha))
    try:
        int(sha, 16)  # validates hex without a literal hex-charset string (see below)
    except ValueError:
        return None, "baseline fixture %s's expected_sha256 is not valid hex" % path
    # Deliberately validated via int(sha, 16) rather than a literal hex-digit charset
    # string -- writing out all 16 hex digits twice (upper and lower case) as one
    # quoted literal is itself 20+ contiguous hex-shaped characters, exactly the
    # scripts/credential-sweep.py HEX_RUN_20 shape this whole function exists to keep
    # the fixtures from tripping (found writing this function: the charset-literal
    # version fired the sweep on ITSELF, at this very line).
    return sha, "ok"


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


def check_non_git_site(site, netlify_token, now=None, timeout=TIMEOUT_SECONDS,
                        fixtures_dir=None):
    """gh-1734: check_site()'s counterpart for a non-git site (stohlerroof-bridge). Fetch
    layer only -- delegates the actual verdict to evaluate_non_git_site(). Every fetch
    step here follows the same fail-loud discipline as check_site(): any failure resolves
    UNMEASURED, never a silent pass and never a crash.

    `fixtures_dir` defaults to None, resolved to the module-level FIXTURES_DIR inside the
    body (see _load_content_baseline()'s docstring for why -- a bound default would make
    monkeypatching FIXTURES_DIR silently not apply to callers, like resolve_site_rows(),
    that omit this argument)."""
    if fixtures_dir is None:
        fixtures_dir = FIXTURES_DIR
    now = now or datetime.datetime.now(datetime.timezone.utc)

    site_data, reason = fetch_netlify_site(site["site_id"], netlify_token)
    if site_data is None:
        return unmeasured_row(site, "Netlify site fetch failed: %s" % reason)

    published = site_data.get("published_deploy") or {}
    published_at_raw = published.get("published_at") or published.get("created_at")
    published_at = _parse_iso8601(published_at_raw)
    if published_at is None:
        return unmeasured_row(
            site, "site has no parseable published_deploy timestamp (never published?)"
        )

    content_url = site.get("content_url")
    if not content_url:
        return unmeasured_row(
            site, "no content_url configured for this non-git site (see SITE_CLASSIFICATION)"
        )

    raw_content, reason = fetch_url_content(content_url, timeout=timeout)
    if raw_content is None:
        return unmeasured_row(site, "published-page fetch failed: %s" % reason)
    content_sha256 = hashlib.sha256(raw_content).hexdigest()

    expected_sha256, reason = _load_content_baseline(
        site.get("baseline_fixture"), fixtures_dir=fixtures_dir
    )
    if expected_sha256 is None:
        return unmeasured_row(site, reason)

    max_age_days = site.get("max_age_days") or DEFAULT_NON_GIT_MAX_AGE_DAYS

    return evaluate_non_git_site(
        site=site,
        content_sha256=content_sha256,
        expected_sha256=expected_sha256,
        published_at=published_at,
        now=now,
        max_age_days=max_age_days,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


_ENUMERATION_SITE = {
    "key": "site-enumeration",
    "label": "Netlify site enumeration (all sites)",
    "repo": ISSUE_REPO,
}


def resolve_site_rows(netlify_token, github_token, queued_stale_minutes=DEFAULT_QUEUED_STALE_MINUTES,
                       now=None):
    """Enumerate sites, classify every one (filter_org_sites()), and check each one
    according to its classification -- or return a single explanatory UNMEASURED row
    when there is nothing to check. Never returns an empty list, and gh-1734: never
    drops a site silently -- every raw Netlify site resolves to exactly one output row,
    whether that is a real measured verdict, an OUT_OF_SCOPE row with its reason, or (for
    a site with no SITE_CLASSIFICATION entry at all) a loud UNMEASURED row demanding it be
    classified.

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
      2. The fetch succeeded but the Netlify account itself returned zero sites (gh-1734:
         filter_org_sites() no longer drops sites, so a non-empty raw_sites list always
         produces at least that many rows -- this branch now only guards a genuinely
         empty account, not a broken filter).
    """
    raw_sites, reason = fetch_netlify_sites(netlify_token)
    if raw_sites is None:
        return [unmeasured_row(_ENUMERATION_SITE, "could not enumerate sites: %s" % reason)]

    classified = filter_org_sites(raw_sites)
    if not classified:
        return [
            unmeasured_row(
                _ENUMERATION_SITE,
                "Netlify fetch succeeded but returned zero sites at all -- a genuinely "
                "empty account is indistinguishable from a wrong-scope token, so this is "
                "UNMEASURED, not a clean pass",
            )
        ]

    rows = []
    for site in classified:
        if not site.get("measured"):
            if site.get("mode") == "unclassified":
                rows.append(unmeasured_row(site, site.get("reason")))
            else:
                rows.append(out_of_scope_row(site, site.get("reason")))
            continue

        mode = site.get("mode")
        if mode == "git":
            rows.append(
                check_site(
                    site, netlify_token, github_token, now=now,
                    queued_stale_minutes=queued_stale_minutes,
                )
            )
        elif mode == "content-hash":
            rows.append(check_non_git_site(site, netlify_token, now=now))
        else:
            rows.append(
                unmeasured_row(
                    site,
                    "SITE_CLASSIFICATION entry has measured=True but an unrecognized "
                    "mode %r -- this is a bug in the table, not a missing entry" % mode,
                )
            )
    return rows


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

    # gh-1721: the alarm POST's own outcome is now first-class in the report, not a
    # stderr-only side effect -- alarm_post_status is None unless --file-issue was
    # requested AND a failing verdict actually triggered an attempt.
    alarm_post_status = None
    alarm_post_detail = None
    if args.file_issue and any(r["verdict"] in FAILING_VERDICTS for r in rows):
        posted, detail = post_issue_comment(render_issue_comment_body(rows, code))
        alarm_post_status = "posted" if posted else "failed"
        alarm_post_detail = detail

    if args.json:
        print(render_json(rows, code, warnings=warnings,
                           alarm_post_status=alarm_post_status, alarm_post_detail=alarm_post_detail))
    else:
        print(render_text(rows, code, warnings=warnings,
                           alarm_post_status=alarm_post_status, alarm_post_detail=alarm_post_detail))

    return final_exit_code(code, alarm_post_status)


if __name__ == "__main__":
    sys.exit(main())
