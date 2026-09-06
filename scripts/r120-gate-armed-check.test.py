#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/r120-gate-armed-check.py (gh-1728, follow-up 1).

No network access and no credentials required -- every fetch-adjacent path is exercised
by monkeypatching urllib.request's `urlopen` so it never leaves this machine, following
the importlib-load pattern this repo already uses for hyphenated script filenames
(scripts/drift-detector-age.test.py, scripts/edge-function-drift-check.test.py).

gh-1728's closes-on requires three things, and this file provides all three:
  1. The scheduled check itself       -> exercised via r120.main() / evaluate_contexts().
  2. ONE REAL FIRING                  -> "REAL FIRING" section below: r120.extract_contexts()
                                          + r120.evaluate_contexts() run against
                                          FIXTURE_PRE_FIX, the literal pre-fix branch
                                          protection payload gh-1728's own body pasted
                                          ("required_status_checks.contexts = ['Null-Byte
                                          & Size Sanity Check', '5-Page Revenue-Path Smoke
                                          Check']" -- R-120 signed review absent). Verdict
                                          MISSING, exit 2, banner present.
  3. THE NEGATIVE CONTROL              -> "NEGATIVE CONTROL" section below: the same two
                                          functions run against FIXTURE_POST_FIX, the
                                          literal post-fix re-read gh-1728's body pasted
                                          ("contexts = [..., 'R-120 signed review']  strict:
                                          true"). Verdict ARMED, exit 0, banner is None
                                          (silent).
Per gh-1728's own design note ("run the check's logic against a saved protection payload
with and without the context ... reproducible in CI rather than a one-off manual
observation"), items 2 and 3 are fixture-driven so they re-run on every invocation of this
file rather than having happened once by hand.

Run: python r120-gate-armed-check.test.py
"""

import importlib.util
import io
import json
import pathlib
import sys
import urllib.error

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("r120", HERE / "r120-gate-armed-check.py")
r120 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r120)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


class _FakeResponse:
    """Minimal context-manager stand-in for urllib.request.urlopen's return value."""

    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


# ---------------------------------------------------------------------------------------
# The two fixtures ARE gh-1728's own pasted evidence, not invented data.
# ---------------------------------------------------------------------------------------

# Pre-fix: gh-1728 body, "What was true, measured" section --
#   GET /repos/StellarEdgeServices/otterquote-platform/branches/main/protection
#     required_status_checks.contexts = ['Null-Byte & Size Sanity Check',
#                                         '5-Page Revenue-Path Smoke Check']
# R-120 signed review is absent. Shaped as the real branch-protection API response
# (nested under required_status_checks), matching what fetch_protection_payload() returns.
FIXTURE_PRE_FIX = {
    "url": "https://api.github.com/repos/StellarEdgeServices/otterquote-platform/branches/main/protection",
    "required_status_checks": {
        "strict": True,
        "contexts": [
            "Null-Byte & Size Sanity Check",
            "5-Page Revenue-Path Smoke Check",
        ],
    },
    "enforce_admins": {"enabled": False},
    "required_pull_request_reviews": None,
    "restrictions": None,
}

# Post-fix: gh-1728 body, "Fixed" section --
#   PATCH .../required_status_checks
#     {"strict": true, "contexts": ["Null-Byte & Size Sanity Check",
#                                    "5-Page Revenue-Path Smoke Check",
#                                    "R-120 signed review"]}
#   re-read: contexts = [..., 'R-120 signed review']  strict: true
FIXTURE_POST_FIX = {
    "url": "https://api.github.com/repos/StellarEdgeServices/otterquote-platform/branches/main/protection",
    "required_status_checks": {
        "strict": True,
        "contexts": [
            "Null-Byte & Size Sanity Check",
            "5-Page Revenue-Path Smoke Check",
            "R-120 signed review",
        ],
    },
    "enforce_admins": {"enabled": False},
    "required_pull_request_reviews": None,
    "restrictions": None,
}


def main():
    # -------------------------------------------------------------------------------
    print("REAL FIRING -- pre-fix payload (gh-1728's own pasted GET, R-120 absent)")
    # -------------------------------------------------------------------------------
    contexts = r120.extract_contexts(FIXTURE_PRE_FIX)
    check("pre-fix contexts extracted exactly as gh-1728 pasted them", contexts, [
        "Null-Byte & Size Sanity Check",
        "5-Page Revenue-Path Smoke Check",
    ])
    result = r120.evaluate_contexts(contexts, r120.DEFAULT_REQUIRED_CONTEXT, "fixture: gh-1728 pre-fix GET")
    check("pre-fix verdict -> MISSING (this is the real firing)", result["verdict"], "MISSING")
    check("pre-fix exit code -> 2", result["code"], 2)
    banner = r120._banner_lines(result, r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, r120.DEFAULT_REQUIRED_CONTEXT)
    check("pre-fix fires a banner (not silent)", banner is not None, True)
    check("pre-fix banner names the missing context", any("R-120 signed review" in line for line in banner), True)
    print("  -- fired banner --")
    for line in banner:
        print("  " + line)

    # -------------------------------------------------------------------------------
    print("\nNEGATIVE CONTROL -- post-fix payload (gh-1728's own pasted re-read, R-120 present)")
    # -------------------------------------------------------------------------------
    contexts = r120.extract_contexts(FIXTURE_POST_FIX)
    check("post-fix contexts extracted exactly as gh-1728 pasted them", contexts, [
        "Null-Byte & Size Sanity Check",
        "5-Page Revenue-Path Smoke Check",
        "R-120 signed review",
    ])
    result = r120.evaluate_contexts(contexts, r120.DEFAULT_REQUIRED_CONTEXT, "fixture: gh-1728 post-fix re-read")
    check("post-fix verdict -> ARMED (this is the negative control)", result["verdict"], "ARMED")
    check("post-fix exit code -> 0", result["code"], 0)
    banner = r120._banner_lines(result, r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, r120.DEFAULT_REQUIRED_CONTEXT)
    check("post-fix stays silent (no banner) -- the control showing the check does NOT cry wolf", banner, None)

    # -------------------------------------------------------------------------------
    print("\nUNMEASURED paths -- must never resolve to ARMED")
    # -------------------------------------------------------------------------------
    r = r120.evaluate_contexts(None, r120.DEFAULT_REQUIRED_CONTEXT, r120.NO_TOKEN_REASON)
    check("contexts=None (no token) -> UNMEASURED", r["verdict"], "UNMEASURED")
    check("contexts=None (no token) -> exit 3", r["code"], 3)
    check("contexts=None (no token) -> contexts field is None", r["contexts"], None)
    banner = r120._banner_lines(r, r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, r120.DEFAULT_REQUIRED_CONTEXT)
    check("UNMEASURED fires a banner (never a quiet skip)", banner is not None, True)
    check("UNMEASURED banner says NOT A PASS", any("NOT A PASS" in line for line in banner), True)

    r = r120.evaluate_contexts(None, r120.DEFAULT_REQUIRED_CONTEXT, "GitHub API HTTP 401 (Unauthorized)")
    check("contexts=None (dead token, 401) -> UNMEASURED, not a crash", r["verdict"], "UNMEASURED")

    # -------------------------------------------------------------------------------
    print("\nextract_contexts is defensive -- malformed payloads resolve to [], never raise")
    # -------------------------------------------------------------------------------
    check("extract_contexts(None) -> []", r120.extract_contexts(None), [])
    check("extract_contexts({}) -> [] (no required_status_checks key)", r120.extract_contexts({}), [])
    check(
        "extract_contexts({'required_status_checks': None}) -> [] (checks disabled)",
        r120.extract_contexts({"required_status_checks": None}),
        [],
    )
    check(
        "extract_contexts({'required_status_checks': {'contexts': None}}) -> []",
        r120.extract_contexts({"required_status_checks": {"contexts": None}}),
        [],
    )
    check(
        "extract_contexts with a non-string entry -> filtered out, never raises",
        r120.extract_contexts({"required_status_checks": {"contexts": ["ok", 42, None]}}),
        ["ok"],
    )
    check("extract_contexts('not-a-dict') -> []", r120.extract_contexts("not-a-dict"), [])

    # -------------------------------------------------------------------------------
    print("\n_token() reads GITHUB_PERSONAL_ACCESS_TOKEN from the environment only")
    # -------------------------------------------------------------------------------
    saved_token = r120.os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN")
    try:
        r120.os.environ.pop("GITHUB_PERSONAL_ACCESS_TOKEN", None)
        check("_token() with unset env var -> None", r120._token(), None)
        r120.os.environ["GITHUB_PERSONAL_ACCESS_TOKEN"] = "   "
        check("_token() with blank/whitespace env var -> None", r120._token(), None)
        r120.os.environ["GITHUB_PERSONAL_ACCESS_TOKEN"] = "fake-not-a-real-token"
        check("_token() with a set value -> returns it unmodified", r120._token(), "fake-not-a-real-token")
    finally:
        if saved_token is None:
            r120.os.environ.pop("GITHUB_PERSONAL_ACCESS_TOKEN", None)
        else:
            r120.os.environ["GITHUB_PERSONAL_ACCESS_TOKEN"] = saved_token

    # -------------------------------------------------------------------------------
    print("\nUNMEASURED on missing token (fetch_protection_payload, no network)")
    # -------------------------------------------------------------------------------
    payload, detail = r120.fetch_protection_payload(r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, token=None)
    check("fetch with token=None -> payload is None", payload, None)
    check("fetch with token=None -> detail mentions the missing token",
          "GITHUB_PERSONAL_ACCESS_TOKEN" in detail, True)

    # -------------------------------------------------------------------------------
    print("\nUNMEASURED on unreachable API (fetch_protection_payload, urlopen monkeypatched)")
    # -------------------------------------------------------------------------------
    real_urlopen = r120.urllib.request.urlopen

    def _raise_network_error(req, timeout=20):
        raise urllib.error.URLError("[Errno -2] Name or service not known")

    r120.urllib.request.urlopen = _raise_network_error
    try:
        payload, detail = r120.fetch_protection_payload(r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, token="fake-token")
        check("fetch with unreachable API -> payload is None", payload, None)
        check("fetch with unreachable API -> detail names the failure",
              "URLError" in detail or "Name or service" in detail, True)
    finally:
        r120.urllib.request.urlopen = real_urlopen

    # HTTP 401 (dead token) -- UNMEASURED, not a crash. This is the exact shape gh-1728
    # measured live: the local env-var copy of GITHUB_PERSONAL_ACCESS_TOKEN returned 401
    # on a plain GET at 15:52Z on 2026-09-06.
    def _raise_http_401(req, timeout=20):
        raise urllib.error.HTTPError(url="https://api.github.com/x", code=401, msg="Unauthorized", hdrs=None, fp=None)

    r120.urllib.request.urlopen = _raise_http_401
    try:
        payload, detail = r120.fetch_protection_payload(r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, token="fake-token")
        check("fetch with HTTP 401 -> payload is None", payload, None)
        check("fetch with HTTP 401 -> detail names the status code", "401" in detail, True)
    finally:
        r120.urllib.request.urlopen = real_urlopen

    # HTTP 403 (insufficient scope) -- UNMEASURED. gh-1728 measured GITHUB_PERSONAL_ACCESS_TOKEN
    # returning 403 on the PATCH (Administration:Read only); a 403 on this script's GET would
    # mean even read access is missing, which must alarm, not silently pass.
    def _raise_http_403(req, timeout=20):
        raise urllib.error.HTTPError(url="https://api.github.com/x", code=403, msg="Forbidden", hdrs=None, fp=None)

    r120.urllib.request.urlopen = _raise_http_403
    try:
        payload, detail = r120.fetch_protection_payload(r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, token="fake-token")
        check("fetch with HTTP 403 -> payload is None", payload, None)
        check("fetch with HTTP 403 -> detail names the status code", "403" in detail, True)
    finally:
        r120.urllib.request.urlopen = real_urlopen

    # HTTP 404 -- branch protection not configured at all. This is a MEASURED answer
    # (zero contexts, certainly not armed), not a fetch failure -- distinct from 401/403.
    def _raise_http_404(req, timeout=20):
        raise urllib.error.HTTPError(url="https://api.github.com/x", code=404, msg="Not Found", hdrs=None, fp=None)

    r120.urllib.request.urlopen = _raise_http_404
    try:
        payload, detail = r120.fetch_protection_payload(r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, token="fake-token")
        check("fetch with HTTP 404 -> payload is NOT None (it's a measured answer)", payload is None, False)
        check("fetch with HTTP 404 -> extracted contexts is []", r120.extract_contexts(payload), [])
        result = r120.evaluate_contexts(r120.extract_contexts(payload), r120.DEFAULT_REQUIRED_CONTEXT, detail)
        check("fetch with HTTP 404 -> verdict MISSING (measured, not UNMEASURED)", result["verdict"], "MISSING")
    finally:
        r120.urllib.request.urlopen = real_urlopen

    # Malformed JSON -- UNMEASURED, not a crash.
    def _bad_json(req, timeout=20):
        return _FakeResponse(b"not json at all {{{")

    r120.urllib.request.urlopen = _bad_json
    try:
        payload, detail = r120.fetch_protection_payload(r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, token="fake-token")
        check("fetch with malformed JSON -> payload is None", payload, None)
        check("fetch with malformed JSON -> detail says so", "JSON" in detail, True)
    finally:
        r120.urllib.request.urlopen = real_urlopen

    # A real, well-formed, reachable response round-trips end to end (armed case).
    def _armed_response(req, timeout=20):
        return _FakeResponse(json.dumps(FIXTURE_POST_FIX).encode("utf-8"))

    r120.urllib.request.urlopen = _armed_response
    try:
        payload, detail = r120.fetch_protection_payload(r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, token="fake-token")
        contexts = r120.extract_contexts(payload)
        result = r120.evaluate_contexts(contexts, r120.DEFAULT_REQUIRED_CONTEXT, detail)
        check("end-to-end fetch of the armed fixture -> ARMED", result["verdict"], "ARMED")
        check("end-to-end fetch of the armed fixture -> exit 0", result["code"], 0)
    finally:
        r120.urllib.request.urlopen = real_urlopen

    # -------------------------------------------------------------------------------
    print("\nNever prints the token -- end-to-end through main()'s own pipeline")
    # -------------------------------------------------------------------------------
    FAKE_SECRET = "super-secret-fake-token-should-never-print-xyz123"
    saved_token = r120.os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN")
    real_urlopen = r120.urllib.request.urlopen

    seen_auth_header = {}

    def _armed_response_2(req, timeout=20):
        # Prove the token isn't even sent anywhere this test could see it leak: stash the
        # Authorization header for a post-hoc assertion -- do NOT print/check it here,
        # since stdout is captured for the leak assertion below and a `check()` call
        # inside this callback would itself print the secret into that capture buffer
        # (that is a test-harness artifact, not something print_report ever does).
        seen_auth_header["value"] = req.headers.get("Authorization")
        return _FakeResponse(json.dumps(FIXTURE_POST_FIX).encode("utf-8"))

    captured = io.StringIO()
    real_stdout = sys.stdout
    try:
        r120.os.environ["GITHUB_PERSONAL_ACCESS_TOKEN"] = FAKE_SECRET
        r120.urllib.request.urlopen = _armed_response_2
        sys.stdout = captured
        payload, detail = r120.fetch_protection_payload(r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, r120._token())
        contexts = r120.extract_contexts(payload)
        result = r120.evaluate_contexts(contexts, r120.DEFAULT_REQUIRED_CONTEXT, detail)
        r120.print_report(result, r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, r120.DEFAULT_REQUIRED_CONTEXT, as_json=False)
        r120.print_report(result, r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, r120.DEFAULT_REQUIRED_CONTEXT, as_json=True)
    finally:
        sys.stdout = real_stdout
        r120.urllib.request.urlopen = real_urlopen
        if saved_token is None:
            r120.os.environ.pop("GITHUB_PERSONAL_ACCESS_TOKEN", None)
        else:
            r120.os.environ["GITHUB_PERSONAL_ACCESS_TOKEN"] = saved_token
    check("Authorization header carried the token (fetch actually used it)",
          seen_auth_header.get("value"), "Bearer " + FAKE_SECRET)
    check("token value never appears in any printed report", FAKE_SECRET in captured.getvalue(), False)

    # -------------------------------------------------------------------------------
    print("\n--json banner field: loudness must not depend on output format")
    # -------------------------------------------------------------------------------
    def rendered_json(result):
        buf = io.StringIO()
        real = sys.stdout
        sys.stdout = buf
        try:
            r120.print_report(result, r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, r120.DEFAULT_REQUIRED_CONTEXT, as_json=True)
        finally:
            sys.stdout = real
        return json.loads(buf.getvalue())

    missing_result = r120.evaluate_contexts(
        r120.extract_contexts(FIXTURE_PRE_FIX), r120.DEFAULT_REQUIRED_CONTEXT, "fixture: pre-fix"
    )
    missing_json = rendered_json(missing_result)
    check("MISSING --json verdict", missing_json["verdict"], "MISSING")
    check("MISSING --json banner carries the same loud text as text mode",
          "MISSING:" in (missing_json["banner"] or ""), True)
    check(
        "MISSING --json banner is byte-identical to the text-mode banner lines",
        missing_json["banner"],
        "\n".join(r120._banner_lines(missing_result, r120.DEFAULT_REPO, r120.DEFAULT_BRANCH, r120.DEFAULT_REQUIRED_CONTEXT)),
    )

    armed_result = r120.evaluate_contexts(
        r120.extract_contexts(FIXTURE_POST_FIX), r120.DEFAULT_REQUIRED_CONTEXT, "fixture: post-fix"
    )
    armed_json = rendered_json(armed_result)
    check("ARMED --json verdict", armed_json["verdict"], "ARMED")
    check("ARMED --json banner is null (no warning to carry)", armed_json["banner"], None)

    unmeasured_result = r120.evaluate_contexts(None, r120.DEFAULT_REQUIRED_CONTEXT, r120.NO_TOKEN_REASON)
    unmeasured_json = rendered_json(unmeasured_result)
    check("UNMEASURED --json banner carries the same loud text as text mode",
          "NOT A PASS" in (unmeasured_json["banner"] or ""), True)
    check("UNMEASURED --json contexts is null", unmeasured_json["contexts"], None)
    check("UNMEASURED --json measured_by is null (no API request was ever attempted)",
          unmeasured_json["measured_by"], None)
    check(
        "--json output carries every manifest-required field",
        {"verdict", "repo", "branch", "required_context", "contexts", "detail", "measured_by", "banner"}
        <= set(armed_json.keys()),
        True,
    )

    # -------------------------------------------------------------------------------
    print("\nCLI flag parsing")
    # -------------------------------------------------------------------------------
    check("no flags -> defaults", r120._parse_args([]), {
        "repo": r120.DEFAULT_REPO,
        "branch": r120.DEFAULT_BRANCH,
        "required_context": r120.DEFAULT_REQUIRED_CONTEXT,
        "as_json": False,
    })
    check(
        "--repo/--branch/--required-context/--json all honoured",
        r120._parse_args(["--repo", "a/b", "--branch", "dev", "--required-context", "X check", "--json"]),
        {"repo": "a/b", "branch": "dev", "required_context": "X check", "as_json": True},
    )

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print("r120-gate-armed-check: all assertions passed (real firing + negative control both verified).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
