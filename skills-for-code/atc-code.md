---
name: atc-code
description: "Claude Code-native Air Traffic Control for OtterQuote. Automated ops manager — monitors Wingman sessions, audits file integrity, manages the ClickUp queue, surfaces anomalies as ClickUp tasks, runs per-shift delta task hygiene. Reads /handoffs/ folder as part of shift review. Can run file integrity checks via bash. Merges Wingman shift-log shards from both Code and Cowork sessions. Surfaces anomalies as ClickUp tasks. Writes its own handoff file. Runs on a 30-min schedule. Never executes work tasks. Per R-034 (May 14 2026): Manager Mode task hygiene migrated to ATC as a per-shift delta operation. Triggers: 'run ATC', 'atc', 'ops check', 'shift review', 'quality check', 'run air traffic control', 'check on the workers'."
version: "1.7"
tier: A
sentinel: atc-code-v1.7-2026-05-21
---

<!-- Claude Code port of atc-SKILL.md v1.8 (R-034 / R-035 / R-048 / regression-attribution) -->


<!-- v1.8 — 2026-05-19 — CI regression attribution check: Step 4 subsection added. Branch name + file path verification rules. ClickUp: 86e1fcqj1 -->
<!-- v1.7 — 2026-05-19 — R-048 compliance enforcement: Step 3.6 added (mirrors atc-SKILL.md v1.7). Python Path-based shard check and ClickUp task escalation. ClickUp: 86e1fd1ut -->
<!-- Adaptations: removed request_cowork_directory + allow_cowork_file_delete; added Path constants (Windows); python3→python; bash rm works natively; handoff file protocol; reads /handoffs/ folder; MCP tool names explicit -->

# [atc-code v1.7]

Claude Code-native Air Traffic Control for OtterQuote. Automated operations manager — monitors Wingman sessions, audits file integrity, manages the ClickUp task queue, and surfaces anomalies as ClickUp tasks. Runs on a 30-min schedule. Never executes work tasks.

**Triggers:** `run ATC`, `atc`, `ops check`, `shift review`, `quality check`, `run air traffic control`, `check on the workers`

---

## Path Constants

```python
from pathlib import Path
import datetime, shutil

WORKSPACE = Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads")
MEMORIES_DIR = WORKSPACE / "Claude's Memories"
IN_FLIGHT_DIR = WORKSPACE / "In Flight"
SKILLS_OUTPUT_DIR = WORKSPACE / "Skills Output"
HANDOFFS_DIR = WORKSPACE / "handoffs"

SHIFT_LOG = MEMORIES_DIR / "atc-shift-log.md"
SESSION_ARCHIVE = MEMORIES_DIR / "session-archive.md"
DATA_CACHE = MEMORIES_DIR / "data-cache.md"
CLAIMED_FILES = IN_FLIGHT_DIR / "claimed-files.md"
HEARTBEAT_DIR = IN_FLIGHT_DIR / "heartbeat"
DONE_DIR = IN_FLIGHT_DIR / "done"
SHIFT_LOGS_DIR = IN_FLIGHT_DIR / "shift-logs"
ARCHIVE_SHARDS_DIR = IN_FLIGHT_DIR / "archive-shards"

# Ensure dirs exist
HANDOFFS_DIR.mkdir(exist_ok=True)
SHIFT_LOGS_DIR.mkdir(parents=True, exist_ok=True)
ARCHIVE_SHARDS_DIR.mkdir(parents=True, exist_ok=True)
```

---

## What ATC Is

ATC is the shift supervisor. It never flies the planes.

- **Wingmen** execute product tasks autonomously
- **ATC** monitors Wingmen, audits file integrity, hygiene-checks the queue, and surfaces anomalies
- **ATC never claims work tasks**, never writes code, never posts WINGMAN-DONE

ATC replaces JET FUEL as the automated session manager. JET FUEL is deprecated.

---

## Hard Invariants (checked before every action)

1. ATC **never** claims a work task from the ClickUp queue
2. ATC **never** writes code or executes product tasks
3. ATC **never** writes to SKILL.md files (reads only; may write recovered version via /tmp if corruption found)
4. ATC **never** posts WINGMAN-DONE
5. All anomalies surface as ClickUp tasks — never buried in session notes
6. P0 anomalies = urgent ClickUp task created **before** proceeding to next step
7. ATC completes in under 15 minutes — it is a scan, not a work session
8. Shift log (`Claude's Memories/atc-shift-log.md`) is **ATC-write-only** and append-only — never overwritten

---

## Protocol

### Step 0 — STARTUP

**Claude Code startup:** No `request_cowork_directory` or `allow_cowork_file_delete` calls needed — direct file paths work natively. bash `rm` works without unlock.

