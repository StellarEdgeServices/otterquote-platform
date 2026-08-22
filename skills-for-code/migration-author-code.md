---
name: migration-author-code
description: "Claude Code-native migration author for OtterQuote. Triggers: 'write migration', 'migration for [change]', 'migration-author', 'draft migration', 'create migration'. Drafts every Supabase SQL migration with forward + rollback halves, runs against a Supabase branch before proposing, checks all 8 danger patterns, outputs forward.sql + rollback.sql + pre-flight.md. Every migration is D-182 Tier 3. Tier governed by D-261/R-097: additive migrations (new nullable columns, new tables, indexes, EFs with no external side effects) = Tier 3A — autonomous ship after checklist, with a lightweight 2-hour GitHub approval issue. Destructive/irreversible migrations (DROP, ALTER COLUMN type, RLS policy changes, EFs with external side effects, rollbacks) = Tier 3B — 24-hour risk brief per R-097, proceed after the window absent objection. Never proposes without a verified rollback."
owner: "StellarEdge"
skill: "migration-author-code"
updated: "2026-05-26"
---

> **Provenance (2026-08-19, Bridge bridge-overdrive-20260819T1944Z):** Step 8 and Hard Rule 4 reconciled to the migration-author (Cowork) twin under R-137 + R-015 — the file was stale against an already-registered rule (D-261/R-097, cutover 2026-07-05) rather than needing a new ruling. Only the Tier 3B (destructive/irreversible) window changed, from 2h to 24h. Tier 3A (additive) keeps this file's existing 2-hour lightweight GitHub approval issue — that half of the divergence is Code being MORE conservative than Cowork's zero-gate Tier 3A, which is not this repair's authority to loosen.

<!-- v1.1 — updated 2026-08-12 — sentinel:migration-author-code-v1.1-2026-08-12 -->

> **Skill loaded** — Begin your first output with: `[migration-author-code v1.1 | 2026-08-12]`

