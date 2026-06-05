#!/usr/bin/env python3
"""
OtterQuote Patch-Fatigue Detector
Scans git history for subsystem-level symptom-keyword commit accretion.
Triggers architectural review when thresholds breach.

Thresholds:
  - 3 symptom commits in 14 days -> trigger
  - 5 symptom commits in 60 days -> trigger

Usage: python3 scripts/patch-fatigue-detector.py [--dry-run] [--clickup-token TOKEN]

Token resolution order:
  1. CLICKUP_API_KEY env var (preferred - add to Doppler prd, task 86e1h1grk)
  2. CLICKUP_TOKEN env var (legacy fallback)
  3. --clickup-token CLI arg (last resort)
"""

import subprocess, json, sys, os, re
from datetime import datetime, timedelta

# --- Config ---
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUBSYSTEM_MAP = os.path.join(REPO_ROOT, "forge-config", "subsystem-map.json")

GLOBAL_SYMPTOM_KEYWORDS = [
    "fix", "hotfix", "patch", "broken", "broke", "race", "retry",
    "still broken", "revert", "again", "workaround", "hack", "temp", "temporary"
]

THRESHOLDS = [
    {"days": 14, "count": 3, "label": "3 patches in 14 days"},
    {"days": 60, "count": 5, "label": "5 patches in 60 days"},
]

CLICKUP_LIST_ID = "901711730553"

def run(cmd):
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    return result.stdout.strip()

def get_token(args):
    """Get ClickUp token from env var (preferred) or CLI arg."""
    token = os.environ.get("CLICKUP_API_KEY") or os.environ.get("CLICKUP_TOKEN")
    if token:
        return token
    for i, arg in enumerate(args):
        if arg == "--clickup-token" and i + 1 < len(args):
            return args[i + 1]
    return None

def get_git_log(since_days, file_patterns=None):
    """Get git log entries with file paths and dates."""
    since = (datetime.now() - timedelta(days=since_days)).strftime("%Y-%m-%d")
    if file_patterns:
        pattern_args = " ".join(f'"{p}"' for p in file_patterns)
        cmd = f'cd {REPO_ROOT} && git log --format="%h %ai %s" --since="{since}" --name-only -- {pattern_args}'
    else:
        cmd = f'cd {REPO_ROOT} && git log --format="%h %ai %s" --since="{since}" --name-only'
    return run(cmd)

def parse_commits(log_output):
    """Parse git log output into [{hash, date, message, files}]."""
    commits = []
    current = None
    for line in log_output.splitlines():
        if re.match(r'^[a-f0-9]{7} \d{4}-\d{2}-\d{2}', line):
            if current:
                commits.append(current)
            parts = line.split(None, 3)
            current = {
                "hash": parts[0],
                "date": parts[1] if len(parts) > 1 else "",
                "message": parts[3] if len(parts) > 3 else "",
                "files": []
            }
        elif line and current:
            current["files"].append(line)
    if current:
        commits.append(current)
    return commits

def is_symptom_commit(message, subsystem_keywords):
    """Check if a commit message contains symptom keywords.

    Commits referencing a D-number (e.g. "fix(D-237)") are deliberate decision
    corrections, not patch-fatigue symptoms — they only match the "fix" keyword
    by accident. Exclude them so the detector does not overcount intentional work.
    """
    if re.search(r'\(D-\d+\)', message):
        return False
    msg_lower = message.lower()
    all_keywords = GLOBAL_SYMPTOM_KEYWORDS + subsystem_keywords
    return any(kw.lower() in msg_lower for kw in all_keywords)

def file_matches_subsystem(filepath, file_patterns):
    """Check if a file matches a subsystem's file patterns."""
    for pattern in file_patterns:
        pat = pattern.replace("**", ".*").replace("*", "[^/]*")
        if re.search(pat, filepath):
            return True
    return False

def analyze_subsystem(subsystem, commits):
    """Count symptom commits touching a subsystem's files in time windows."""
    symptom_commits = []
    for commit in commits:
        file_match = any(
            file_matches_subsystem(f, subsystem["files"])
            for f in commit["files"]
        )
        if file_match and is_symptom_commit(commit["message"], subsystem.get("keywords", [])):
            symptom_commits.append(commit)
    return symptom_commits

def check_thresholds(symptom_commits):
    """Check if any threshold is breached based on commit dates."""
    breaches = []
    now = datetime.now()

    for threshold in THRESHOLDS:
        days = threshold["days"]
        cutoff = now - timedelta(days=days)
        count = 0
        for commit in symptom_commits:
            try:
                commit_date = datetime.fromisoformat(commit["date"])
                if commit_date >= cutoff:
                    count += 1
            except:
                count += 1

        if count >= threshold["count"]:
            breaches.append({
                "threshold": threshold["label"],
                "count": count,
                "days": days
            })

    return breaches