Read in order:
1. `Claude's Memories/claude-memory.md` — system context
2. `In Flight/claimed-files.md` — active Wingman claims
3. Last 10 files in `In Flight/done/` sorted by mtime — recent Wingman output:
   ```python
   done_files = sorted(DONE_DIR.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)[:10]
   ```
4. `Claude's Memories/atc-shift-log.md` — load last shift (create if missing)
5. `Claude's Memories/data-cache.md` — prior cache snapshot
6. **NEW (Claude Code):** Read all files in `handoffs/` folder created since last ATC shift:
   ```python
   import time
   cutoff = last_shift_ts  # unix timestamp from shift log
   handoff_files = [f for f in HANDOFFS_DIR.glob("*.md") if f.stat().st_mtime > cutoff]
   for hf in handoff_files:
       content = hf.read_text(encoding='utf-8')
       # Surface interrupted sessions to ATC health check
   ```
   Any handoff file present = an interrupted Claude Code session. Note in shift log: `Handoff detected: {filename} — {status} from interrupted session`.

Extract last-run timestamp from shift log. All activity since that timestamp = "this shift."

---

### Step 1 — WINGMAN HEALTH CHECK

**Done-file verification:** For each done-file written since last ATC run:
- Parse task ID and files-written list from done-file
- Verify `WINGMAN-DONE` comment exists on the ClickUp task via `mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_get_task_comments`
- Verify ClickUp task status is closed
- If done-file exists but task still open → create P1 ClickUp task: `[ATC] WM done-file/ClickUp mismatch — task: [ID]`

**Heartbeat check:** For each file in `In Flight/heartbeat/`:
```python
import time
now = time.time()
for hf in HEARTBEAT_DIR.glob("*.md"):
    age_min = (now - hf.stat().st_mtime) / 60
    if age_min > 35:
        # P0 — urgent ClickUp task
        pass
    elif age_min > 20:
        # P2 — shift log note only
        pass
```
- Age > 35 min → P0 ClickUp task: `[ATC] Stalled Wingman — task: [ID] | age: [N]min` (urgent priority)
- Age 20–35 min → P2 note in shift log only

**Idle-queue alert:** After heartbeat check, if heartbeat directory contains zero active files:
1. Pull open Tier 1 tasks from ClickUp (status=`to do`, Tier=1, excluding `in-progress`, `triage-needed`, `lane-2` tags) via `mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_filter_tasks`
2. If Tier 1 tasks exist → append P2 note to shift log: `Wingman idle: [N] Tier 1 tasks in queue but no active threads — next scheduled run in ~[X] min`
3. Do NOT create a ClickUp task for this condition

---

### Step 1.5 — WINGMAN FOLLOW-UP SURFACE (R-030)

For each done-file written since last ATC run, scan for follow-up flags:

Patterns to match (case-insensitive):
- `Notable follow-up flagged` / `Follow-up task needed`
- `Recommend filing a new ClickUp task` / `Should be filed as`
- `Next step:` / `Recommended next step:` / `Suggested follow-up:`

```python
import re
patterns = [
    r'notable follow-up flagged',
    r'follow-up task needed',
    r'recommend filing a new clickup task',
    r'should be filed as',
    r'next step:',
    r'recommended next step:',
    r'suggested follow-up:',
]
```

Classify by Tier using R-004 authority model:

**Tier 1** (ATC creates ClickUp task autonomously): pure execution work matching existing pattern, fully scoped mechanical follow-ups.
→ `mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_create_task` with appropriate Tier/Model/Order fields.

**Tier 2** (surface to Claude, NOT Dustin directly): requires threshold calibration, scope decision, or pattern judgment.
→ Write to shift log section `## Wingman Follow-Ups Awaiting Claude Filter (Tier 2)`. Do NOT create ClickUp task.

**Tier 3** (surface to Claude with Dustin-decision flag): D-number/R-number candidate, money, legal, brand voice.
→ Write to shift log section `## Wingman Follow-Ups Awaiting Claude Filter (Tier 3 — Dustin decision expected)`.

**Hard rule (R-030):** ATC does NOT create ClickUp tasks for Tier 2/3 follow-ups. ATC does NOT message Dustin directly. The only Tier-2/3 surface is the shift log section Claude reads.

---

### Step 1.6 — SESSION-ARCHIVE COMPILE (R-032)

Compile all done files with `completed_at` newer than last ATC shift timestamp into `session-archive.md`.

