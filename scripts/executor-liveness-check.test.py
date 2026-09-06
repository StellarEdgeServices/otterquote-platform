#!/usr/bin/env python3
"""
Proof-of-detection test for scripts/executor-liveness-check.py (gh-1588).

Covers the two shapes the issue exists to close:
  Read 3a: a heartbeat whose last_heartbeat has simply gone stale (TTL breach),
           plus the clock-skew guard (a last_heartbeat in the future is
           invalid, not extra-fresh).
  Read 3b: the harder "cnem shape" -- current_task/tasks_completed unchanged
           across two consecutive intervals while last_heartbeat keeps
           advancing and status never goes idle.
  Read 4:  a claude.exe process old enough, with no live heartbeat whose
           started_at matches its creation window, counts as a leak; a
           process that DOES match a live heartbeat's started_at does not.
And the house rule shared with drift-detector-age.py: UNMEASURED (heartbeat
dir unreadable, or process enumeration failed outright) must never look like
a pass, and a real zero (0 breaches/streaks/leaks) must print as 0, not
silence.

No filesystem writes outside a pytest-style tmp dir, and no real subprocess or
network call -- `fetch_claude_processes`'s `run` callable is monkeypatched,
following the importlib-load + injected-fake pattern already used by
scripts/drift-detector-age.test.py.

Run: python executor-liveness-check.test.py
"""

import importlib.util
import io
import json
import pathlib
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("elc", HERE / "executor-liveness-check.py")
elc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(elc)

FAILURES = []


