#!/usr/bin/env python3
"""
edge-function-drift-remote.py -- Edge Function drift for Supabase projects whose
function source lives in a GitHub repo OTHER than this checkout (gh-1700).

WHY THIS EXISTS
----------------
`edge-function-drift-check.py` (gh-1295) answers "do the deployed bytes equal
`main`'s bytes?" for `otterquote-platform`'s own Supabase project, using the
already-checked-out working tree as the repo side. It has never looked at
`otter-crm`'s SEPARATE Supabase project (ref `lreqwnqvlerdgukpklwb`), because
`otter-crm`'s function source lives in a SEPARATE GitHub repo
(`StellarEdgeServices/otter-crm`) that this workflow does not check out.

gh-1700: as of PR #1698, `edge-function-drift.yml`'s Netlify half reports green
for all three sites including `otter-crm`, while the Edge Function half still
covers none of `otter-crm`'s functions -- "the workflow that carries
`otter-crm`'s name in its output now reports green for `otter-crm`, while
covering none of `otter-crm`'s Edge Functions." A partially-green detector is
worse than a red one: it retires the suspicion that keeps someone checking by
hand (this issue's own framing, and #1517's founding case in new clothes --
`otter-crm` sat frozen 22 days on cancelled builds with nothing alarming).

THIS SCRIPT is additive, not a replacement: it covers projects whose function
source is NOT in this checkout. `otterquote-platform` stays on the existing
local-checkout path (`edge-function-drift-check.py`, unmodified by this file).
Adding a fourth remote project is one entry in REMOTE_PROJECTS below.

REUSE, NOT REIMPLEMENTATION
----------------------------
The three hard-won rules from gh-1295 -- content-hash only, never `version`,
never `updated_at`, never normalize -- and the fetch-side fixes (`--use-api`
to avoid the Docker eszip-corruption path, `_reclaim_tree` for the root-owned-
files bug, test-file-never-bundled handling) already live in
`edge-function-drift-check.py` and are proven by its own test suite. This
script loads that file as a module via `importlib.util.spec_from_file_location`
-- the SAME idiom `edge-function-drift-check.test.py` already uses to import a
hyphenated filename -- and calls its pure `build_report()` / `render_markdown()`
/ `report_exit_code()` / network `require_cli()` / `list_deployed_slugs()` /
`fetch_all()` directly. There is exactly one place the three rules are
enforced; this file only supplies remote-repo fetching and multi-project
orchestration around it.

CREDENTIAL DESIGN (read before touching this -- this family's recurring bug)
------------------------------------------------------------------------------
Three detectors in this family have now shipped with a credential that could
never authenticate: `drift-detector-age.py` measured `UNMEASURED -- GitHub API
HTTP 401` this run because its env-var PAT is dead, and PR #1735's first
attempt wired a NEW detector to `secrets.GITHUB_PERSONAL_ACCESS_TOKEN` -- a
name GitHub Actions structurally refuses to let any repository secret be
named, the identical bug `30e10dc` fixed in this workflow on 2026-09-05 by
renaming to `GH_CROSS_REPO_PAT`. So, non-negotiable for this file:

  1. No secret name here starts with `GITHUB_`. The GitHub-side credential is
     `GH_CROSS_REPO_PAT` (already exists, created for gh-1549, a fine-grained
     PAT with Contents+Metadata+Administration read on both
     otterquote-platform and otter-crm). This script only calls the git
     trees/blobs read endpoints -- Contents read is sufficient. It does NOT
     need Administration read. Issue #1727 proposes stripping Administration
     from this PAT; if that lands, THIS script keeps working -- said loudly
     here so a future reader does not have to re-derive it.
  2. No `|| github.token` fallback anywhere below. A fallback silently
     substitutes a token that cannot see `otter-crm` at all (the default
     `secrets.GITHUB_TOKEN` is scoped to the repo the workflow runs in) and
     reports a quieter UNMEASURED that hides which credential is missing.
  3. The Supabase side needs a NEW secret, `SUPABASE_CRM_ACCESS_TOKEN` -- a
     Supabase Personal/Management-API access token (`sbp_...`) with read
     access to the `otter-crm` project (ref `lreqwnqvlerdgukpklwb`). The
     existing `SUPABASE_ACCESS_TOKEN` secret is scoped to
     `otterquote-platform`'s project only and is NOT assumed to also reach
     `otter-crm` -- this script never tries it as a fallback for that reason.
     (If a `SUPABASE_CRM_PAT` secret already exists under that name from a
     prior session, this workflow needs pointing at it under the env var name
     below instead of a fresh mint -- confirm before assuming either way.)
  4. UNMEASURED must fail as loudly as a real drift finding, and must NEVER
     read as "no drift found" (gh-1419). A project whose credential is missing
     or whose GitHub/Supabase fetch fails is a `status: UNMEASURED` row in the
     report -- it is NEVER silently absent, and it OUTRANKS a clean verdict in
     the overall exit code. See `overall_exit_code()`.
  5. No credential VALUE is ever printed, logged, or included in an exception
     message this script emits (R-089) -- only presence and HTTP status.

Deploys nothing, writes nothing outside a scratch temp dir it cleans up. Read
only, per this issue's constraints.

USAGE
  GH_CROSS_REPO_PAT=... SUPABASE_CRM_ACCESS_TOKEN=... \\
      python3 scripts/edge-function-drift-remote.py --markdown-out out.md --json-out out.json

  python3 scripts/edge-function-drift-remote.test.py     # fixture-driven, no
                                                          # network, no credentials

EXIT
  0  every configured remote project measured IDENTICAL (or IN_REPO_NEVER_DEPLOYED
     downgraded -- not offered as a flag here since this file has no per-PR caller)
  1  measured drift on at least one project, and every project was measurable
  2  at least one project is UNMEASURED -- outranks 1, same ordering as
     edge-function-drift-check.py's own report_exit_code()
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_house_detector():
    """Load edge-function-drift-check.py as a module -- same importlib idiom
    edge-function-drift-check.test.py already uses for this hyphenated
    filename. Reuses its pure comparison/report layer rather than
    reimplementing gh-1295's three rules a second time."""
    spec = importlib.util.spec_from_file_location(
        "edge_function_drift_check", HERE / "edge-function-drift-check.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


efdc = _load_house_detector()

# ---------------------------------------------------------------------------
# Config -- one entry per Supabase project whose function source is NOT in
# this checkout. Adding a fourth remote project is one dict appended below.
# ---------------------------------------------------------------------------

GITHUB_TOKEN_ENV_VAR = "GH_CROSS_REPO_PAT"

REMOTE_PROJECTS = [
    {
        "name": "otter-crm",
        "github_repo": "StellarEdgeServices/otter-crm",
        "functions_dir": "supabase/functions",
        "project_ref": "lreqwnqvlerdgukpklwb",
        "supabase_token_env": "SUPABASE_CRM_ACCESS_TOKEN",
    },
]

TIMEOUT_SECONDS = 20

UNMEASURED = "UNMEASURED"  # project-level: could not even attempt the compare


class RemoteFetchError(Exception):
    """Raised by the GitHub fetch layer. Always caught by check_project() and
    turned into a project-level UNMEASURED row -- never allowed to abort the
    whole run or drop a project from the report."""


# ---------------------------------------------------------------------------
# Network layer -- GitHub side (repo source at `main`). The only part of this
# file that touches the network besides the Supabase CLI calls in
# edge-function-drift-check.py.
# ---------------------------------------------------------------------------


def _github_get(url: str, token: str):
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "User-Agent": "otterquote-drift-detector-remote",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Deliberately no response body echoed -- see R-089 discipline note above.
        raise RemoteFetchError(f"GitHub API HTTP {exc.code} ({exc.reason}) for {url}") from None
    except Exception as exc:  # noqa: BLE001 -- any failure here is UNMEASURED, not a crash
        raise RemoteFetchError(f"{type(exc).__name__} fetching {url}") from None


def fetch_github_function_tree(repo: str, functions_dir: str, token: str) -> dict:
    """Return {relative_path: raw_bytes} for every blob under `functions_dir`
    on `main`, via the git trees (recursive) + git blobs API -- two calls per
    file-set rather than one Contents-API call per file. Raises
    RemoteFetchError on any failure; never returns a partial map silently and
    never treats zero files as a valid empty project (mirrors
    list_deployed_slugs()'s own "empty result is unmeasurable" rule)."""
    tree = _github_get(f"https://api.github.com/repos/{repo}/git/trees/main?recursive=1", token)
    prefix = functions_dir.rstrip("/") + "/"
    blobs = [
        entry
        for entry in tree.get("tree", [])
        if entry.get("type") == "blob" and entry.get("path", "").startswith(prefix)
    ]
    if not blobs:
        raise RemoteFetchError(
            f"{repo}: zero files found under {functions_dir} on main -- treated as "
            "unmeasurable, not as an empty-but-valid project."
        )
    out = {}
    for entry in blobs:
        blob = _github_get(f"https://api.github.com/repos/{repo}/git/blobs/{entry['sha']}", token)
        if blob.get("encoding") != "base64":
            raise RemoteFetchError(f"{repo}: blob {entry['path']} was not base64-encoded")
        rel = entry["path"][len(prefix):]
        out[rel] = base64.b64decode(blob["content"])
    return out


# ---------------------------------------------------------------------------
# Orchestration -- one project. `github_fetch`/`list_slugs`/`fetch_all`/
# `require_cli` are ALL injectable so the fixture suite can drive this with
# zero network, zero credentials, AND zero dependency on an external binary
# actually being on PATH -- a unit/fixture suite must be hermetic. Every one
# of the four defaults to the real call; only the test module substitutes
# fakes. (gh-1737 review: `require_cli` was the one seam missing here, and its
# absence let the fixture suite's "happy path" cases silently degrade to
# UNMEASURED -- and then crash indexing a None report -- on any runner/machine
# without the Supabase CLI already on PATH.)
# ---------------------------------------------------------------------------


@contextlib.contextmanager
def _supabase_token_env(value: str):
    """Temporarily set SUPABASE_ACCESS_TOKEN -- the name both the Supabase CLI
    and edge-function-drift-check.py's list_deployed_slugs()/fetch_all() read
    -- to `value`, restoring whatever was there after. Never logs `value`."""
    prior = os.environ.get("SUPABASE_ACCESS_TOKEN")
    os.environ["SUPABASE_ACCESS_TOKEN"] = value
    try:
        yield
    finally:
        if prior is None:
            os.environ.pop("SUPABASE_ACCESS_TOKEN", None)
        else:
            os.environ["SUPABASE_ACCESS_TOKEN"] = prior


def _unmeasured(project: dict, reason: str) -> dict:
    return {
        "name": project["name"],
        "project_ref": project.get("project_ref"),
        "github_repo": project.get("github_repo"),
        "status": UNMEASURED,
        "reason": reason,
        "report": None,
    }


def check_project(
    project: dict,
    github_fetch=fetch_github_function_tree,
    list_slugs=None,
    fetch_all=None,
    require_cli=None,
) -> dict:
    """Compare one remote project's deployed Edge Functions against its own
    repo's `main`. Returns {name, project_ref, github_repo, status, reason,
    report}. NEVER raises -- every failure mode becomes status=UNMEASURED with
    a `reason`, so a caller iterating N projects always gets N rows back, and
    a project is never silently dropped from the output (gh-1419, and this
    issue's own thesis: a missing row is what let the otter-crm gap hide
    behind a green Netlify row).

    `require_cli` is injectable (defaults to `efdc.require_cli`, the real
    `shutil.which("supabase")` check) for the identical reason `list_slugs`
    and `fetch_all` are: a fixture suite that calls the real one is not
    hermetic, and depends on whichever machine happens to run it already
    having the Supabase CLI on PATH (gh-1737 review)."""
    list_slugs = list_slugs or efdc.list_deployed_slugs
    fetch_all = fetch_all or efdc.fetch_all
    require_cli = require_cli or efdc.require_cli

    token_env = project["supabase_token_env"]
    github_token = os.environ.get(GITHUB_TOKEN_ENV_VAR, "").strip()
    supabase_token = os.environ.get(token_env, "").strip()

    if not github_token:
        return _unmeasured(project, f"{GITHUB_TOKEN_ENV_VAR} is not set in the environment")
    if not supabase_token:
        return _unmeasured(project, f"{token_env} is not set in the environment")

    repo_tmp = None
    deployed_tmp = None
    try:
        try:
            repo_files = github_fetch(project["github_repo"], project["functions_dir"], github_token)
        except RemoteFetchError as exc:
            return _unmeasured(project, str(exc))

        repo_tmp = Path(tempfile.mkdtemp(prefix="ef-drift-remote-repo-"))
        repo_functions_dir = repo_tmp / efdc.FUNCTIONS_DIR
        for rel, data in repo_files.items():
            dest = repo_functions_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)

        with _supabase_token_env(supabase_token):
            try:
                cli = require_cli()
                slugs = list_slugs(cli, project["project_ref"])
            except SystemExit:
                return _unmeasured(project, "Supabase CLI/token check failed -- see step log above")

            deployed_tmp = Path(tempfile.mkdtemp(prefix="ef-drift-remote-deployed-"))
            deployed_slugs, failed_fetches = fetch_all(cli, project["project_ref"], slugs, deployed_tmp)

        report = efdc.build_report(repo_functions_dir, deployed_tmp, deployed_slugs)
        for slug in failed_fetches:
            report["functions"].append({"slug": slug, "verdict": efdc.FETCH_FAILED, "files": []})
            report["counts"][efdc.FETCH_FAILED] = report["counts"].get(efdc.FETCH_FAILED, 0) + 1
        report["functions"].sort(key=lambda r: r["slug"])

        return {
            "name": project["name"],
            "project_ref": project["project_ref"],
            "github_repo": project["github_repo"],
            "status": "MEASURED",
            "reason": None,
            "report": report,
        }
    except Exception as exc:  # noqa: BLE001 -- last-resort net: one bad project
        # must never take down the whole run or vanish from the output.
        return _unmeasured(project, f"{type(exc).__name__}: {exc}")
    finally:
        if repo_tmp:
            shutil.rmtree(repo_tmp, ignore_errors=True)
        if deployed_tmp:
            shutil.rmtree(deployed_tmp, ignore_errors=True)