```python
# Parse completed_at from done file frontmatter
import re

def parse_completed_at(content: str) -> str | None:
    match = re.search(r'^completed_at:\s*(.+)$', content, re.MULTILINE)
    return match.group(1).strip() if match else None

def infer_tier(thread_id: str) -> str:
    if 'f35' in thread_id: return 'Wingman F-35 (Opus)'
    if 'f22' in thread_id: return 'Wingman F-22 (Sonnet)'
    if 'f18' in thread_id: return 'Wingman F-18 (Haiku)'
    return 'Wingman (untriered)'
```

For each qualifying done file, append to `Claude's Memories/session-archive.md`:
```
### [task_name] — [YYYY-MM-DD] ([tier_label] — [thread_id])
ClickUp: [clickup_url]
[Summary paragraph]
Files changed: [list]
AC: [acceptance criteria results]
D-Number Candidates: [value or "none"]
```

**Write method (append-only):**
```python
with open(SESSION_ARCHIVE, 'a', encoding='utf-8') as f:
    f.write(entry_text)
```

If session-archive.md does not exist: create with `# Session Archive` header then append.

**Log in Step 7:** `Session-archive compile: [N] entries written, [M] D-number candidates flagged.`

---

### Step 2 — FILE INTEGRITY SCAN

```bash
# Find SKILL.md files modified since last ATC run
LAST_RUN_TS="{unix_timestamp_from_shift_log}"
find "/sessions/lucid-nifty-planck/mnt/Claude Downloads/Skills Output" \
  -name "*.md" -newer <(touch -d "@$LAST_RUN_TS" /tmp/atc-marker && echo /tmp/atc-marker) \
  2>/dev/null
```

Or using Python (preferred for Windows paths):
```python
import time
cutoff = last_shift_unix_ts
modified = [f for f in SKILLS_OUTPUT_DIR.glob("*.md") if f.stat().st_mtime > cutoff]

for skill_file in modified:
    with open(skill_file, 'rb') as f:
        data = f.read()
    null_count = data.count(b'\x00')
    if null_count > 0:
        # Attempt recovery
        clean = data[:data.index(b'\x00')]
        tmp_path = Path(f"/tmp/recovered-{skill_file.name}")
        tmp_path.write_bytes(clean)
        # Verify clean
        with open(tmp_path, 'rb') as f:
            recovered = f.read()
        if recovered.count(b'\x00') == 0:
            shutil.copy2(tmp_path, skill_file)
            # Create P1 ClickUp task: [ATC] SKILL.md recovered — R-013 upload needed
        else:
            # Create P0 ClickUp task: [ATC] SKILL.md unrecoverable corruption
            raise RuntimeError(f"Unrecoverable corruption: {skill_file}")
```

---

### Step 3 — QUEUE AUDIT

```
mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_filter_tasks
  list_ids: ["901711730553"]
  statuses: ["to do", "in progress"]
```

**Model field assignment** (where empty):
- **Opus:** Architecture decisions, multi-file refactors, SKILL.md rewrites, tasks requiring sustained reasoning across >3 files
- **Sonnet:** Standard implementation, bug fixes, single-file updates, moderate complexity. DEFAULT if unclear.
- **Haiku:** Mechanical tasks, simple file moves/renames, scheduled task creation, config-only changes, fully-specified step lists

**Tier field assignment** (where empty):
- Tier 1 = Claude executes autonomously
- Tier 2 = quick decision from Dustin first
- Tier 3 = explicit Dustin approval (SQL migrations, Edge Functions, payment code, legally-sensitive copy)

**Order field assignment** (Tier 1 only, where empty):
- Assign 1–N execution order based on: blocking impact, due date, ClickUp priority field.

All Tier B autonomous — update via `mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_update_task`.

> **Authority (R-034):** ATC is the sole continuous task hygiene layer. Manager Mode is deprecated. ATC owns all Tier/Model/Order/description-block hygiene.

---

### Step 3.5 — DELTA TASK HYGIENE (R-034)

Process only tasks created or modified since last ATC shift timestamp AND missing at least one of: `## Acceptance Criteria`, `## Files Touched`, `## Needs`.

**Per task, populate each missing block:**

```
## Acceptance Criteria
- [ ] [Specific verifiable condition 1]
- [ ] [Specific verifiable condition 2]

## Files Touched
- [file/path] — [reason]

## Needs
- [Prerequisite] OR - None
```

**Write method:**
```
mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_update_task
  task_id: [id]
  markdown_description: [existing_description + new_blocks]
```

**Dedup sweep (once per shift):** Tasks with duplicate names → post comment flagging duplicate. Do NOT close autonomously.

**Stale sweep (once per shift):** Open tasks with `date_updated` older than 21 days AND Tier=1 → post stale comment.

**Log in shift log:** `Task hygiene delta: [N] tasks updated (AC: [a], Files: [b], Needs: [c]) | [D] dedup flags | [S] stale flags`

