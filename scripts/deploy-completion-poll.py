#!/usr/bin/env python3
"""gh-1729: detect a Netlify production deploy COMPLETING, so
entry-point-reachability-live.yml has something real to trigger on.

## Why this exists

PR #1720 wired entry-point-reachability-live.yml's trigger to GitHub's
`deployment_status` event. Measured (#1729, CTO comment 5572644176):

    GET /repos/StellarEdgeServices/otterquote-platform/deployments   -> 200, count 0
    GET /repos/StellarEdgeServices/otterquote-platform/environments  -> {"total_count":0}

Zero GitHub Deployments have ever existed in this repo and no environment is
defined, so `deployment_status` cannot fire -- it is not merely unused, it is
not produced. Netlify does not create GitHub Deployments for this repo's
integration; commit statuses are the closest thing it emits, and even those
were empty on the two most recent `main` tips checked. So there is no GitHub
event to react to, and this script exists to poll Netlify directly instead.

## The trap this script exists to avoid

Netlify deploys ASYNCHRONOUSLY after a merge to `main`. A trigger keyed on
the merge itself (a `push` event, or any commit-based hook) runs against the
OLD bytes and passes -- a green signal about a deploy that has not happened,
which is worse than no check (see #1729's body; #1693 is the live case this
would have missed). This script never looks at the merge commit. It looks
only at Netlify's own `published_deploy` -- the deploy Netlify has actually
finished serving -- and reports THAT deploy's commit_ref. The caller (the
workflow) must run the reachability spec against that commit's published
site, never against `github.sha` from the triggering event.

## What it does

1. Fetch the named Netlify site (by `name`, e.g. "jade-alpaca-b82b5e").
2. Read `published_deploy.id` and `published_deploy.commit_ref`.
3. Compare `published_deploy.id` to the last-seen id (passed in via
   --last-seen-file, typically restored from an actions/cache entry keyed on
   this workflow -- see entry-point-reachability-live.yml).
4. Print `changed=true|false`, `deploy_id=...`, `commit_ref=...` in
   GitHub Actions `$GITHUB_OUTPUT` format (or plain KEY=VALUE lines when
   GITHUB_OUTPUT is unset, for local/test use) and write the new state to
   --last-seen-file so the next scheduled run can compare against it.

Exit codes (same convention as netlify-deploy-drift.py / drift-detector-age.py):
  0  measured, no new deploy since last check
  2  measured, a new production deploy has completed (drift-worthy signal)
  3  UNMEASURED -- could not read the site (bad token, network, bad site name)

## Usage

    NETLIFY_PAT=... python3 scripts/deploy-completion-poll.py \
        --site-name jade-alpaca-b82b5e \
        --last-seen-file /tmp/last-deploy-state.json
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

NETLIFY_TOKEN_ENV_VAR = "NETLIFY_PAT"
UNMEASURED_EXIT = 3
CHANGED_EXIT = 2
UNCHANGED_EXIT = 0


def fetch_site_by_name(site_name, token, timeout=20):
    """Returns (site_dict_or_None, reason_or_None). Never raises.

    Netlify's `/api/v1/sites/{site_id}` endpoint takes the site's UUID, not
    its `name` -- passing `name` 404s. This lists the account's sites (same
    call netlify-deploy-drift.py's enumeration uses) and matches on the
    `name` field, so callers can pass the human-readable Netlify site name
    (e.g. "jade-alpaca-b82b5e") without needing to know its UUID."""
    req = urllib.request.Request(
        "https://api.netlify.com/api/v1/sites?filter=all&per_page=100",
        headers={"Authorization": "Bearer %s" % token},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            sites = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return None, "Netlify site list fetch failed: HTTP %s %s" % (e.code, e.reason)
    except urllib.error.URLError as e:
        return None, "Netlify site list fetch failed: %s" % (e.reason,)
    except Exception as e:  # pragma: no cover - defensive
        return None, "Netlify site list fetch failed: %r" % (e,)
    for site in sites or []:
        if site.get("name") == site_name:
            return site, None
    return None, "no site named %r found on this Netlify account (%d sites checked)" % (site_name, len(sites or []))


def extract_published_deploy(site):
    """Pure function: site dict -> (deploy_id, commit_ref) or (None, None) if
    the site has never published (no crash either way)."""
    pd = (site or {}).get("published_deploy") or {}
    return pd.get("id"), pd.get("commit_ref")


def load_last_seen(path):
    """Pure-ish (one read): returns the last-seen deploy_id, or None if the
    file doesn't exist / can't be parsed (first run, or a cache miss --
    both must be treated as 'no prior state', never as an error)."""
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("deploy_id")
    except Exception:
        return None


def save_state(path, deploy_id, commit_ref):
    if not path:
        return
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"deploy_id": deploy_id, "commit_ref": commit_ref}, f)


def decide(last_seen_deploy_id, current_deploy_id):
    """Pure function -- the whole decision, isolated from I/O so it is
    trivially unit-testable without a network or a filesystem.

    A deploy_id that is None (site never published) never counts as
    'changed' relative to another None -- avoids a false trigger on a
    site with no deploys at all. A first-ever observation (last_seen is
    None, current is not) DOES count as changed -- there is no prior
    state to compare against, so the only safe default is "treat as new"
    rather than silently swallowing the very first real deploy this
    script ever observes."""
    if current_deploy_id is None:
        return False
    return current_deploy_id != last_seen_deploy_id


def emit(key, value):
    gh_output = os.environ.get("GITHUB_OUTPUT")
    line = "%s=%s\n" % (key, value)
    if gh_output:
        with open(gh_output, "a", encoding="utf-8") as f:
            f.write(line)
    else:
        sys.stdout.write(line)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--site-name", required=True, help="Netlify site 'name' (not domain), e.g. jade-alpaca-b82b5e")
    p.add_argument("--last-seen-file", required=True, help="Path to persist/read last-seen deploy state (restored via actions/cache across runs)")
    args = p.parse_args(argv)

    token = os.environ.get(NETLIFY_TOKEN_ENV_VAR)
    if not token:
        print("!! UNMEASURED -- %s not set in the environment" % NETLIFY_TOKEN_ENV_VAR, file=sys.stderr)
        emit("changed", "false")
        emit("status", "UNMEASURED")
        return UNMEASURED_EXIT

    site, reason = fetch_site_by_name(args.site_name, token)
    if site is None:
        print("!! UNMEASURED -- %s" % reason, file=sys.stderr)
        emit("changed", "false")
        emit("status", "UNMEASURED")
        return UNMEASURED_EXIT

    deploy_id, commit_ref = extract_published_deploy(site)
    last_seen = load_last_seen(args.last_seen_file)
    changed = decide(last_seen, deploy_id)

    print(
        "site=%s last_seen_deploy=%s current_deploy=%s published_commit_ref=%s changed=%s"
        % (args.site_name, last_seen, deploy_id, commit_ref, changed)
    )

    save_state(args.last_seen_file, deploy_id, commit_ref)

    emit("changed", "true" if changed else "false")
    emit("deploy_id", deploy_id or "")
    emit("commit_ref", commit_ref or "")
    emit("status", "MEASURED")

    return CHANGED_EXIT if changed else UNCHANGED_EXIT


if __name__ == "__main__":
    sys.exit(main())
