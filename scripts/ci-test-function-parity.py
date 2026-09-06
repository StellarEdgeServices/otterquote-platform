#!/usr/bin/env python3
"""
ci-test-function-parity.py — CI-test Edge Function parity check (gh-1584)

Answers exactly one question: does every Edge Function the E2E test path
actually calls exist on the CI-test Supabase project (`zsdvaqilfdclwosmiheh`)?

Background: gh-689 repointed the E2E workflow onto the dedicated CI-test
project in August. Nothing was ever built to keep that project's deployed
functions in sync with what the E2E path calls, and nothing noticed for two
weeks because no test path happened to call a real one -- until it did
(gh-1584 root cause: the seed writes fixture rows around the gate instead of
calling the validator, because at the time nothing else called it either).

Ruling (CTO, gh-1584, 2026-09-04T19:16:26Z): CI-test is deploy-as-needed, NOT
full parity with production -- a mirror nobody watches drifts silently, which
is worse than a suite that stops with a clear "function not found". So the
policy is deploy-as-needed *plus* this check, which is the actual mechanism:
it fails the PR when the E2E path calls a function this project does not
have, rather than relying on someone remembering to deploy it.

Method:
  1. Scan tests/e2e/**/*.{mjs,ts,js} (excluding node_modules) for every Edge
     Function name referenced via `/functions/v1/<name>` or
     `functions.invoke('<name>')` / `functions.invoke("<name>")`.
  2. List the functions actually deployed on the CI-test project via the
     Supabase Management API.
  3. Compare. Exit 0 if every referenced name is deployed (prints the table).
     Exit 2 and list the missing names if any referenced function is absent
     -- this is the actual defect gh-1584 is about, and deploying the
     missing function is the CTO's call per-function, not this script's.
     Exit 3 (UNMEASURED) if the token is missing or the Management API is
     unreachable -- per gh-1419's rule, "unmeasured" must fail exactly as
     loudly as "failed" and must never look like a clean pass.

Requires SUPABASE_ACCESS_TOKEN (a Supabase Personal Access Token, sbp_...)
in the environment. The service-role key is not sufficient -- the Management
API rejects it.

Usage:
  SUPABASE_ACCESS_TOKEN=sbp_... python3 scripts/ci-test-function-parity.py
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

CI_TEST_PROJECT_REF = "zsdvaqilfdclwosmiheh"
MANAGEMENT_API_BASE = "https://api.supabase.com/v1"

# Function names are the Supabase slug charset: letters, digits, hyphen, underscore.
_NAME = r"[A-Za-z0-9_-]+"
URL_PATH_RE = re.compile(r"/functions/v1/(" + _NAME + r")")
INVOKE_RE = re.compile(r"functions\.invoke\(\s*['\"](" + _NAME + r")['\"]")

E2E_SCAN_EXTENSIONS = {".mjs", ".ts", ".js"}


class FetchError(Exception):
    """Raised when the Management API cannot be reached or answers unusably.

    `status` carries the HTTP status code when one was received (e.g. a 401
    or 404), or None when the request never got an HTTP response at all
    (DNS/connection failure, timeout).
    """

    def __init__(self, message: str, status=None):
        super().__init__(message)
        self.status = status


def extract_functions_from_text(text: str) -> set:
    """Pure regex extraction over one file's text. No I/O -- unit-testable directly."""
    names = set()
    names.update(m.group(1) for m in URL_PATH_RE.finditer(text))
    names.update(m.group(1) for m in INVOKE_RE.finditer(text))
    return names