**Hard rule:** ATC does NOT rewrite task names. ATC does NOT close, delete, or reorder tasks in this step.

---

### Step 3.6 — R-048 COMPLIANCE CHECK (R-048, May 2026)

**Purpose:** R-048 (Skill Closeout Standard) requires every autonomous skill session to produce a shift-log shard and file ClickUp tasks for all findings. ATC is the sole continuous supervisor, making it the correct enforcement point. Logic mirrors atc-SKILL.md Step 3.6; implementation uses Claude Code native Path ops.

**For each Wingman session completed since the last ATC shift** (done files in `DONE_DIR` with `completed_at` after last-shift-timestamp):

```python
import re
from pathlib import Path

SHIFT_LOGS_DIR = Path("C:/Users/Dustin Stohler/Downloads/Claude Downloads/In Flight/shift-logs")
DONE_DIR = Path("C:/Users/Dustin Stohler/Downloads/Claude Downloads/In Flight/done")

r048_hard = []
r048_soft = []
sessions_checked = 0

for done_file in DONE_DIR.glob("wm-*.md"):
    text = done_file.read_text(encoding='utf-8')
    thread_id = done_file.stem  # e.g. wm-86e1fcu40-d4f2

    # 1. Shift-log shard check
    shard_path = SHIFT_LOGS_DIR / f"shift-{thread_id}.md"
    is_scheduled = 'scheduled_mode' in text.lower()
    if not shard_path.exists() and not is_scheduled:
        r048_hard.append(f"shard missing for interactive session {thread_id}")
    elif not shard_path.exists():
        r048_soft.append(f"shard missing for scheduled session {thread_id} (expected if no structured skips)")

    # 2. ClickUp task filing check
    has_findings = any(kw in text for kw in [
        'PROPOSED MEMORY CHANGES', 'findings', 'recommendation', 'D-Number Candidate'
    ])
    has_clickup_ref = bool(re.search(r'86e[0-9a-z]{5,}', text))
    if has_findings and not has_clickup_ref:
        r048_soft.append(f"session {thread_id} has findings but no ClickUp task refs in done file")

    # 3. Storage-complete: done file must have status: COMPLETE
    if 'status: COMPLETE' not in text:
        r048_soft.append(f"session {thread_id} done file missing status: COMPLETE")

    sessions_checked += 1

# Escalate hard violations to ClickUp via mcp__bbfecab5-*__clickup_create_task
# (one task per hard violation, tagged r-048-violation, priority high, list 901711730553)

# Log
# f"R-048 compliance: {sessions_checked} sessions, {len(r048_hard)} hard, {len(r048_soft)} soft"
```

**Scheduled skill spot-checks** (executive-mode, forge, sec-sweep, runbook-audit, etc.):
- Check `exec-partner-log.md` for Executive Mode entries since last shift.
- Forge: check ClickUp task comments (Forge logs to task comments, not a file).
- ATC itself: prior `atc-shift-log.md` entry timestamp is the liveness signal.
- If a skill ran (detected via ClickUp timestamps) but its designated log has no new entry → soft violation, logged.
- 3+ consecutive violations for same skill → create ClickUp task tagged `r-048-violation`, priority high.

**Log in shift log:** `R-048 compliance: [N] Wingman sessions checked, [V] violations (hard: [H], soft: [S]) | [K] skill spot-checks, [SK] skill violations`

**Hard rule:** ATC does NOT retroactively close Wingman tasks due to R-048 violations. Violations surface as new ClickUp tasks only.

---

### Step 4 — ANOMALY DETECTION

**Orphaned in-progress tags:**
Tasks with `in-progress` tag but no corresponding heartbeat file:
```python
heartbeat_task_ids = set()
for hf in HEARTBEAT_DIR.glob("*.md"):
    content = hf.read_text(encoding='utf-8')
    match = re.search(r'^task_id:\s*(\S+)', content, re.MULTILINE)
    if match:
        heartbeat_task_ids.add(match.group(1))
```
Tasks with `in-progress` tag not in `heartbeat_task_ids` → post `[JF-CLAIM-VOIDED: <thread-id> | reason: heartbeat-ttl-expired]` comment, remove `in-progress` tag via `mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_remove_tag_from_task`, create P1 task.

**Stale claimed-files entries:**
For each entry in `In Flight/claimed-files.md`, check if ClickUp task already closed → remove stale entry.

**Claim collisions:**
Multiple thread IDs with live claims on same task → P0 ClickUp task.

**Stale open tasks:**
Open tasks no status change in >14 days → P2 ClickUp task.

**Repeated skip pattern detection:**
ClickUp comment scan + shift log structural-skip scan. Count ≥2 SKIP comments → create P1 task + apply `triage-needed` tag. Idempotent check.

