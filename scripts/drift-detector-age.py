#!/usr/bin/env python3
"""drift-detector-age.py -- is the Edge Function drift detector's schedule still alive?

Built for gh-1501 (CTO run rw-f22-20260902T113702-luol), design comment 5509114408 on
that issue. Deliberately modelled on "In Flight/bin/backup-age.py", which solved this
identical shape for the memory backup (dead 80 days, nothing noticed, because the only
thing that would have noticed was the unrun step itself).

WHY THIS EXISTS
----------------
".github/workflows/edge-function-drift.yml" (workflow id 346281499) is schedule-only for
its purpose: its `push` trigger is path-filtered to the detector's OWN source files
(scripts/edge-function-drift-check.py, its test, and the workflow file itself), so it does
NOT fire when an Edge Function changes. When the daily cron (17 9 * * *) silently does not
fire, the silence is indistinguishable from "62/62 IDENTICAL". gh-1501 observed exactly
that: the 2026-09-02 09:17 UTC slot never ran and nobody noticed until a manual browser
read three hours later.

THE RULE IT OBEYS, same rule backup-age.py obeys, applied to this subject: a liveness
check that shares a trigger with its subject is not a liveness check. So this script:
  * Reads the run history via the REST API, never a local marker this pipeline wrote.
  * NEVER reports OK when it could not measure. No token, no network, no readable
    timestamp -> exit 3 UNMEASURED, which is a different and louder thing than exit 0
    FRESH. Per gh-1419: UNMEASURED MUST FAIL AS LOUDLY AS STALE. This script never prints
    anything resembling "drift detector OK" on verdict 3.
  * Is session-triggered (run it whenever you want an answer), not scheduler-triggered --
    a watchdog built on GitHub's own `schedule:` trigger would inherit the exact
    unreliability it exists to catch.

REPORT ONLY. This script makes zero writes: no workflow_dispatch, no re-run, no edit to
any workflow. A detector that repairs itself hides the scheduler fault it exists to expose
(this is the settled design on gh-1501 comment 5509114408 -- do not "improve" this later
without re-reading that comment).

THRESHOLD DERIVATION (--threshold-hours, default 36)
  cron period                                   = 24h
  worst observed scheduler delay on this workflow = 7h15m (run 33415036347,
      2026-08-31 target 09:00Z, fired 16:36Z -- see edge-function-drift.yml's own
      header comment)
  24h + 7h15m = 31h15m minimum before "late" can even be distinguished from "on time
      but delayed like every prior observed fire". 36h is chosen deliberately above
      that floor -- comfortably past the observed delay distribution captured in the
      workflow's history (both prior scheduled fires landed 4h50m-7h15m late and
      neither was a dropped run), so this does not cry wolf on a delay shape that has
      already happened twice and self-healed. Tightening it needs a bigger delay
      sample, not arithmetic on today's one worst case.

AUTH
  Reads GITHUB_PERSONAL_ACCESS_TOKEN from the environment (os.environ) only -- no file
  parsing, so this script cannot reproduce backup-age.py's documented _token() bug
  (matching a comment line that merely mentions the var name and "="). If a file-based
  fallback is ever added here, it MUST skip lines starting with "#" the way
  backup-age.py's _token() does today, per the fix applied there 2026-08-31. The token
  VALUE is never printed, logged, or included in any exception message this script
  emits -- R-089.

USAGE
    python drift-detector-age.py                        # default 36h threshold
    python drift-detector-age.py --threshold-hours 36
    python drift-detector-age.py --json
EXIT
    0 FRESH       newest successful scheduled/dispatched run <= threshold hours old
    2 STALE       newest successful run > threshold hours old
    3 UNMEASURED  could not measure at all (no token, network/auth failure, empty
                  result set, or an unreadable timestamp) -- this is NOT a pass
"""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

REPO = "StellarEdgeServices/otterquote-platform"
WORKFLOW_ID = 346281499  # Edge Function Drift (.github/workflows/edge-function-drift.yml)
DEFAULT_THRESHOLD_HOURS = 36.0  # see THRESHOLD DERIVATION above -- do not "round" this down


def _token():
    """Read GITHUB_PERSONAL_ACCESS_TOKEN from the environment. The VALUE never leaves
    this process and is never printed -- R-089. Returns None (not "") when absent/blank."""
    tok = os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN")
    return tok.strip() if tok and tok.strip() else None


