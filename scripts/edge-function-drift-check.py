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
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from email import policy as _email_policy
from email import message_from_bytes as _message_from_bytes
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


# gh-1295, 2026-08-31 (CTO cto-2026-08-31T11:56:50Z): a *.test.ts file lives in the
# repo's function directory and is NEVER bundled into a deploy -- the Supabase CLI
# ships what the entrypoint imports, and a test file is imported by nothing. Before
# this, their absence read as `missing_in_deploy` and flipped the whole function to
# DRIFTED.
#
# Measured on the first full 57-function run: 29 DRIFTED, of which **5 were this and
# nothing else** -- create-docusign-envelope, docusign-webhook, hover-webhook,
# validate-contract-template, and parse-hover-measurements, the last of which had been
# deployed from `main` minutes earlier and was byte-identical on its only real file.
# A detector that reports a just-deployed function as drifted is a detector nobody
# will believe by the third run.
#
# The row is still PRINTED, only its verdict changes -- the same tightening
# credential-sweep.py took on the sbp_ prefix (a narrowing that cannot hide a real
# finding, because a test file that genuinely differs still reports `differs`).
NON_DRIFT_STATUSES = frozenset({"same", "test_not_bundled", "unreferenced_not_bundled"})


def is_test_path(rel: str, fixtures_are_tests: bool = True) -> bool:
    """True for a repo file that is a test (or a test fixture) and therefore never deployed.

    `fixtures_are_tests=False` is passed by compare_function when a non-test file mentions
    `__fixtures__` (production code loads from it), so the directory is NOT a test asset."""
    parts = rel.split("/")
    name = parts[-1]
    return (
        name.endswith((".test.ts", ".test.js", ".test.tsx", "_test.ts"))
        or name.startswith("test_")
        or (fixtures_are_tests and "__fixtures__" in parts[:-1])
    )


# gh-1295 (CTO RUN 62, cto-2026-10-07T17:47:04Z): the bundler ships what the entrypoint
# imports, so a non-test file that NOTHING reachable from the entrypoint imports is never
# deployed either -- exactly like a test file. Measured on scheduled run 37652054968
# (2026-10-07): meta-leadgen-webhook/email-footer.ts and send-partner-onboarding/
# claim-stage-sql-proof.ts are imported only by their *.test.ts files, so they read
# `missing_in_deploy` and flipped two healthy functions to DRIFTED on every run.
# What this does NOT excuse: a file the entrypoint DOES reach (directly or through other
# files) but the deploy lacks -- the docusign-webhook/verify.ts shape -- stays
# `missing_in_deploy` and stays DRIFTED. When there is no entrypoint to walk from, nothing
# is excused (fail toward reporting drift).
_REL_IMPORT = re.compile(
    r"""(?:\bimport|\bexport)\s+(?:[^'"();]*?\bfrom\s*)?["'](\.{1,2}/[^"']+)["']"""
    r"""|\bimport\(\s*["'](\.{1,2}/[^"']+)["']\s*\)"""
)
_CODE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts")
_ENTRYPOINTS = ("index.ts", "index.tsx", "index.js", "index.mjs", "mod.ts")


_TEXT_SUFFIXES = _CODE_SUFFIXES + (".json", ".jsonc")
_CONFIG_NAMES = ("deno.json", "deno.jsonc", "import_map.json")
# `import(` that is not a member call; a literal argument is one plain string followed by `,` or `)`.
_DYN_IMPORT = re.compile(r"(?<![\w.$])import\s*\(")
_DYN_LITERAL = re.compile(r"""\s*(?:'[^'\n]*'|"[^"\n]*"|`[^`$\n]*`)\s*[,)]""")


