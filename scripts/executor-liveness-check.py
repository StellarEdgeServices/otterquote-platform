#!/usr/bin/env python3
"""executor-liveness-check.py -- is the run-work executor actually alive, or just
noisy?

Built for gh-1588 ("reads 3 + 4" of the #1549 liveness job), CTO ruling comment
5532040121 on that issue. Deliberately modelled on scripts/drift-detector-age.py
(gh-1501), which solved the identical shape for a different subject: a liveness
check that shares a trigger with its subject is not a liveness check, and
UNMEASURED must never look like a pass.

WHY THIS EXISTS
----------------
Two failure shapes on Dustin's machine had no automated detector before this:

Read 3 -- a heartbeat that is technically fresh but lying. Every run-work session
writes "In Flight/heartbeat/<thread_id>.md" and re-stamps `last_heartbeat` on a
cadence. A TTL breach (last_heartbeat older than 30 minutes) is the easy case.
The harder case is the one this issue was filed to name: `rw-f22-20260902T233851-
cnem.md` kept `last_heartbeat` advancing for roughly eleven hours while
`current_task` stayed pinned at "wave1 gh-1438/gh-1500a/gh-1509b" long after its
own drain ledger showed those three issues finished. Every poller that trusted
last_heartbeat alone saw a live process and left #1438/#1500/#1509 looking
claimed. The rule this script enforces: a heartbeat is a liveness signal, not a
keep-alive -- last_heartbeat may only advance when current_task or
tasks_completed advances with it, or status becomes "idle". Detecting that needs
state between runs (see STATE FILE below); a first run with no prior state
cannot see a streak and must say so rather than fabricate one.

Read 4 -- leaked claude.exe session hosts. A `claude-code\\*\\claude.exe` process
that has been running for hours with no live heartbeat whose `started_at`
matches its process-start window is very likely an orphan from an ended
session (measured baseline 2026-09-03: 26 resident processes, 23 verifiably
dead, ~2 GB). This script counts and WARNS. It never kills anything -- reaping
was done with Dustin in the loop on 2026-09-03 and stays that way; a detector
that reaps is a different, unauthorized change (see issue #1588 BUILD section).

STATE FILE
----------
The stale-current_task streak (Read 3's harder case) needs the *previous* run's
observation of each heartbeat's (thread_id, current_task, tasks_completed,
last_heartbeat). That is kept in a small JSON file under "In Flight/" (default:
"<home>/Downloads/Claude Downloads/In Flight/bin/executor-liveness-state.json"
-- override with --state-file or EXECUTOR_LIVENESS_STATE_FILE). This is the
ONLY file this script writes; it never touches a heartbeat file, and it lives
outside "Claude's Memories/" per R-045 (this lane's write boundary is
"In Flight/" and the repo, never the memory tree).

THE RULE IT OBEYS, same rule drift-detector-age.py obeys, applied here:
  * NEVER reports a pass when it could not measure. Cannot read the heartbeat
    directory, or cannot enumerate claude.exe processes at all (not "zero
    found" -- an actual enumeration failure) -> exit 3 UNMEASURED, which is a
    different and louder thing than exit 0 CLEAN. Per gh-1419:
    UNMEASURED MUST FAIL AS LOUDLY AS STALE/ALARM. This script never prints
    anything resembling "OK" on verdict 3.
  * Detecting zero breaches is a pass and prints as the number 0, not as
    silence -- every count (heartbeats read, TTL breaches, stale-task streaks,
    leaked hosts) is always printed, in both text and --json mode.
  * REPORT ONLY. This script makes zero writes outside its own state file: no
    deleting, reaping, or modifying any heartbeat file, no killing any process.
    A detector that repairs itself hides the fault it exists to expose (the
    same settled design as drift-detector-age.py, gh-1501 comment 5509114408).

TELEMETRY
---------
The issue also requires a liveness row in "scanner-telemetry.md" (#1501's
lesson: a detector whose own silence is undetectable is the same defect one
level up). That file lives under "Claude's Memories/", which this lane may not
write (R-045). So this script only ever PRINTS the exact row it would append
(see --json field "telemetry_row" / the "TELEMETRY ROW" line in text mode);
appending it is the CTO's action, taken in the same run the script lands
(issue #1588 comment 5532040121).

USAGE
    python executor-liveness-check.py
    python executor-liveness-check.py --json
    python executor-liveness-check.py --heartbeat-dir "<path>" --state-file "<path>"
    python executor-liveness-check.py --leak-age-hours 2 --started-at-tolerance-minutes 10
                  --leak-age-hours: how old (hours) an unmatched claude.exe process
                      must be before it counts as a leak (default 2.0).
                  --started-at-tolerance-minutes: how close a process's creation
                      time must be to a live heartbeat's started_at to count as
                      "matched, not a leak" (default 10).
EXIT
    0 CLEAN       heartbeats read, processes enumerated, zero TTL breaches,
                  zero stale-task streaks, zero leaked hosts.
    2 ALARM       TTL breach, and/or a stale-task streak, and/or one or more
                  leaked hosts.
    3 UNMEASURED  could not read the heartbeat directory at all, or could not
                  enumerate claude.exe processes at all -- this is NOT a pass.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SCRIPT_NAME = "executor-liveness-check.py"
HEARTBEAT_TTL_MINUTES = 30.0  # per issue body: read 3's first alarm condition
DEFAULT_LEAK_AGE_HOURS = 2.0
DEFAULT_STARTED_AT_TOLERANCE_MINUTES = 10.0
PWSH_CANDIDATES = ("pwsh", "powershell")
PWSH_TIMEOUT_SECONDS = 30

# Matches "...claude-code\<anything>\claude.exe" or the forward-slash form,
# case-insensitively, per the issue's own filter ("claude-code\*\claude.exe").
CLAUDE_EXE_PATTERN = re.compile(r"claude-code[\\/].*[\\/]claude\.exe$", re.IGNORECASE)

# Deliberately -AsArray so a 0- or 1-match result still comes back as a JSON
# array (PowerShell's ConvertTo-Json otherwise collapses a single object to a
# bare object and an empty pipeline to nothing at all -- both would need
# special-casing on the Python side if not forced here).
POWERSHELL_ENUM_SCRIPT = r"""
$ErrorActionPreference = "Stop"
$procs = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and ($_.ExecutablePath -match 'claude-code[\\/].*[\\/]claude\.exe$')
}
$out = foreach ($p in $procs) {
    $created = $null
    if ($p.CreationDate) {
        $created = $p.CreationDate.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    [PSCustomObject]@{
        ProcessId       = $p.ProcessId
        ExecutablePath  = $p.ExecutablePath
        CreationDateUtc = $created
    }
}
$out | ConvertTo-Json -Depth 3 -AsArray
"""


def default_heartbeat_dir():
    override = os.environ.get("EXECUTOR_LIVENESS_HEARTBEAT_DIR")
    if override:
        return override
    return os.path.join(
        os.path.expanduser("~"), "Downloads", "Claude Downloads", "In Flight", "heartbeat"
    )


def default_state_file():
    override = os.environ.get("EXECUTOR_LIVENESS_STATE_FILE")
    if override:
        return override
    return os.path.join(
        os.path.expanduser("~"),
        "Downloads",
        "Claude Downloads",
        "In Flight",
        "bin",
        "executor-liveness-state.json",
    )


# ---------------------------------------------------------------------------
# Time parsing (shared by heartbeat timestamps and process CreationDateUtc)
# ---------------------------------------------------------------------------


def parse_iso_utc(iso):
    """Parse a 'YYYY-MM-DDTHH:MM:SSZ'-shaped timestamp into an aware UTC
    datetime. Raises ValueError on anything unreadable -- callers must treat
    that as unmeasurable for that one value, never as a silent default."""
    s = iso.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Read 3a/3b/3c: heartbeat parsing + per-heartbeat evaluation
# ---------------------------------------------------------------------------


def parse_heartbeat_text(text):
    """Parse a heartbeat file's simple 'key: value' lines into a dict. Lines
    starting with '#' and blank lines are skipped. Only the first ':' splits
    key from value, so a value (e.g. a URL or a timestamp) may itself contain
    colons."""
    fields = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        fields[key.strip()] = value.strip()
    return fields


def discover_heartbeat_files(heartbeat_dir):
    """Return (sorted list of *.md paths, None) or (None, reason) if the
    directory itself could not be listed at all. An existing-but-empty
    directory is NOT a failure -- it returns ([], None)."""
    try:
        if not os.path.isdir(heartbeat_dir):
            return None, "heartbeat directory does not exist: %s" % heartbeat_dir
        names = [n for n in os.listdir(heartbeat_dir) if n.lower().endswith(".md")]
    except Exception as exc:  # noqa: BLE001 -- any failure here is UNMEASURED
        return None, "%s: %s" % (type(exc).__name__, exc)
    return sorted(os.path.join(heartbeat_dir, n) for n in names), None


def load_heartbeat_file(path):
    """Return (fields_dict, None) or (None, reason) for one heartbeat file.
    Never raises."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except Exception as exc:  # noqa: BLE001
        return None, "%s: %s" % (type(exc).__name__, exc)
    return parse_heartbeat_text(text), None


def evaluate_single_heartbeat(path, fields, now, prior_entry):
    """Pure verdict logic for one heartbeat (no I/O). Returns a dict:
      file, thread_id, status, current_task, tasks_completed, last_heartbeat,
      started_at, started_at_dt (or None), age_minutes (or None),
      clock_skew (bool), ttl_breach (bool), stale_task_streak (bool),
      streak_measurable (bool -- False on first observation of this thread),
      live (bool -- True iff not ttl_breach and not clock_skew),
      alarm (bool), reasons (list[str]).
    """
    thread_id = fields.get("thread_id") or os.path.splitext(os.path.basename(path))[0]
    status = fields.get("status", "")
    current_task = fields.get("current_task", "")
    tasks_completed = fields.get("tasks_completed", "")
    last_heartbeat_raw = fields.get("last_heartbeat")
    started_at_raw = fields.get("started_at")

    reasons = []
    clock_skew = False
    ttl_breach = False
    age_minutes = None

    started_at_dt = None
    if started_at_raw:
        try:
            started_at_dt = parse_iso_utc(started_at_raw)
        except Exception as exc:  # noqa: BLE001
            reasons.append("started_at unreadable (%s): %s" % (started_at_raw, exc))

    if not last_heartbeat_raw:
        ttl_breach = True
        reasons.append("last_heartbeat field missing")
    else:
        try:
            last_dt = parse_iso_utc(last_heartbeat_raw)
        except Exception as exc:  # noqa: BLE001
            ttl_breach = True
            reasons.append("last_heartbeat unreadable (%s): %s" % (last_heartbeat_raw, exc))
        else:
            if last_dt > now:
                # Clock-skew guard: a last_heartbeat in the future is INVALID,
                # treated as missing/not live -- never as extra-fresh.
                clock_skew = True
                ttl_breach = True
                reasons.append(
                    "CLOCK_SKEW: last_heartbeat (%s) is after now (%s) -- invalid, "
                    "treated as missing" % (last_heartbeat_raw, now.isoformat())
                )
            else:
                age_minutes = (now - last_dt).total_seconds() / 60.0
                if age_minutes > HEARTBEAT_TTL_MINUTES:
                    ttl_breach = True
                    reasons.append(
                        "TTL breach: last_heartbeat is %.1f minutes old (limit %.0f)"
                        % (age_minutes, HEARTBEAT_TTL_MINUTES)
                    )

    live = not ttl_breach and not clock_skew

    stale_task_streak = False
    streak_measurable = prior_entry is not None
    if prior_entry is not None and live:
        same_task = prior_entry.get("current_task", None) == current_task
        same_completed = prior_entry.get("tasks_completed", None) == tasks_completed
        prior_last_hb = prior_entry.get("last_heartbeat")
        advanced = (prior_last_hb is not None) and (prior_last_hb != last_heartbeat_raw)
        if same_task and same_completed and advanced and status.strip().lower() != "idle":
            stale_task_streak = True
            reasons.append(
                "STALE-TASK STREAK: current_task/tasks_completed unchanged across two "
                "consecutive intervals while last_heartbeat advanced (%s -> %s) and "
                "status is not idle -- the cnem shape (gh-1588)"
                % (prior_last_hb, last_heartbeat_raw)
            )

    alarm = ttl_breach or clock_skew or stale_task_streak

    return {
        "file": path,
        "thread_id": thread_id,
        "status": status,
        "current_task": current_task,
        "tasks_completed": tasks_completed,
        "last_heartbeat": last_heartbeat_raw,
        "started_at": started_at_raw,
        "started_at_dt": started_at_dt,
        "age_minutes": age_minutes,
        "clock_skew": clock_skew,
        "ttl_breach": ttl_breach,
        "stale_task_streak": stale_task_streak,
        "streak_measurable": streak_measurable,
        "live": live,
        "alarm": alarm,
        "reasons": reasons,
    }


def evaluate_heartbeats(heartbeat_dir, state, now):
    """Read every *.md in heartbeat_dir and evaluate each. Returns
    (results_list, read_error). read_error is None unless the directory
    itself could not be listed -- a per-file read failure instead produces a
    result entry with alarm=True and its own reason, so one unreadable file
    does not blind the whole run."""
    paths, err = discover_heartbeat_files(heartbeat_dir)
    if err is not None:
        return None, err

    prior_heartbeats = state.get("heartbeats", {}) if isinstance(state, dict) else {}
    results = []
    for path in paths:
        fields, file_err = load_heartbeat_file(path)
        if file_err is not None:
            thread_id = os.path.splitext(os.path.basename(path))[0]
            results.append(
                {
                    "file": path,
                    "thread_id": thread_id,
                    "status": "",
                    "current_task": "",
                    "tasks_completed": "",
                    "last_heartbeat": None,
                    "started_at": None,
                    "started_at_dt": None,
                    "age_minutes": None,
                    "clock_skew": False,
                    "ttl_breach": True,
                    "stale_task_streak": False,
                    "streak_measurable": False,
                    "live": False,
                    "alarm": True,
                    "reasons": ["could not read file: %s" % file_err],
                }
            )
            continue
        thread_id = fields.get("thread_id") or os.path.splitext(os.path.basename(path))[0]
        prior_entry = prior_heartbeats.get(thread_id)
        results.append(evaluate_single_heartbeat(path, fields, now, prior_entry))
    return results, None


def build_state(prior_state, heartbeat_results, now):
    """Merge this run's successfully-read heartbeats into prior_state's
    'heartbeats' dict (entries for heartbeats not seen this run are left
    untouched -- a deleted/rotated file should not erase the last known
    observation, it just stops being updated)."""
    heartbeats = dict(prior_state.get("heartbeats", {})) if isinstance(prior_state, dict) else {}
    for r in heartbeat_results:
        if r.get("last_heartbeat") is None and "could not read file" in " ".join(r.get("reasons", [])):
            continue  # unreadable this run -- do not overwrite a good prior observation
        heartbeats[r["thread_id"]] = {
            "current_task": r["current_task"],
            "tasks_completed": r["tasks_completed"],
            "last_heartbeat": r["last_heartbeat"],
            "status": r["status"],
            "observed_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
    return {"version": 1, "heartbeats": heartbeats}


def load_state(path):
    """Return (state_dict, note). note is None on a normal load, or a short
    explanation on first-run/corrupt-file fallback -- never raises, and a
    missing/corrupt state file is NOT treated as UNMEASURED (it just means the
    stale-task streak read starts fresh)."""
    if not os.path.exists(path):
        return {"version": 1, "heartbeats": {}}, "no prior state file -- first run"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            raise ValueError("state file root is not a JSON object")
        data.setdefault("heartbeats", {})
        return data, None
    except Exception as exc:  # noqa: BLE001
        return {"version": 1, "heartbeats": {}}, "prior state file unreadable, starting fresh: %s" % exc


def save_state(path, state):
    """Write the state JSON. Returns None on success, or an error string.
    This is the ONLY file this script ever writes."""
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
            fh.write("\n")
        return None
    except Exception as exc:  # noqa: BLE001
        return "%s: %s" % (type(exc).__name__, exc)


# ---------------------------------------------------------------------------
# Read 4: leaked claude.exe session hosts
# ---------------------------------------------------------------------------


def _run_powershell(script_text, timeout=PWSH_TIMEOUT_SECONDS):
    last_exc = None
    for exe in PWSH_CANDIDATES:
        try:
            return subprocess.run(
                [exe, "-NoProfile", "-NonInteractive", "-Command", script_text],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except FileNotFoundError as exc:  # try the next candidate
            last_exc = exc
            continue
    raise last_exc or FileNotFoundError("no pwsh/powershell executable found on PATH")


def fetch_claude_processes(run=_run_powershell, timeout=PWSH_TIMEOUT_SECONDS):
    """Enumerate claude-code\\*\\claude.exe processes. Returns
    (list_of_dicts, source_note) on success (list may be empty -- that is a
    real zero, not a failure), or (None, reason) if enumeration itself could
    not be completed at all. Never raises."""
    try:
        proc = run(POWERSHELL_ENUM_SCRIPT, timeout)
    except Exception as exc:  # noqa: BLE001 -- any failure here is UNMEASURED
        return None, "%s: %s" % (type(exc).__name__, exc)

    if proc.returncode != 0:
        return None, "pwsh exited %s: %s" % (proc.returncode, (proc.stderr or "").strip()[:300])

    raw = (proc.stdout or "").strip()
    if not raw or raw == "null":
        return [], "Get-CimInstance Win32_Process reachable, zero matching processes"

    try:
        data = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        return None, "pwsh output was not valid JSON: %s" % exc

    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return None, "unexpected pwsh JSON shape: %s" % type(data).__name__

    return data, "Get-CimInstance Win32_Process (%d matched)" % len(data)


def evaluate_leaks(processes, heartbeat_results, leak_age_hours, tolerance_minutes, now):
    """Cross-reference enumerated processes against live heartbeats'
    started_at. Returns a dict: considered (list), leaks (list), leak_count,
    unmeasured_processes (list -- processes whose own CreationDate could not
    be read; reported, never silently dropped)."""
    live_started = [
        r["started_at_dt"]
        for r in heartbeat_results
        if r.get("live") and r.get("started_at_dt") is not None
    ]
    tolerance_seconds = tolerance_minutes * 60.0

    considered = []
    leaks = []
    unmeasured_processes = []

    for p in processes:
        pid = p.get("ProcessId")
        exe = p.get("ExecutablePath")
        created_raw = p.get("CreationDateUtc")

        if not created_raw:
            unmeasured_processes.append(
                {"pid": pid, "executable_path": exe, "reason": "no CreationDate reported"}
            )
            continue
        try:
            created_dt = parse_iso_utc(created_raw)
        except Exception as exc:  # noqa: BLE001
            unmeasured_processes.append(
                {
                    "pid": pid,
                    "executable_path": exe,
                    "reason": "unparseable CreationDateUtc (%s): %s" % (created_raw, exc),
                }
            )
            continue

        age_hours = (now - created_dt).total_seconds() / 3600.0
        matched = any(
            abs((created_dt - s).total_seconds()) <= tolerance_seconds for s in live_started
        )
        entry = {
            "pid": pid,
            "executable_path": exe,
            "created_at": created_raw,
            "age_hours": age_hours,
            "matched_live_heartbeat": matched,
        }
        is_leak = (not matched) and (age_hours > leak_age_hours)
        entry["leak"] = is_leak
        considered.append(entry)
        if is_leak:
            leaks.append(entry)

    return {
        "considered": considered,
        "leaks": leaks,
        "leak_count": len(leaks),
        "unmeasured_processes": unmeasured_processes,
    }


# ---------------------------------------------------------------------------
# Overall verdict + reporting
# ---------------------------------------------------------------------------


def compute_verdict(heartbeat_results, heartbeat_read_error, leak_result, process_read_error):
    """Pure combination logic. UNMEASURED wins over ALARM wins over CLEAN --
    an unreadable heartbeat directory or a failed process enumeration is
    UNMEASURED regardless of what the other read found."""
    if heartbeat_read_error is not None or process_read_error is not None:
        reasons = []
        if heartbeat_read_error is not None:
            reasons.append("heartbeat read failed: %s" % heartbeat_read_error)
        if process_read_error is not None:
            reasons.append("process enumeration failed: %s" % process_read_error)
        return {"verdict": "UNMEASURED", "code": 3, "detail": "; ".join(reasons)}

    ttl_breaches = sum(1 for r in heartbeat_results if r["ttl_breach"])
    stale_streaks = sum(1 for r in heartbeat_results if r["stale_task_streak"])
    leak_count = leak_result["leak_count"]

    if ttl_breaches or stale_streaks or leak_count:
        parts = []
        if ttl_breaches:
            parts.append("%d TTL breach(es)" % ttl_breaches)
        if stale_streaks:
            parts.append("%d stale-task streak(s)" % stale_streaks)
        if leak_count:
            parts.append("%d leaked host(s)" % leak_count)
        return {"verdict": "ALARM", "code": 2, "detail": ", ".join(parts)}

    return {"verdict": "CLEAN", "code": 0, "detail": "0 breaches, 0 streaks, 0 leaks"}


def _banner_lines(verdict):
    if verdict == "UNMEASURED":
        return [
            "  " + "!" * 70,
            "  >> UNMEASURED IS NOT A PASS. <<",
            "  This script could not read the heartbeat directory and/or could not",
            "  enumerate claude.exe processes -- that is the EXACT blind state a",
            "  silent detector would hide (#1501's lesson). This is UNKNOWN, not",
            "  verified-healthy. Fix the measurement, then re-run.",
            "  " + "!" * 70,
        ]
    if verdict == "ALARM":
        return [
            "  " + "#" * 70,
            "  >> ALARM: a heartbeat breached its TTL, or advertised a stale",
            "     current_task while advancing (the cnem shape), or a leaked",
            "     claude.exe host was found. See the per-item detail above.",
            "     This script does NOT reap or repair anything by design.",
            "  " + "#" * 70,
        ]
    return None


def telemetry_row(now, heartbeat_count, ttl_breaches, stale_streaks, leak_count, verdict, note):
    """Build the exact scanner-telemetry.md row this run would append, in
    that file's documented format:
    '| Date | Scanner | Cadence | Findings | Actions | Empty? | Notes |'
    This script never writes to scanner-telemetry.md (Claude's Memories/ is
    outside this lane's write boundary, R-045) -- it only prints this line for
    the CTO to paste."""
    date = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    findings = (
        "%d heartbeat(s) read, %d TTL breach(es), %d stale-task streak(s), %d leaked host(s)"
        % (heartbeat_count, ttl_breaches, stale_streaks, leak_count)
    )
    actions = "0 (report-only; never kills a process, never edits a heartbeat file)"
    empty = "Y" if verdict == "CLEAN" else "N"
    notes = "verdict=%s (gh-1588 executor-liveness-check.py) -- %s" % (verdict, note)
    return "| %s | %s | run-work Step 0.45 pre-flight (Code lane, every wake) | %s | %s | %s | %s |" % (
        date,
        SCRIPT_NAME,
        findings,
        actions,
        empty,
        notes,
    )


def print_report(
    now,
    heartbeat_results,
    heartbeat_read_error,
    leak_result,
    process_read_error,
    state_note,
    verdict_info,
    as_json,
):
    ttl_breaches = sum(1 for r in heartbeat_results if r["ttl_breach"]) if heartbeat_results else 0
    stale_streaks = (
        sum(1 for r in heartbeat_results if r["stale_task_streak"]) if heartbeat_results else 0
    )
    unmeasurable_streaks = (
        sum(1 for r in heartbeat_results if not r["streak_measurable"]) if heartbeat_results else 0
    )
    leak_count = leak_result["leak_count"] if leak_result else 0
    heartbeat_count = len(heartbeat_results) if heartbeat_results else 0
    row = telemetry_row(
        now, heartbeat_count, ttl_breaches, stale_streaks, leak_count, verdict_info["verdict"], verdict_info["detail"]
    )
    banner_lines = _banner_lines(verdict_info["verdict"])

    if as_json:
        payload = {
            "verdict": verdict_info["verdict"],
            "detail": verdict_info["detail"],
            "now": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "heartbeat_count": heartbeat_count,
            "ttl_breach_count": ttl_breaches,
            "stale_task_streak_count": stale_streaks,
            "streak_unmeasurable_count": unmeasurable_streaks,
            "heartbeat_read_error": heartbeat_read_error,
            "heartbeats": [
                {
                    "thread_id": r["thread_id"],
                    "status": r["status"],
                    "current_task": r["current_task"],
                    "last_heartbeat": r["last_heartbeat"],
                    "age_minutes": None if r["age_minutes"] is None else round(r["age_minutes"], 2),
                    "live": r["live"],
                    "ttl_breach": r["ttl_breach"],
                    "clock_skew": r["clock_skew"],
                    "stale_task_streak": r["stale_task_streak"],
                    "streak_measurable": r["streak_measurable"],
                    "reasons": r["reasons"],
                }
                for r in (heartbeat_results or [])
            ],
            "leak_count": leak_count,
            "leaks": leak_result["leaks"] if leak_result else [],
            "unmeasured_processes": leak_result["unmeasured_processes"] if leak_result else [],
            "process_read_error": process_read_error,
            "state_note": state_note,
            "telemetry_row": row,
            "banner": "\n".join(banner_lines) if banner_lines else None,
        }
        print(json.dumps(payload, indent=2))
        return

    print("EXECUTOR LIVENESS CHECK   now=%s" % now.strftime("%Y-%m-%dT%H:%M:%SZ"))
    print("  verdict                 : %s" % verdict_info["verdict"])
    print("  detail                  : %s" % verdict_info["detail"])
    print("  state                   : %s" % (state_note or "loaded"))
    print()
    print("READ 3 -- heartbeats")
    if heartbeat_read_error is not None:
        print("  UNMEASURED: %s" % heartbeat_read_error)
    else:
        print("  heartbeats read         : %d" % heartbeat_count)
        print("  TTL breaches (>%.0fm)    : %d" % (HEARTBEAT_TTL_MINUTES, ttl_breaches))
        print("  stale-task streaks      : %d" % stale_streaks)
        print("  streak not yet measurable (no prior state): %d" % unmeasurable_streaks)
        for r in heartbeat_results:
            marker = "ALARM" if r["alarm"] else "clean"
            age = "n/a" if r["age_minutes"] is None else "%.1fm" % r["age_minutes"]
            print(
                "    [%s] %-45s status=%-10s age=%-8s current_task=%s"
                % (marker, r["thread_id"], r["status"] or "?", age, r["current_task"] or "?")
            )
            for reason in r["reasons"]:
                print("        - %s" % reason)
    print()
    print("READ 4 -- leaked claude.exe session hosts")
    if process_read_error is not None:
        print("  UNMEASURED: %s" % process_read_error)
    else:
        print("  processes matched claude-code\\*\\claude.exe: %d" % len(leak_result["considered"] + leak_result["unmeasured_processes"]))
        print("  leaked (WARN only, never killed)            : %d" % leak_count)
        if leak_result["unmeasured_processes"]:
            print("  processes with unreadable CreationDate       : %d" % len(leak_result["unmeasured_processes"]))
        for entry in leak_result["leaks"]:
            print(
                "    [LEAK] pid=%s age=%.1fh path=%s"
                % (entry["pid"], entry["age_hours"], entry["executable_path"])
            )
    print()
    print("TELEMETRY ROW (paste into Claude's Memories/scanner-telemetry.md -- this lane may not write it, R-045):")
    print("  %s" % row)

    if banner_lines:
        print()
        for line in banner_lines:
            print(line)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def build_arg_parser():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--heartbeat-dir", default=None)
    p.add_argument("--state-file", default=None)
    p.add_argument("--leak-age-hours", type=float, default=DEFAULT_LEAK_AGE_HOURS)
    p.add_argument(
        "--started-at-tolerance-minutes", type=float, default=DEFAULT_STARTED_AT_TOLERANCE_MINUTES
    )
    p.add_argument("--json", action="store_true")
    return p


def main(argv=None):
    args = build_arg_parser().parse_args(argv if argv is not None else sys.argv[1:])
    heartbeat_dir = args.heartbeat_dir or default_heartbeat_dir()
    state_file = args.state_file or default_state_file()

    now = datetime.now(timezone.utc)

    prior_state, state_note = load_state(state_file)
    heartbeat_results, heartbeat_read_error = evaluate_heartbeats(heartbeat_dir, prior_state, now)

    processes, process_source_or_error = fetch_claude_processes()
    process_read_error = process_source_or_error if processes is None else None

    if heartbeat_results is not None:
        leak_result = evaluate_leaks(
            processes or [],
            heartbeat_results,
            args.leak_age_hours,
            args.started_at_tolerance_minutes,
            now,
        )
    else:
        leak_result = {"considered": [], "leaks": [], "leak_count": 0, "unmeasured_processes": []}

    verdict_info = compute_verdict(
        heartbeat_results or [], heartbeat_read_error, leak_result, process_read_error
    )

    print_report(
        now,
        heartbeat_results or [],
        heartbeat_read_error,
        leak_result,
        process_read_error,
        state_note,
        verdict_info,
        args.json,
    )

    # Persist state for the NEXT run's stale-task streak read -- only when we
    # actually read the heartbeat directory this run (never overwrite good
    # prior state with nothing on an UNMEASURED heartbeat read).
    if heartbeat_results is not None:
        new_state = build_state(prior_state, heartbeat_results, now)
        save_err = save_state(state_file, new_state)
        if save_err is not None:
            sys.stderr.write("WARNING: could not save state file %s: %s\n" % (state_file, save_err))

    return verdict_info["code"]


if __name__ == "__main__":
    sys.exit(main())
