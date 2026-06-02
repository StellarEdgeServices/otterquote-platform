"""commit_via_api - atomic single-commit helper for the OtterQuote platform repo (D-232).

Pattern: blob -> tree (with base_tree) -> commit -> ref. Every blob uploads before
the tree is created; if any blob fails, no tree/commit/ref is created and the repo
stays clean.

Why base_tree matters: without it, the tree contains ONLY the listed paths and the
resulting commit effectively deletes every other file in the repo. base_tree=<head
tree sha> tells GitHub to start from the existing tree and overlay the listed
entries. This is the primary regression fix vs the May 8, 2026 first-pass build.

Public API:
    commit_files(paths, message, branch, working_dir) -> dict
    deploy_to_main(paths, message, pr_title, working_dir, ...) -> dict
    deploy_to_main_legacy(commit_result, pr_title, ...) -> dict   [DEPRECATED]
    revert_commit(commit_sha, branch) -> dict
    get_branch_head(branch) -> str
    create_branch(branch, from_sha) -> None
    delete_branch(branch) -> None
    create_pull_request(title, body, head, base) -> dict
    list_pull_requests(head, base, state) -> list
    merge_pull_request(pr_number, ...) -> dict
    GitHubApiError  -- raised on any non-2xx response
    TruncationError -- raised when a committed blob is smaller than the source file

Auth: GITHUB_DEPLOY_PAT env var (read at call time, never logged).
Repo: StellarEdgeServices/otterquote-platform (constant).
Dependencies: requests + stdlib only. No bash, no subprocess.

D-232 (May 13, 2026): deploy_to_main() routes via feature branch -> PR to main,
NOT via staging detour. staging is now a one-way mirror of main (staging-mirror.yml).
"""
from __future__ import annotations

import base64
import glob
import os
import sys
import time
from typing import Any

REPO_OWNER = "StellarEdgeServices"
REPO_NAME = "otterquote-platform"
REPO = f"{REPO_OWNER}/{REPO_NAME}"
API_ROOT = "https://api.github.com"

# Retry budget for transient 5xx / connection errors. 3 attempts at 0/2/6s backoff.
_RETRY_STATUSES = {502, 503, 504}
_RETRY_DELAYS = (0, 2, 6)

# Branches that were part of the pre-D-232 staging-detour flow.
# commit_files() still accepts them but logs a deprecation warning.
_LEGACY_STAGING_BRANCHES = {"staging"}


def read_repo_text(path: str, working_dir: str) -> tuple[str, str]:
    """Read a repo file in binary mode and return (text, newline_style).

    IMPORTANT: Always use this function when reading file content you intend to
    edit and re-commit via commit_files(). Never use subprocess text mode or
    open(path, 'r') without 'rb' — text mode silently normalizes CRLF to LF,
    causing a full-file-rewrite diff on files stored as CRLF in the repo.
    (Root cause of the repair-intake.html phantom-rewrite incident, 2026-06-01.)

    Args:
        path:        Repo-relative file path.
        working_dir: Local directory where path is resolved.

    Returns:
        (text, newline) where newline is '\\r\\n' if the file uses Windows line
        endings, or '\\n' otherwise. The returned text always uses '\\n' as the
        line separator — use encode_with_newlines(text, newline) to restore the
        original style before writing back.
    """
    full = os.path.join(working_dir, path)
    with open(full, "rb") as fh:
        raw = fh.read()
    newline = "\r\n" if b"\r\n" in raw else "\n"
    text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n")
    return text, newline


def encode_with_newlines(text: str, newline: str) -> bytes:
    """Re-encode text with the original newline style detected by read_repo_text().

    Use this to write back an edited file so its line endings match the repo:

        text, nl = read_repo_text("foo.html", working_dir)
        text = text.replace("old string", "new string")
        with open(os.path.join(working_dir, "foo.html"), "wb") as fh:
            fh.write(encode_with_newlines(text, nl))
        commit_files(["foo.html"], ...)  # now produces a surgical diff

    Args:
        text:    Normalized LF text (as returned by read_repo_text).
        newline: '\\r\\n' or '\\n' (as returned by read_repo_text).

    Returns:
        UTF-8 encoded bytes with the requested line endings applied.
    """
    if newline == "\r\n":
        text = text.replace("\n", "\r\n")
    return text.encode("utf-8")