def _scan_texts(repo_dir: Path, rels):
    """(texts, unsafe) for the fail-closed excuse.

    texts  {key: text} of every non-test text/code file the function ships from: its own
           directory, plus the sibling `_shared/` tree and any deno.json / import map next to
           the function or its functions dir (PR #2600 review 2, finding 2: a reference that
           lives OUTSIDE the function directory must be seen too). Tests never ship, so what
           they mention proves nothing.
    unsafe a reason string when the walker cannot be trusted for this function, else None:
           - a code/config file does not decode as UTF-8 (finding 1: one stray byte, or a
             UTF-16 file, must not make the file look like it imports nothing), or
           - a dynamic `import(` has a computed (non-literal) specifier (finding 3).
           When unsafe, nothing is excused for the function: every missing file is reported
           as missing_in_deploy, i.e. the detector fails toward reporting drift."""
    texts, bad, computed = {}, [], []

    def take(key, path):
        try:
            texts[key] = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            bad.append(key)
        except OSError:
            pass

    for rel in rels:
        if is_test_path(rel) or not rel.endswith(_TEXT_SUFFIXES):
            continue
        take(rel, repo_dir / rel)
    functions_dir = repo_dir.parent
    shared = functions_dir / "_shared"
    if shared.is_dir():
        for path in sorted(shared.rglob("*")):
            if path.is_file() and path.name.endswith(_TEXT_SUFFIXES):
                key = "../_shared/" + path.relative_to(shared).as_posix()
                if not is_test_path(key):
                    take(key, path)
    for base, prefix in ((repo_dir, ""), (functions_dir, "../"), (functions_dir.parent, "../../")):
        for name in _CONFIG_NAMES:
            if (base / name).is_file() and (prefix + name) not in texts:
                take(prefix + name, base / name)
    for key, text in texts.items():
        if not key.endswith(_CODE_SUFFIXES):
            continue
        for m in _DYN_IMPORT.finditer(text):
            line_start = text.rfind("\n", 0, m.start()) + 1
            if text[line_start:m.start()].lstrip().startswith(("//", "*", "/*")):
                continue  # prose in a comment line ("... no cross-directory import (same ..."), not a call
            if not _DYN_LITERAL.match(text, m.end()):
                computed.append(key)
                break
    if bad:
        return texts, "undecodable (not UTF-8): " + ", ".join(sorted(bad))
    if computed:
        return texts, "computed dynamic import() specifier in: " + ", ".join(sorted(computed))
    return texts, None


def quoted_mention(rel: str, texts: dict) -> bool:
    """True when ANY other non-test file names `rel` inside a quoted string ('...', "..." or
    `...`): the file's basename or its extensionless stem, as a whole path segment. This is
    the fail-closed half of the excuse (PR #2600 review, comment 6045665870): the import
    regex cannot see comments inside import braces, `import{a}from`, template-literal or
    multi-argument dynamic imports, import-map aliases, Deno.readTextFile / Worker / URL
    reads, extensionless specifiers or createRequire -- but every one of them still quotes
    the file name, so a quoted mention keeps the file reported as missing_in_deploy.
    A commented-out import also counts: that errs toward reporting drift."""
    base = rel.rsplit("/", 1)[-1]
    stem = base.rsplit(".", 1)[0] if "." in base else base
    pat = re.compile(
        r"""['"`][^'"`\n]*?(?<![\w.-])(?:%s|%s)(?![\w-])[^'"`\n]*?['"`]"""
        % (re.escape(base), re.escape(stem))
    )
    return any(pat.search(t) for k, t in texts.items() if k != rel)


def reachable_from_entrypoint(repo_dir: Path, rels, fixtures_are_tests: bool = True) -> set:
    """Repo-relative POSIX paths reachable from the function's entrypoint through
    relative imports of non-test code files. Empty set when there is no entrypoint."""
    present = set(rels)
    queue = [e for e in _ENTRYPOINTS if e in present]
    seen = set(queue)
    while queue:
        cur = queue.pop()
        if not cur.endswith(_CODE_SUFFIXES):
            continue
        try:
            src = (repo_dir / cur).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for m in _REL_IMPORT.finditer(src):
            spec = m.group(1) or m.group(2)
            tgt = posixpath.normpath(posixpath.join(posixpath.dirname(cur), spec))
            if tgt.startswith("..") or tgt not in present or tgt in seen or is_test_path(tgt, fixtures_are_tests):
                continue
            seen.add(tgt)
            queue.append(tgt)
    return seen


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