def iter_e2e_source_files(e2e_root: Path):
    if not e2e_root.is_dir():
        return
    for path in sorted(e2e_root.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix not in E2E_SCAN_EXTENSIONS:
            continue
        if "node_modules" in path.parts:
            continue
        yield path


def collect_referenced_functions(e2e_root: Path) -> set:
    names = set()
    for path in iter_e2e_source_files(e2e_root):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        names.update(extract_functions_from_text(text))
    return names


def fetch_deployed_function_slugs(project_ref: str, token: str, urlopen=urllib.request.urlopen) -> list:
    """Return the list of function slugs deployed on `project_ref`.

    Raises FetchError on any failure: no token, network error, non-200
    response, or a response body that doesn't parse as the expected JSON
    array of function objects. `urlopen` is injectable for tests.

    The explicit User-Agent is load-bearing, not cosmetic: verified live
    2026-09-04 that api.supabase.com's Cloudflare front door 403s
    (`error code: 1010`, the "browser signature" ban) on urllib's default
    "Python-urllib/x.y" User-Agent, with a VALID token, before the request
    ever reaches Supabase's own auth. Without this header the check would
    misreport a working token as UNMEASURED.
    """
    url = f"{MANAGEMENT_API_BASE}/projects/{project_ref}/functions"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "otterquote-ci-test-function-parity/1.0",
        },
    )
    try:
        with urlopen(req, timeout=30) as resp:
            status = getattr(resp, "status", 200)
            body = resp.read()
    except urllib.error.HTTPError as exc:
        raise FetchError(f"Management API returned HTTP {exc.code}", status=exc.code) from exc
    except urllib.error.URLError as exc:
        raise FetchError(f"Management API unreachable: {exc.reason}", status=None) from exc

    if status != 200:
        raise FetchError(f"Management API returned HTTP {status}", status=status)

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise FetchError(f"Management API response was not valid JSON: {exc}", status=status) from exc

    if not isinstance(payload, list):
        raise FetchError(
            f"Management API response was not a JSON array (got {type(payload).__name__})",
            status=status,
        )

    return [entry.get("slug") for entry in payload if isinstance(entry, dict) and entry.get("slug")]


def render_table(referenced: list, deployed: set) -> str:
    if not referenced:
        return "(no /functions/v1/... or functions.invoke(...) references found under tests/e2e/)"
    width = max(len(n) for n in referenced) + 2
    lines = [f"{'function'.ljust(width)}status", f"{'-' * width}{'-' * 8}"]
    for name in referenced:
        status = "present" if name in deployed else "MISSING"
        lines.append(f"{name.ljust(width)}{status}")
    return "\n".join(lines)


def run(e2e_root: Path, project_ref: str, token: str, fetcher=fetch_deployed_function_slugs) -> int:
    """Core logic, decoupled from argv/env for testability. Returns the process exit code."""
    referenced = sorted(collect_referenced_functions(e2e_root))

    if not token:
        print(
            "UNMEASURED: SUPABASE_ACCESS_TOKEN is not set.\n"
            "  This must be a Supabase Personal Access Token (sbp_...); the service-role\n"
            "  key is not sufficient. This is a FAILURE, not a skip -- per gh-1419, an\n"
            "  unmeasured run must fail exactly as loudly as a measured failure.",
            file=sys.stderr,
        )
        return 3

    try:
        deployed = set(fetcher(project_ref, token))
    except FetchError as exc:
        print(
            f"UNMEASURED: could not list deployed functions on {project_ref}: {exc}\n"
            f"  (HTTP status: {exc.status if exc.status is not None else 'no response'})\n"
            "  This is a FAILURE, not a skip -- per gh-1419, an unmeasured run must fail\n"
            "  exactly as loudly as a measured failure.",
            file=sys.stderr,
        )
        return 3

    print(render_table(referenced, deployed))

    missing = [n for n in referenced if n not in deployed]
    if missing:
        print(
            f"\nMISSING on CI-test project {project_ref}: {', '.join(missing)}\n"
            "The E2E test path calls a function this project does not have deployed.\n"
            "Per the CTO's ruling on gh-1584: CI-test is deploy-as-needed, not full\n"
            "parity -- deploying the missing function is a per-function call for the\n"
            "CTO to make, not something this check or its caller should do.",
            file=sys.stderr,
        )
        return 2

    return 0


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    e2e_root = repo_root / "tests" / "e2e"
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    return run(e2e_root, CI_TEST_PROJECT_REF, token)


if __name__ == "__main__":
    sys.exit(main())
