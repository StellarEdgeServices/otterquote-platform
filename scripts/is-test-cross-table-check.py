#!/usr/bin/env python3
"""
is-test-cross-table-check.py — cross-table `is_test` disagreement guard (gh-1763)

Answers exactly one question: do `profiles.is_test` and `contractors.is_test`
agree for every contractor identity on the target Supabase project?

Background: gh-1763 found 7 production rows where they disagreed — every one
`profiles.is_test = false` over `contractors.is_test = true` — and it broke a
real R-173 gate (claim `82f5dff4-5867-4b7a-88ca-942ce9bfe867` stopped a
signing ceremony because three tables said "test" and the one carrying the
human identity said "production"). The CTO's ruling on that issue (comment
5572645535, 2026-09-07): `profiles` is authoritative for identity-level
`is_test`; `contractors` mirrors it. This script is the mechanism that keeps
it that way — per constitution entry 16 ("a recurring defect closes on a
mechanism, not a rule") and the issue's own step 3 ("Not optional and not a
follow-up... this reappears the next time a test contractor is seeded by a
path that writes one table and not the other").

This script does NOT touch production by default — the plain PostgREST mode
below queries whatever project SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY point
at, and the CI job that originally wired it in
(.github/workflows/e2e-tests.yml, "is-test Cross-Table Guard (gh-1763)")
points that mode at the dedicated CI-test project (zsdvaqilfdclwosmiheh) —
the same project `Seed Must Pass (gh-1584)` already seeds/tears down every
run. See gh-1763's hard limits: the guard's own RED/GREEN self-test writes a
fixture row, and that write may only ever happen in a local/fixture context,
never in prod.

DISQUALIFYING GAP FOUND ON PR #1826 REVIEW (comment 5577633751, 2026-09-08):
the CI job above only ever ran `--self-test` against CI-test. Nothing
anywhere asserted the disagreement count against PRODUCTION on a schedule —
the exact quantity the CTO's ruling (issue #1763 comment 5572645535, item 3)
says must stay 0, "not optional and not a follow-up." A guard that never
reads prod can stay green in CI while production silently regresses.

FIX: a second mode, `--management-api --project-ref <ref>`, that runs the
issue's own read-only disagreement SQL against a project via the Supabase
Management API's `database/query` SQL endpoint
(https://api.supabase.com/v1/projects/<ref>/database/query), authenticated
with a Personal Access Token (SUPABASE_ACCESS_TOKEN, sbp_...) rather than a
service-role key. This exists specifically because the Code lane has no
SUPABASE_SERVICE_ROLE_KEY for production anywhere (see memory
code-lane-cannot-verify-gated-efs) — the PostgREST path above is structurally
unusable against prod, and this repo's own precedent for reading production
on a schedule without a service-role key is exactly this Management-API/PAT
pattern (scripts/edge-function-drift-check.py,
scripts/ci-test-function-parity.py both use
SUPABASE_ACCESS_TOKEN + https://api.supabase.com/v1). The query this mode
runs is a single SELECT — it can prove RED without ever writing to prod,
which is the hard limit gh-1763's PR body already committed to.

Method (plain PostgREST mode):
  1. Fetch every `contractors` row (id, user_id, is_test, company_name) via
     PostgREST.
  2. Fetch the matching `profiles` rows (id, is_test, role) for those
     `user_id`s, filtered to role='contractor' — same predicate as the
     issue's own disagreement query.
  3. Join client-side (PostgREST embedding needs a named FK relationship this
     script should not have to guess); report every pair where
     `profile.is_test != contractor.is_test`.
  4. Exit 0 if none. Exit 1 and print every offending pair if any are found.
     Exit 3 (UNMEASURED) on a missing credential or an unreachable/malformed
     API response — per gh-1419, "unmeasured" must fail exactly as loudly as
     "measured failure" and must never look like a clean pass.

Method (--management-api mode): identical disagreement logic, but the JOIN
and the `is_test` comparison happen inside one SQL statement submitted to the
Management API — the API returns rows already in the same
profile_id/profile_is_test/contractor_id/contractor_is_test/company_name
shape find_disagreements() produces, so the same render_table() and the same
0/1/3 exit-code contract apply on both paths.

Usage:
  SUPABASE_URL=https://<ref>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=... \
  python3 scripts/is-test-cross-table-check.py

  # RED/GREEN self-test (CI-test project only — refuses to run against prod):
  SUPABASE_URL=https://zsdvaqilfdclwosmiheh.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=... \
  python3 scripts/is-test-cross-table-check.py --self-test

  # Scheduled, read-only, production-safe (no service-role key needed):
  SUPABASE_ACCESS_TOKEN=sbp_... \
  python3 scripts/is-test-cross-table-check.py --management-api --project-ref yeszghaspzwwstvsrioa
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

PRODUCTION_PROJECT_REF = "yeszghaspzwwstvsrioa"
IDS_PER_BATCH = 200  # PostgREST `in.()` filters -- kept well under any URL-length concern.

MANAGEMENT_API_BASE = "https://api.supabase.com/v1"

# Identical to the issue body's own disagreement query -- same columns, same
# predicate, same ORDER BY -- so the BEFORE evidence pasted on gh-1763/#1826
# is reproducible byte-for-byte by this mode. Read-only: a single SELECT,
# never a write, over any project it is pointed at including production.
DISAGREEMENT_SQL = (
    "select p.id as profile_id, p.is_test as profile_is_test, "
    "c.id as contractor_id, c.is_test as contractor_is_test, c.company_name "
    "from profiles p join contractors c on c.user_id = p.id "
    "where p.role = 'contractor' and p.is_test is distinct from c.is_test "
    "order by c.created_at;"
)


class FetchError(Exception):
    """Raised when the target project cannot be reached or answers unusably.

    `status` carries the HTTP status code when one was received (e.g. a 401
    or 404), or None when the request never got an HTTP response at all
    (DNS/connection failure, timeout).
    """

    def __init__(self, message: str, status=None):
        super().__init__(message)
        self.status = status


def _request(method: str, url: str, service_key: str, body=None, urlopen=urllib.request.urlopen, extra_headers=None):
    """Low-level PostgREST/Admin-API call. Raises FetchError on any failure."""
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        # See ci-test-function-parity.py: Supabase's front door has been observed
        # to 403 urllib's default User-Agent even with a valid credential.
        "User-Agent": "otterquote-is-test-cross-table-check/1.0",
    }
    if extra_headers:
        headers.update(extra_headers)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urlopen(req, timeout=30) as resp:
            status = getattr(resp, "status", 200)
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore") if hasattr(exc, "read") else ""
        raise FetchError(f"HTTP {exc.code} from {url}: {detail[:500]}", status=exc.code) from exc
    except urllib.error.URLError as exc:
        raise FetchError(f"{url} unreachable: {exc.reason}", status=None) from exc

    if status not in (200, 201, 204):
        raise FetchError(f"HTTP {status} from {url}", status=status)

    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise FetchError(f"{url} response was not valid JSON: {exc}", status=status) from exc


def fetch_contractors(project_url: str, service_key: str, urlopen=urllib.request.urlopen) -> list:
    """Every contractors row that has a user_id (unattached rows can't disagree with a profile)."""
    url = f"{project_url}/rest/v1/contractors?select=id,user_id,is_test,company_name&user_id=not.is.null&limit=10000"
    payload = _request("GET", url, service_key, urlopen=urlopen)
    if not isinstance(payload, list):
        raise FetchError(f"contractors fetch did not return a JSON array (got {type(payload).__name__})")
    return payload


def fetch_profiles_by_ids(project_url: str, service_key: str, ids: list, urlopen=urllib.request.urlopen) -> list:
    """profiles rows for the given ids, restricted to role='contractor' -- matches the
    issue body's own disagreement query predicate exactly."""
    rows = []
    for i in range(0, len(ids), IDS_PER_BATCH):
        batch = ids[i:i + IDS_PER_BATCH]
        id_list = ",".join(batch)
        url = (
            f"{project_url}/rest/v1/profiles"
            f"?select=id,is_test,role&role=eq.contractor&id=in.({id_list})&limit=10000"
        )
        payload = _request("GET", url, service_key, urlopen=urlopen)
        if not isinstance(payload, list):
            raise FetchError(f"profiles fetch did not return a JSON array (got {type(payload).__name__})")
        rows.extend(payload)
    return rows


def find_disagreements(contractors: list, profiles: list) -> list:
    """Pure join+compare, no I/O -- unit-testable directly.

    Mirrors the issue body's query: `where p.role = 'contractor' and
    p.is_test is distinct from c.is_test`. A contractor whose user_id has no
    matching profiles row (or whose profile isn't role='contractor') is not
    in scope -- same as the SQL join, which would simply drop it.
    """
    profiles_by_id = {p["id"]: p for p in profiles}
    offenders = []
    for c in contractors:
        p = profiles_by_id.get(c.get("user_id"))
        if p is None:
            continue
        if p.get("is_test") != c.get("is_test"):
            offenders.append({
                "profile_id": p["id"],
                "profile_is_test": p.get("is_test"),
                "contractor_id": c["id"],
                "contractor_is_test": c.get("is_test"),
                "company_name": c.get("company_name"),
            })
    return offenders


def render_table(offenders: list) -> str:
    if not offenders:
        return "(no disagreements)"
    lines = ["profile_id                           profile_is_test  contractor_id                         contractor_is_test  company_name"]
    lines.append("-" * 140)
    for o in offenders:
        lines.append(
            f"{o['profile_id']}  {str(o['profile_is_test']).ljust(15)}  "
            f"{o['contractor_id']}  {str(o['contractor_is_test']).ljust(18)}  {o['company_name']}"
        )
    return "\n".join(lines)


def run(project_url: str, service_key: str, urlopen=urllib.request.urlopen) -> int:
    """Core logic, decoupled from argv/env for testability. Returns the process exit code."""
    if not project_url or not service_key:
        print(
            "UNMEASURED: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set.\n"
            "  This is a FAILURE, not a skip -- per gh-1419, an unmeasured run must fail\n"
            "  exactly as loudly as a measured failure.",
            file=sys.stderr,
        )
        return 3

    try:
        contractors = fetch_contractors(project_url, service_key, urlopen=urlopen)
        user_ids = sorted({c["user_id"] for c in contractors if c.get("user_id")})
        profiles = fetch_profiles_by_ids(project_url, service_key, user_ids, urlopen=urlopen) if user_ids else []
    except FetchError as exc:
        print(
            f"UNMEASURED: could not read profiles/contractors from {project_url}: {exc}\n"
            f"  (HTTP status: {exc.status if exc.status is not None else 'no response'})\n"
            "  This is a FAILURE, not a skip -- per gh-1419.",
            file=sys.stderr,
        )
        return 3

    offenders = find_disagreements(contractors, profiles)
    print(render_table(offenders))

    if offenders:
        print(
            f"\nDISAGREEMENT: {len(offenders)} row(s) where profiles.is_test != contractors.is_test "
            f"on {project_url}.\n"
            "Per the CTO's ruling on gh-1763 (comment 5572645535): profiles is authoritative for "
            "identity-level is_test; contractors mirrors it. A disagreement here means a seeding path "
            "wrote one table and not the other -- repair profiles.is_test to match the facts on the "
            "ground (see the gh-1763 migration draft), do not just flip contractors.",
            file=sys.stderr,
        )
        return 1

    print(f"\nCLEAN: profiles.is_test and contractors.is_test agree on every row on {project_url}.")
    return 0


# ---------------------------------------------------------------------------
# --management-api: read-only production-safe mode (PR #1826 review fix).
# Runs DISAGREEMENT_SQL via the Supabase Management API instead of PostgREST,
# so it works with a Personal Access Token (SUPABASE_ACCESS_TOKEN) rather
# than a service-role key -- the credential the Code lane actually has for
# production. Never writes anything; the query is a single SELECT.
# ---------------------------------------------------------------------------

def fetch_disagreements_via_management_api(project_ref: str, token: str, urlopen=urllib.request.urlopen) -> list:
    """Run DISAGREEMENT_SQL against `project_ref` via the Management API's
    `database/query` SQL endpoint. Returns the same offender-shaped dicts
    render_table()/run()'s callers already expect. Raises FetchError on any
    failure -- no token, network error, non-2xx response, non-JSON body, a
    body that isn't a JSON array, or a row missing an expected column.

    The explicit User-Agent mirrors ci-test-function-parity.py's finding
    (2026-09-04): api.supabase.com's Cloudflare front door 403s urllib's
    default User-Agent even with a valid token, before the request ever
    reaches Supabase's own auth. Confirmed live against both
    yeszghaspzwwstvsrioa (production) and zsdvaqilfdclwosmiheh (CI-test)
    while building this fix (2026-09-08): the endpoint returns HTTP 201 with
    a JSON array of rows already in this exact column shape.
    """
    url = f"{MANAGEMENT_API_BASE}/projects/{project_ref}/database/query"
    body = json.dumps({"query": DISAGREEMENT_SQL}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "otterquote-is-test-cross-table-check/1.0",
        },
    )
    try:
        with urlopen(req, timeout=30) as resp:
            status = getattr(resp, "status", 200)
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore") if hasattr(exc, "read") else ""
        raise FetchError(f"Management API HTTP {exc.code} from {url}: {detail[:500]}", status=exc.code) from exc
    except urllib.error.URLError as exc:
        raise FetchError(f"Management API {url} unreachable: {exc.reason}", status=None) from exc

    # The Management API's SQL endpoint answers 201 (query executed), not 200.
    if status not in (200, 201):
        raise FetchError(f"Management API HTTP {status} from {url}", status=status)

    if not raw:
        raise FetchError(f"Management API response from {url} was empty", status=status)

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise FetchError(f"Management API response from {url} was not valid JSON: {exc}", status=status) from exc

    if not isinstance(payload, list):
        raise FetchError(
            f"Management API response from {url} was not a JSON array (got {type(payload).__name__})",
            status=status,
        )

    required_keys = {"profile_id", "profile_is_test", "contractor_id", "contractor_is_test"}
    offenders = []
    for row in payload:
        if not isinstance(row, dict) or not required_keys <= row.keys():
            raise FetchError(f"Management API row from {url} missing expected columns: {row!r}", status=status)
        offenders.append({
            "profile_id": row["profile_id"],
            "profile_is_test": row["profile_is_test"],
            "contractor_id": row["contractor_id"],
            "contractor_is_test": row["contractor_is_test"],
            "company_name": row.get("company_name"),
        })
    return offenders


