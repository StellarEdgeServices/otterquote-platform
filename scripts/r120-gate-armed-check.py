#!/usr/bin/env python3
"""r120-gate-armed-check.py -- is "R-120 signed review" still a required status check on `main`?

Built for gh-1728, follow-up 1 (CTO RUN 26 re-armed the gate at 2026-09-06T15:27:39Z; this
is the detector that notices if it ever falls off again). Modelled on
scripts/drift-detector-age.py's FRESH/STALE/UNMEASURED shape -- same house pattern, applied
to branch protection instead of a workflow-run timestamp.

WHY THIS EXISTS
----------------
Constitution entry 6 (R-120): "Any diff touching legal wording, consent, pricing, or money
requires a human read before merge." That requirement has exactly one piece of machinery
behind it -- ".github/workflows/r120-signed-review.yml" being a REQUIRED status check on
`main`. A requirement with no enforcement is a preference (gh-1728 CEO ruling comment
5560409401). Disarming the check is a legitimate, recurring need -- every future rotation
of the R-120 keypair needs it, because the gate verifies signatures against the pubkey as it
exists on `main` and cannot let its own replacement through while armed (gh-1728 body). But
re-arming afterwards is a MANUAL step with no owner, no timer, and no detector. On
2026-09-06 it silently did not happen for ~73 minutes (14:14:36Z merge of PR #1717 to
15:27:39Z when CTO RUN 26 found it), and nothing noticed until a human read the branch
protection payload by hand. This script is that notice, running on a schedule instead of by
luck.

Not required as a status check on main itself. This is a MONITOR, not a gate: it does not
touch branch protection, does not run per-PR, and (per gh-1728 scope) is explicitly
forbidden from modifying r120-signed-review.yml, r120-review-gate.yml, or the protection
rules themselves. It only reads and alarms.

VERDICTS
    ARMED       required_status_checks.contexts on the target branch contains the required
                context. Silent -- no banner, exit 0.
    MISSING     the branch was reachable and its protection payload was read, but the
                required context is absent from required_status_checks.contexts (including
                the case where required_status_checks is null/absent, and the case where
                the branch has no protection at all, i.e. GET returned 404 -- a 404 is a
                real, measured answer: "no rules", not a fetch failure). Loud banner, exit 2.
    UNMEASURED  the payload could not be read at all: no token, network failure, non-404
                HTTP error (401 dead token, 403 insufficient scope, 5xx, etc.), or a response
                that was not parseable JSON. NEVER treated as a pass -- per gh-1419,
                "UNMEASURED IS NOT A PASS" is settled policy in this codebase, and a gate
                that cannot be read must alarm exactly as loudly as one confirmed absent.
                Loud banner, exit 3.

CREDENTIAL
    Reads GITHUB_PERSONAL_ACCESS_TOKEN from the environment (os.environ) only -- same
    discipline as drift-detector-age.py, so this cannot reproduce backup-age.py's documented
    _token() bug (matching a comment line that merely mentions the var name). Reading branch
    protection needs Administration:Read on the target repo; per gh-1728, the Actions
    *secret* named GITHUB_PERSONAL_ACCESS_TOKEN is a DIFFERENT store from the local
    environment-variable copy that was measured dead (401) on 2026-09-06 -- this script
    makes no assumption about which is valid and reports UNMEASURED with the HTTP status if
    neither works. The token VALUE is never printed, logged, or included in any exception
    message (R-089).

FIXTURE-BASED PROOF (gh-1728 design note: "run the check's logic against a saved protection
payload with and without the context, reproducible in CI rather than a one-off manual
observation"). r120-gate-armed-check.test.py embeds the two payloads gh-1728 itself recorded
-- the pre-fix GET (context absent) and the post-fix re-read (context present) -- and runs
this script's own extract_contexts()/evaluate_contexts() against both. That is simultaneously
the real firing (against the absent-context payload) and the negative control (against the
present-context payload), and it re-runs on every CI invocation rather than having happened
once by hand.

USAGE
    python r120-gate-armed-check.py                     # live check against main
    python r120-gate-armed-check.py --repo OWNER/REPO --branch main
    python r120-gate-armed-check.py --required-context "R-120 signed review"
    python r120-gate-armed-check.py --json
                  machine-readable verdict: {verdict, repo, branch, required_context,
                  contexts, detail, measured_by, banner}. `banner` carries the exact
                  MISSING/UNMEASURED warning text emitted in text mode (null on ARMED) --
                  same discipline as drift-detector-age.py: the loudness must not be a
                  function of the output format.
EXIT
    0 ARMED        required context present in required_status_checks.contexts
    2 MISSING      branch protection was read; required context is absent
    3 UNMEASURED   could not read branch protection at all -- NOT a pass
"""
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_REPO = "StellarEdgeServices/otterquote-platform"
DEFAULT_BRANCH = "main"
DEFAULT_REQUIRED_CONTEXT = "R-120 signed review"
NO_TOKEN_REASON = "no GITHUB_PERSONAL_ACCESS_TOKEN found in the environment"