def fetch_newest_successful_run(token, timeout=20):
    """Return (iso_created_at, source) for the newest *successful* run of this workflow,
    or (None, reason) if it could not be determined. Never raises -- every failure mode
    (missing token, network, auth, empty result, malformed response) is UNMEASURED, not
    a crash and not silently FRESH."""
    if not token:
        return None, "no GITHUB_PERSONAL_ACCESS_TOKEN found in the environment"

    url = (
        "https://api.github.com/repos/%s/actions/workflows/%s/runs"
        "?status=success&per_page=10" % (REPO, WORKFLOW_ID)
    )
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "User-Agent": "otterquote-drift-detector-age",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        # Deliberately do not echo response body -- it can carry request metadata we
        # do not want in a log, and it never contains anything a STALE/UNMEASURED
        # reader needs beyond the status code.
        return None, "GitHub API HTTP %s (%s)" % (exc.code, exc.reason)
    except Exception as exc:  # noqa: BLE001 -- any failure here is UNMEASURED, not STALE
        return None, "%s: %s" % (type(exc).__name__, exc)

    try:
        data = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        return None, "response was not valid JSON: %s" % exc

    runs = [r for r in data.get("workflow_runs", []) if r.get("conclusion") == "success"]
    if not runs:
        return None, (
            "Actions API reachable but returned zero successful runs for workflow %s"
            % WORKFLOW_ID
        )

    newest = max(runs, key=lambda r: r.get("created_at") or "")
    iso = newest.get("created_at")
    if not iso:
        return None, "newest successful run (id=%s) has no created_at field" % newest.get("id")
    return iso, "actions-api run id=%s" % newest.get("id")


def parse_iso_utc(iso):
    """Parse a GitHub API timestamp ('...Z' = UTC) into an aware UTC datetime. Raises
    ValueError on anything unreadable -- callers must treat that as UNMEASURED."""
    s = iso.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def compute_result(iso, reason, threshold_hours, now=None):
    """Pure verdict logic -- no I/O. `iso` is the newest successful run's created_at, or
    None if it could not be fetched (in which case `reason` explains why). Returns a
    dict with verdict/code/age_hours/detail; never returns FRESH when `iso` is None."""
    now = now or datetime.now(timezone.utc)

    if iso is None:
        return {"verdict": "UNMEASURED", "code": 3, "age_hours": None, "detail": reason}

    try:
        t = parse_iso_utc(iso)
    except Exception as exc:  # noqa: BLE001
        return {
            "verdict": "UNMEASURED",
            "code": 3,
            "age_hours": None,
            "detail": "timestamp %r unreadable: %s" % (iso, exc),
        }

    age_hours = (now - t).total_seconds() / 3600.0
    if age_hours <= threshold_hours:
        return {"verdict": "FRESH", "code": 0, "age_hours": age_hours, "detail": reason}
    return {"verdict": "STALE", "code": 2, "age_hours": age_hours, "detail": reason}


def parse_threshold_hours(argv):
    if "--threshold-hours" in argv:
        return float(argv[argv.index("--threshold-hours") + 1])
    return DEFAULT_THRESHOLD_HOURS


def print_report(iso, result, threshold_hours, as_json):
    if as_json:
        print(
            json.dumps(
                {
                    "verdict": result["verdict"],
                    "repo": REPO,
                    "workflow_id": WORKFLOW_ID,
                    "newest_successful_run_created_at": iso,
                    "age_hours": None
                    if result["age_hours"] is None
                    else round(result["age_hours"], 2),
                    "threshold_hours": threshold_hours,
                    "detail": result["detail"],
                }
            )
        )
        return

    print("EDGE FUNCTION DRIFT DETECTOR AGE   repo=%s workflow_id=%s" % (REPO, WORKFLOW_ID))
    print("  verdict                 : %s" % result["verdict"])
    print("  newest successful run at: %s" % (iso or "UNKNOWN"))
    print(
        "  age (hours)             : %s   threshold %.1f"
        % (
            "UNKNOWN" if result["age_hours"] is None else "%.2f" % result["age_hours"],
            threshold_hours,
        )
    )
    print("  detail                  : %s" % result["detail"])

    if result["verdict"] == "UNMEASURED":
        print("  " + "!" * 70)
        print("  >> UNMEASURED IS NOT A PASS. <<")
        print("  This script could not determine whether the drift detector's schedule")
        print("  is alive -- that is the EXACT blind state that let a slot go silently")
        print("  unrun on gh-1501. This is UNKNOWN, not verified-healthy. Fix the")
        print("  measurement (token/network/API), then re-run.")
        print("  " + "!" * 70)
    elif result["verdict"] == "STALE":
        print("  " + "#" * 70)
        print("  >> STALE: the drift detector has not completed successfully within")
        print("     the %.1fh threshold. Its schedule may have silently skipped a slot" % threshold_hours)
        print("     (gh-1501). Check the Actions UI for workflow %s and, if the" % WORKFLOW_ID)
        print("     scheduler is the fault, that is itself the thing to escalate --")
        print("     this script does NOT dispatch or repair anything by design.")
        print("  " + "#" * 70)


def main():
    argv = sys.argv[1:]
    threshold_hours = parse_threshold_hours(argv)
    as_json = "--json" in argv

    token = _token()
    iso, reason = fetch_newest_successful_run(token)
    result = compute_result(iso, reason, threshold_hours)
    print_report(iso, result, threshold_hours, as_json)
    return result["code"]


if __name__ == "__main__":
    sys.exit(main())
