#!/usr/bin/env python3
"""
edge-function-drift-check.py — OtterQuote Deployed-vs-`main` Edge Function Drift Detector

Answers exactly one question, for every deployed Edge Function:

    Do the bytes running in production equal the bytes on `main`?

Motivation: gh-1295 (P0). "A merge is not a deploy, and this system has no
mechanism that notices the difference." Every instance so far was found by a
human reading a narrative, days or weeks late:

  - `create-docusign-envelope` — 23 days stale, the contract path dead behind it (gh-1244)
  - `process-auto-bids` — 7 days stale, placing live bids against the wrong matcher (gh-1253)
  - gh-912 filed the same class in 2026-08 and was closed `not_planned` with its
    audit never run, which is why gh-1295 had to rediscover it.

Three manual measurements were run on gh-1295 (2026-08-27 x2, 2026-08-28). They
are step 1. This is step 2: the mechanism that fails loudly without anyone's
cooperation, per R-148.

-------------------------------------------------------------------------------
THE THREE RULES, taken verbatim from gh-1295's own findings. Do not relax these.
-------------------------------------------------------------------------------

1. NEVER read `version`. The 2026-08-28 sweep observed every one of 57 functions
   climb +2 in a single run with `updated_at` and `ezbr_sha256` byte-identical.
   A matching version number is evidence of nothing, and so is a changing one.

2. NEVER read `updated_at`, and never fall back to a timestamp when a hash is
   unavailable. The 2026-08-27 sweep found the date heuristic produced 7 false
   DRIFT calls out of 20 candidates (35% false-positive) AND missed real drift:
   `send-sms` was deployed nine days BEFORE the commit whose code it already
   carried. A timestamp comparison is not a cheaper approximation of this check,
   it is a different check that gets a materially different answer.

3. NEVER normalize. Compare raw bytes. The manual sweeps had to allow an
   "identical modulo comment-ruler length" class only because reading deployed
   source back through a model's context cannot reproduce long runs of U+2500.
   That is an artifact of the manual channel, not a property of the check. CI has
   both copies on disk and has no such excuse. Ten functions are unresolved in the
   manual tables purely because of it; this detector settles them.

A corollary rule, from the `notify-admin-new-contractor` finding: the question is
NOT "was this deployed from a commit?" — that function's deployed source
corresponds to no commit in 1,319 and would pass such a check. The question is
"do the running bytes equal `main`'s bytes?" Only the second one is worth asking.

-------------------------------------------------------------------------------
FAIL-LOUD, NOT FAIL-QUIET
-------------------------------------------------------------------------------

Being unable to measure is a FAILURE (exit 2), never a pass. This is deliberate
and is the whole point of the issue: gh-1344 records that `sec-sweep` "has run
blind since it was written" because it lacked a credential and silently did
nothing. A detector for the defect class "looks shipped, isn't" must not itself
be able to look green while measuring nothing. A missing token, a missing CLI, or
a per-function fetch failure all exit non-zero and say so.

-------------------------------------------------------------------------------
USAGE
-------------------------------------------------------------------------------

  # Normal CI run — fetches deployed source, compares against the working tree
  SUPABASE_ACCESS_TOKEN=sbp_... \
  python3 scripts/edge-function-drift-check.py --project-ref yeszghaspzwwstvsrioa

  # Compare against an already-downloaded tree; performs no network I/O.
  # This is the seam the unit test drives.
  python3 scripts/edge-function-drift-check.py --deployed-dir /tmp/deployed

  Options:
    --repo-root PATH       repo root (default: the script's parent's parent)
    --markdown-out PATH    write the drift table as Markdown
    --json-out PATH        write the full report as JSON
    --fetch-only-slugs a,b restrict to these slugs (debugging; NOT for CI)

  Exit codes:
    0  — every deployed function is byte-identical to `main`
    1  — drift found (or a deployed function has no counterpart in the repo)
    2  — COULD NOT MEASURE: no token, no CLI, or a fetch failed. Never silent.

Requires the Supabase CLI on PATH and SUPABASE_ACCESS_TOKEN in the environment
(a Personal Access Token — the service-role key is NOT sufficient; the Management
API rejects it). The CLI is used rather than hand-rolling the
`GET /v1/projects/{ref}/functions/{slug}/body` eszip parse, because the CLI
already handles eszip extraction and legacy-bundle formats.

ADR: Docs/ADRs/ADR-010-schema-column-lint.md (same fail-hard CI convention as
schema-column-lint.py / schema-secret-lint.py / migration-filename-lint.py)
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Directory (relative to repo root) holding the checked-in function source.
FUNCTIONS_DIR = "supabase/functions"

# Entries under FUNCTIONS_DIR that are not themselves deployable functions.
NON_FUNCTION_ENTRIES = {"_shared"}

# Verdicts.
IDENTICAL = "IDENTICAL"
DRIFTED = "DRIFTED"
DEPLOYED_NOT_IN_REPO = "DEPLOYED_NOT_IN_REPO"
IN_REPO_NEVER_DEPLOYED = "IN_REPO_NEVER_DEPLOYED"
FETCH_FAILED = "FETCH_FAILED"

# Verdicts that mean "the check could not be performed", as opposed to
# "the check was performed and the answer is bad". Kept separate so a fetch
# failure can never be reported as a clean result.
UNMEASURED_VERDICTS = {FETCH_FAILED}

# Verdicts that represent a real, measured problem.
#
# IN_REPO_NEVER_DEPLOYED is included deliberately: a function merged to `main`
# that was never deployed is the purest instance of "a merge is not a deploy",
# which is the whole thesis of gh-1295. The cost is a false alarm during the
# legitimate window between merging a brand-new function and deploying it; since
# this runs on a schedule against `main` rather than as a per-PR gate, that window
# is hours, not the norm. `--allow-undeployed` downgrades it to a warning for the
# run that lands such a function.
FAILING_VERDICTS = {DRIFTED, DEPLOYED_NOT_IN_REPO, IN_REPO_NEVER_DEPLOYED}


# ---------------------------------------------------------------------------
# Pure comparison layer — no network, no subprocess, no clock.
# Everything below this line is deterministic given two directory trees.
# ---------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    """Raw SHA-256 of the file's bytes. No decoding, no newline translation,
    no whitespace stripping. See rule 3."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def hash_tree(root: Path) -> dict:
    """Map every file under `root` to the SHA-256 of its bytes, keyed by POSIX
    path relative to `root`. Missing root yields an empty map."""
    if not root.is_dir():
        return {}
    out = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            out[path.relative_to(root).as_posix()] = sha256_file(path)
    return out