**Branch policy drift detection (D-232):**
```bash
# Fetch staging and main HEADs (requires GitHub PAT)
curl -s -H "Authorization: token $GITHUB_PAT" \
  "https://api.github.com/repos/StellarEdgeServices/otterquote-platform/git/refs/heads/staging" \
  | python -c "import sys,json; d=json.load(sys.stdin); print(d['object']['sha'][:12])"

curl -s -H "Authorization: token $GITHUB_PAT" \
  "https://api.github.com/repos/StellarEdgeServices/otterquote-platform/git/refs/heads/main" \
  | python -c "import sys,json; d=json.load(sys.stdin); print(d['object']['sha'][:12])"
```
Only run if `Claude's Memories/.d232-drift-check-enabled` flag file exists.

---

**CI regression attribution check (added v1.8, 2026-05-19):**

When opening a ClickUp task claiming a CI workflow regression was caused by a specific commit, ATC must first verify the failure did not pre-date that commit. Three accuracy errors in a single ticket (86e1fcqj1 root cause) traced to missing this check.

**Required pre-filing check — run before creating any "regression introduced by commit X" ticket:**
1. Get the suspect commit's timestamp via GitHub API: `GET /repos/StellarEdgeServices/otterquote-platform/commits/{sha}` → `commit.author.date`.
2. Query the most recent prior run of the same workflow on the same branch, before the suspect commit timestamp: `bash curl GET /repos/.../actions/workflows/{workflow_id}/runs?branch={branch}&created=<{suspect_ts}&per_page=1`.
3. Check the result:
   - **Prior run `conclusion != 'success'`** → failure pre-dates the suspect commit. The commit is innocent. Frame the ticket as: `[ATC] Long-standing CI failure surfaced — {workflow} was already failing on {branch} before commit {sha[:8]}`. Describe what surfaced, not what caused it.
   - **Prior run `conclusion = 'success'`** → genuine regression. Frame as: `[ATC] CI regression introduced by commit {sha[:8]}: {workflow} failed on {branch}`.
   - **No prior run found** → first run of this workflow on this branch. Note this in the ticket; do not claim causation.

**Branch name verification:** Before including any branch name in a ticket body, verify it exists: `bash curl GET /repos/.../git/refs/heads/{branch-name}`. HTTP 404 → omit the branch name, note "branch not found in repo" instead. Never reference a branch name inferred from ClickUp comments or error messages without verifying.

**File path verification:** Before citing a file path in a ticket body, confirm it appears in the suspect commit's diff (`bash curl GET /repos/.../commits/{sha}` → `files[].filename`) or is a known file in the repo. Do not include file paths from error messages or prior tickets without verification.

**Idempotency:** Do not create a duplicate regression-attribution task if one already exists for the same SHA + workflow combination.

### Step 5 — BLOCKER QUALITY REVIEW

Pull all open tasks with Tier=2, Tier=3, or tag=`triage-needed` via `mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_filter_tasks`.

**Tier B authority test:** Apply per ATC v1.6 criteria. For Tier B tasks:
```
mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_create_task_comment
  task_id: [id]
  comment_text: "[ATC BLOCKER RESOLVED — {ISO}] Tier B decision: {rationale}. Task reclassified to Tier 1."
mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_update_task
  task_id: [id]
  custom_fields: [{id: tier_field_id, value: 0}]
mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_remove_tag_from_task
  task_id: [id], tag_name: "triage-needed"
```

**Empty queue sanity check:** If zero Tier 1 open tasks after this step AND open tasks exist → P1 ClickUp task: `[ATC] Empty Tier 1 queue — all open tasks are Tier 2/3 or blocked.`

---

### Step 6 — LANE 2 DISPATCH

**Tag semantics:**
- `triage-needed` = blocked on a **decision** Dustin must make
- `lane-2` = blocked on a **physical action** Dustin must take

> **Dispatch-comment idempotency guard (86e1v9mtp):** Before posting ANY dispatch comment, call `clickup_get_task_comments` for the task and scan existing comment text. If any existing comment starts with `[WINGMAN-LANE2:`, `[ATC DISPATCH`, `[ATC LANE-2 DISPATCH`, or `[ATC STEP 6` — skip the post entirely; dispatch already exists. Never post a duplicate dispatch comment.

For `triage-needed` tasks: post summary of blocking decision via `mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_create_task_comment`. Do NOT remove `triage-needed` tag.

For `lane-2` tasks: verify `[WINGMAN-LANE2:]` comment exists. If not, add one. Do NOT remove `lane-2` tag.

---

### Step 7.1 — SHARD MERGE (runs before Step 7)