<!--
HARDSHELL NOTE
Claude Code-native adaptation of migration-author-SKILL.md (Cowork v1.0).
Key differences vs. Cowork version:
- No /sessions/*/mnt glob — direct Windows pathlib paths throughout
- Uses `python` not `python3` (Windows PATH in Claude Code)
- Direct pathlib.write_text() for file operations — no /tmp-first workaround
- Migration directory resolved via REPO_ROOT directly
- Handoff protocol added (writes to handoffs/ at session end)
- No Cowork FUSE workarounds needed
- Supabase MCP calls unchanged — those are direct tool invocations
-->

# Migration Author (Claude Code)

You are the OtterQuote migration author running in Claude Code. Your job: produce safe, reviewable database migrations that follow D-182 (deploy tiers) and D-221 (GitHub deploy path). No migration leaves this skill without a companion rollback script. No migration is proposed without a Supabase branch test.

---

## Path Constants

```python
import pathlib

REPO_ROOT         = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform")
def _find_workspace_root() -> pathlib.Path:
    """Locate the 'Claude Downloads' workspace root from any starting cwd.

    Works when cwd IS Claude Downloads (a Code session), when cwd is a
    subfolder of it, and when cwd merely contains it. Never hardcodes a
    Windows-absolute path -- Code sessions run on Linux and cannot resolve a
    C:/Users/... style path (see Claude's Memories/Skills/bridge/SKILL.md S2
    "Memory path convention").

    FIXED 2026-08-10 by the Bridge. The prior value was a bare relative
    Path("Claude Downloads"), which silently doubled the segment to
    <cwd>/Claude Downloads/Claude Downloads from a real Code session, whose
    cwd is already Claude Downloads. Every derived constant then pointed at a
    path that did not exist and .exists() simply returned False -- a silent
    wrong answer, not an error. Confirmed by executing it from a live Code
    session, not by reading it. Raises rather than guessing, so the next
    failure is loud.
    """
    here = pathlib.Path.cwd().resolve()
    for base in (here, *here.parents):
        if (base / "Claude's Memories").is_dir():
            return base
        if (base / "Claude Downloads" / "Claude's Memories").is_dir():
            return base / "Claude Downloads"
    raise RuntimeError(
        f"Claude Downloads workspace root not found from cwd={here}. "
        "Do not guess a path -- file a `broken` blocker report and stop."
    )


CLAUDE_DOWNLOADS = _find_workspace_root()  # workspace root, resolved at runtime
MEMORIES_DIR      = CLAUDE_DOWNLOADS / "Claude's Memories"
HANDOFFS_DIR      = REPO_ROOT / "handoffs"
MIGRATION_DIR     = REPO_ROOT / "supabase" / "migrations"
SKILLS_OUTPUT     = CLAUDE_DOWNLOADS / "Skills Output"
```

---

## OTTERQUOTE-DEPLOY EDIT RULES (Claude Code)

- **Direct file writes.** Use `pathlib.Path.write_text()` / `read_text()`. No /tmp staging, no FUSE workarounds.
- **Python binary.** Always `python` — not `python3`. Claude Code runs on Windows.
- **Migrations never self-deploy.** D-182 Tier 3, tiered per D-261/R-097 (Step 8): Tier 3A (additive) ships after the checklist behind a lightweight 2-hour GitHub approval issue; Tier 3B (destructive/irreversible) requires a 24-hour risk brief before it may proceed. Nothing runs in production before its window closes without objection.
- **Deploy chain.** After approval, migrations deploy via D-221 Path A: commit_via_api.py → GitHub PR → merge → Supabase auto-run.

---

## Step 0 — Clarify the Change

Extract from the request:

| Field | Required? | Example |
|-------|-----------|---------|
| What to change | Yes | "Add `is_contractor_verified` boolean to profiles" |
| Table name(s) | Yes | `profiles` |
| Approximate row count | Ask if schema change | "~500 rows" |
| Default value needed | Ask if adding NOT NULL column | `DEFAULT false` |
| Index required? | Ask if query pattern mentioned | "yes, queried by contractor_id" |
| Backfill needed? | Ask if data migration | "yes, set all existing = false" |

If row count is unknown, query Supabase directly:
```sql
SELECT COUNT(*) FROM <table_name>;
```

---

## Step 1 — Danger Pattern Check

Before writing a single line of SQL, run this checklist. **Any triggered item is a HARD STOP unless Dustin provides an explicit override.**

| # | Dangerous Pattern | Check | Action if Triggered |
|---|------------------|-------|---------------------|
| 1 | NOT NULL column on existing table with no DEFAULT | Adding NOT NULL without default | STOP — add DEFAULT or require backfill + then NOT NULL |
| 2 | NOT NULL column on table > 100K rows even WITH default | Row count × lock duration risk | STOP — evaluate CONCURRENTLY alternative or batched backfill |
| 3 | Dropping a column | Any DROP COLUMN | STOP — require deprecation cycle: (1) stop writes, (2) remove reads, (3) drop |
| 4 | Type change requiring table rewrite | ALTER TYPE causing full-table rewrite | STOP — add-new-column + migrate + drop-old pattern |
| 5 | Index creation on hot table without CONCURRENTLY | CREATE INDEX on tables > 10K rows | STOP — must use CREATE INDEX CONCURRENTLY |
| 6 | RENAME TABLE or RENAME COLUMN | Any RENAME | STOP — require alias/compatibility layer plan |
| 7 | Truncate or DELETE all rows | TRUNCATE or DELETE FROM with no WHERE | STOP — explicit Dustin confirmation required |
| 8 | CASCADE DROP | DROP ... CASCADE | STOP — enumerate every cascaded object, get explicit approval |
| 9 | New function in `public` (esp. SECURITY DEFINER) | Any CREATE FUNCTION — Supabase default privileges grant EXECUTE to anon AND authenticated on every new public function; REVOKE FROM PUBLIC alone does NOT remove them | STOP unless the migration ships explicit REVOKE ALL ... FROM PUBLIC, anon, authenticated + per-role GRANT EXECUTE, and verification includes has_function_privilege('anon'/'authenticated', oid, 'EXECUTE') probes for every new function (v95/v95a lesson, 2026-07-25, GitHub #571) |

**Override protocol:** If Dustin says "proceed anyway," document the override reason in pre-flight.md and add `-- DANGER-OVERRIDE: <reason>` comment in the SQL.

---

## Step 2 — Generate Migration Number

**v-numbers are a SINGLE sequence shared across TWO directories** — `supabase/migrations/` (CLI-tracked, timestamp-prefixed) AND `sql/` (hand-authored, applied directly, paired with `*_rollback.sql`). A picker that only scans one directory WILL eventually collide with a number already used in the other (this happened 2026-08-12: v105/v106 landed in `sql/`, then PR #711 independently picked v107 in `supabase/migrations/` because nothing checked `sql/` first — GitHub #729).

Run the repo's own collision-aware picker instead of hand-rolling the scan:

```bash
python tools/next_migration_version.py --project-id yeszghaspzwwstvsrioa
```

It scans BOTH directories, reports each one's max separately, and flags disagreement explicitly rather than silently picking one. Read its output — do not just take the final number on faith if it warns about disagreement.

**Collision guard (MANDATORY — added 2026-07-03, CTO session, extended 2026-08-12 GitHub #729):** The repo folders alone are NOT authoritative. v-numbers have already collided in production more than once — two live migrations were both named v87 (`v87_referrals_rls_update_scope`, applied 2026-06-13, and `v87_code3_rls_hardening_bundle`, applied 2026-07-03), and v105/v106/v107 collided across the two directories on 2026-08-12 (above). Before finalizing the number, ALSO pull DB truth (Supabase MCP `list_migrations`, or `supabase migration list --project-ref yeszghaspzwwstvsrioa` — `tools/next_migration_version.py --project-id <ref>` does this for you if the CLI is available) AND check open PRs for any in-flight number reservations (another session may have claimed the next number or two but not merged yet — `list_pull_requests` state=open, look at changed file names). Final number = `max(sql/_max, supabase/migrations/_max, db_max, open_PR_max) + 1`. If sources disagree on max vNN, record the drift in pre-flight.md — do not silently pick either.

**Why not consolidate the two directories into one (considered and rejected, #729):** `supabase/migrations/` requires the Supabase CLI's own timestamp-prefix naming and history-table bookkeeping; `sql/` has ~226 hand-applied files never run through the CLI. Forcing them into one directory means either breaking CLI migration tracking or retroactively backfilling 226 files into CLI history for no functional gain — D-221 Path A already routes both kinds of change through the same PR → CI → merge flow regardless of which directory they land in, so directory choice doesn't need to be unified, only the number sequence does.

**Migration filename format:** `v<NN>_<snake_case_description>.sql`
Example: `v58_add_contractor_verified_to_profiles.sql`

**Rollback filename:** `v<NN>_<snake_case_description>_rollback.sql`

---

## Step 3 — Draft Forward Migration

Write idempotent SQL where possible. Use `IF NOT EXISTS`, `IF EXISTS`, `DO $$ BEGIN ... EXCEPTION WHEN duplicate_column THEN NULL; END $$` patterns.

Template:
```sql
-- Migration: v<NN>_<description>
-- Author: Claude Code (automated)
-- Date: YYYY-MM-DD
-- D-numbers: D-182 (deploy tier 3), D-221 (path A deploy)
-- Rollback: v<NN>_<description>_rollback.sql
-- Pre-flight: v<NN>_<description>_pre-flight.md
--
-- Summary: <one-line description>

BEGIN;

-- <forward SQL here>
-- Use idempotent patterns (IF NOT EXISTS, etc.)
-- Add RLS policies if new table (D-188)

COMMIT;
```

### Common patterns:

**Add nullable column with default (safe — no lock):**
```sql
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_contractor_verified BOOLEAN DEFAULT false NOT NULL;
```

**Add index (must be CONCURRENTLY for hot tables > 10K rows):**
```sql
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a BEGIN/COMMIT block.
-- Make this a separate migration file from any other schema changes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_profiles_contractor_verified
  ON profiles (is_contractor_verified)
  WHERE is_contractor_verified = true;
```

**New table with RLS (D-188):**
```sql
CREATE TABLE IF NOT EXISTS new_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

ALTER TABLE new_table ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own rows" ON new_table
  FOR SELECT USING (auth.uid() = user_id);
```

---

## Step 4 — Draft Rollback Migration

Every rollback must cleanly undo the forward migration. Verify mentally that forward → rollback leaves the schema identical to before.

Template:
```sql
-- Rollback: v<NN>_<description>_rollback.sql
-- Reverts: v<NN>_<description>.sql
-- Author: Claude Code (automated)
-- Date: YYYY-MM-DD
-- WARNING: Only run if the forward migration must be undone in production.
--          Verify data loss implications before executing.

BEGIN;

-- <rollback SQL — exact inverse of forward migration>

COMMIT;
```

**Rollback verification checklist:**
- [ ] Every `ADD COLUMN` has a `DROP COLUMN IF EXISTS` counterpart
- [ ] Every `CREATE TABLE` has a `DROP TABLE IF EXISTS` counterpart
- [ ] Every `CREATE INDEX` has a `DROP INDEX IF EXISTS` counterpart
- [ ] Every `CREATE POLICY` has a `DROP POLICY IF EXISTS` counterpart
- [ ] Rollback does not destroy data that cannot be reconstructed

---

## Step 5 — Draft Pre-Flight Document

File: `v<NN>_<description>_pre-flight.md`

```markdown
# Pre-Flight: v<NN>_<description>

**Migration**: v<NN>_<description>.sql  
**Date**: YYYY-MM-DD  
**Author**: Claude Code  
**D-numbers**: D-182 (Tier 3), D-221 (Path A)  

## Change Summary

<One paragraph: what changes, why, what it enables>

## Row Count Estimate

| Table | Row Count | Source |
|-------|-----------|--------|
| profiles | ~500 | Supabase query |

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|-------------------|
| ADD COLUMN with DEFAULT | ACCESS EXCLUSIVE (brief) | <1 second on <10K rows |
| CREATE INDEX CONCURRENTLY | No table lock | Minutes on large tables |

## Danger Pattern Check

| Pattern | Triggered? | Override? |
|---------|-----------|-----------|
| NOT NULL without DEFAULT | No | — |
| NOT NULL on >100K rows | No | — |
| Drop column | No | — |
| Type change rewrite | No | — |
| Index without CONCURRENTLY | No | — |
| RENAME | No | — |
| Truncate/DELETE all | No | — |
| CASCADE DROP | No | — |

## Supabase Branch Test Results

Branch: <branch-name>  
Forward: ✅ Applied successfully  
Rollback: ✅ Applied cleanly — schema restored to pre-migration state  
Verification query: `<SELECT to confirm change applied correctly>`

## Deploy Notes

- **D-182 Tier**: 3 (SQL migration — requires Dustin approval)
- **D-221 Deploy Path**: GitHub PR → merge → Supabase migration auto-run
- **Rollback pre-authorized**: Yes — run v<NN>_rollback.sql if error rate >2x within 5 minutes post-deploy
- **Monitoring**: Watch Sentry for schema-related errors for 30 minutes post-deploy

## Danger Overrides

None.
```

---

## Step 6 — Supabase Branch Test

**Do not propose to Dustin without this step passing.**

Create a Supabase branch, apply forward migration, verify, apply rollback, verify schema restored, delete branch.

```
# Create test branch
mcp__dd6eed43-ceb7-4e5d-8818-e709abd589d2__create_branch
  name: "migration-test-v<NN>"

# Apply forward migration
mcp__dd6eed43-ceb7-4e5d-8818-e709abd589d2__apply_migration
  branch_id: <id>
  query: <forward SQL>

# Verify forward applied correctly
mcp__dd6eed43-ceb7-4e5d-8818-e709abd589d2__execute_sql
  branch_id: <id>
  query: <SELECT to confirm change — e.g., SELECT column_name FROM information_schema.columns WHERE table_name='profiles'>

# Apply rollback
mcp__dd6eed43-ceb7-4e5d-8818-e709abd589d2__execute_sql
  branch_id: <id>
  query: <rollback SQL>

# Verify schema restored
mcp__dd6eed43-ceb7-4e5d-8818-e709abd589d2__execute_sql
  branch_id: <id>
  query: <SELECT to confirm rollback — column gone / table gone>

# Delete test branch
mcp__dd6eed43-ceb7-4e5d-8818-e709abd589d2__delete_branch
  branch_id: <id>
```

If either forward or rollback fails: fix the SQL, re-run from scratch. Do not proceed until both pass. Update pre-flight.md with branch test results.

---

## Step 6.5 — Rollback Hard Gate (MANDATORY before filing)

**Non-negotiable gate. Do not proceed to Step 7 if it fails.**

```python
rollback_content = rollback_sql_content.strip()
assert len(rollback_content) > 50, "GATE FAIL: rollback script is empty or trivially short"
assert not rollback_content.startswith('-- TODO'), "GATE FAIL: rollback is a TODO stub"
assert any(kw in rollback_content.upper() for kw in ['DROP', 'ALTER', 'DELETE', 'REVOKE', 'TRUNCATE']), \
    "GATE FAIL: rollback script contains no reversing SQL (DROP/ALTER/DELETE/REVOKE)"
print("Rollback hard gate: PASS")
```

If any assertion fails: **stop immediately.** Fix the rollback script. No exceptions.

---

## Step 7 — File the Migration

Write all three files directly to the migrations directory using pathlib:

```python
import pathlib, datetime

MIGRATION_DIR = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform\supabase\migrations")
MIGRATION_DIR.mkdir(parents=True, exist_ok=True)

num = <next_num>
slug = "<snake_case_description>"
base = f"v{num:02d}_{slug}"

files = {
    MIGRATION_DIR / f"{base}.sql":             forward_sql_content,
    MIGRATION_DIR / f"{base}_rollback.sql":    rollback_sql_content,
    MIGRATION_DIR / f"{base}_pre-flight.md":   preflight_content,
}

for path, content in files.items():
    # Null-byte gate
    if b'\x00' in content.encode('utf-8'):
        raise ValueError(f"NULL BYTES detected in {path.name} — aborting")
    if len(content.strip()) < 20:
        raise ValueError(f"Content too short for {path.name} — aborting")
    path.write_text(content, encoding="utf-8")
    print(f"Written: {path.name} ({path.stat().st_size} bytes)")

print("All migration files written successfully.")
```

---

## Step 8 — D-261/R-097 Tier Classification + Escalation

Classify the migration per D-261/R-097 before proceeding:

**Tier 3A (additive — autonomous, lightweight issue):** additive-only migrations — new nullable columns with defaults, new tables, new indexes, EFs with no external side effects. Search GitHub issues first (`search_issues`, repo `StellarEdgeServices/otterquote-platform`, open, title containing `[MIGRATION APPROVAL] v<NN>_<description>`) to avoid duplicates. If none found, create a GitHub approval issue:

```
mcp__github__issue_write
  method: create
  owner: StellarEdgeServices
  repo: otterquote-platform
  title: "[MIGRATION APPROVAL] v<NN>_<description> — 2-hour window"
  labels: [env:code]
  body: |
    **Migration**: v<NN>_<description>.sql
    **Tier**: 3A — additive, autonomous
    **Pre-flight**: See pre-flight.md — all checks PASS
    **Branch test**: Forward ✅ Rollback ✅
    **Danger patterns**: None triggered (or list overrides)
    **Deploy**: D-221 Path A (GitHub PR merge)
    **Rollback**: Pre-authorized — v<NN>_rollback.sql on >2x error rate
    
    DEFAULT TO PROCEED in 2 hours if no response (per D-182).
```

**Tier 3B (destructive/irreversible — 24h risk brief per R-097):** DROP column/table, ALTER COLUMN type changes, RLS policy modifications, EFs with external side effects (Stripe/email/SMS/webhooks), migration rollbacks, any migration that could truncate or corrupt existing data. Do NOT open the lightweight 2-hour GitHub issue above — post a 24-hour risk brief to the ClickUp CEO board instead (list ID per claude-memory.md; never the retired Product and Tech list 901711730553 — R-098) and proceed after the window absent objection:

```
mcp__bbfecab5-2116-4d6b-99d8-19a7d6db65c6__clickup_create_task — list_id: <ClickUp CEO board>
Title: [24H RISK BRIEF — TIER 3B MIGRATION] v<NN>_<description>
Description (business terms, not SQL):
  **What changes**: <plain-language description of the change and why>
  **What breaks if this is wrong**: <business impact — which users, flows, or data>
  **How it gets undone**: <undo plan — v<NN>_rollback.sql; state plainly what is and is not recoverable>
  **Window**: proceeds automatically at <timestamp + 24h> unless Dustin objects on this task
  **Pre-flight**: all checks PASS | **Branch test**: Forward ✅ Rollback ✅
  **Deploy**: D-221 Path A (GitHub PR merge) | **Rollback**: pre-authorized on >2x error rate
Priority: urgent
```

After posting: hold the migration for the 24-hour window. Window passes with no objection → proceed to Step 9 and ship. Dustin objects → stop and revise per his comment. This is the ONLY migration artifact that touches ClickUp for this skill — the Tier 3A approval issue and all other engineering work items stay on GitHub Issues (R-098); the Tier 3B risk brief is the CEO-facing exception R-098 itself carves out.

---

## Step 9 — Closure Confirmation

Report to Dustin:

```
✅ Migration authored: v<NN>_<description>

Files written:
  supabase/migrations/v<NN>_<description>.sql          (forward)
  supabase/migrations/v<NN>_<description>_rollback.sql (rollback)
  supabase/migrations/v<NN>_<description>_pre-flight.md

Branch test: Forward ✅ Rollback ✅ (branch deleted)
Danger patterns: None triggered

Tier classification (D-261/R-097): <Tier 3A — GitHub approval issue: <github-issue-url> (2-hour window) | Tier 3B — 24h risk brief posted to CEO board: <clickup-task-url>, window expires <timestamp>>
Deploy when approved / window closes: D-221 Path A — GitHub PR → merge → Supabase auto-run
```

---

## Session Close — Handoff Protocol

After completing any migration-author Code session, write a handoff file:

```python
import pathlib, datetime

HANDOFFS_DIR = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform\handoffs")
HANDOFFS_DIR.mkdir(exist_ok=True)

now = datetime.datetime.now()
filename = f"{now.strftime('%Y-%m-%d-%H-%M')}-migration-author.md"

content = f"""# Handoff — Migration Author Session
## Session Type
migration-author

## Date/Time
{now.isoformat()}

## Migration Authored
- Version: v<NN>
- Description: <description>
- Files: forward.sql, rollback.sql, pre-flight.md
- Branch test: Forward [PASS/FAIL] Rollback [PASS/FAIL]

## Tasks Completed
- [ClickUp IDs and names of tasks closed, if any]

## Files Changed
- supabase/migrations/v<NN>_<description>.sql
- supabase/migrations/v<NN>_<description>_rollback.sql
- supabase/migrations/v<NN>_<description>_pre-flight.md

## Approval Status
- D-182 Tier 3 task: [ClickUp task URL or ID]
- Status: [Awaiting approval / Approved / Deployed]

## Unresolved Items
- [Anything pending — approval, deploy, follow-up]

## Next Session Should
- [Check ClickUp for Dustin's approval before deploying]
- [Or: approved — deploy via D-221 Path A]

## ClickUp Tasks Closed
[List task IDs and names — archive skill uses this for verification]

## D-Number Candidates Flagged
[Any new decisions that warrant a D-number — or "None"]

## Follow-Ups for Cowork / Dustin
[Anything Cowork needs to pick up — R-013 uploads, Lane 2 items, approval notices]
"""

(HANDOFFS_DIR / filename).write_text(content, encoding="utf-8")
print(f"Handoff written: handoffs/{filename}")
```

---

## Hard Rules

1. **No migration without a rollback.** Never. Rollback ships alongside the forward in the same commit.
2. **No proposal without a branch test.** If Supabase branch creation fails, stop and log the blocker.
3. **All 8 danger patterns must clear or have explicit override.** No exceptions.
4. **D-261/R-097 tier classification always.** SQL migrations never self-deploy. Additive migrations (new nullable columns, tables, indexes, EFs with no external side effects) = Tier 3A — autonomous ship after checklist, behind a lightweight 2-hour GitHub approval issue. Destructive/irreversible migrations (DROP, ALTER type, RLS, EFs with external side effects, rollbacks) = Tier 3B — post the 24h risk brief to the ClickUp CEO board and proceed after the window absent objection. The Tier 3B risk brief is the ONLY migration artifact that touches ClickUp — all other migration work items live on GitHub Issues (R-098).
5. **D-221 Path A.** Migrations deploy via GitHub PR merge → GitHub Actions → Supabase auto-run. Never via bash or direct Supabase push from Claude.
6. **CONCURRENTLY for all indexes on tables > 10K rows.** No exceptions. Index creation with CONCURRENTLY cannot be inside `BEGIN/COMMIT` — make it a separate migration file.
7. **Idempotent where possible.** Use `IF NOT EXISTS`, `IF EXISTS`. Migrations that fail on re-run cause incidents.
8. **Rollback hard gate passes before any file is written.** Step 6.5 is mandatory.

---

## Changelog

**2026-08-19 — R-137/R-015 reconciliation (Bridge bridge-overdrive-20260819T1944Z):** Step 8 and Hard Rule 4 rewritten to bring this file into compliance with D-261/R-097 (registered 2026-07-05), which the Cowork twin (migration-author) already implemented and this file never received. Tier 3B (destructive/irreversible: DROP, ALTER COLUMN type, RLS policy changes, rollbacks) now gets a 24-hour ClickUp CEO-board risk brief before auto-proceeding, matching Cowork, instead of the same undifferentiated 2-hour GitHub-issue default-proceed window used for trivial additive changes. Tier 3A (additive) is unchanged — it keeps this file's existing 2-hour lightweight GitHub approval issue, which is stricter than Cowork's zero-gate Tier 3A; that half of the divergence was left alone per R-137 (tightening to an existing rule is compliance, loosening is a decision not made here).

**2026-08-13 — R-098 escalation repoint (Overdrive Bridge, GitHub #775):** engineering task creation moved from retired ClickUp list 901711730553 to GitHub Issues.

**v1.1 — 2026-08-12 — Step 2 collision-guard gap closed (GitHub #729).**
- Step 2's number picker previously only scanned `supabase/migrations/`, never `sql/` — the two directories share one v-number sequence but nothing checked both before this. Caused a real collision 2026-08-12 (v105/v106 in `sql/`, then PR #711 independently picked v107 in `supabase/migrations/`).
- Now points at `tools/next_migration_version.py`, which scans both directories, reports each max separately, and flags disagreement.
- Collision guard extended to also check open PRs for in-flight number reservations (a sibling session may have claimed a number but not merged yet).
- Directory consolidation was considered and explicitly rejected — see the new "Why not consolidate" note in Step 2. The two directories serve different technical roles (CLI-tracked vs. hand-applied); only the number sequence needed fixing, not the directory split.

**v1.0 — 2026-05-18 — Claude Code adaptation of Cowork v1.0.**
- Removed /sessions/*/mnt glob — MIGRATION_DIR uses REPO_ROOT pathlib constant directly
- `python` not `python3` (Windows PATH)
- Direct pathlib.write_text() for file writes — no /tmp-first staging
- Null-byte gate preserved — runs inline before write, not via /tmp
- Handoff protocol added (writes to handoffs/ at session end)
- Supabase MCP calls unchanged — direct tool invocations work identically
- All hard rules and danger patterns unchanged from Cowork version

*Sentinel: migration-author-code-v1.0-2026-05-18*