def compare_function(slug: str, repo_dir: Path, deployed_dir: Path, out_of_tree: dict = None) -> dict:
    """Compare one function's deployed tree against its repo tree.

    Returns a row: {slug, verdict, files: [{path, status, repo_sha, deployed_sha}]}
    where status is one of same | differs | missing_in_repo | missing_in_deploy.

    `out_of_tree` is {repo-root-relative path: (repo_sha256 or None, deployed_sha256)} for files
    the deployed bundle carries from OUTSIDE supabase/functions/ (e.g. react-app/app/lib/...),
    which the Supabase CLI refuses to extract; they are compared like any other file.
    """
    repo_hashes = hash_tree(repo_dir)
    deployed_hashes = hash_tree(deployed_dir)

    texts, unsafe = _scan_texts(repo_dir, repo_hashes)
    # `__fixtures__/` is a test asset only while no non-test file mentions it, and never when
    # the scan is unsafe (an unreadable file might mention it).
    fixtures_are_tests = unsafe is None and not any("__fixtures__" in t for t in texts.values())
    # Unsafe scan (undecodable file / computed import): excuse nothing -> empty reachable set.
    reachable = set() if unsafe else reachable_from_entrypoint(repo_dir, repo_hashes, fixtures_are_tests)
    files = []
    for rel in sorted(set(repo_hashes) | set(deployed_hashes)):
        repo_sha = repo_hashes.get(rel)
        deployed_sha = deployed_hashes.get(rel)
        if repo_sha is None:
            status = "missing_in_repo"
        elif deployed_sha is None:
            if is_test_path(rel, fixtures_are_tests):
                status = "test_not_bundled"
            elif (
                reachable
                and rel.endswith(_CODE_SUFFIXES)
                and rel not in reachable
                and not quoted_mention(rel, texts)
            ):
                status = "unreferenced_not_bundled"
            else:
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

    for rel, (repo_sha, deployed_sha) in sorted((out_of_tree or {}).items()):
        if repo_sha is None:
            status = "missing_in_repo"
        elif repo_sha == deployed_sha:
            status = "same"
        else:
            status = "differs"
        files.append({"path": rel, "status": status, "repo_sha256": repo_sha, "deployed_sha256": deployed_sha})

    if not repo_hashes:
        verdict = DEPLOYED_NOT_IN_REPO
    elif all(f["status"] in NON_DRIFT_STATUSES for f in files):
        verdict = IDENTICAL
    else:
        verdict = DRIFTED

    row = {"slug": slug, "verdict": verdict, "files": files}
    if unsafe:
        row["excuse_disabled"] = unsafe
    return row


# Where the Management API fallback parks deployed files that live OUTSIDE supabase/functions/.
OUT_OF_TREE_DIR = "__out_of_tree__"