def compare_function(slug: str, repo_dir: Path, deployed_dir: Path) -> dict:
    """Compare one function's deployed tree against its repo tree.

    Returns a row: {slug, verdict, files: [{path, status, repo_sha, deployed_sha}]}
    where status is one of same | differs | missing_in_repo | missing_in_deploy.
    """
    repo_hashes = hash_tree(repo_dir)
    deployed_hashes = hash_tree(deployed_dir)

    files = []
    for rel in sorted(set(repo_hashes) | set(deployed_hashes)):
        repo_sha = repo_hashes.get(rel)
        deployed_sha = deployed_hashes.get(rel)
        if repo_sha is None:
            status = "missing_in_repo"
        elif deployed_sha is None:
            status = "missing_in_deploy"
        elif repo_sha == deployed_sha:
            status = "same"
        else:
            status = "differs"
        files.append(
            {
                "path": rel,
                "status": status,
                "repo_sha256": repo_sha,
                "deployed_sha256": deployed_sha,
            }
        )

    if not repo_hashes:
        verdict = DEPLOYED_NOT_IN_REPO
    elif all(f["status"] == "same" for f in files):
        verdict = IDENTICAL
    else:
        verdict = DRIFTED

    return {"slug": slug, "verdict": verdict, "files": files}


def build_report(repo_functions_dir: Path, deployed_root: Path, deployed_slugs, repo_slugs=None) -> dict:
    """Compare every deployed slug against the repo, and note repo functions
    that are not deployed at all.

    `deployed_root` holds one subdirectory per slug, each mirroring the layout
    of `supabase/functions/<slug>/`.
    """
    if repo_slugs is None:
        repo_slugs = discover_repo_slugs(repo_functions_dir)

    rows = []
    for slug in sorted(deployed_slugs):
        rows.append(
            compare_function(
                slug,
                repo_functions_dir / slug,
                deployed_root / slug,
            )
        )

    for slug in sorted(set(repo_slugs) - set(deployed_slugs)):
        rows.append({"slug": slug, "verdict": IN_REPO_NEVER_DEPLOYED, "files": []})

    counts = {}
    for row in rows:
        counts[row["verdict"]] = counts.get(row["verdict"], 0) + 1

    return {
        "deployed_count": len(set(deployed_slugs)),
        "repo_count": len(set(repo_slugs)),
        "counts": counts,
        "functions": rows,
    }


