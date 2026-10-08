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
    --allowlist PATH       files allowed to be absent from a deploy (default:
                           scripts/edge-function-drift-allowlist.txt). Exact repo paths only;
                           anything else missing from a deploy is DRIFTED. The excused files
                           are printed in every report.
    --fetch-only-slugs a,b restrict to these slugs (debugging; NOT for CI)

  Exit codes:
    0  — every deployed function is byte-identical to `main`
    1  — drift found (or a deployed function has no counterpart in the repo)
    2  — COULD NOT MEASURE: no token, no CLI, a fetch failed, or the allowlist is invalid
         (a listed file, or a `*.test.*` file, is named by non-test code). Never silent.

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
NON_DRIFT_STATUSES = frozenset({"same", "test_not_bundled", "allowlisted_not_bundled"})


def is_test_path(rel: str) -> bool:
    """True for a `*.test.*` file: a name that contains `.test.` followed by an extension.

    CTO RUN 63 (PR #2600 review 6051654612): this used to also match `*_test.ts` and `test_*`,
    which excused a production file such as `test_mode.ts` by its name alone. Only `*.test.*`
    is excused by name now (the one form the tree uses: 254 files, all `*.test.*`), and even
    that excuse is withdrawn for a file that non-test code quotes (test_file_import_violations).
    """
    name = rel.rsplit("/", 1)[-1]
    head, sep, tail = name.partition(".test.")
    return bool(head) and bool(sep) and bool(tail)


# gh-1295 (CTO RUN 63, PR #2600 fourth attempt): the ONLY other file allowed to be absent from
# a deployed bundle is one named in a checked-in allowlist of exact repo paths. Earlier
# attempts tried to RECOGNISE such files (walk imports, search for quoted names, refuse on
# computed imports); three independent reviews each found another code shape that made the
# recogniser excuse a file the bundle really needed. The fix is to stop recognising. A file
# not on the list that is missing from, or differs from, the deploy is DRIFTED, whatever it
# looks like.
ALLOWLIST_FILENAME = "edge-function-drift-allowlist.txt"
ALLOWLIST_SEPARATOR = " :: "


class AllowlistError(ValueError):
    """The allowlist file is malformed. Always fatal (exit 2): a list that cannot be read
    must never silently become 'excuse nothing' or 'excuse everything'."""


def load_allowlist(path: Path) -> dict:
    """{exact repo-root-relative path: one-line reason}. Raises AllowlistError on any bad line."""
    entries = {}
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as exc:
        raise AllowlistError(f"cannot read allowlist {path}: {type(exc).__name__}") from None
    for n, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        rel, sep, reason = line.partition(ALLOWLIST_SEPARATOR)
        rel, reason = rel.strip(), reason.strip()
        if not sep or not rel or not reason:
            raise AllowlistError(f"{path}:{n}: expected '<repo path>{ALLOWLIST_SEPARATOR}<reason>'")
        if (
            not rel.startswith(FUNCTIONS_DIR + "/")
            or rel.endswith("/")
            or any(c in rel for c in "*?[]{}\\")
            or any(part in ("", ".", "..") for part in rel.split("/"))
        ):
            raise AllowlistError(f"{path}:{n}: '{rel}' is not an exact file path under {FUNCTIONS_DIR}/")
        if rel in entries:
            raise AllowlistError(f"{path}:{n}: '{rel}' is listed twice")
        entries[rel] = reason
    return entries


_QUOTED = re.compile(r"""(['"`])([^'"`\n]{1,400})['"`]""")
_SPECIFIER = re.compile(r"[\w@~:./-]+")
_MODULE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts")