def find_existing_breach_task(subsystem_name, clickup_token):
    """Search ClickUp for existing open [PATCH FATIGUE] or [ARCH REVIEW] task for this subsystem."""
    import urllib.request, urllib.parse

    encoded = urllib.parse.quote(subsystem_name)
    url = (
        f"https://api.clickup.com/api/v2/list/{CLICKUP_LIST_ID}/task"
        f"?statuses%5B%5D=to+do&search={encoded}"
    )
    req = urllib.request.Request(
        url,
        headers={"Authorization": clickup_token},
        method="GET"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            tasks = result.get("tasks", [])
            for task in tasks:
                name = task.get("name", "")
                if (("[PATCH FATIGUE]" in name or "[ARCH REVIEW]" in name)
                        and subsystem_name.lower() in name.lower()):
                    return task
    except Exception as e:
        print(f"  Warning: could not search existing tasks: {e}")
    return None

def update_clickup_task(task_id, new_name, new_description, clickup_token):
    """Update an existing ClickUp task name and description in-place."""
    import urllib.request

    payload = json.dumps({
        "name": new_name,
        "description": new_description,
    }).encode()

    req = urllib.request.Request(
        f"https://api.clickup.com/api/v2/task/{task_id}",
        data=payload,
        headers={"Authorization": clickup_token, "Content-Type": "application/json"},
        method="PUT"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            return result.get("url", f"https://app.clickup.com/t/{task_id}")
    except Exception as e:
        print(f"  ClickUp update error: {e}")
        return None

def create_or_update_clickup_task(subsystem_name, breaches, patch_history, clickup_token):
    """Create a new [PATCH FATIGUE] BREACH task or update an existing one in-place."""
    if not clickup_token:
        print(f"  [DRY-RUN] Would create/update: [PATCH FATIGUE] BREACH -- {subsystem_name}")
        return None, "dry-run"

    import urllib.request

    breach_lines = "\n".join(
        f"- {b['threshold']}: {b['count']} symptom commits" for b in breaches
    )
    history_lines = "\n".join(
        f"  - {c['hash']}: {c['message']}" for c in patch_history[-10:]
    )

    description = (
        f"PATCH-FATIGUE ALERT: {subsystem_name}\n\n"
        f"Thresholds breached:\n{breach_lines}\n\n"
        f"Recent symptom commits (last 10):\n{history_lines}\n\n"
        "## Required Actions\n"
        "1. **Name the failure mode:** What is the underlying structural issue? Write it in one sentence.\n"
        "2. **Classify:** Is this (a) a design flaw needing architectural change [D-flow], "
        "(b) a process/tooling gap [R-flow], or (c) legitimate iteration on a new feature?\n"
        "3. **Route:**\n"
        "   - If architectural -> run Decision Protocol (D-flow)\n"
        "   - If process gap -> run Decision Protocol (R-flow)\n"
        "   - If legitimate iteration -> close this task with a note\n\n"
        f"Auto-updated by patch-fatigue-detector.py on {datetime.now().strftime('%Y-%m-%d')}.\n"
    )

    worst = breaches[0]
    task_name = (
        f"[PATCH FATIGUE] BREACH -- {subsystem_name} "
        f"({worst['count']} patches in {worst['days']} days)"
    )

    existing = find_existing_breach_task(subsystem_name, clickup_token)

    if existing:
        task_id = existing["id"]
        url = update_clickup_task(task_id, task_name, description, clickup_token)
        return url, "updated"

    payload = json.dumps({
        "name": task_name,
        "description": description,
        "priority": 2,
        "tags": ["patch-fatigue", "any-env", "lane-1", "sonnet"]
    }).encode()

    req = urllib.request.Request(
        f"https://api.clickup.com/api/v2/list/{CLICKUP_LIST_ID}/task",
        data=payload,
        headers={"Authorization": clickup_token, "Content-Type": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            return result.get("url", "created"), "created"
    except Exception as e:
        print(f"  ClickUp API error: {e}")
        return None, "error"

def main():
    dry_run = "--dry-run" in sys.argv
    clickup_token = None if dry_run else get_token(sys.argv)

    with open(SUBSYSTEM_MAP) as f:
        config = json.load(f)

    subsystems = config["subsystems"]

    print(f"=== Patch-Fatigue Detector ===")
    print(f"Scanning git history... {'(DRY-RUN)' if dry_run else ''}")
    print()

    max_days = max(t["days"] for t in THRESHOLDS)
    log_output = get_git_log(max_days)
    all_commits = parse_commits(log_output)

    print(f"Total commits in last {max_days} days: {len(all_commits)}")
    print()

    triggered = []
    clean = []

    for subsystem in subsystems:
        symptom_commits = analyze_subsystem(subsystem, all_commits)
        breaches = check_thresholds(symptom_commits)

        if breaches:
            print(f"BREACH: {subsystem['name']}")
            for b in breaches:
                print(f"   {b['threshold']}: {b['count']} symptom commits")
            print(f"   Recent: {', '.join(c['hash'] for c in symptom_commits[-3:])}")

            if not dry_run and clickup_token:
                url, action = create_or_update_clickup_task(
                    subsystem["name"], breaches, symptom_commits, clickup_token
                )
                print(f"   ClickUp ({action}): {url}")
            elif dry_run:
                print(f"   [DRY-RUN] Would create/update ClickUp task")

            triggered.append({
                "subsystem": subsystem["name"],
                "breaches": breaches,
                "count": len(symptom_commits)
            })
            print()
        else:
            clean.append(subsystem["name"])

    print(f"=== Summary ===")
    print(f"Breaches: {len(triggered)} subsystems")
    print(f"Clean: {len(clean)} subsystems")
    if triggered:
        print(f"Review required: {', '.join(t['subsystem'] for t in triggered)}")
    else:
        print("No architectural review needed -- patch counts within thresholds.")

    return 0 if not triggered else 1

if __name__ == "__main__":
    sys.exit(main())