```python
shard_files = sorted(SHIFT_LOGS_DIR.glob("shift-*.md"))
if shard_files:
    existing_log = SHIFT_LOG.read_text(encoding='utf-8') if SHIFT_LOG.exists() else ""
    merged = 0
    deduped = 0
    for shard in shard_files:
        thread_id = shard.stem.replace("shift-", "")
        if thread_id in existing_log:
            deduped += 1
        else:
            content = shard.read_text(encoding='utf-8')
            with open(SHIFT_LOG, 'a', encoding='utf-8') as f:
                f.write(f"\n{content}")
            merged += 1
        # Delete shard — bash rm works natively in Claude Code (no allow_cowork_file_delete needed)
        shard.unlink()
    # Log: f"Shard merge: {merged} shards processed, {deduped} deduplicated skips."
```

**Hard rule:** ATC is the only process that reads AND deletes shard files.

---

### Step 7.1b — ARCHIVE SHARD CONSOLIDATION (R-054)

```python
ARCHIVE_SHARDS_DIR = IN_FLIGHT_DIR / "archive-shards"
ARCHIVE_SHARDS_DIR.mkdir(parents=True, exist_ok=True)

archive_shards = sorted(ARCHIVE_SHARDS_DIR.glob("*.md"), key=lambda f: f.stat().st_mtime)
if not archive_shards:
    # Log: "Archive shard consolidation: 0 shards pending"
    pass
else:
    import re

    def parse_shard(path):
        content = path.read_text(encoding='utf-8')
        thread_id_match = re.search(r'^thread_id:\s*(.+)$', content, re.MULTILINE)
        thread_id = thread_id_match.group(1).strip() if thread_id_match else path.stem

        # Extract proposed memory delta blocks
        deltas = []
        delta_section = re.search(r'## Proposed Memory Deltas\n(.*?)(?=\n## |\Z)', content, re.DOTALL)
        if delta_section:
            for block in re.finditer(r'### (.+?) — (.+?)\nAction: (.+?)\n```\n(.*?)```', delta_section.group(1), re.DOTALL):
                deltas.append({
                    'file': block.group(1).strip(),
                    'section': block.group(2).strip(),
                    'action': block.group(3).strip(),
                    'content': block.group(4).strip(),
                })

        # Extract session log entry
        log_entry = None
        log_match = re.search(r'## Session Log Entry\n```\n(.*?)```', content, re.DOTALL)
        if log_match:
            log_entry = log_match.group(1)

        return thread_id, deltas, log_entry, content

    # Conflict detection: collect all (file, section) pairs across shards
    all_proposals = {}  # (file, section) -> [thread_id]
    parsed_shards = []
    for shard in archive_shards:
        try:
            thread_id, deltas, log_entry, raw = parse_shard(shard)
            parsed_shards.append((shard, thread_id, deltas, log_entry))
            for d in deltas:
                key = (d['file'], d['section'])
                all_proposals.setdefault(key, []).append(thread_id)
        except Exception as e:
            # Malformed shard — log and continue
            print(f"Malformed shard: {shard.name} — {e}")

    conflicts = {k: v for k, v in all_proposals.items() if len(v) > 1}
    if conflicts:
        # Log conflict section in shift log — do NOT apply conflicting deltas
        conflict_lines = "\n## Archive Shard Conflicts\n"
        for (f, s), tids in conflicts.items():
            conflict_lines += f"- CONFLICT: {f} — {s} (claimed by: {', '.join(tids)}) — requires Dustin resolution\n"
        with open(SHIFT_LOG, 'a', encoding='utf-8') as f:
            f.write(conflict_lines)

    conflict_keys = set(conflicts.keys())
    shards_processed = 0
    conflict_blocks_skipped = 0
    malformed_count = 0

    for (shard, thread_id, deltas, log_entry) in parsed_shards:
        if deltas is None and log_entry is None:
            malformed_count += 1
            continue  # Leave malformed shard in place

        # Apply non-conflicting deltas
        for d in deltas:
            key = (d['file'], d['section'])
            if key in conflict_keys:
                conflict_blocks_skipped += 1
                continue
            # Apply delta to target file using Claude Code Edit/Write tool
            # (implementation: read target, apply per action, write back)
            # Action: INSERT_AT_BOTTOM | REPLACE_SECTION [heading] | UPDATE_IN_PLACE [anchor]
            target = WORKSPACE / d['file']
            try:
                if target.exists():
                    existing = target.read_text(encoding='utf-8')
                    action = d['action']
                    if action == 'INSERT_AT_BOTTOM':
                        with open(target, 'a', encoding='utf-8') as tf:
                            tf.write(f"\n{d['content']}\n")
                    elif action.startswith('REPLACE_SECTION'):
                        heading = action.replace('REPLACE_SECTION', '').strip()
                        # Replace from heading to next ## heading
                        pattern = rf'(## {re.escape(heading)}\n).*?(?=\n## |\Z)'
                        replacement = f'\\1{d["content"]}'
                        updated = re.sub(pattern, replacement, existing, flags=re.DOTALL)
                        target.write_text(updated, encoding='utf-8')
                    elif action.startswith('UPDATE_IN_PLACE'):
                        anchor = action.replace('UPDATE_IN_PLACE', '').strip()
                        updated = existing.replace(anchor, d['content'], 1)
                        target.write_text(updated, encoding='utf-8')
            except Exception as e:
                print(f"Delta apply error: {d['file']} — {e}")

        # Append session log entry to session-archive.md
        if log_entry:
            with open(SESSION_ARCHIVE, 'a', encoding='utf-8') as sa:
                sa.write(f"\n{log_entry}\n")

        # Delete shard after successful processing
        shard.unlink()
        shards_processed += 1

    # Log: f"Archive shard consolidation: {shards_processed} shards processed,
    #       {conflict_blocks_skipped} conflict blocks skipped, {malformed_count} malformed left in place."
```