def run_management_api(
    project_ref: str,
    token: str,
    fetcher=fetch_disagreements_via_management_api,
    file_issue: bool = False,
    poster=None,
) -> int:
    """Core logic for the scheduled, read-only, production-safe mode.

    Deliberately mirrors run()'s exit-code contract exactly (0 clean / 1
    disagreement / 3 UNMEASURED) so the workflow step that calls this can
    treat both modes identically. A missing project_ref or token, a network
    failure, or an unparsable response is UNMEASURED (exit 3) -- per
    gh-1419, that must fail exactly as loudly as a measured disagreement,
    never as a silent/clean pass. Tested here (2026-09-08) with a
    deliberately bad token: the Management API returns HTTP 401
    ("JWT could not be decoded"), which surfaces through FetchError as
    UNMEASURED, not GREEN.

    file_issue=True posts an alarm comment (via `poster`, default
    post_issue_comment) ONLY when a real disagreement is found -- never on
    UNMEASURED alone (a measurement gap is not a drift finding, same rule
    netlify-deploy-drift.py's --file-issue follows) and never on clean.
    """
    if poster is None:
        poster = post_issue_comment

    if not project_ref or not token:
        print(
            "UNMEASURED: --project-ref and/or SUPABASE_ACCESS_TOKEN are not set.\n"
            "  SUPABASE_ACCESS_TOKEN must be a Supabase Personal Access Token (sbp_...);\n"
            "  the service-role key is not usable here -- the Management API rejects it.\n"
            "  This is a FAILURE, not a skip -- per gh-1419, an unmeasured run must fail\n"
            "  exactly as loudly as a measured failure.",
            file=sys.stderr,
        )
        return 3

    try:
        offenders = fetcher(project_ref, token)
    except FetchError as exc:
        print(
            f"UNMEASURED: could not run the disagreement query against {project_ref} via the "
            f"Management API: {exc}\n"
            f"  (HTTP status: {exc.status if exc.status is not None else 'no response'})\n"
            "  This is a FAILURE, not a skip -- per gh-1419.",
            file=sys.stderr,
        )
        return 3

    print(render_table(offenders))

    if offenders:
        print(
            f"\nDISAGREEMENT: {len(offenders)} row(s) where profiles.is_test != contractors.is_test "
            f"on project {project_ref} (via Management API, read-only).\n"
            "Per the CTO's ruling on gh-1763 (comment 5572645535): profiles is authoritative for "
            "identity-level is_test; contractors mirrors it. A disagreement here means a seeding path "
            "wrote one table and not the other -- repair profiles.is_test to match the facts on the "
            "ground (see the gh-1763 migration draft), do not just flip contractors.",
            file=sys.stderr,
        )
        if file_issue:
            poster(render_issue_comment_body(offenders, project_ref))
        return 1

    print(
        f"\nCLEAN: profiles.is_test and contractors.is_test agree on every row on project "
        f"{project_ref} (via Management API, read-only)."
    )
    return 0