def check(label, actual, expected):
    if actual == expected:
        print(f"  PASS  {label}: {actual}")
    else:
        print(f"  FAIL  {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def write_heartbeat(dirpath, thread_id, **fields):
    lines = ["# run-work Heartbeat", "thread_id: %s" % thread_id]
    for k, v in fields.items():
        lines.append("%s: %s" % (k, v))
    (pathlib.Path(dirpath) / ("%s.md" % thread_id)).write_text("\n".join(lines) + "\n", encoding="utf-8")


class _FakeProc:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def main():
    now = datetime(2026, 9, 3, 22, 40, 0, tzinfo=timezone.utc)

    # -------------------------------------------------------------------------------
    print("parse_heartbeat_text -- key: value parsing, skips comments/blank lines")
    # -------------------------------------------------------------------------------
    text = "# run-work Heartbeat\nthread_id: abc\nlast_heartbeat: 2026-09-03T22:31:48Z\n\ncurrent_task: wave1 gh-1\nnotes: a | b: c\n"
    fields = elc.parse_heartbeat_text(text)
    check("thread_id parsed", fields.get("thread_id"), "abc")
    check("comment line skipped", "run-work Heartbeat" not in fields, True)
    check("only first colon splits (notes keeps its own colon)", fields.get("notes"), "a | b: c")

    # -------------------------------------------------------------------------------
    print("\nparse_iso_utc")
    # -------------------------------------------------------------------------------
    check("Z-suffixed timestamp parses to aware UTC", elc.parse_iso_utc("2026-09-03T22:31:48Z"), now.replace(hour=22, minute=31, second=48))
    try:
        elc.parse_iso_utc("not-a-timestamp")
        check("garbage timestamp raises", "raised", "did not raise")
    except Exception:
        check("garbage timestamp raises", "raised", "raised")

    # -------------------------------------------------------------------------------
    print("\nevaluate_single_heartbeat -- TTL breach boundary")
    # -------------------------------------------------------------------------------
    fresh = elc.evaluate_single_heartbeat(
        "x.md",
        {"thread_id": "t1", "status": "executing", "current_task": "gh-1", "tasks_completed": "0",
         "last_heartbeat": iso(now - timedelta(minutes=5)), "started_at": iso(now - timedelta(minutes=30))},
        now, None,
    )
    check("5m-old heartbeat -> live, no TTL breach", fresh["live"], True)
    check("5m-old heartbeat -> not alarm", fresh["alarm"], False)

    exactly_30 = elc.evaluate_single_heartbeat(
        "x.md", {"thread_id": "t1", "last_heartbeat": iso(now - timedelta(minutes=30))}, now, None,
    )
    check("exactly-30m -> NOT a breach (boundary is > 30, not >=)", exactly_30["ttl_breach"], False)

    just_over = elc.evaluate_single_heartbeat(
        "x.md", {"thread_id": "t1", "last_heartbeat": iso(now - timedelta(minutes=31))}, now, None,
    )
    check("31m-old heartbeat -> TTL breach", just_over["ttl_breach"], True)
    check("31m-old heartbeat -> alarm", just_over["alarm"], True)

    missing = elc.evaluate_single_heartbeat("x.md", {"thread_id": "t1"}, now, None)
    check("missing last_heartbeat field -> treated as TTL breach, not a crash", missing["ttl_breach"], True)

    # -------------------------------------------------------------------------------
    print("\nClock-skew guard -- a future last_heartbeat is INVALID, not extra-fresh")
    # -------------------------------------------------------------------------------
    future = elc.evaluate_single_heartbeat(
        "x.md", {"thread_id": "t1", "last_heartbeat": iso(now + timedelta(minutes=10))}, now, None,
    )
    check("future last_heartbeat -> clock_skew True", future["clock_skew"], True)
    check("future last_heartbeat -> live False (treated as missing)", future["live"], False)
    check("future last_heartbeat -> alarm True", future["alarm"], True)

    # -------------------------------------------------------------------------------
    print("\nStale-task streak -- the measured cnem shape")
    # -------------------------------------------------------------------------------
    prior = {"current_task": "wave1 gh-1438/gh-1500a/gh-1509b", "tasks_completed": "3",
              "last_heartbeat": iso(now - timedelta(minutes=20)), "status": "executing"}
    same_task_advanced_hb = elc.evaluate_single_heartbeat(
        "x.md",
        {"thread_id": "cnem", "status": "executing",
         "current_task": "wave1 gh-1438/gh-1500a/gh-1509b", "tasks_completed": "3",
         "last_heartbeat": iso(now - timedelta(minutes=5))},
        now, prior,
    )
    check("unchanged task + advanced last_heartbeat + not idle -> stale_task_streak True",
          same_task_advanced_hb["stale_task_streak"], True)
    check("stale-task streak -> alarm True", same_task_advanced_hb["alarm"], True)

    # Same shape, but status is idle -- must NOT alarm (explicit exception in the rule).
    idle_case = elc.evaluate_single_heartbeat(
        "x.md",
        {"thread_id": "cnem", "status": "idle",
         "current_task": "wave1 gh-1438/gh-1500a/gh-1509b", "tasks_completed": "3",
         "last_heartbeat": iso(now - timedelta(minutes=5))},
        now, prior,
    )
    check("unchanged task but status=idle -> no stale-task alarm", idle_case["stale_task_streak"], False)

    # current_task DID change -- no streak, this is normal progress.
    progressed = elc.evaluate_single_heartbeat(
        "x.md",
        {"thread_id": "cnem", "status": "executing",
         "current_task": "wave2 gh-1600", "tasks_completed": "4",
         "last_heartbeat": iso(now - timedelta(minutes=5))},
        now, prior,
    )
    check("current_task advanced -> no stale-task streak", progressed["stale_task_streak"], False)

    # No prior state at all -- must not fabricate a streak.
    first_run = elc.evaluate_single_heartbeat(
        "x.md",
        {"thread_id": "cnem", "status": "executing",
         "current_task": "wave1 gh-1438", "tasks_completed": "0",
         "last_heartbeat": iso(now - timedelta(minutes=5))},
        now, None,
    )
    check("no prior state -> streak_measurable False", first_run["streak_measurable"], False)
    check("no prior state -> stale_task_streak False (never fabricated)", first_run["stale_task_streak"], False)

    # -------------------------------------------------------------------------------
    print("\nevaluate_heartbeats / discover_heartbeat_files -- directory-level I/O")
    # -------------------------------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        write_heartbeat(td, "hb-fresh", status="executing", current_task="gh-1",
                         tasks_completed="0", last_heartbeat=iso(now - timedelta(minutes=2)),
                         started_at=iso(now - timedelta(minutes=10)))
        write_heartbeat(td, "hb-stale", status="executing", current_task="gh-2",
                         tasks_completed="0", last_heartbeat=iso(now - timedelta(minutes=90)),
                         started_at=iso(now - timedelta(minutes=100)))
        results, err = elc.evaluate_heartbeats(td, {"heartbeats": {}}, now)
        check("directory read -> no error", err, None)
        check("directory read -> 2 heartbeats found", len(results), 2)
        by_id = {r["thread_id"]: r for r in results}
        check("hb-fresh -> not alarm", by_id["hb-fresh"]["alarm"], False)
        check("hb-stale -> alarm (TTL breach)", by_id["hb-stale"]["alarm"], True)

    missing_dir_results, missing_dir_err = elc.evaluate_heartbeats(
        "C:\\definitely\\does\\not\\exist\\anywhere", {"heartbeats": {}}, now
    )
    check("nonexistent heartbeat dir -> results is None", missing_dir_results, None)
    check("nonexistent heartbeat dir -> error is set (UNMEASURED path)", missing_dir_err is not None, True)

    with tempfile.TemporaryDirectory() as td_empty:
        empty_results, empty_err = elc.evaluate_heartbeats(td_empty, {"heartbeats": {}}, now)
        check("existing-but-empty heartbeat dir -> NOT an error", empty_err, None)
        check("existing-but-empty heartbeat dir -> 0 heartbeats, not UNMEASURED", empty_results, [])

    # -------------------------------------------------------------------------------
    print("\nState file persistence -- load_state / save_state / build_state round-trip")
    # -------------------------------------------------------------------------------
    with tempfile.TemporaryDirectory() as td:
        state_path = str(pathlib.Path(td) / "sub" / "state.json")
        state0, note0 = elc.load_state(state_path)
        check("no state file yet -> empty heartbeats dict", state0["heartbeats"], {})
        check("no state file yet -> note explains first run", "first run" in (note0 or ""), True)

        fake_results = [
            {"thread_id": "cnem", "current_task": "wave1 gh-1438", "tasks_completed": "0",
             "last_heartbeat": iso(now), "status": "executing", "reasons": []}
        ]
        new_state = elc.build_state(state0, fake_results, now)
        save_err = elc.save_state(state_path, new_state)
        check("save_state -> no error, creates parent dirs", save_err, None)
        check("state file actually exists after save", pathlib.Path(state_path).exists(), True)

        reloaded, note1 = elc.load_state(state_path)
        check("reload -> note is None (normal load)", note1, None)
        check("reload -> cnem entry round-trips", reloaded["heartbeats"]["cnem"]["current_task"], "wave1 gh-1438")

        # Corrupt the file -- must fall back cleanly, never raise.
        pathlib.Path(state_path).write_text("{not valid json", encoding="utf-8")
        corrupt_state, corrupt_note = elc.load_state(state_path)
        check("corrupt state file -> falls back to empty, does not raise", corrupt_state["heartbeats"], {})
        check("corrupt state file -> note explains fallback", "unreadable" in (corrupt_note or ""), True)

    # -------------------------------------------------------------------------------
    print("\nfetch_claude_processes -- UNMEASURED paths must never resolve to a pass")
    # -------------------------------------------------------------------------------
    procs, reason = elc.fetch_claude_processes(run=lambda *a, **k: _FakeProc(stdout="", returncode=1, stderr="boom"))
    check("nonzero pwsh exit -> processes is None (UNMEASURED)", procs, None)
    check("nonzero pwsh exit -> reason names the failure", "boom" in reason, True)

    def _raise(*a, **k):
        raise FileNotFoundError("no pwsh")
    procs2, reason2 = elc.fetch_claude_processes(run=_raise)
    check("pwsh not found -> processes is None (UNMEASURED)", procs2, None)

    procs3, reason3 = elc.fetch_claude_processes(run=lambda *a, **k: _FakeProc(stdout="not json"))
    check("unparseable pwsh output -> processes is None (UNMEASURED)", procs3, None)

    # -------------------------------------------------------------------------------
    print("\nfetch_claude_processes -- real zero is a pass, not UNMEASURED")
    # -------------------------------------------------------------------------------
    procs4, reason4 = elc.fetch_claude_processes(run=lambda *a, **k: _FakeProc(stdout="null"))
    check("pwsh returns null (AsArray, zero matches) -> [] not None", procs4, [])
    check("zero matches -> reason says so, not an error", "zero matching" in reason4, True)

    procs5, reason5 = elc.fetch_claude_processes(run=lambda *a, **k: _FakeProc(stdout="[]"))
    check("pwsh returns [] -> [] not None", procs5, [])

    single = json.dumps([{"ProcessId": 111, "ExecutablePath": r"C:\claude-code\v1\claude.exe",
                            "CreationDateUtc": iso(now - timedelta(hours=1))}])
    procs6, reason6 = elc.fetch_claude_processes(run=lambda *a, **k: _FakeProc(stdout=single))
    check("pwsh returns one matched process -> list of 1", len(procs6), 1)
    check("pwsh returns one matched process -> reason names count 1", "1 matched" in reason6, True)

    # -------------------------------------------------------------------------------
    print("\nevaluate_leaks -- matched-by-started_at is not a leak; unmatched+old is")
    # -------------------------------------------------------------------------------
    live_hb = elc.evaluate_single_heartbeat(
        "x.md",
        {"thread_id": "live1", "status": "executing", "current_task": "gh-9",
         "last_heartbeat": iso(now - timedelta(minutes=1)),
         "started_at": iso(now - timedelta(hours=3))},
        now, None,
    )
    check("sanity: live_hb is live", live_hb["live"], True)

    processes = [
        # Matches live_hb's started_at within tolerance -> not a leak even though old.
        {"ProcessId": 1, "ExecutablePath": r"C:\claude-code\v1\claude.exe",
         "CreationDateUtc": iso(now - timedelta(hours=3, minutes=1))},
        # No matching live heartbeat, and older than the leak-age threshold -> leak.
        {"ProcessId": 2, "ExecutablePath": r"C:\claude-code\v1\claude.exe",
         "CreationDateUtc": iso(now - timedelta(hours=5))},
        # No matching live heartbeat, but younger than the leak-age threshold -> not yet a leak.
        {"ProcessId": 3, "ExecutablePath": r"C:\claude-code\v1\claude.exe",
         "CreationDateUtc": iso(now - timedelta(minutes=30))},
        # Unreadable CreationDate -> reported separately, never silently dropped.
        {"ProcessId": 4, "ExecutablePath": r"C:\claude-code\v1\claude.exe", "CreationDateUtc": None},
    ]
    leak_result = elc.evaluate_leaks(processes, [live_hb], leak_age_hours=2.0, tolerance_minutes=10.0, now=now)
    leak_pids = sorted(e["pid"] for e in leak_result["leaks"])
    check("only pid 2 is a leak", leak_pids, [2])
    check("leak_count matches", leak_result["leak_count"], 1)
    check("pid 4 (unreadable CreationDate) reported in unmeasured_processes, not silently dropped",
          any(e["pid"] == 4 for e in leak_result["unmeasured_processes"]), True)

    # -------------------------------------------------------------------------------
    print("\ncompute_verdict -- UNMEASURED beats ALARM beats CLEAN")
    # -------------------------------------------------------------------------------
    clean_leak = {"leak_count": 0}
    v = elc.compute_verdict([], None, clean_leak, None)
    check("zero everything -> CLEAN", v["verdict"], "CLEAN")
    check("zero everything -> exit 0", v["code"], 0)

    v = elc.compute_verdict([], "dir unreadable", clean_leak, None)
    check("heartbeat read failure -> UNMEASURED regardless of leaks", v["verdict"], "UNMEASURED")
    check("heartbeat read failure -> exit 3", v["code"], 3)

    v = elc.compute_verdict([], None, clean_leak, "pwsh not found")
    check("process enumeration failure -> UNMEASURED", v["verdict"], "UNMEASURED")
    check("process enumeration failure -> exit 3", v["code"], 3)

    alarm_hb = [{"ttl_breach": True, "stale_task_streak": False}]
    v = elc.compute_verdict(alarm_hb, None, clean_leak, None)
    check("a TTL breach -> ALARM", v["verdict"], "ALARM")
    check("a TTL breach -> exit 2", v["code"], 2)

    v = elc.compute_verdict([], None, {"leak_count": 3}, None)
    check("leaks alone -> ALARM", v["verdict"], "ALARM")
    check("leaks alone -> exit 2", v["code"], 2)

    # -------------------------------------------------------------------------------
    print("\nprint_report -- UNMEASURED/ALARM banners loud, CLEAN is quiet; --json mirrors text")
    # -------------------------------------------------------------------------------
    def rendered(as_json, **kw):
        buf = io.StringIO()
        real = sys.stdout
        sys.stdout = buf
        try:
            elc.print_report(as_json=as_json, **kw)
        finally:
            sys.stdout = real
        return buf.getvalue()

    clean_verdict = elc.compute_verdict([], None, clean_leak, None)
    clean_text = rendered(
        False, now=now, heartbeat_results=[], heartbeat_read_error=None,
        leak_result={"considered": [], "leaks": [], "leak_count": 0, "unmeasured_processes": []},
        process_read_error=None, state_note=None, verdict_info=clean_verdict,
    )
    check("CLEAN text output does not carry an ALARM/UNMEASURED banner",
          ("NOT A PASS" in clean_text) or ("ALARM:" in clean_text), False)
    check("CLEAN text output still prints the telemetry row", "TELEMETRY ROW" in clean_text, True)

    unmeasured_verdict = elc.compute_verdict([], "heartbeat dir gone", clean_leak, None)
    unmeasured_text = rendered(
        False, now=now, heartbeat_results=[], heartbeat_read_error="heartbeat dir gone",
        leak_result={"considered": [], "leaks": [], "leak_count": 0, "unmeasured_processes": []},
        process_read_error=None, state_note=None, verdict_info=unmeasured_verdict,
    )
    check("UNMEASURED text output carries the loud banner", "NOT A PASS" in unmeasured_text, True)

    unmeasured_json = json.loads(rendered(
        True, now=now, heartbeat_results=[], heartbeat_read_error="heartbeat dir gone",
        leak_result={"considered": [], "leaks": [], "leak_count": 0, "unmeasured_processes": []},
        process_read_error=None, state_note=None, verdict_info=unmeasured_verdict,
    ))
    check("UNMEASURED --json verdict field", unmeasured_json["verdict"], "UNMEASURED")
    check("UNMEASURED --json banner carries the same loud text as text mode",
          "NOT A PASS" in (unmeasured_json["banner"] or ""), True)
    check("UNMEASURED --json still carries a telemetry_row string",
          isinstance(unmeasured_json["telemetry_row"], str) and len(unmeasured_json["telemetry_row"]) > 0, True)

    # -------------------------------------------------------------------------------
    print("\ntelemetry_row -- matches the documented scanner-telemetry.md column format")
    # -------------------------------------------------------------------------------
    row = elc.telemetry_row(now, 5, 1, 0, 2, "ALARM", "1 TTL breach(es), 2 leaked host(s)")
    check("telemetry_row has 7 pipe-delimited columns (leading/trailing pipes)", row.count("|"), 8)
    check("telemetry_row names the script", elc.SCRIPT_NAME in row, True)
    check("telemetry_row Empty? column is N for a non-CLEAN verdict", "| N |" in row, True)

    clean_row = elc.telemetry_row(now, 5, 0, 0, 0, "CLEAN", "0 breaches, 0 streaks, 0 leaks")
    check("telemetry_row Empty? column is Y for CLEAN", "| Y |" in clean_row, True)

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} assertion(s): {', '.join(FAILURES)}")
        return 1
    print("executor-liveness-check: all assertions passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
