#!/usr/bin/env python3
"""patch-fatigue-detector.py — Patch Fatigue Detector for OtterQuote.

Scans git log for symptom-keyword commits by subsystem over the past 90 days.
Detects breach thresholds:
  - SHORT: 3 or more symptom-fix commits within any 14-day window per subsystem
  - LONG:  5 or more symptom-fix commits within any 60-day window per subsystem

Creates ClickUp tasks for detected breaches when --clickup-token is provided.

Usage:
    python3 scripts/patch-fatigue-detector.py [--clickup-token TOKEN] [--repo-dir DIR]

Output:
    Human-readable summary to stdout, JSON with --output-json.
    Exit code 0 = clean, 1 = breach(es) detected, 2 = error.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SYMPTOM_KEYWORDS = re.compile(
    r'\b(fix|bug|hotfix|patch|workaround|revert|repair|broken|crash|error|issue|'
    r'regression|typo|oops|wrong|missed|forgot|correct|undo)\b',
    re.IGNORECASE,
)

# Ordered most-specific first. Each entry: (regex_pattern, subsystem_name)
SUBSYSTEM_RULES: list[tuple[str, str]] = [
    (r'(?:^|/)CLAUDE\.md$', 'docs'),
    (r'(?:^|/)\.claude/commands/|slash[-_]command', 'tooling'),
    (r'netlify/edge-functions/admin', 'admin'),
    (r'netlify/edge-functions/auth-callback|js/auth\.js|auth-callback|login-gate|contractor-login|contractor-join|(?:^|/)login\.html', 'auth'),
    (r'netlify/edge-functions/create-docusign|docusign', 'contracts'),
    (r'netlify/edge-functions/send-email|mailgun|email', 'email'),
    (r'netlify/edge-functions/stripe|stripe|payment', 'payment'),
    (r'netlify/edge-functions', 'edge-functions'),
    (r'contractor', 'contractor'),
    (r'homeowner|claim-start|claimant', 'homeowner'),
    (r'sql/|supabase/migrations', 'schema'),
    (r'scripts/', 'tooling'),
    (r'\.github/', 'ci-cd'),
    (r'netlify\.toml|_redirects|_headers', 'deploy'),
    (r'\.html$|\.css$', 'frontend'),
    (r'\.js$|\.ts$|\.jsx$|\.tsx$', 'frontend'),
]

SHORT_WINDOW_DAYS = 14
SHORT_BREACH_THRESHOLD = 3
LONG_WINDOW_DAYS = 60
LONG_BREACH_THRESHOLD = 5

CLICKUP_LIST_ID = "901711730553"
CLICKUP_API_ROOT = "https://api.clickup.com/api/v2"

# ---------------------------------------------------------------------------
# Subsystem detection
# ---------------------------------------------------------------------------


def classify_path(file_path: str) -> str:
    """Return the subsystem name for a given file path."""
    for pattern, name in SUBSYSTEM_RULES:
        if re.search(pattern, file_path, re.IGNORECASE):
            return name
    return 'other'


def classify_paths(file_paths: list[str]) -> set[str]:
    """Return all subsystems touched by a list of file paths."""
    return {classify_path(p) for p in file_paths} if file_paths else {'other'}


# ---------------------------------------------------------------------------
# Git log parsing
# ---------------------------------------------------------------------------


def get_commits(repo_dir: str, days: int) -> list[dict[str, Any]]:
    """Return commits from the last N days with metadata and files changed."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%Y-%m-%d')

    log_result = subprocess.run(
        ['git', 'log', f'--since={since}', '--format=%H|%at|%s', '--no-merges'],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if log_result.returncode != 0:
        raise RuntimeError(f"git log failed: {log_result.stderr.strip()}")

    commits: list[dict[str, Any]] = []
    for line in log_result.stdout.strip().splitlines():
        if not line.strip():
            continue
        parts = line.split('|', 2)
        if len(parts) < 3:
            continue
        sha, timestamp_str, subject = parts
        try:
            ts = datetime.fromtimestamp(int(timestamp_str), tz=timezone.utc)
        except (ValueError, OverflowError):
            continue

        files_result = subprocess.run(
            ['git', 'diff-tree', '--no-commit-id', '-r', '--name-only', sha],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=30,
        )
        file_paths = [f for f in files_result.stdout.strip().splitlines() if f]

        commits.append({
            'sha': sha[:12],
            'timestamp': ts,
            'subject': subject,
            'file_paths': file_paths,
        })

    return commits


# ---------------------------------------------------------------------------
# Breach detection
# ---------------------------------------------------------------------------


def is_symptom_commit(subject: str) -> bool:
    """Return True if the commit subject contains symptom keywords."""
    return bool(SYMPTOM_KEYWORDS.search(subject))


def detect_breaches(commits: list[dict]) -> dict[str, list[dict]]:
    """Detect patch fatigue breaches by subsystem using sliding-window analysis.

    Returns: dict mapping subsystem -> list of breach report dicts.
    """
    symptom_commits = [c for c in commits if is_symptom_commit(c['subject'])]

    # Group by subsystem
    by_subsystem: dict[str, list[dict]] = defaultdict(list)
    for commit in symptom_commits:
        for sub in classify_paths(commit['file_paths']):
            by_subsystem[sub].append(commit)

    breaches: dict[str, list[dict]] = {}

    for subsystem, sub_commits in by_subsystem.items():
        sorted_commits = sorted(sub_commits, key=lambda c: c['timestamp'])
        sub_breaches: list[dict] = []

        for window_days, threshold, breach_type in [
            (SHORT_WINDOW_DAYS, SHORT_BREACH_THRESHOLD, 'SHORT'),
            (LONG_WINDOW_DAYS, LONG_BREACH_THRESHOLD, 'LONG'),
        ]:
            for i, c in enumerate(sorted_commits):
                window_end = c['timestamp'] + timedelta(days=window_days)
                window_commits = [
                    x for x in sorted_commits[i:]
                    if x['timestamp'] <= window_end
                ]
                if len(window_commits) >= threshold:
                    sub_breaches.append({
                        'type': breach_type,
                        'window_days': window_days,
                        'threshold': threshold,
                        'count': len(window_commits),
                        'window_start': c['timestamp'].isoformat(),
                        'window_end': window_end.isoformat(),
                        'commits': [x['sha'] for x in window_commits],
                        'subjects': [x['subject'] for x in window_commits],
                    })
                    break  # One breach report per type per subsystem is enough

        if sub_breaches:
            breaches[subsystem] = sub_breaches

    return breaches


# ---------------------------------------------------------------------------
# ClickUp integration
# ---------------------------------------------------------------------------


def create_clickup_task(token: str, subsystem: str, breach: dict) -> str | None:
    """Create a ClickUp task for a detected patch fatigue breach."""
    try:
        import urllib.request
        import urllib.error

        breach_type = breach['type']
        count = breach['count']
        window = breach['window_days']
        threshold = breach['threshold']

        name = (
            f"[PATCH FATIGUE] {subsystem} — "
            f"{count} symptom-commits in {window} days "
            f"({breach_type}: threshold {threshold})"
        )

        subjects_preview = '\n'.join(f'  - {s}' for s in breach['subjects'][:5])
        if len(breach['subjects']) > 5:
            subjects_preview += f'\n  ... and {len(breach["subjects"]) - 5} more'

        description = (
            f"Patch Fatigue Detector — {breach_type} Breach\n\n"
            f"Subsystem: {subsystem}\n"
            f"Window: {window} days ({breach_type} threshold: {threshold})\n"
            f"Detected: {count} symptom-fix commits\n"
            f"Period: {breach['window_start'][:10]} to {breach['window_end'][:10]}\n\n"
            f"Commits involved:\n{subjects_preview}\n\n"
            f"SHAs: {', '.join(breach['commits'][:10])}\n\n"
            f"Action Required\n\n"
            f"The {subsystem} subsystem shows repeated symptom-fix commits. "
            f"This pattern suggests an unresolved root cause. "
            f"Schedule a root-cause investigation rather than continuing to patch."
        )

        payload = json.dumps({
            "name": name,
            "description": description,
            "priority": 2,
            "tags": ["patch-fatigue"],
        }).encode()

        req = urllib.request.Request(
            f"{CLICKUP_API_ROOT}/list/{CLICKUP_LIST_ID}/task",
            data=payload,
            headers={
                "Authorization": token,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            task_data = json.loads(resp.read())
            task_id = task_data.get("id")
            sys.stderr.write(f"[patch-fatigue-detector] Created ClickUp task {task_id}: {name}\n")
            return task_id

    except Exception as exc:
        sys.stderr.write(f"[patch-fatigue-detector] WARNING: ClickUp task creation failed: {exc}\n")
        return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Patch Fatigue Detector for OtterQuote — scans git log for recurring symptom-fix commits"
    )
    parser.add_argument(
        '--clickup-token',
        help='ClickUp API token for creating breach tasks',
        default=os.environ.get('CLICKUP_TOKEN'),
    )
    parser.add_argument(
        '--repo-dir',
        help='Path to the git repository root (default: current directory)',
        default='.',
    )
    parser.add_argument(
        '--output-json',
        action='store_true',
        help='Output results as JSON instead of human-readable format',
    )
    args = parser.parse_args()

    repo_dir = os.path.abspath(args.repo_dir)

    if not os.path.isdir(os.path.join(repo_dir, '.git')):
        sys.stderr.write(f"[patch-fatigue-detector] ERROR: {repo_dir} is not a git repository\n")
        return 2

    sys.stderr.write(f"[patch-fatigue-detector] Scanning git log (last 90 days) in {repo_dir}...\n")

    try:
        commits = get_commits(repo_dir, days=90)
    except Exception as exc:
        sys.stderr.write(f"[patch-fatigue-detector] ERROR: Failed to read git log: {exc}\n")
        return 2

    symptom_count = sum(1 for c in commits if is_symptom_commit(c['subject']))
    sys.stderr.write(
        f"[patch-fatigue-detector] Scanned {len(commits)} commits, "
        f"{symptom_count} matched symptom keywords.\n"
    )

    breaches = detect_breaches(commits)

    result: dict[str, Any] = {
        "scan_date": datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        "repo_dir": repo_dir,
        "commits_scanned": len(commits),
        "symptom_commits": symptom_count,
        "breaches": breaches,
        "status": "BREACH" if breaches else "CLEAN",
    }

    if args.output_json:
        print(json.dumps(result, default=str, indent=2))
    else:
        sep = '=' * 60
        print(f"\n{sep}")
        print(f"PATCH FATIGUE DETECTOR — {result['status']}")
        print(sep)
        print(f"Scan date:        {result['scan_date'][:10]}")
        print(f"Commits scanned:  {result['commits_scanned']}")
        print(f"Symptom commits:  {result['symptom_commits']}")

        if not breaches:
            print("\n✓ No patch fatigue breaches detected.")
        else:
            print(f"\n⚠  BREACHES DETECTED — {len(breaches)} subsystem(s)\n")
            for subsystem, sub_breaches in sorted(breaches.items()):
                for breach in sub_breaches:
                    print(
                        f"  [{breach['type']}] {subsystem}: "
                        f"{breach['count']} commits in {breach['window_days']} days "
                        f"(threshold: {breach['threshold']})"
                    )
                    print(
                        f"    Window: {breach['window_start'][:10]} → "
                        f"{breach['window_end'][:10]}"
                    )
                    for subject in breach['subjects'][:3]:
                        print(f"    • {subject}")
                    if len(breach['subjects']) > 3:
                        print(f"    ... and {len(breach['subjects']) - 3} more")
                    print()

        print(sep)

    # Create ClickUp tasks for detected breaches
    if breaches and args.clickup_token:
        sys.stderr.write(
            f"[patch-fatigue-detector] Creating ClickUp tasks for {len(breaches)} breach(es)...\n"
        )
        created = 0
        for subsystem, sub_breaches in breaches.items():
            for breach in sub_breaches:
                if create_clickup_task(args.clickup_token, subsystem, breach):
                    created += 1
        sys.stderr.write(f"[patch-fatigue-detector] Created {created} ClickUp task(s).\n")
    elif breaches and not args.clickup_token:
        sys.stderr.write(
            "[patch-fatigue-detector] NOTE: Breaches detected but no --clickup-token provided. "
            "Pass --clickup-token TOKEN to auto-create ClickUp tasks.\n"
        )

    return 1 if breaches else 0


if __name__ == '__main__':
    sys.exit(main())