# ---------------------------------------------------------------------------
# --file-issue: alarm channel for the scheduled production check (PR #1826
# review fix). Same shape as scripts/netlify-deploy-drift.py's
# post_issue_comment() -- the alarm IS the comment, per the #1295 pattern.
# Posts to gh-1763 itself, the issue this guard exists to keep closed. NEVER
# fires on UNMEASURED alone (exit 3) -- a measurement gap is not a drift
# finding, and conflating the two would train readers to ignore the comment.
# ---------------------------------------------------------------------------

ALARM_ISSUE_NUMBER = 1763
ISSUE_REPO = "StellarEdgeServices/otterquote-platform"
# Same name netlify-deploy-drift.py reads (its own doc explains why the
# secret backing it can't be named GITHUB_*): GITHUB_TOKEN is tried first.
GITHUB_TOKEN_ENV_VAR = "GITHUB_PERSONAL_ACCESS_TOKEN"


def render_issue_comment_body(offenders: list, project_ref: str) -> str:
    return (
        f"Automated production `is_test` cross-table check "
        f"(`scripts/is-test-cross-table-check.py --management-api`, gh-1763) found "
        f"{len(offenders)} disagreement(s) on project `{project_ref}`:\n\n"
        f"{render_table(offenders)}\n\n"
        "Per the CTO's ruling (comment 5572645535): `profiles` is authoritative for "
        "identity-level `is_test`; `contractors` mirrors it. Repair `profiles.is_test` to "
        "match the facts on the ground -- do not just flip `contractors`."
    )