def _warn_lineending_mismatch(path: str, new_bytes: bytes, head_sha: str) -> None:
    """Warn to stderr if new_bytes has different line endings than the HEAD blob.

    Detects CRLF->LF or LF->CRLF conversions that would produce a full-file-rewrite
    diff despite only a small net change. Best-effort: silently skips on API errors.
    """
    try:
        head_data = _request("GET", f"/repos/{REPO}/contents/{path}?ref={head_sha}")
        encoded = head_data.get("content", "").replace("\n", "").replace("\r", "")
        if not encoded:
            return
        head_bytes = base64.b64decode(encoded)
    except Exception:
        return  # best-effort guard; never block a commit

    head_has_crlf = b"\r\n" in head_bytes
    new_has_crlf = b"\r\n" in new_bytes

    if head_has_crlf == new_has_crlf:
        return  # consistent — no issue

    # Line-ending mismatch found. Check if net byte change is small (likely phantom rewrite).
    net_delta = abs(len(new_bytes) - len(head_bytes))
    size_ratio = net_delta / max(len(head_bytes), 1)

    direction = "CRLF→LF" if (head_has_crlf and not new_has_crlf) else "LF→CRLF"
    severity = "PHANTOM REWRITE" if size_ratio < 0.05 else "line-ending change"

    sys.stderr.write(
        f"[commit_via_api] WARNING ({severity}): {path} stored as "
        f"{'CRLF' if head_has_crlf else 'LF'} in repo but upload is "
        f"{'LF' if not new_has_crlf else 'CRLF'}-only ({direction}). "
        f"Net byte delta {net_delta:,} ({size_ratio:.1%} of file). "
        f"This will produce a full-file-rewrite diff. "
        f"Use read_repo_text()+encode_with_newlines() to preserve line endings.\n"
    )


class GitHubApiError(Exception):
    """Raised on any non-2xx response from the GitHub API."""

    def __init__(self, status: int, body: str, url: str, method: str) -> None:
        self.status = status
        self.body = body
        self.url = url
        self.method = method
        super().__init__(f"{method} {url} -> HTTP {status}\n{body[:500]}")


class TruncationError(Exception):
    """Raised when a committed blob is smaller than the source file (< 98% threshold)."""

    def __init__(self, truncated: list[tuple[str, int, int]],
                 reverted: bool = True,
                 revert_error: str | None = None) -> None:
        self.truncated = truncated
        self.reverted = reverted
        self.revert_error = revert_error
        details = "; ".join(
            f"{p}: expected {exp}B committed {got}B ({got / exp:.1%})"
            for p, exp, got in truncated
        )
        revert_note = " (commit reverted)" if reverted else f" (REVERT FAILED: {revert_error})"
        super().__init__(f"Truncation detected{revert_note}: {details}")


def _check_blob_sizes(blob_shas: dict[str, str],
                      source_sizes: dict[str, int]) -> list[tuple[str, int, int]]:
    """Fetch each committed blob from GitHub and compare its size to the source."""
    truncated: list[tuple[str, int, int]] = []
    for path, blob_sha in blob_shas.items():
        expected = source_sizes[path]
        if expected == 0:
            continue
        blob_data = _request("GET", f"/repos/{REPO}/git/blobs/{blob_sha}")
        committed = blob_data.get("size", 0)
        if committed < int(expected * 0.98):
            truncated.append((path, expected, committed))
    return truncated