def _import_violations(candidates, repo_root: Path) -> dict:
    """{candidate path: first importer that quotes it}, over every non-`*.test.*` file under
    supabase/functions/. A candidate (an allowlisted file, or a file excused by its `*.test.*`
    name) that non-test code names is bundled, so its absence from a deploy would be real drift
    and the excuse is wrong. A test-NAMED importer that is not `*.test.*` (`test_helpers.ts`,
    `util_test.ts`) counts as non-test code here: the importer exemption is the same narrow
    name rule as the file excuse, so a production file cannot hide behind a test-like name."""
    root = Path(repo_root)
    functions = root / FUNCTIONS_DIR
    candidates = list(candidates)
    if not candidates or not functions.is_dir():
        return {}
    # Lookup tables so the scan is O(quoted strings), not O(strings x candidates).
    by_path = {}   # resolved relative specifier -> candidate paths
    by_base = {}   # exact file name -> candidate paths (alias / import-map specifiers)
    for rel in candidates:
        base = rel.rsplit("/", 1)[-1]
        stem = base[: base.rfind(".")] if "." in base else base
        keys = {rel}
        if stem != base:
            keys.add(rel[: len(rel) - len(base) + len(stem)])
        if any(base == "index" + suffix for suffix in _MODULE_SUFFIXES):
            keys.add(posixpath.dirname(rel))
        for k in keys:
            by_path.setdefault(k, []).append(rel)
        by_base.setdefault(base, []).append(rel)
    found = {}
    for path in sorted(functions.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        importer = path.relative_to(root).as_posix()
        if is_test_path(importer):
            continue
        try:
            text = path.read_bytes().decode("latin-1")  # never fails, never skips a file
        except OSError:
            continue
        for m in _QUOTED.finditer(text):
            quote, spec = m.group(1), m.group(2)
            if not _SPECIFIER.fullmatch(spec):
                continue  # prose between two apostrophes in a comment, not a path
            if spec.startswith(("./", "../")):
                hits = by_path.get(posixpath.normpath(posixpath.join(posixpath.dirname(importer), spec)), ())
            else:
                # alias / import-map specifier. Backticks are skipped here: a `code span` in a
                # comment is far more common than an aliased template-literal import.
                hits = by_base.get(spec.rsplit("/", 1)[-1], ()) if quote != "`" else ()
            for rel in hits:
                if rel not in found and importer != rel:
                    found[rel] = importer
    return found


def allowlist_import_violations(allowlist: dict, repo_root: Path) -> dict:
    """{allowlisted path: first non-test file that quotes it}. An allowlisted file that
    non-test code names is bundled, so its absence from a deploy would be real drift and the
    entry is wrong. This is a tripwire on the list, not a recogniser: the excuse itself is
    still the exact path. It resolves every quoted relative specifier (`./x`, `../y/x.ts`,
    extensionless, directory index) against the importing file, and flags a non-relative
    quoted string (an alias) whose last segment is the file's exact name. Computed paths
    cannot be resolved and are not seen, which is why adding to the list is a reviewed act."""
    return _import_violations(allowlist, repo_root) if allowlist else {}


def test_file_import_violations(repo_root: Path) -> dict:
    """{`*.test.*` path: first non-test file that quotes it}. The name excuse applies only to
    a `*.test.*` file that no non-test code imports; one that is quoted is not excused and the
    run exits 2, exactly as for a listed file. Same resolver, same limits (a computed path is
    not seen)."""
    root = Path(repo_root)
    functions = root / FUNCTIONS_DIR
    if not functions.is_dir():
        return {}
    tests = [
        p.relative_to(root).as_posix()
        for p in sorted(functions.rglob("*"))
        if p.is_file() and not p.is_symlink() and is_test_path(p.name)
    ]
    return _import_violations(tests, repo_root)


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


def compare_function(slug: str, repo_dir: Path, deployed_dir: Path, out_of_tree: dict = None, allowlist: dict = None, test_violations=None) -> dict:
    """Compare one function's deployed tree against its repo tree.

    Returns a row: {slug, verdict, files: [{path, status, repo_sha, deployed_sha}]}
    where status is one of same | differs | missing_in_repo | missing_in_deploy, plus the two
    non-drift statuses test_not_bundled (a *.test.* file) and allowlisted_not_bundled (the
    file's exact repo path is on the allowlist; its reason is on the file entry).

    `out_of_tree` is {repo-root-relative path: (repo_sha256 or None, deployed_sha256)} for files
    the deployed bundle carries from OUTSIDE supabase/functions/ (e.g. react-app/app/lib/...),
    which the Supabase CLI refuses to extract; they are compared like any other file.

    `allowlist` is {exact repo-root-relative path: reason}. It only ever excuses a file that
    exists in the repo and is absent from the deploy; a listed file that is deployed and
    differs is still `differs`.

    `test_violations` is a set of repo paths of `*.test.*` files that non-test code quotes
    (test_file_import_violations); the name excuse is withdrawn for them.
    """
    repo_hashes = hash_tree(repo_dir)
    deployed_hashes = hash_tree(deployed_dir)
    allowlist = allowlist or {}
    test_violations = set(test_violations or ())

    files = []
    for rel in sorted(set(repo_hashes) | set(deployed_hashes)):
        repo_sha = repo_hashes.get(rel)
        deployed_sha = deployed_hashes.get(rel)
        entry_extra = {}
        if repo_sha is None:
            status = "missing_in_repo"
        elif deployed_sha is None:
            repo_path = f"{FUNCTIONS_DIR}/{slug}/{rel}"
            if is_test_path(rel) and repo_path not in test_violations:
                status = "test_not_bundled"
            elif repo_path in allowlist:
                status = "allowlisted_not_bundled"
                entry_extra = {"repo_path": repo_path, "reason": allowlist[repo_path]}
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
                **entry_extra,
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

    return {"slug": slug, "verdict": verdict, "files": files}


# Where the Management API fallback parks deployed files that live OUTSIDE supabase/functions/.
OUT_OF_TREE_DIR = "__out_of_tree__"


def build_report(
    repo_functions_dir: Path,
    deployed_root: Path,
    deployed_slugs,
    repo_slugs=None,
    repo_root: Path = None,
    allowlist: dict = None,
    fetch_failed: dict = None,
) -> dict:
    """Compare every deployed slug against the repo, and note repo functions
    that are not deployed at all.

    `deployed_root` holds one subdirectory per slug, each mirroring the layout
    of `supabase/functions/<slug>/`.

    `fetch_failed` is {slug: reason} for functions that are deployed but could not be
    downloaded. Each gets exactly ONE row, FETCH_FAILED (could not measure), and is never
    also reported as IN_REPO_NEVER_DEPLOYED: it is not in `deployed_slugs` (nothing was
    fetched) but it is deployed.

    `repo_root` is where out-of-tree files (react-app/..., fetched through the Management
    API) are compared against. When a deployed function carries such files and `repo_root`
    is None there is nothing to compare them to, so each is reported `missing_in_repo`
    (DRIFTED): the report never reads IDENTICAL on a file it did not compare.

    `allowlist` is {exact repo path: reason} (see load_allowlist). The report lists every file
    it actually excused under "excused", every entry that names no file in the repo under
    "allowlist_stale", and every entry that non-test code quotes under
    "allowlist_violations"; a violating entry is NOT applied. A `*.test.*` file that non-test
    code quotes is not excused by its name either: it is listed under "test_name_violations".
    """
    if repo_slugs is None:
        repo_slugs = discover_repo_slugs(repo_functions_dir)
    fetch_failed = dict(fetch_failed or {})
    allowlist = dict(allowlist or {})

    scan_root = repo_root if repo_root is not None else repo_functions_dir.parent.parent
    tests_on_disk = [
        p.relative_to(scan_root).as_posix()
        for p in sorted((scan_root / FUNCTIONS_DIR).rglob("*"))
        if p.is_file() and not p.is_symlink() and is_test_path(p.name)
    ] if (scan_root / FUNCTIONS_DIR).is_dir() else []
    quoted = _import_violations(list(allowlist) + [t for t in tests_on_disk if t not in allowlist], scan_root)
    violations = {k: v for k, v in quoted.items() if k in allowlist}
    test_violations = {k: v for k, v in quoted.items() if k not in allowlist}
    effective = {k: v for k, v in allowlist.items() if k not in violations}
    stale = sorted(k for k in allowlist if not (scan_root / k).is_file())

    rows = []
    for slug in sorted(deployed_slugs):
        oot = {}
        oot_dir = deployed_root / OUT_OF_TREE_DIR / slug
        if oot_dir.is_dir():
            for rel, deployed_sha in hash_tree(oot_dir).items():
                repo_file = repo_root / rel if repo_root is not None else None
                oot[rel] = (sha256_file(repo_file) if repo_file is not None and repo_file.is_file() else None, deployed_sha)
        rows.append(
            compare_function(
                slug,
                repo_functions_dir / slug,
                deployed_root / slug,
                out_of_tree=oot,
                allowlist=effective,
                test_violations=set(test_violations),
            )
        )

    for slug in sorted(set(repo_slugs) - set(deployed_slugs) - set(fetch_failed)):
        rows.append({"slug": slug, "verdict": IN_REPO_NEVER_DEPLOYED, "files": []})
    for slug in sorted(fetch_failed):
        rows.append({"slug": slug, "verdict": FETCH_FAILED, "files": [], "reason": fetch_failed[slug]})

    counts = {}
    for row in rows:
        counts[row["verdict"]] = counts.get(row["verdict"], 0) + 1

    excused = [
        {"slug": row["slug"], "path": f["repo_path"], "reason": f["reason"]}
        for row in rows
        for f in row["files"]
        if f["status"] == "allowlisted_not_bundled"
    ]
    rows.sort(key=lambda r: r["slug"])

    return {
        "deployed_count": len(set(deployed_slugs)),
        "repo_count": len(set(repo_slugs)),
        "counts": counts,
        "functions": rows,
        "excused": excused,
        "allowlist_stale": stale,
        "allowlist_violations": violations,
        "test_name_violations": test_violations,
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
    if report.get("allowlist_violations") or report.get("test_name_violations"):
        return 2  # the allowlist (or a name excuse) is wrong; nothing it excused can be trusted
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
            "Each was fetched through the Supabase CLI (retried with backoff when the failure looks "
            "transient; a refusal to extract an out-of-tree file is tried once) and then through the "
            "Management API, and none of those settled it. The run stays RED (exit 2) on purpose: a "
            "detector that turns green when it could not measure is worse than a red one. Unmeasured: "
            + ", ".join(f"`{r['slug']}` ({r.get('reason') or 'no reason recorded'})" for r in unmeasured),
            "",
        ]
    drifted = [r for r in report["functions"] if r["verdict"] in FAILING_VERDICTS]
    if drifted:
        lines += [f"> **DRIFT: {len(drifted)} function(s) measured and failing** (see table).", ""]
    violations = report.get("allowlist_violations") or {}
    if violations:
        lines += [
            f"> **ALLOWLIST INVALID (exit 2): {len(violations)} listed file(s) are named by non-test code.** "
            "Such a file is bundled, so its absence from a deploy is real drift and the entry is not applied. "
            "Remove it from `scripts/" + ALLOWLIST_FILENAME + "`: "
            + ", ".join(f"`{k}` (named in `{v}`)" for k, v in sorted(violations.items())),
            "",
        ]

    test_viol = report.get("test_name_violations") or {}
    if test_viol:
        lines += [
            f"> **TEST-NAMED FILE IS IMPORTED (exit 2): {len(test_viol)} `*.test.*` file(s) are named by non-test code.** "
            "Such a file is not excused by its name; if the deploy lacks it that is real drift. Rename the file "
            "or stop importing it: "
            + ", ".join(f"`{k}` (named in `{v}`)" for k, v in sorted(test_viol.items())),
            "",
        ]

    # Always printed, even when every function is IDENTICAL: an excuse nobody can see is how a
    # wrong one survives. Anything NOT listed here that is missing from a deploy is DRIFTED.
    excused = report.get("excused") or []
    lines += [
        f"## Files excused by the allowlist ({len(excused)})",
        "",
        f"Exact repo paths in `scripts/{ALLOWLIST_FILENAME}` that are absent from the deployed bundle. "
        "No other file is excused, except a `*.test.*` file that no non-test code quotes.",
        "",
    ]
    lines += [f"- `{e['path']}` ({e['slug']}): {e['reason']}" for e in excused] or ["- none"]
    stale = report.get("allowlist_stale") or []
    if stale:
        lines += ["", "Allowlist entries that name no file in the repo (delete them): " + ", ".join(f"`{k}`" for k in stale)]
    lines.append("")

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
            lines = [ln for ln in err.splitlines() if ln.strip()]
            marker = next((ln for ln in lines if CLI_OUT_OF_TREE_MARKER in ln), "")
            # The CLI ends with a boilerplate "Try rerunning the command with --debug ..." line;
            # the line before it is the actual error.
            real = [ln for ln in lines if not ln.lstrip().startswith("Try rerunning")]
            tail = marker or (real[-1] if real else (lines[-1] if lines else "no stderr"))
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
    parser.add_argument(
        "--allowlist",
        default=str(Path(__file__).resolve().parent / ALLOWLIST_FILENAME),
        help="Checked-in list of repo paths allowed to be absent from a deploy (default: next to this script).",
    )
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
    try:
        allowlist = load_allowlist(Path(args.allowlist))
    except AllowlistError as exc:
        die_unmeasured(str(exc))

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
        report = build_report(
            repo_functions_dir,
            deployed_root,
            deployed_slugs,
            repo_root=repo_root,
            allowlist=allowlist,
            fetch_failed={slug: FETCH_REASONS.get(slug) for slug in failed_fetches},
        )

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
                    f"COULD NOT MEASURE: {len(failed_fetches)} function(s) failed to download through the "
                    f"CLI and the Management API: {', '.join(failed_fetches)}\n"
                    "This is NOT a drift finding, and the run stays red on purpose.",
                    file=sys.stderr,
                )
            if report.get("test_name_violations"):
                print(
                    "COULD NOT TRUST THE TEST-NAME EXCUSE: " + ", ".join(sorted(report["test_name_violations"]))
                    + " are `*.test.*` files named by non-test code.",
                    file=sys.stderr,
                )
            if report.get("allowlist_violations"):
                print(
                    "COULD NOT TRUST THE ALLOWLIST: " + ", ".join(sorted(report["allowlist_violations"]))
                    + " are named by non-test code. Remove them from the allowlist.",
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