def _token():
    """Read GITHUB_PERSONAL_ACCESS_TOKEN from the environment. The VALUE never leaves
    this process and is never printed -- R-089. Returns None (not "") when absent/blank."""
    tok = os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN")
    return tok.strip() if tok and tok.strip() else None


def fetch_protection_payload(repo, branch, token, timeout=20):
    """Return (payload, detail) for the branch protection endpoint, or (None, reason) if it
    could not be read at all. A 404 (branch protection not configured) is NOT a failure to
    measure -- it is a real answer, returned here as an empty-but-valid payload so the
    caller reports MISSING (measured, absent) rather than UNMEASURED (could not measure).
    Never raises -- every failure mode is funneled into a (None, reason) return."""
    if not token:
        return None, NO_TOKEN_REASON

    url = "https://api.github.com/repos/%s/branches/%s/protection" % (repo, branch)
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "User-Agent": "otterquote-r120-gate-armed-check",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            # A real, measured answer: no branch protection at all on this branch, so
            # the required context is certainly not enforced. Deliberately does not
            # echo the response body -- it never carries anything a MISSING/UNMEASURED
            # reader needs beyond "no protection rules exist".
            return {"required_status_checks": {"contexts": []}}, (
                "branch protection GET returned 404 -- no protection rules configured on %r"
                % branch
            )
        # Deliberately does not echo response body -- can carry request metadata we do
        # not want logged, and never contains anything a MISSING/UNMEASURED reader
        # needs beyond the status code.
        return None, "GitHub API HTTP %s (%s)" % (exc.code, exc.reason)
    except Exception as exc:  # noqa: BLE001 -- any failure here is UNMEASURED, not MISSING
        return None, "%s: %s" % (type(exc).__name__, exc)

    try:
        data = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        return None, "response was not valid JSON: %s" % exc

    if not isinstance(data, dict):
        return None, "response JSON was not an object (got %s)" % type(data).__name__

    return data, "branch protection API"


def extract_contexts(payload):
    """Pure, defensive extraction of required_status_checks.contexts from a branch
    protection payload. Never raises: any missing/malformed nesting (required_status_checks
    absent, null, or contexts not a list) resolves to an empty list -- "measured, and there
    are zero required contexts" -- rather than an exception. This is the function the
    fixture-based test drives directly against the pre-fix and post-fix payloads gh-1728
    recorded, so it IS the real-firing/negative-control logic, not a stand-in for it."""
    if not isinstance(payload, dict):
        return []
    rsc = payload.get("required_status_checks")
    if not isinstance(rsc, dict):
        return []
    contexts = rsc.get("contexts")
    if not isinstance(contexts, list):
        return []
    return [c for c in contexts if isinstance(c, str)]