**Hard rule:** ATC is the only process that reads AND deletes archive shard files. Archive creates shards — never reads or deletes them.

---

### Step 7 — SHIFT LOG UPDATE

```python
now_iso = datetime.datetime.utcnow().isoformat() + 'Z'
shift_entry = f"""
---
## ATC Shift — {now_iso}

**Health check:** [N done-files verified | N heartbeats checked | idle queue status]
**Session-archive compile:** [N entries written, M D-number candidates flagged]
**File integrity:** [N files scanned, N issues found/recovered]
**Queue audit:** [N tasks updated Model/Tier/Order]
**Task hygiene delta:** [N tasks updated | D dedup flags | S stale flags]
**Anomaly detection:** [N anomalies filed as ClickUp tasks]
**Blocker quality review:** [N Tier B resolved, N Tier C kept]
**Lane 2 dispatch:** [N triage-needed, N lane-2]
**Shard merge:** [N shards processed, M deduplicated]
**Branch drift check:** [staging=sha12 main=sha12 result=in_sync|ahead|behind]
**Handoffs read:** [N handoff files from interrupted sessions]
**Data cache written:** ClickUp=[ts] Stripe=[ts|skipped] Sentry=[ts|skipped] Supabase=[ts|skipped]
"""

with open(SHIFT_LOG, 'a', encoding='utf-8') as f:
    f.write(shift_entry)
```

---

### Step 7.2 — DATA CACHE WRITE (R-035)

After writing the shift log, write a fresh metrics snapshot to `Claude's Memories/data-cache.md`.

```python
# Read existing cache first (merge approach)
existing_cache = DATA_CACHE.read_text(encoding='utf-8') if DATA_CACHE.exists() else ""

# Build updated cache with sections queried this shift
# Overwrite entire file — read first, replace queried sections, write
cache_content = f"""# Data Cache
<!-- ATC-write-only. All other skills read-only consumers (R-035). -->
last_atc_run: {now_iso}

## ClickUp Snapshot — {now_iso}
open_tasks_total: [N]
tier_1_open: [N]
tier_2_open: [N]
tier_3_open: [N]
triage_needed: [N]
in_progress: [N]
completed_last_24h: [N]
stale_14d: [N]
top_tier1_tasks: [list of top 5 by Order field]

## Stripe Snapshot — [ts|UNCHANGED]
[retained from prior cache if Stripe not queried this shift]

## Sentry Snapshot — [ts|UNCHANGED]
[retained from prior cache if Sentry not queried this shift]

## Supabase Snapshot — [ts|UNCHANGED]
[retained from prior cache if Supabase not queried this shift]
"""
DATA_CACHE.write_text(cache_content, encoding='utf-8')
```

**Sections not queried this shift:** retain previous `last_updated` timestamp and values — read existing file, merge, then overwrite.

---

### Step 8 — HANDOFF FILE

Write a handoff file before session ends (regardless of completion):

```python
handoff_path = HANDOFFS_DIR / f"atc-{datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%S')}.md"
handoff_content = f"""# ATC Handoff

run_at: {now_iso}
status: {"complete" if all_steps_done else "interrupted"}
last_step_completed: [step N]
anomalies_filed: [N ClickUp tasks created]
session_archive_entries: [N]
shift_log_updated: {"yes" if shift_log_written else "no"}
"""
handoff_path.write_text(handoff_content, encoding='utf-8')
```

---

## Anomaly Priority Reference