def discover_repo_slugs(repo_functions_dir: Path):
    """Function directories checked into the repo, excluding shared helpers."""
    if not repo_functions_dir.is_dir():
        return []
    return sorted(
        p.name
        for p in repo_functions_dir.iterdir()
        if p.is_dir() and p.name not in NON_FUNCTION_ENTRIES and not p.name.startswith(".")
    )


def report_exit_code(report: dict, allow_undeployed: bool = False) -> int:
    """0 clean · 1 measured drift · 2 could not measure.

    'Could not measure' outranks 'drift': a run that failed to fetch even one
    function does not get to report a drift count as if it were complete. And a
    run that measured NOTHING is unmeasured, never clean — an empty result set is
    overwhelmingly a credential or path problem, and reporting it green is the
    exact fail-quiet shape gh-1295 exists to close.
    """
    verdicts = {row["verdict"] for row in report["functions"]}
    if verdicts & UNMEASURED_VERDICTS:
        return 2
    if report["deployed_count"] == 0:
        return 2
    failing = set(FAILING_VERDICTS)
    if allow_undeployed:
        failing.discard(IN_REPO_NEVER_DEPLOYED)
    if verdicts & failing:
        return 1
    return 0


def render_markdown(report: dict) -> str:
    """Human-readable drift table for the CI job summary and the issue thread."""
    counts = report["counts"]
    lines = [
        "# Edge Function drift — deployed vs `main`",
        "",
        f"**{report['deployed_count']} deployed · {report['repo_count']} in repo** — "
        + " · ".join(f"{n} {v}" for v, n in sorted(counts.items()))
        + ".",
        "",
        "Raw SHA-256 byte comparison. No `version`, no `updated_at`, no normalization "
        "(gh-1295 rules 1-3).",
        "",
    ]

    problems = [r for r in report["functions"] if r["verdict"] != IDENTICAL]
    if not problems:
        lines.append("Every deployed function is byte-identical to `main`.")
        return "\n".join(lines) + "\n"

    lines += ["| Function | Verdict | Files differing |", "|---|---|---|"]
    for row in problems:
        bad = [f for f in row["files"] if f["status"] != "same"]
        detail = ", ".join(f"`{f['path']}` ({f['status']})" for f in bad) or "—"
        lines.append(f"| `{row['slug']}` | **{row['verdict']}** | {detail} |")

    lines += [
        "",
        "## Per-file hashes",
        "",
    ]
    for row in problems:
        bad = [f for f in row["files"] if f["status"] != "same"]
        if not bad:
            continue
        lines.append(f"### `{row['slug']}`")
        lines.append("")
        lines.append("| File | Status | `main` sha256 | deployed sha256 |")
        lines.append("|---|---|---|---|")
        for f in bad:
            lines.append(
                f"| `{f['path']}` | {f['status']} | `{(f['repo_sha256'] or '—')[:16]}` "
                f"| `{(f['deployed_sha256'] or '—')[:16]}` |"
            )
        lines.append("")

    lines += [
        "> **Do not fix drift by redeploying everything** (gh-1295). Some functions may be",
        "> deliberately pinned, and a blanket redeploy on a path with no detector is how you",
        "> find that out expensively. Redeploying `process-auto-bids` places live bids;",
        "> `create-docusign-envelope` is `tier:3b`. Each row is its own decision.",
    ]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Fetch layer — the only part that touches the network.