def _load_pat_from_secrets_file() -> str | None:
    """Fallback: read GITHUB_DEPLOY_PAT from .deploy-secrets in the Tools directory."""
    patterns = [
        "/sessions/*/mnt/Claude Downloads/Stellar Edge Services/OtterQuote/Tools/.deploy-secrets",
    ]
    for pattern in patterns:
        for path in glob.glob(pattern):
            try:
                with open(path) as fh:
                    for line in fh:
                        line = line.strip()
                        if line.startswith("#") or "=" not in line:
                            continue
                        key, _, val = line.partition("=")
                        if key.strip() == "GITHUB_DEPLOY_PAT":
                            val = val.strip().strip('"').strip("'")
                            if val and val != "YOUR_PAT_HERE":
                                return val
            except OSError:
                continue
    return None


def _auth_headers() -> dict[str, str]:
    """Build auth headers from GITHUB_DEPLOY_PAT."""
    pat = os.environ.get("GITHUB_DEPLOY_PAT") or _load_pat_from_secrets_file()
    if not pat:
        raise RuntimeError(
            "GITHUB_DEPLOY_PAT not found. Set the environment variable or add "
            "GITHUB_DEPLOY_PAT=<token> to "
            "Stellar Edge Services/OtterQuote/Tools/.deploy-secrets"
        )
    return {
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _check_rate_limit(headers: dict[str, Any]) -> None:
    """Inspect X-RateLimit-Remaining; warn to stderr if < 500."""
    try:
        remaining = int(headers.get("X-RateLimit-Remaining", 9999))
    except (TypeError, ValueError):
        return
    if remaining < 500:
        reset = headers.get("X-RateLimit-Reset", "?")
        sys.stderr.write(
            f"[commit_via_api] WARNING: GitHub rate limit at {remaining} "
            f"remaining (reset epoch={reset})\n"
        )


def _request(method: str, endpoint: str, *, json_body: dict | None = None,
             expected_status: int | tuple[int, ...] = 200) -> Any:
    """Single API request with bounded retries on transient 5xx errors."""
    import requests

    url = f"{API_ROOT}{endpoint}"
    expected = (expected_status,) if isinstance(expected_status, int) else expected_status

    last_status = 0
    last_body = ""
    for attempt, delay in enumerate(_RETRY_DELAYS):
        if delay:
            time.sleep(delay)
        try:
            resp = requests.request(method, url, json=json_body,
                                    headers=_auth_headers(), timeout=30)
        except requests.RequestException as exc:
            last_status, last_body = 0, f"requests exception: {exc}"
            continue

        _check_rate_limit(resp.headers)
        last_status, last_body = resp.status_code, resp.text

        if resp.status_code in expected:
            if not resp.text:
                return None
            try:
                return resp.json()
            except ValueError:
                return {"_raw": resp.text}

        if resp.status_code in _RETRY_STATUSES and attempt < len(_RETRY_DELAYS) - 1:
            sys.stderr.write(
                f"[commit_via_api] transient {resp.status_code} on {method} "
                f"{url}, retrying after {_RETRY_DELAYS[attempt + 1]}s\n"
            )
            continue

        raise GitHubApiError(resp.status_code, resp.text, url, method)

    raise GitHubApiError(last_status, last_body, url, method)


def _create_blob(file_bytes: bytes) -> str:
    body = {"content": base64.b64encode(file_bytes).decode("ascii"),
            "encoding": "base64"}
    return _request("POST", f"/repos/{REPO}/git/blobs",
                    json_body=body, expected_status=201)["sha"]


def _create_tree(entries: list[dict], base_tree_sha: str) -> str:
    """Create a tree referencing existing entries (mode 100644, type blob)."""
    body = {"tree": entries, "base_tree": base_tree_sha}
    return _request("POST", f"/repos/{REPO}/git/trees",
                    json_body=body, expected_status=201)["sha"]


def _create_commit(message: str, tree_sha: str, parent_shas: list[str]) -> str:
    body = {"message": message, "tree": tree_sha, "parents": parent_shas}
    return _request("POST", f"/repos/{REPO}/git/commits",
                    json_body=body, expected_status=201)["sha"]


def _update_ref(branch: str, commit_sha: str) -> None:
    """Fast-forward update; force=False so we never rewrite history."""
    body = {"sha": commit_sha, "force": False}
    _request("PATCH", f"/repos/{REPO}/git/refs/heads/{branch}",
             json_body=body, expected_status=200)


def _get_commit(commit_sha: str) -> dict:
    return _request("GET", f"/repos/{REPO}/git/commits/{commit_sha}")


def get_branch_head(branch: str) -> str:
    """Return the current head commit sha for branch."""
    if not branch:
        raise ValueError("branch must be non-empty")
    data = _request("GET", f"/repos/{REPO}/git/refs/heads/{branch}")
    return data["object"]["sha"]


def commit_files(paths: list[str], message: str, branch: str,
                 working_dir: str,
                 skip_size_check: bool = False) -> dict[str, Any]:
    """Atomically commit one or more files to branch.

    All blobs are uploaded BEFORE the tree is created; if any blob fails, no
    tree/commit/ref is created. New tree uses base_tree=<head tree sha> so
    files outside paths are preserved.

    After the commit lands on the branch, each blob size is fetched from GitHub
    and compared to the pre-read source bytes. If any file is < 98% of its source
    size (a sign of FUSE/bindfs silent truncation), the commit is automatically
    reverted and TruncationError is raised.

    D-232 note: For new code, prefer calling deploy_to_main() which handles
    feature branch creation and PR flow automatically. Callers passing
    branch='staging' receive a deprecation warning -- staging is now a read-only
    mirror of main and direct commits to it are blocked by branch protection
    (impl 2/6, May 13, 2026).

    LINE ENDINGS WARNING: This function reads files from working_dir in binary
    mode ('rb'), preserving whatever line endings are on disk. If a caller reads
    a file in text mode (subprocess, open(f, 'r'), etc.) and writes it back, CRLF
    sequences are silently stripped to LF on most systems, producing a
    full-file-rewrite diff on any CRLF-stored repo file. To safely round-trip
    text edits, use:
        text, nl = read_repo_text(path, working_dir)   # binary-safe read
        text = text.replace(...)                        # edit in LF-normalized space
        with open(os.path.join(working_dir, path), "wb") as f:
            f.write(encode_with_newlines(text, nl))     # restore original endings
    This was the root cause of the repair-intake.html phantom-rewrite (2026-06-01).
    A pre-commit guard (_warn_lineending_mismatch) emits a stderr warning if it
    detects a mismatch between the uploaded blob and the HEAD blob's line endings.

    Args:
        paths:           Repo-relative file paths to commit.
        message:         Git commit message.
        branch:          Target branch name.
        working_dir:     Local directory where paths are resolved.
        skip_size_check: If True, skip post-commit blob size verification.
    """
    if not paths:
        raise ValueError("paths must contain at least one entry")
    if not branch:
        raise ValueError("branch must be non-empty")
    if not message:
        raise ValueError("message must be non-empty")

    # D-232 deprecation warning for legacy staging-detour callers.
    if branch in _LEGACY_STAGING_BRANCHES:
        sys.stderr.write(
            f"[commit_via_api] DEPRECATION WARNING: committing directly to '{branch}' "
            f"is the pre-D-232 staging-detour flow. Under D-232, staging is a "
            f"read-only mirror of main. Use deploy_to_main() instead. Direct commits "
            f"to staging will be rejected by branch protection (HTTP 422).\n"
        )

    file_bytes_by_path: dict[str, bytes] = {}
    for path in paths:
        full = os.path.join(working_dir, path)
        if not os.path.isfile(full):
            raise ValueError(f"file not found at {full}")
        with open(full, "rb") as fh:
            file_bytes_by_path[path] = fh.read()

    head_sha = get_branch_head(branch)
    head_commit = _get_commit(head_sha)
    head_tree_sha = head_commit["tree"]["sha"]

    # Pre-commit line-ending guard: warn if any file has a CRLF<->LF mismatch vs HEAD.
    # This catches edits made in subprocess/text mode that would produce phantom
    # full-file-rewrite diffs. Use read_repo_text()+encode_with_newlines() to avoid.
    for path, file_bytes in file_bytes_by_path.items():
        _warn_lineending_mismatch(path, file_bytes, head_sha)

    blob_shas: dict[str, str] = {}
    for path, file_bytes in file_bytes_by_path.items():
        blob_shas[path] = _create_blob(file_bytes)

    entries = [{"path": p, "mode": "100644", "type": "blob", "sha": blob_shas[p]}
               for p in paths]
    tree_sha = _create_tree(entries, base_tree_sha=head_tree_sha)
    commit_sha = _create_commit(message, tree_sha, [head_sha])
    _update_ref(branch, commit_sha)

    if not skip_size_check:
        source_sizes = {p: len(b) for p, b in file_bytes_by_path.items()}
        truncated = _check_blob_sizes(blob_shas, source_sizes)
        if truncated:
            reverted = True
            revert_error: str | None = None
            try:
                revert_commit(commit_sha, branch)
            except Exception as exc:
                reverted = False
                revert_error = str(exc)
            raise TruncationError(truncated, reverted=reverted, revert_error=revert_error)

    return {
        "sha": commit_sha,
        "branch": branch,
        "files_committed": list(paths),
        "url": f"https://github.com/{REPO}/commit/{commit_sha}",
    }


def revert_commit(commit_sha: str, branch: str) -> dict[str, Any]:
    """Create a true file-level revert of commit_sha on branch."""
    if not commit_sha:
        raise ValueError("commit_sha must be non-empty")
    if not branch:
        raise ValueError("branch must be non-empty")

    detail = _request("GET", f"/repos/{REPO}/commits/{commit_sha}")
    files_changed = detail.get("files", [])
    if not files_changed:
        raise ValueError(f"commit {commit_sha} touched no files; nothing to revert")

    parents = detail.get("parents", [])
    if not parents:
        raise ValueError(f"commit {commit_sha} has no parent; cannot revert")
    parent_sha = parents[0]["sha"]

    head_sha = get_branch_head(branch)
    head_commit = _get_commit(head_sha)
    head_tree_sha = head_commit["tree"]["sha"]

    tree_entries: list[dict] = []
    for f in files_changed:
        path = f["filename"]
        status = f["status"]
        if status == "added":
            tree_entries.append({"path": path, "mode": "100644",
                                 "type": "blob", "sha": None})
        elif status in ("modified", "renamed", "removed"):
            parent_blob = _request(
                "GET", f"/repos/{REPO}/contents/{path}?ref={parent_sha}")
            tree_entries.append({"path": path, "mode": "100644",
                                 "type": "blob", "sha": parent_blob["sha"]})

    revert_tree = _create_tree(tree_entries, base_tree_sha=head_tree_sha)
    revert_sha = _create_commit(
        f"Revert {commit_sha[:7]}\n\nReverts {commit_sha}",
        revert_tree, [head_sha])
    _update_ref(branch, revert_sha)

    return {
        "sha": revert_sha,
        "branch": branch,
        "files_committed": [f["filename"] for f in files_changed],
        "url": f"https://github.com/{REPO}/commit/{revert_sha}",
    }


def delete_branch(branch: str) -> None:
    """Delete a branch via DELETE /git/refs/heads/<branch>."""
    _request("DELETE", f"/repos/{REPO}/git/refs/heads/{branch}",
             expected_status=204)


def create_branch(branch: str, from_sha: str) -> None:
    """Create a branch pointing at from_sha."""
    _request("POST", f"/repos/{REPO}/git/refs",
             json_body={"ref": f"refs/heads/{branch}", "sha": from_sha},
             expected_status=201)


def create_pull_request(
    title: str,
    body: str,
    head: str = "staging",
    base: str = "main",
) -> dict[str, Any]:
    """Open a PR from head to base.

    Returns the full PR payload including number, html_url, node_id.
    Raises GitHubApiError on failure. Not idempotent -- callers should
    check list_pull_requests() before calling to avoid 422 on duplicate.

    Args:
        title: PR title (plain text).
        body:  PR description (Markdown).
        head:  Source branch.
        base:  Target branch (default: main).
    """
    if not title:
        raise ValueError("title must be non-empty")
    return _request(
        "POST",
        f"/repos/{REPO}/pulls",
        json_body={"title": title, "body": body, "head": head, "base": base,
                   "draft": False},
        expected_status=201,
    )


def list_pull_requests(
    head: str = "staging",
    base: str = "main",
    state: str = "open",
) -> list[dict[str, Any]]:
    """Return open PRs matching head to base."""
    data = _request(
        "GET",
        f"/repos/{REPO}/pulls",
        json_body=None,
    )
    return [
        pr for pr in (data or [])
        if pr.get("state") == state
        and pr["head"]["ref"] == head
        and pr["base"]["ref"] == base
    ]


def _poll_required_checks(pr_number: int, poll_interval: int, deadline: float) -> str:
    """Poll PR mergeable_state until clean/unstable or deadline expires.

    Returns final mergeable_state string.
    Raises RuntimeError on dirty/draft (unrecoverable) or deadline exceeded.

    D-232: required CI gate is the Null-Byte & Size Sanity Check. The
    mergeable_state field aggregates all required checks. clean = all pass.
    unstable = required checks pass but non-required are pending/failing --
    still mergeable per D-232 May 13, 2026 fix.
    """
    mergeable_state = "unknown"
    while time.time() < deadline:
        pr = _request("GET", f"/repos/{REPO}/pulls/{pr_number}")
        mergeable_state = pr.get("mergeable_state", "unknown")
        sys.stderr.write(
            f"[commit_via_api] PR #{pr_number} mergeable_state={mergeable_state}\n"
        )
        if mergeable_state in ("clean", "unstable"):
            return mergeable_state
        if mergeable_state in ("dirty", "draft"):
            raise RuntimeError(
                f"PR #{pr_number} cannot be merged: mergeable_state={mergeable_state}"
            )
        time.sleep(poll_interval)

    raise RuntimeError(
        f"PR #{pr_number} did not pass CI within the allotted window "
        f"(last state={mergeable_state})"
    )


def merge_pull_request(
    pr_number: int,
    merge_method: str = "merge",
    poll_interval: int = 15,
    timeout: int = 600,
) -> dict[str, Any]:
    """Merge an open PR once all required status checks are green.

    Polls mergeable_state until clean or timeout expires.
    Raises RuntimeError on timeout or unmergeable state.

    D-232 defaults: poll_interval=15s, timeout=600s (10 min) to accommodate
    the Null-Byte & Size Sanity Check CI gate on main. Previously 10s/180s.

    Args:
        pr_number:     PR number from create_pull_request()["number"].
        merge_method:  merge, squash, or rebase.
        poll_interval: Seconds between polls (default 15).
        timeout:       Max seconds to wait for CI (default 600).
    """
    deadline = time.time() + timeout
    _poll_required_checks(pr_number, poll_interval, deadline)

    result = _request(
        "PUT",
        f"/repos/{REPO}/pulls/{pr_number}/merge",
        json_body={"merge_method": merge_method},
        expected_status=200,
    )
    return {
        "sha": result.get("sha"),
        "merged": result.get("merged", False),
        "message": result.get("message", ""),
        "pr_number": pr_number,
        "url": f"https://github.com/{REPO}/pull/{pr_number}",
    }


def deploy_to_main(
    paths: list[str],
    message: str,
    pr_title: str,
    working_dir: str,
    pr_body: str = "",
    merge_method: str = "squash",
    merge_on_green: bool = True,
    timeout: int = 600,
    feature_branch_prefix: str = "auto",
    delete_branch_after: bool = True,
) -> dict[str, Any]:
    """D-232 deploy: feature branch -> PR to main -> CI gate -> merge -> staging sync.

    Per D-232 (May 13, 2026), staging is a one-way mirror of main. Code lands on
    main via PR from a feature branch (NOT via the old staging detour). After merge,
    staging-mirror.yml auto-fast-forwards staging from main within ~60s.

    Tier rules under D-182:
      - Tier 1 callers: pass merge_on_green=True (default). Fully autonomous:
        creates branch, commits, opens PR, waits for CI, merges, cleans up.
      - Tier 2/3 callers: pass merge_on_green=False. Creates branch, commits,
        opens PR, then STOPS and returns the PR URL for Dustin review. Caller
        must invoke merge_pull_request(pr_number) separately after approval.

    Flow (merge_on_green=True):
      1. Generate feature branch name: {prefix}/{slug}-{unix-ts}
      2. Create branch from current main HEAD
      3. Atomic commit of paths to that branch (with truncation check)
      4. Open PR: head=feat_branch, base=main
      5. Poll CI until Null-Byte & Size Sanity Check passes (up to timeout secs)
      6. Merge PR via squash (default; aligns with D-221 PR pattern)
      7. Delete feature branch (default)
      8. Return PR + merge metadata

    Edge cases handled:
      - Branch already exists (422): raises GitHubApiError with clear message.
      - CI timeout: raises RuntimeError with last observed mergeable_state.
      - Merge failure (conflict/unmergeable): raises RuntimeError.
      - Blob truncation: commit auto-reverted, feature branch cleaned up,
        TruncationError raised.
      - Branch cleanup failure: logged to stderr, non-fatal.

    Args:
        paths:                  Repo-relative file paths to commit.
        message:                Git commit message (body of squash commit).
        pr_title:               PR title (becomes squash commit subject).
        working_dir:            Local directory where paths are resolved.
        pr_body:                Optional Markdown PR description.
        merge_method:           squash (default), merge, or rebase.
        merge_on_green:         True (Tier 1) = merge autonomously on CI green.
                                False (Tier 2/3) = open PR only, return for review.
        timeout:                Seconds to wait for CI (default 600 / 10 min).
        feature_branch_prefix:  Prefix for the auto-generated branch (default auto).
        delete_branch_after:    Delete feature branch after merge (default True).

    Returns:
        dict with: pr_number, pr_url, feature_branch, feature_commit,
                   main_head_at_branch, and either merge_sha+merged (on success)
                   or merge_pending=True (merge_on_green=False).
    """
    # Step 1: generate feature branch name from PR title slug
    slug_seed = pr_title.split("\n", 1)[0].lower()
    slug = "".join(c if c.isalnum() else "-" for c in slug_seed)[:40].strip("-") or "deploy"
    feat_branch = f"{feature_branch_prefix}/{slug}-{int(time.time())}"

    # Step 2: create branch from main HEAD
    main_head = get_branch_head("main")
    try:
        create_branch(feat_branch, main_head)
    except GitHubApiError as exc:
        if exc.status == 422:
            raise GitHubApiError(
                422,
                (f"Feature branch '{feat_branch}' already exists or ref is invalid. "
                 f"Delete the stale branch or use a different feature_branch_prefix. "
                 f"Original error: {exc.body}"),
                exc.url,
                exc.method,
            ) from exc
        raise
    sys.stderr.write(
        f"[commit_via_api] Created feature branch {feat_branch} from main {main_head[:12]}\n"
    )

    # Step 3: atomic commit with truncation guard
    try:
        commit_result = commit_files(
            paths=paths,
            message=message,
            branch=feat_branch,
            working_dir=working_dir,
        )
    except TruncationError:
        # commit_files already reverted the bad commit; clean up dangling branch
        try:
            delete_branch(feat_branch)
            sys.stderr.write(
                f"[commit_via_api] Cleaned up feature branch {feat_branch} after truncation\n"
            )
        except Exception as cleanup_exc:
            sys.stderr.write(
                f"[commit_via_api] WARN: could not clean branch after truncation: {cleanup_exc}\n"
            )
        raise
    sys.stderr.write(
        f"[commit_via_api] Committed {len(paths)} file(s) as {commit_result['sha'][:12]}\n"
    )

    # Step 4: open PR to main (check for existing PR first to avoid 422)
    existing = list_pull_requests(head=feat_branch, base="main")
    if existing:
        pr = existing[0]
        sys.stderr.write(
            f"[commit_via_api] Reusing existing PR #{pr['number']}: {pr['html_url']}\n"
        )
    else:
        pr = create_pull_request(
            title=pr_title,
            body=pr_body or message,
            head=feat_branch,
            base="main",
        )
    sys.stderr.write(
        f"[commit_via_api] PR #{pr['number']} opened: {pr['html_url']}\n"
    )

    base_result: dict[str, Any] = {
        "pr_number": pr["number"],
        "pr_url": pr["html_url"],
        "feature_branch": feat_branch,
        "feature_commit": commit_result["sha"],
        "main_head_at_branch": main_head,
    }

    # Tier 2/3 early return -- caller reviews PR before merge
    if not merge_on_green:
        base_result["merge_pending"] = True
        sys.stderr.write(
            f"[commit_via_api] merge_on_green=False -- PR #{pr['number']} open for review. "
            f"Call merge_pull_request({pr['number']}) after Dustin approval.\n"
        )
        return base_result

    # Steps 5+6: poll CI, then merge
    try:
        merge = merge_pull_request(
            pr["number"], merge_method=merge_method, timeout=timeout
        )
    except (RuntimeError, GitHubApiError):
        sys.stderr.write(
            f"[commit_via_api] Merge failed for PR #{pr['number']}. "
            f"Feature branch {feat_branch} retained for inspection.\n"
        )
        raise

    # Step 7: cleanup feature branch (non-fatal)
    if delete_branch_after:
        try:
            delete_branch(feat_branch)
            sys.stderr.write(
                f"[commit_via_api] Deleted feature branch {feat_branch}\n"
            )
        except Exception as exc:
            sys.stderr.write(
                f"[commit_via_api] WARN: branch cleanup failed (non-fatal): {exc}\n"
            )

    base_result.update({
        "merge_sha": merge["sha"],
        "merged": merge["merged"],
    })
    return base_result


def deploy_to_main_legacy(
    commit_result: dict[str, Any],
    pr_title: str,
    pr_body: str = "",
    merge_method: str = "merge",
    timeout: int = 180,
) -> dict[str, Any]:
    """DEPRECATED: pre-D-232 staging-detour deploy. Soak-window fallback only.

    This captures the pre-D-232 (pre-May 13, 2026) deploy pattern where code
    first landed on staging, then was promoted to main via a staging->main PR.

    Under D-232, staging is a one-way mirror of main. Direct commits to staging
    are blocked by branch protection (HTTP 422). New code MUST land on main via
    deploy_to_main() (feature branch -> PR to main).

    REMOVAL SCHEDULE: Remove after impl 5 (claude-memory.md Deployment rewrite)
    lands AND no caller has invoked this signature for two consecutive sessions.

    Args:
        commit_result: Dict returned by commit_files() with branch='staging'.
                       Expected keys: sha, branch, url.
        pr_title:      PR title matching commit message subject line.
        pr_body:       Optional Markdown description (defaults to commit URL).
        merge_method:  merge (default), squash, or rebase.
        timeout:       Seconds to wait for CI before giving up (default 180).

    Returns:
        dict with keys: pr_number, pr_url, merge_sha, merged, staging_commit
    """
    staging_branch = commit_result.get("branch", "staging")
    sys.stderr.write(
        f"[commit_via_api] DEPRECATED: deploy_to_main_legacy() called with "
        f"branch='{staging_branch}'. Staging is now a read-only mirror of main "
        f"(D-232). Switch callers to deploy_to_main(). This function will be "
        f"removed after the May 13-14, 2026 soak window.\n"
    )

    existing = list_pull_requests(head=staging_branch, base="main")
    if existing:
        pr = existing[0]
        sys.stderr.write(
            f"[commit_via_api] Reusing PR #{pr['number']}: {pr['html_url']}\n"
        )
    else:
        pr = create_pull_request(
            title=pr_title,
            body=pr_body or commit_result.get("url", ""),
            head=staging_branch,
            base="main",
        )
    merge = merge_pull_request(
        pr["number"], merge_method=merge_method, timeout=timeout
    )
    return {
        "pr_number": pr["number"],
        "pr_url": pr["html_url"],
        "merge_sha": merge["sha"],
        "merged": merge["merged"],
        "staging_commit": commit_result["sha"],
    }