def check_all(projects=None, **kwargs) -> list:
    return [check_project(p, **kwargs) for p in (projects if projects is not None else REMOTE_PROJECTS)]


def overall_exit_code(results: list) -> int:
    """0 clean · 1 measured drift (every project measurable) · 2 at least one
    project UNMEASURED. UNMEASURED outranks drift: a run that could not read
    one project does not get to report the others' clean verdicts as if the
    whole run were trustworthy -- same ordering edge-function-drift-check.py's
    own report_exit_code() uses."""
    if not results:
        return 2
    if any(r["status"] == UNMEASURED for r in results):
        return 2
    worst = 0
    for r in results:
        code = efdc.report_exit_code(r["report"])
        if code == 2:
            return 2
        worst = max(worst, code)
    return worst


def render_markdown(results: list) -> str:
    lines = ["# Edge Function drift -- remote projects (gh-1700)", ""]
    for r in results:
        lines.append(f"## `{r['name']}` (project `{r['project_ref'] or '?'}`, repo `{r['github_repo'] or '?'}`)")
        lines.append("")
        if r["status"] == UNMEASURED:
            lines.append(f"**UNMEASURED** -- {r['reason']}")
            lines.append("")
            lines.append(
                "This is a FAILURE, not a clean run (gh-1419: UNMEASURED must fail as "
                "loudly as DRIFTED, and must never read as \"no drift found\")."
            )
        else:
            lines.append(efdc.render_markdown(r["report"]))
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().split("\n")[0])
    parser.add_argument("--markdown-out")
    parser.add_argument("--json-out")
    args = parser.parse_args()

    results = check_all()
    markdown = render_markdown(results)
    print(markdown)

    if args.markdown_out:
        Path(args.markdown_out).write_text(markdown, encoding="utf-8")
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(results, indent=2), encoding="utf-8")

    code = overall_exit_code(results)
    if code == 2:
        print(
            "COULD NOT MEASURE at least one remote project -- see UNMEASURED row(s) above. "
            "This is a failure, not a skip.",
            file=sys.stderr,
        )
    elif code == 1:
        print("Edge Function drift check (remote projects) FAILED -- deployed source differs from main.", file=sys.stderr)
    else:
        print("Edge Function drift check (remote projects) PASSED for every configured project.")
    return code


if __name__ == "__main__":
    sys.exit(main())