# ---------------------------------------------------------------------------


def require_cli() -> str:
    cli = shutil.which("supabase")
    if not cli:
        die_unmeasured(
            "the Supabase CLI is not on PATH.\n"
            "        Install it in the workflow before this step "
            "(supabase/setup-cli@v1)."
        )
    return cli


def require_token() -> str:
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    if not token:
        die_unmeasured(
            "SUPABASE_ACCESS_TOKEN is not set.\n"
            "        This must be a Supabase Personal Access Token (sbp_...). The\n"
            "        service-role key is NOT sufficient — the Management API rejects it.\n"
            "        Mint one at https://supabase.com/dashboard/account/tokens and add it\n"
            "        as the repository secret SUPABASE_ACCESS_TOKEN."
        )
    return token


def die_unmeasured(message: str) -> None:
    """Exit 2. Never exit 0 on an unmeasurable run — see FAIL-LOUD above."""
    print(f"\nCOULD NOT MEASURE: {message}", file=sys.stderr)
    print(
        "\nThis is a FAILURE, not a skip. A drift detector that can run green while\n"
        "measuring nothing is the exact defect class gh-1295 exists to close.",
        file=sys.stderr,
    )
    sys.exit(2)


def list_deployed_slugs(cli: str, project_ref: str) -> list:
    """Deployed function slugs, parsed from `supabase functions list`.

    Only the slug column is read. The `version` and `updated_at` columns this
    command also prints are deliberately ignored — see rules 1 and 2.
    """
    proc = subprocess.run(
        [cli, "functions", "list", "--project-ref", project_ref, "--output", "json"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        die_unmeasured(
            f"`supabase functions list` failed (exit {proc.returncode}):\n{proc.stderr.strip()}"
        )
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        die_unmeasured(f"could not parse `supabase functions list` output as JSON: {exc}")

    slugs = [entry["slug"] for entry in payload if entry.get("slug")]
    if not slugs:
        die_unmeasured(
            "`supabase functions list` returned zero functions. That is far more likely\n"
            "        to be a credential or project-ref problem than a project with no Edge\n"
            "        Functions, so it is treated as unmeasurable rather than clean."
        )
    return slugs


def download_function(cli: str, project_ref: str, slug: str, dest_root: Path) -> bool:
    """Download one deployed function into `dest_root/<slug>/`.

    The CLI writes to `<cwd>/supabase/functions/<slug>/`, so each download runs in
    its own scratch cwd and the result is moved into place. Returns False on
    failure — the caller records FETCH_FAILED rather than treating it as clean.
    """
    with tempfile.TemporaryDirectory() as scratch:
        proc = subprocess.run(
            [cli, "functions", "download", slug, "--project-ref", project_ref],
            capture_output=True,
            text=True,
            cwd=scratch,
        )
        produced = Path(scratch) / FUNCTIONS_DIR / slug
        if proc.returncode != 0 or not produced.is_dir():
            print(
                f"  ! fetch failed for {slug} (exit {proc.returncode}): "
                f"{proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else 'no stderr'}",
                file=sys.stderr,
            )
            return False
        dest = dest_root / slug
        if dest.exists():
            shutil.rmtree(dest)
        shutil.move(str(produced), str(dest))
        return True


def fetch_all(cli: str, project_ref: str, slugs, dest_root: Path):
    """Download every slug. Returns (fetched, failed)."""
    fetched, failed = [], []
    for i, slug in enumerate(slugs, 1):
        print(f"[{i}/{len(slugs)}] downloading {slug}")
        (fetched if download_function(cli, project_ref, slug, dest_root) else failed).append(slug)
    return fetched, failed


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> int:
    default_root = Path(__file__).resolve().parent.parent

    parser = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    parser.add_argument("--repo-root", default=str(default_root))
    parser.add_argument("--project-ref", help="Supabase project ref (required unless --deployed-dir)")
    parser.add_argument(
        "--deployed-dir",
        help="Compare against an already-downloaded tree instead of fetching. No network I/O.",
    )
    parser.add_argument("--markdown-out")
    parser.add_argument("--json-out")
    parser.add_argument("--fetch-only-slugs", help="Comma-separated slugs; debugging only, NOT for CI.")
    parser.add_argument(
        "--allow-undeployed",
        action="store_true",
        help="Downgrade IN_REPO_NEVER_DEPLOYED from a failure to a warning. Use only on "
             "the run that lands a brand-new function, before its first deploy.",
    )
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    repo_functions_dir = repo_root / FUNCTIONS_DIR
    failed_fetches = []

    if args.deployed_dir:
        deployed_root = Path(args.deployed_dir).resolve()
        if not deployed_root.is_dir():
            die_unmeasured(f"--deployed-dir {deployed_root} does not exist")
        deployed_slugs = sorted(p.name for p in deployed_root.iterdir() if p.is_dir())
        tmpdir = None
    else:
        if not args.project_ref:
            parser.error("--project-ref is required unless --deployed-dir is given")
        cli = require_cli()
        require_token()  # presence-checked here so the run dies before any fetch
        slugs = list_deployed_slugs(cli, args.project_ref)
        if args.fetch_only_slugs:
            wanted = {s.strip() for s in args.fetch_only_slugs.split(",") if s.strip()}
            slugs = [s for s in slugs if s in wanted]
        tmpdir = tempfile.mkdtemp(prefix="ef-drift-")
        deployed_root = Path(tmpdir)
        deployed_slugs, failed_fetches = fetch_all(cli, args.project_ref, slugs, deployed_root)

    try:
        report = build_report(repo_functions_dir, deployed_root, deployed_slugs)
        for slug in failed_fetches:
            report["functions"].append({"slug": slug, "verdict": FETCH_FAILED, "files": []})
            report["counts"][FETCH_FAILED] = report["counts"].get(FETCH_FAILED, 0) + 1
        report["functions"].sort(key=lambda r: r["slug"])

        markdown = render_markdown(report)
        print()
        print(markdown)

        if args.markdown_out:
            Path(args.markdown_out).write_text(markdown, encoding="utf-8")
        if args.json_out:
            Path(args.json_out).write_text(json.dumps(report, indent=2), encoding="utf-8")

        code = report_exit_code(report, allow_undeployed=args.allow_undeployed)
        if code == 2:
            if report["deployed_count"] == 0:
                print(
                    "COULD NOT MEASURE: zero deployed functions were compared. An empty result\n"
                    "is treated as a failure to measure, not as a clean run.",
                    file=sys.stderr,
                )
            if failed_fetches:
                print(
                    f"COULD NOT MEASURE: {len(failed_fetches)} function(s) failed to download: "
                    f"{', '.join(failed_fetches)}",
                    file=sys.stderr,
                )
        elif code == 1:
            print("Edge Function drift check FAILED — deployed source differs from `main`.", file=sys.stderr)
        else:
            print("Edge Function drift check PASSED — every deployed function matches `main`.")
        return code
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