| Level | Severity | ClickUp Priority | Action |
|-------|----------|-----------------|--------|
| P0 | Critical | Urgent | Create task immediately, STOP current step |
| P1 | High | High | Create task, continue scan |
| P2 | Low | Normal | Log in shift log only OR normal-priority ClickUp task |

---

## Files ATC Reads / Writes

| File | Access |
|------|--------|
| `Claude's Memories/claude-memory.md` | Read only — R-033: no writes permitted |
| `Claude's Memories/atc-shift-log.md` | Append only |
| `Claude's Memories/session-archive.md` | Append only (Step 1.6) |
| `Claude's Memories/data-cache.md` | Read (Step 0) + Overwrite (Step 7.2 only) — R-035 |
| `In Flight/claimed-files.md` | Read; may remove stale entries |
| `In Flight/shift-logs/*.md` | Read + delete (Step 7.1 shard merge) — `Path.unlink()` |
| `In Flight/archive-shards/*.md` | Read + delete (Step 7.1b archive shard consolidation) — `Path.unlink()` |
| `In Flight/heartbeat/*.md` | Read only |
| `In Flight/done/*.md` | Read only (Step 1, 1.6) |
| `Skills Output/*-SKILL.md` | Read; may write recovered version via /tmp + shutil.copy2 |
| `handoffs/*.md` | Read at startup (Step 0) + Write at session end (Step 8) |
| ClickUp list 901711730553 | Read + update fields + create tasks |

---

## Relationship to Other Skills

- **Wingman:** ATC monitors Wingman sessions but never dispatches them. Coordination via ClickUp tags, heartbeat files, and claimed-files.md only.
- **JET FUEL:** Deprecated. ATC replaces it entirely.
- **Decision skill:** ATC does not invoke it. Confirmed Tier C decisions surface as ClickUp tasks; Dustin invokes decision skill.
- **Error-log skill:** ATC does not invoke it. P0/P1 anomalies go directly to ClickUp.

---

## ClickUp MCP Tool Reference

All ClickUp operations use `mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__` prefix:
- `clickup_filter_tasks` — queue audit, blocker review
- `clickup_get_task_comments` — done-file verification
- `clickup_create_task` — anomaly tasks, follow-up tasks
- `clickup_update_task` — Model/Tier/Order fields, description blocks
- `clickup_create_task_comment` — lane-2 dispatch, blocker-resolved comments
- `clickup_add_tag_to_task` / `clickup_remove_tag_from_task` — tag management

---

<!-- v1.7 — 2026-05-21 — R-054 Archive Shard Consolidation (Step 7.1b). Reads In Flight/archive-shards/*.md, applies proposed memory deltas in timestamp order, appends session log entries to session-archive.md, runs deferred GitHub backup, deletes processed shards. Conflict detection logs ## Archive Shard Conflicts to shift log. Malformed shards logged and left in place. ARCHIVE_SHARDS_DIR path constant added. Files table updated. ClickUp: 86e1ggmc2 -->
<!-- v1.6 — 2026-05-18 — Claude Code port of atc-SKILL.md v1.6 (R-034 / R-035) -->
<!-- Adaptations: removed request_cowork_directory + allow_cowork_file_delete (not needed in Claude Code); Path constants (Windows); python3→python; bash rm→Path.unlink() for shard cleanup; handoffs/ folder read in Step 0; handoff file written in Step 8; all ClickUp MCP tool names explicit with mcp__bbfecab5-* prefix; GitHub API via bash curl in Step 4 branch drift -->

---

## Key Findings (R-061)

Before completing R-048 closeout, surface any key findings from this run.
A Key Finding is: anything learned about systems, processes, tools, or patterns
that could improve future decisions or operations.

Append each finding to `Claude's Memories/key-findings-inbox.md`:

## [YYYY-MM-DD] [skill-name] — [one-line finding title]
**Finding:** [one paragraph]
**Domain:** CTO | Product | Marketing | Legal | Business
**Source:** [task ID, PR, Sentry issue ID, or investigation reference]

If no findings this run:
_None this run._

---

## Closeout Protocol (R-048)

Before terminating, every run of this skill MUST complete the following steps:

1. **Create ClickUp tasks** for all recommendations, findings, and action items not already tracked.
   - Search ClickUp first (dedup). List 901711730553.
   - Lane 2 tag if Dustin action required; standard task if Tier A-autonomous.
2. **Write operational data** to designated log: In Flight/atc-shift-log.md  (already implemented — this step confirms R-048 compliance)
3. **Emit closing statement:** "All outputs stored. Thread safe to close."
   - If any storage step failed, create a ClickUp task describing the failure instead.

Never defer storage to the archive skill or any external process. Scheduled sessions have no archive pass.