def evaluate_contexts(contexts, required_context, detail):
    """Pure verdict logic -- no I/O. `contexts` is None when the payload could not be
    fetched at all (UNMEASURED); otherwise it is the (possibly empty) list already
    extracted via extract_contexts(). Never returns ARMED when contexts is None."""
    if contexts is None:
        return {
            "verdict": "UNMEASURED",
            "code": 3,
            "contexts": None,
            "detail": detail,
        }
    if required_context in contexts:
        return {
            "verdict": "ARMED",
            "code": 0,
            "contexts": contexts,
            "detail": detail,
        }
    return {
        "verdict": "MISSING",
        "code": 2,
        "contexts": contexts,
        "detail": detail,
    }


def _banner_lines(result, repo, branch, required_context):
    """Return the loud warning lines for MISSING/UNMEASURED verdicts, or None for ARMED.
    Both text mode and --json mode build the banner from this single source so the
    loudness is never a function of the output format (same rule as
    drift-detector-age.py's _banner_lines, ruled on gh-1501 comment 5509656183 2c)."""
    if result["verdict"] == "UNMEASURED":
        return [
            "  " + "!" * 70,
            "  >> UNMEASURED IS NOT A PASS. <<",
            "  This script could not read branch protection on %s:%s at all -- that is" % (repo, branch),
            "  the EXACT blind state gh-1728 exists to close: a requirement",
            "  (constitution entry 6, R-120) with no enforcement looks identical to one",
            "  that is silently armed unless someone actually reads it. This is UNKNOWN,",
            "  not verified-armed. Fix the measurement (token/network/scope), then re-run.",
            "  " + "!" * 70,
        ]
    if result["verdict"] == "MISSING":
        return [
            "  " + "#" * 70,
            "  >> MISSING: %r is NOT a required status check on %s:%s. <<" % (required_context, repo, branch),
            "     Constitution entry 6 (R-120) has no enforcement right now -- any PR",
            "     touching legal wording, consent, pricing, or money can merge unsigned",
            "     for as long as this stays true (gh-1728). If this is intentional (a",
            "     signing-key rotation in progress, per gh-1728's own account of why it",
            "     was legitimately off once), re-arm as soon as the rotation completes:",
            "     PATCH /repos/%s/branches/%s/protection/required_status_checks" % (repo, branch),
            "       {\"strict\": true, \"contexts\": [..., %r]}" % required_context,
            "  " + "#" * 70,
        ]
    return None


def print_report(result, repo, branch, required_context, as_json):
    banner_lines = _banner_lines(result, repo, branch, required_context)
    measured_by = None if result["detail"] == NO_TOKEN_REASON else "branch-protection-api"

    if as_json:
        print(
            json.dumps(
                {
                    "verdict": result["verdict"],
                    "repo": repo,
                    "branch": branch,
                    "required_context": required_context,
                    "contexts": result["contexts"],
                    "detail": result["detail"],
                    "measured_by": measured_by,
                    "banner": "\n".join(banner_lines) if banner_lines else None,
                }
            )
        )
        return

    print("R-120 GATE ARMED CHECK   repo=%s branch=%s" % (repo, branch))
    print("  required context        : %s" % required_context)
    print("  verdict                  : %s" % result["verdict"])
    print(
        "  required_status_checks.contexts: %s"
        % (result["contexts"] if result["contexts"] is not None else "UNKNOWN")
    )
    print("  detail                   : %s" % result["detail"])

    if banner_lines:
        for line in banner_lines:
            print(line)


def _parse_args(argv):
    def _flag(name, default):
        return argv[argv.index(name) + 1] if name in argv else default

    return {
        "repo": _flag("--repo", DEFAULT_REPO),
        "branch": _flag("--branch", DEFAULT_BRANCH),
        "required_context": _flag("--required-context", DEFAULT_REQUIRED_CONTEXT),
        "as_json": "--json" in argv,
    }


def main():
    args = _parse_args(sys.argv[1:])
    token = _token()
    payload, detail = fetch_protection_payload(args["repo"], args["branch"], token)
    contexts = None if payload is None else extract_contexts(payload)
    result = evaluate_contexts(contexts, args["required_context"], detail)
    print_report(result, args["repo"], args["branch"], args["required_context"], args["as_json"])
    return result["code"]


if __name__ == "__main__":
    sys.exit(main())