def build_report(repo_functions_dir: Path, deployed_root: Path, deployed_slugs, repo_slugs=None, repo_root: Path = None) -> dict:
    """Compare every deployed slug against the repo, and note repo functions
    that are not deployed at all.

    `deployed_root` holds one subdirectory per slug, each mirroring the layout
    of `supabase/functions/<slug>/`.
    """
    if repo_slugs is None:
        repo_slugs = discover_repo_slugs(repo_functions_dir)

    rows = []
    for slug in sorted(deployed_slugs):
        oot = {}
        oot_dir = deployed_root / OUT_OF_TREE_DIR / slug
        if repo_root is not None and oot_dir.is_dir():
            for rel, deployed_sha in hash_tree(oot_dir).items():
                repo_file = repo_root / rel
                oot[rel] = (sha256_file(repo_file) if repo_file.is_file() else None, deployed_sha)
        rows.append(
            compare_function(
                slug,
                repo_functions_dir / slug,
                deployed_root / slug,
                out_of_tree=oot,
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

    unmeasured = [r for r in report["functions"] if r["verdict"] in UNMEASURED_VERDICTS]
    if unmeasured:
        lines += [
            f"> **COULD NOT MEASURE {len(unmeasured)} function(s) - this is NOT a drift finding.** "
            "Each was tried 3 times with backoff on the CLI and once through the Management API, "
            "and none of those settled it. The run stays RED (exit 2) on purpose: a detector that "
            "turns green when it could not measure is worse than a red one. Unmeasured: "
            + ", ".join(f"`{r['slug']}` ({r.get('reason') or 'no reason recorded'})" for r in unmeasured),
            "",
        ]
    drifted = [r for r in report["functions"] if r["verdict"] in FAILING_VERDICTS]
    if drifted:
        lines += [f"> **DRIFT: {len(drifted)} function(s) measured and failing** (see table).", ""]
    problems = [r for r in report["functions"] if r["verdict"] != IDENTICAL]
    if not problems:
        lines.append("Every deployed function is byte-identical to `main`.")
        return "\n".join(lines) + "\n"

    lines += ["| Function | Verdict | Files differing |", "|---|---|---|"]
    for row in problems:
        bad = [f for f in row["files"] if f["status"] != "same"]
        detail = ", ".join(f"`{f['path']}` ({f['status']})" for f in bad) or "—"
        if row.get("reason"):
            detail = "could not measure: " + row["reason"]
        if row.get("excuse_disabled"):
            detail += f" [excuses disabled: {row['excuse_disabled']}]"
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


def _reclaim_tree(path: Path) -> None:
    """Best-effort: make every entry under `path` owned by us and writable.

    gh-1295's first live run (2026-08-31) crashed on function 1 of 57: `supabase
    functions download` shells out to Docker, and on the hosted Ubuntu runner the
    files it writes come back root-owned / read-only. `shutil.move`'s rename fails
    with EPERM, its copy+rmtree fallback then fails too (rmtree's own permission
    self-heal calls `os.chmod`, which itself raises EPERM on a file this process
    does not own). Reclaiming ownership via `sudo chown` (passwordless on
    GitHub-hosted runners) handles the ownership-mismatch case; the chmod pass
    below handles the plainer read-only-without-ownership-mismatch case so this
    also works unprivileged (e.g. local reproduction without sudo).
    """
    if hasattr(os, "getuid"):  # sudo/chown are POSIX-only; CI runs on Linux
        subprocess.run(
            ["sudo", "chown", "-R", f"{os.getuid()}:{os.getgid()}", str(path)],
            capture_output=True,
        )
    for root, dirs, files in os.walk(path):
        for name in dirs:
            p = os.path.join(root, name)
            try:
                os.chmod(p, os.stat(p).st_mode | stat.S_IWUSR | stat.S_IXUSR | stat.S_IRUSR)
            except OSError:
                pass
        for name in files:
            p = os.path.join(root, name)
            try:
                os.chmod(p, os.stat(p).st_mode | stat.S_IWUSR | stat.S_IRUSR)
            except OSError:
                pass
    try:
        os.chmod(path, os.stat(path).st_mode | stat.S_IWUSR | stat.S_IXUSR | stat.S_IRUSR)
    except OSError:
        pass


# Transient-failure policy (CTO RUN 63, PR #2600). A fetch that fails is retried: 3 CLI tries
# with backoff, then one independent attempt through the Management API. Only when none of
# those settles it is the function reported FETCH_FAILED (exit 2, "COULD NOT MEASURE").
# That stays RED, deliberately: a detector that goes green when it could not measure is worse
# than a red one (gh-1295 / gh-1344 / gh-1419). The summary says it is not drift.
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = (3, 8)  # sleep before try 2 and try 3
# The CLI refuses a bundle that imports from outside supabase/functions/. That is
# deterministic, not transient: retrying it three times only wastes a minute.
CLI_OUT_OF_TREE_MARKER = "refusing to extract Function file outside"
API_TIMEOUT_SECONDS = 120

# slug -> why it could not be measured (read by main() and the report).
FETCH_REASONS = {}


def _cli_download(cli: str, project_ref: str, slug: str, dest_root: Path):
    """One `supabase functions download --use-api` attempt. Returns (ok, last stderr line).

    `--use-api` is load-bearing, not an optimization (gh-1295, 2026-08-31). The
    CLI has TWO extraction paths for the downloaded eszip: a local Docker
    edge-runtime container when Docker is reachable, and a server-side unbundle
    (`--use-api`) when it is not. The Docker path returned transformed bytes for
    EVERY function on the hosted ubuntu-latest runner - 58-59/59 DRIFTED with an
    unstable split across runs on an unchanged `main`, including functions
    independently proven byte-identical - while the non-Docker path is
    byte-faithful (verified 2026-08-31: 41/60 IDENTICAL locally with CLI 2.116.0,
    matching `main` blob-for-blob on just-deployed functions, and the same
    `stripe-webhook` sha256 `de947265cb...` the repo side reports). Pinning the
    CLI version (PR #1428) was tested and falsified as a fix - the variable was
    Docker's presence, so force the server-side path everywhere.

    The CLI writes to `<cwd>/supabase/functions/<slug>/`, so each download runs in its own
    scratch cwd and the result is moved into place.
    """
    with tempfile.TemporaryDirectory() as scratch:
        proc = subprocess.run(
            [cli, "functions", "download", slug, "--project-ref", project_ref, "--use-api"],
            capture_output=True,
            text=True,
            cwd=scratch,
        )
        produced = Path(scratch) / FUNCTIONS_DIR / slug
        if proc.returncode != 0 or not produced.is_dir():
            err = proc.stderr.strip()
            # The refusal line is not always the LAST stderr line ("Try rerunning ..." follows it).
            marker = next((ln for ln in err.splitlines() if CLI_OUT_OF_TREE_MARKER in ln), "")
            tail = marker or (err.splitlines()[-1] if err else "no stderr")
            return False, f"exit {proc.returncode}: {tail}"
        # Reclaim the WHOLE scratch tree, not just `produced`: removing or
        # renaming a directory entry needs write permission on its PARENT, not
        # on the entry itself (gh-1295 live-run crashes, 2026-08-31, twice).
        _reclaim_tree(Path(scratch))
        dest = dest_root / slug
        if dest.exists():
            shutil.rmtree(dest)
        shutil.move(str(produced), str(dest))
        return True, ""


def split_bundle(slug: str, raw: dict):
    """Split a Management API bundle ({name: bytes}) into (in_tree, out_of_tree).

    in_tree      {path relative to the function dir: bytes}
    out_of_tree  {repo-root-relative path: bytes} for files from outside supabase/functions/

    Three root conventions are seen on production (CTO RUNs 60/61, ef-deploy.py read_body):
    "supabase/functions/<slug>/x" (repo-rooted), "functions/<slug>/x" (rooted at supabase/),
    and "<slug>/x" (rooted at the functions dir). `_shared` files are not the function's own."""
    in_tree, out = {}, {}
    for name, data in raw.items():
        n = name[len("source/"):] if name.startswith("source/") else name
        for root in (f"supabase/functions/{slug}/", f"functions/{slug}/", f"{slug}/"):
            if n.startswith(root):
                in_tree[n[len(root):]] = data
                break
        else:
            if n.startswith(("supabase/functions/", "functions/", "_shared/")):
                continue  # another function's or shared code, not this function's own files
            out[n] = data
    return in_tree, out


def api_read_body(project_ref: str, slug: str, token: str) -> dict:
    """Deployed bundle via the Management API (Accept: multipart/form-data) -> {name: bytes}.
    Raises OSError-derived or ValueError on any failure; never prints the token."""
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{project_ref}/functions/{slug}/body",
        headers={
            "Authorization": "Bearer " + token,
            "User-Agent": "otterquote-drift-detector",
            "Accept": "multipart/form-data",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=API_TIMEOUT_SECONDS) as resp:
            ctype = resp.headers.get("Content-Type", "")
            body = resp.read()
    except urllib.error.HTTPError as exc:
        raise ValueError(f"Management API HTTP {exc.code}") from None
    if not ctype.startswith("multipart/form-data"):
        raise ValueError(f"Management API returned content-type {ctype!r}, not multipart/form-data")
    msg = _message_from_bytes(
        b"Content-Type: " + ctype.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body,
        policy=_email_policy.HTTP,
    )
    raw = {}
    for part in msg.iter_parts():
        name = part.get_filename()
        if name:
            raw[name] = part.get_payload(decode=True)
    if not raw:
        raise ValueError("Management API bundle had no files")
    return raw


def _api_download(project_ref: str, slug: str, dest_root: Path, read_body=api_read_body) -> None:
    """Fallback fetch: write the function's own files to dest_root/<slug>/ and any file the
    bundle carries from outside supabase/functions/ to dest_root/__out_of_tree__/<slug>/.
    Raises on failure (caller records the reason)."""
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    if not token:
        raise ValueError("SUPABASE_ACCESS_TOKEN is not set")
    in_tree, out = split_bundle(slug, read_body(project_ref, slug, token))
    if not in_tree:
        raise ValueError("Management API bundle had no files under the function directory")
    for base, files in ((dest_root / slug, in_tree), (dest_root / OUT_OF_TREE_DIR / slug, out)):
        if base.exists():
            shutil.rmtree(base)
        for rel, data in files.items():
            target = base / rel
            if not target.resolve().is_relative_to(base.resolve()):
                raise ValueError(f"unsafe path in bundle: {rel}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        if files or base == dest_root / slug:
            base.mkdir(parents=True, exist_ok=True)


def download_function(cli: str, project_ref: str, slug: str, dest_root: Path,
                      sleep=time.sleep, api_download=_api_download, cli_download=_cli_download) -> bool:
    """Download one deployed function into `dest_root/<slug>/`. Returns False only when every
    route failed; the reason is left in FETCH_REASONS[slug]. The caller records FETCH_FAILED
    (never a clean result).

    1. CLI, up to RETRY_ATTEMPTS tries with backoff. An out-of-tree refusal is deterministic
       and skips the remaining tries.
    2. Management API body read (what ef-deploy.py verify uses), which can also carry files
       from outside supabase/functions/.
    """
    FETCH_REASONS.pop(slug, None)
    last = ""
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        ok, last = cli_download(cli, project_ref, slug, dest_root)
        if ok:
            return True
        print(f"  ! CLI fetch of {slug}, try {attempt}/{RETRY_ATTEMPTS} failed ({last})", file=sys.stderr)
        if CLI_OUT_OF_TREE_MARKER in last:
            break
        if attempt < RETRY_ATTEMPTS:
            sleep(RETRY_BACKOFF_SECONDS[min(attempt - 1, len(RETRY_BACKOFF_SECONDS) - 1)])
    try:
        api_download(project_ref, slug, dest_root)
        print(f"  ~ {slug} fetched through the Management API after the CLI failed ({last})")
        return True
    except Exception as exc:  # noqa: BLE001 - any failure here is "could not measure"
        FETCH_REASONS[slug] = f"CLI: {last}; Management API: {type(exc).__name__}: {exc}"
        print(f"  ! fetch failed for {slug}: {FETCH_REASONS[slug]}", file=sys.stderr)
        return False


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
        deployed_slugs = sorted(
            p.name for p in deployed_root.iterdir() if p.is_dir() and p.name != OUT_OF_TREE_DIR
        )
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
        report = build_report(repo_functions_dir, deployed_root, deployed_slugs, repo_root=repo_root)
        for slug in failed_fetches:
            report["functions"].append(
                {"slug": slug, "verdict": FETCH_FAILED, "files": [], "reason": FETCH_REASONS.get(slug)}
            )
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
                    f"COULD NOT MEASURE: {len(failed_fetches)} function(s) failed to download after "
                    f"{RETRY_ATTEMPTS} CLI tries and a Management API attempt: {', '.join(failed_fetches)}\n"
                    "This is NOT a drift finding, and the run stays red on purpose.",
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