def post_issue_comment(body: str, timeout: int = 30) -> tuple:
    """POST `body` as a comment on ALARM_ISSUE_NUMBER. Returns (success, detail).

    Never raises -- posting the alarm must never crash the run that found the
    problem it's reporting (same discipline as netlify-deploy-drift.py's
    post_issue_comment)."""
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get(GITHUB_TOKEN_ENV_VAR)
    if not token:
        reason = f"no GITHUB_TOKEN / {GITHUB_TOKEN_ENV_VAR} in environment -- skipping comment"
        print(f"!! --file-issue requested but {reason}", file=sys.stderr)
        return False, reason
    req = urllib.request.Request(
        f"https://api.github.com/repos/{ISSUE_REPO}/issues/{ALARM_ISSUE_NUMBER}/comments",
        data=json.dumps({"body": body}).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "otterquote-is-test-cross-table-check/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        reason = f"HTTP {exc.code} ({exc.reason}) posting comment on #{ALARM_ISSUE_NUMBER}"
        print(f"!! failed to post comment on #{ALARM_ISSUE_NUMBER}: {reason}", file=sys.stderr)
        return False, reason
    except Exception as exc:  # noqa: BLE001 -- posting the comment must never crash the run
        reason = f"{type(exc).__name__}: {exc}"
        print(f"!! failed to post comment on #{ALARM_ISSUE_NUMBER}: {reason}", file=sys.stderr)
        return False, reason
    html_url = None
    try:
        html_url = json.loads(raw.decode("utf-8")).get("html_url")
    except Exception:  # noqa: BLE001 -- a parse failure here doesn't change that the POST succeeded
        pass
    detail = html_url or "posted (no html_url in response)"
    print(f"Posted disagreement report to issue #{ALARM_ISSUE_NUMBER}: {detail}", file=sys.stderr)
    return True, detail


# ---------------------------------------------------------------------------
# --self-test: RED/GREEN demonstration against a fixture. NEVER run against
# production -- guarded below. Creates one throwaway auth user + profiles +
# contractors row, puts them in the exact bad shape gh-1763 found, confirms
# the guard goes RED, fixes the row, confirms GREEN, then deletes everything
# it created. Fails closed: cleanup runs in `finally` regardless of outcome.
# ---------------------------------------------------------------------------

def _admin_create_user(project_url: str, service_key: str, email: str, urlopen=urllib.request.urlopen) -> str:
    url = f"{project_url}/auth/v1/admin/users"
    body = {
        "email": email,
        "password": uuid.uuid4().hex + "Aa1!",
        "email_confirm": True,
    }
    payload = _request("POST", url, service_key, body=body, urlopen=urlopen)
    if not isinstance(payload, dict) or "id" not in payload:
        raise FetchError(f"admin createUser did not return an id (got {payload!r})")
    return payload["id"]


def _admin_delete_user(project_url: str, service_key: str, user_id: str, urlopen=urllib.request.urlopen):
    url = f"{project_url}/auth/v1/admin/users/{user_id}"
    _request("DELETE", url, service_key, urlopen=urlopen)


def _insert_profile(project_url: str, service_key: str, profile_id: str, is_test: bool, urlopen=urllib.request.urlopen):
    url = f"{project_url}/rest/v1/profiles"
    body = {
        "id": profile_id,
        "role": "contractor",
        "is_test": is_test,
        "full_name": "IS-TEST GUARD SELFTEST (gh-1763) -- DO NOT USE",
    }
    _request("POST", url, service_key, body=body, urlopen=urlopen, extra_headers={"Prefer": "return=minimal"})


def _insert_contractor(project_url: str, service_key: str, user_id: str, is_test: bool, urlopen=urllib.request.urlopen) -> str:
    url = f"{project_url}/rest/v1/contractors"
    body = {
        "user_id": user_id,
        "company_name": "IS-TEST GUARD SELFTEST (gh-1763) -- DO NOT USE",
        "contact_name": "gh-1763 selftest",
        "email": f"gh1763-selftest+{user_id}@otterquote-internal.test",
        "is_test": is_test,
    }
    payload = _request("POST", url, service_key, body=body, urlopen=urlopen, extra_headers={"Prefer": "return=representation"})
    if not isinstance(payload, list) or not payload or "id" not in payload[0]:
        raise FetchError(f"contractors insert did not return the created row (got {payload!r})")
    return payload[0]["id"]


def _update_contractor_is_test(project_url: str, service_key: str, contractor_id: str, is_test: bool, urlopen=urllib.request.urlopen):
    url = f"{project_url}/rest/v1/contractors?id=eq.{contractor_id}"
    _request("PATCH", url, service_key, body={"is_test": is_test}, urlopen=urlopen, extra_headers={"Prefer": "return=minimal"})


def _delete_contractor(project_url: str, service_key: str, contractor_id: str, urlopen=urllib.request.urlopen):
    url = f"{project_url}/rest/v1/contractors?id=eq.{contractor_id}"
    _request("DELETE", url, service_key, urlopen=urlopen)


def _delete_profile(project_url: str, service_key: str, profile_id: str, urlopen=urllib.request.urlopen):
    url = f"{project_url}/rest/v1/profiles?id=eq.{profile_id}"
    _request("DELETE", url, service_key, urlopen=urlopen)


def self_test(project_url: str, service_key: str, urlopen=urllib.request.urlopen) -> int:
    if PRODUCTION_PROJECT_REF in project_url:
        print(
            f"REFUSING: --self-test writes a fixture row and must never run against "
            f"production ({PRODUCTION_PROJECT_REF}). Point SUPABASE_URL at the CI-test "
            "project (zsdvaqilfdclwosmiheh) instead. Per gh-1763's hard limits, the RED "
            "control's seeded write may only happen in a local/fixture context.",
            file=sys.stderr,
        )
        return 2

    if not project_url or not service_key:
        print("UNMEASURED: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set.", file=sys.stderr)
        return 3

    email = f"gh1763-selftest+{uuid.uuid4().hex}@otterquote-internal.test"
    user_id = None
    contractor_id = None
    profile_inserted = False
    overall_ok = True

    try:
        try:
            print(f"=== gh-1763 guard self-test against {project_url} ===")
            user_id = _admin_create_user(project_url, service_key, email, urlopen=urlopen)
            print(f"Created throwaway auth user {user_id} ({email})")

            # Exact bad shape gh-1763 found: profile says production, contractor says test.
            _insert_profile(project_url, service_key, user_id, is_test=False, urlopen=urlopen)
            profile_inserted = True
            contractor_id = _insert_contractor(project_url, service_key, user_id, is_test=True, urlopen=urlopen)
            print(f"Seeded bad-shape fixture: profile {user_id} is_test=false, contractor {contractor_id} is_test=true")

            print("\n--- RED run (bad fixture present) ---")
            red_code = run(project_url, service_key, urlopen=urlopen)
            red_ok = red_code == 1
            print(f"RED expectation (exit==1): {'PASS' if red_ok else 'FAIL'} (got exit {red_code})")
            overall_ok = overall_ok and red_ok

            # Repair the fixture: contractors mirrors profiles per the CTO's ruling.
            _update_contractor_is_test(project_url, service_key, contractor_id, is_test=False, urlopen=urlopen)
            print(f"\nRepaired fixture: contractor {contractor_id} is_test set to false to match profile")

            print("\n--- GREEN run (clean fixture) ---")
            green_code = run(project_url, service_key, urlopen=urlopen)
            green_ok = green_code == 0
            print(f"GREEN expectation (exit==0): {'PASS' if green_ok else 'FAIL'} (got exit {green_code})")
            overall_ok = overall_ok and green_ok
        except FetchError as exc:
            print(
                f"UNMEASURED: self-test setup/teardown call failed: {exc}\n"
                f"  (HTTP status: {exc.status if exc.status is not None else 'no response'})",
                file=sys.stderr,
            )
            overall_ok = False
    finally:
        print("\n--- cleanup ---")
        try:
            if contractor_id:
                _delete_contractor(project_url, service_key, contractor_id, urlopen=urlopen)
                print(f"Deleted contractor {contractor_id}")
        except FetchError as exc:
            print(f"cleanup warning: could not delete contractor {contractor_id}: {exc}", file=sys.stderr)
        try:
            if profile_inserted:
                _delete_profile(project_url, service_key, user_id, urlopen=urlopen)
                print(f"Deleted profile {user_id}")
        except FetchError as exc:
            print(f"cleanup warning: could not delete profile {user_id}: {exc}", file=sys.stderr)
        try:
            if user_id:
                _admin_delete_user(project_url, service_key, user_id, urlopen=urlopen)
                print(f"Deleted auth user {user_id}")
        except FetchError as exc:
            print(f"cleanup warning: could not delete auth user {user_id}: {exc}", file=sys.stderr)

    print(f"\n=== self-test {'PASS' if overall_ok else 'FAIL'} ===")
    return 0 if overall_ok else 1


def _arg_value(argv: list, flag: str):
    """Return the value following `flag` in argv, or None if absent/dangling."""
    if flag in argv:
        i = argv.index(flag)
        if i + 1 < len(argv):
            return argv[i + 1]
    return None


def main() -> int:
    argv = sys.argv[1:]

    if "--management-api" in argv:
        project_ref = _arg_value(argv, "--project-ref")
        token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
        file_issue = "--file-issue" in argv
        return run_management_api(project_ref, token, file_issue=file_issue)

    project_url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

    if "--self-test" in argv:
        return self_test(project_url, service_key)

    return run(project_url, service_key)


if __name__ == "__main__":
    sys.exit(main())
