---
name: dep-upgrader-code
description: "Claude Code-native dependency upgrade automation for OtterQuote. Sweeps open Dependabot PRs, classifies by semver bump (patch/minor/major), merges patches and passing minors autonomously, surfaces majors as Tier C with breaking-change summaries. Triggers: 'upgrade dep [name]', 'dep-upgrader', 'run dep upgrades', 'upgrade dependencies', 'process dependabot PRs', 'run dependency sweep'. Invoke proactively whenever a dependency advisory is discussed, weekly via scheduled task, or when sec-sweep surfaces a High/Critical finding with an available patch."
version: "1.0"
tier: A
sentinel: dep-upgrader-code-v1.0-2026-05-19
---

<!-- Claude Code-native adaptation of dep-upgrader-SKILL.md (Cowork v1.0) -->
<!-- Key differences vs. Cowork version:
     - No request_cowork_directory — direct pathlib paths throughout
     - Uses `python` not `python3` (Windows PATH in Claude Code)
     - Direct pathlib.write_text() for file operations
     - Handoff protocol added (writes to handoffs/ at session end)
     - No Cowork FUSE workarounds needed
     - GitHub MCP calls unchanged
-->

# [dep-upgrader-code v1.0]

Dependency upgrade automation for OtterQuote (Claude Code). Sweeps open Dependabot PRs on `StellarEdgeServices/otterquote-platform`, classifies each by semver bump type, merges what is safe autonomously, and surfaces breaking changes to Dustin.

**Triggers:** `upgrade dep [name]`, `dep-upgrader`, `run dep upgrades`, `upgrade dependencies`, `process dependabot PRs`, `run dependency sweep`

---

## Path Constants

```python
import pathlib, datetime

REPO_ROOT       = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform")
CLAUDE_DOWNLOADS = pathlib.Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads")
HANDOFFS_DIR    = REPO_ROOT / "handoffs"
DEP_UPGRADES_DIR = CLAUDE_DOWNLOADS / "Stellar Edge Services" / "OtterQuote" / "Engineering" / "Dep-Upgrades"
DEP_UPGRADES_DIR.mkdir(parents=True, exist_ok=True)

today = datetime.date.today().strftime("%Y-%m-%d")
digest_path = DEP_UPGRADES_DIR / f"{today}.md"
```

---

## Hard Invariants

1. **Never merge a PR with failing CI.** CI red is always a blocker.
2. **Never merge a major bump autonomously.** Majors always go to Tier C.
3. **Never merge a PR touching auth, payment, or core DB packages without explicit Dustin approval** — even if patch/minor and CI green. Affected: `@supabase/*`, `stripe`, `jsonwebtoken`, `passport`, `next-auth`, any package containing `auth`, `oauth`, or `crypto`.
4. **Log every decision** in the per-PR decision log.
5. **Changelogs must be read before merging minor bumps.** No changelog → treat as major.

---

## Tool Availability Check

- **GitHub MCP** (`mcp__github__*`): required. If unavailable → this is a toolchain gap that cannot file to GitHub by definition (R-098 exception); search the ClickUp CEO board for an existing open "GitHub MCP unavailable" task first (dedup), file there if none found, and exit. Close with evidence once the MCP is restored.
- **WebFetch / WebSearch**: needed for changelogs. If unavailable → treat all minors as majors.

---

## Session Modes

**Targeted mode** (`upgrade dep [name]`): process only that package's open Dependabot PR(s).

**Sweep mode** (`dep-upgrader`, `run dep upgrades`, scheduled): process ALL open Dependabot PRs in order: patches → minors → majors.

---

## Protocol

### Step 0 — Setup

```python
import pathlib, datetime

DEP_UPGRADES_DIR = pathlib.Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads\Stellar Edge Services\OtterQuote\Engineering\Dep-Upgrades")
DEP_UPGRADES_DIR.mkdir(parents=True, exist_ok=True)
today = datetime.date.today().strftime("%Y-%m-%d")
digest_path = DEP_UPGRADES_DIR / f"{today}.md"
mode = "sweep"  # or "targeted" based on trigger
```

---

### Step 1 — Fetch Open Dependabot PRs

Using GitHub MCP:
- List open PRs on `StellarEdgeServices/otterquote-platform`
- Filter: author = `dependabot[bot]` OR title starts with "Bump " OR "chore(deps)"

For each PR, extract: PR number, title, package name, ecosystem, current → proposed version, PR URL, CI status (all check runs), days open.

**Targeted mode:** filter to requested package. If no matching PR: report and exit.

---

### Step 2 — Classify Each Bump

| Bump | Definition |
|------|-----------|
| Patch | Z increments: `1.2.3 → 1.2.4` |
| Minor | Y increments: `1.2.x → 1.3.0` |
| Major | X increments: `1.x.y → 2.0.0` |

**Edge cases:**
- `0.x.y` packages: Y increment → treat as major
- Pre-release to release: minor if same X, major if X changes
- Lock-file-only bumps: treat as patch

**Auth/payment override (Hard Invariant #3):** flag for explicit approval regardless of bump type.

---

### Step 3 — Fetch Changelog (Minor and Major only)

For minor/major bumps, fetch in order:
1. GitHub releases page
2. `CHANGELOG.md` on proposed version tag
3. npm registry release notes
4. PyPI changelog

**No changelog retrievable:** treat as major (escalate).

**Breaking change signals:** "breaking change", "BREAKING", "migration guide", "removed", "renamed", "deprecated and removed", API signature changes, Node version requirements.

---

### Step 4 — CI Status Gate

Read all CI check runs for the PR head SHA.

- ALL green → CI passes
- ANY failed → block merge, escalate
- ANY pending → wait 5 min, re-check once; still pending → treat as failed
- No checks → treat as failed (do not auto-merge unvalidated code)

---

### Step 5 — Decision Matrix

| Bump Type | Auth/Payment Pkg | CI Status | Changelog | Action |
|-----------|-----------------|-----------|-----------|--------|
| Patch | No | Green | N/A | AUTO-MERGE |
| Patch | No | Red/Pending | N/A | ESCALATE (CI failure) |
| Patch | Yes | Any | N/A | ESCALATE (sensitive package) |
| Minor | No | Green | Available, no breaking signals | AUTO-MERGE |
| Minor | No | Green | Unavailable | ESCALATE (treat as major) |
| Minor | No | Green | Breaking signals found | ESCALATE (major risk) |
| Minor | No | Red | Any | ESCALATE (CI failure) |
| Minor | Yes | Any | Any | ESCALATE (sensitive package) |
| Major | Any | Any | Any | ESCALATE (always Tier C) |

**AUTO-MERGE:** Approve PR via GitHub MCP → squash merge → log.

**ESCALATE (R-098 — no per-dep tasks anywhere):**
1. Do NOT merge
2. Do NOT create a separate ClickUp task or GitHub issue per dependency — the Dependabot PR itself is the per-dependency work item.
3. Post comment on the Dependabot PR with the reason, bump type, and changelog excerpt/breaking-change summary. Add a `triage-needed` label to the PR if the escalation is a judgment call (major bump, sensitive package) — no label needed for a plain CI-failure escalation.
4. Record the escalation as a line-item in the weekly digest and the weekly GitHub sweep issue — not as an individual filing.
5. **Exception — CEO-facing escalation:** money/legal/brand/vendor-action escalations dedup-check and file to the ClickUp CEO board instead — do not cross-file to GitHub.
6. Log decision

---

### Step 6 — Write Decision Log

```python
import pathlib, datetime

DEP_UPGRADES_DIR = pathlib.Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads\Stellar Edge Services\OtterQuote\Engineering\Dep-Upgrades")
DEP_UPGRADES_DIR.mkdir(parents=True, exist_ok=True)
today = datetime.date.today().strftime("%Y-%m-%d")
digest_path = DEP_UPGRADES_DIR / f"{today}.md"

digest = f"""# dep-upgrader Session — {today}

**Mode:** sweep / targeted
**Repo:** StellarEdgeServices/otterquote-platform
**PRs evaluated:** N
**Auto-merged:** N
**Escalated:** N

---

## Results

[per-PR result blocks]
"""
digest_path.write_text(digest, encoding='utf-8')
print(f"Digest written: {digest_path}")
```

Null-byte verify:
```python
data = pathlib.Path(str(digest_path)).read_bytes()
assert data.count(b'\x00') == 0, f"NULL BYTES in digest: {data.count(b'\x00')}"
print("null-byte: PASS")
```

---

### Step 7 — Weekly Sweep GitHub Issue + Handoff (R-098)

**The ClickUp "Weekly Dependency Sweep Log" persistent task (list `901711730553`, confirmed-retired) is retired.** File the weekly digest as a **GitHub issue per run** on `StellarEdgeServices/otterquote-platform`, not an accumulating ClickUp anchor.

**Search open issues first (mandatory dedup):** Look for an existing open issue titled `Dependency sweep — YYYY-MM-DD` for today's date before creating a new one; comment on it instead if found (guards against same-day re-runs).

Create (or comment on) a GitHub issue:
```
Title: Dependency sweep — YYYY-MM-DD
Labels: lane:auto, env:code

Body: dep-upgrader run YYYY-MM-DD: [N merged, N escalated, N skipped]. Full log: [digest path].
[per-PR summary from Step 6]
```

Dependabot PRs remain the per-dependency work items — no per-dep ClickUp tasks or GitHub issues are filed alongside this rollup. Close this issue only when every referenced PR has resolved, attaching evidence (merge SHA(s) or superseding-PR note) per CTO-Operating-Model-v2 §6.

Write handoff file:
```python
import pathlib, datetime

HANDOFFS_DIR = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform\handoffs")
HANDOFFS_DIR.mkdir(parents=True, exist_ok=True)
ts = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
handoff = HANDOFFS_DIR / f"dep-upgrader-{ts}.md"
handoff.write_text(f"""# dep-upgrader Handoff — {ts}
completed_at: {ts}
mode: sweep
merged: N
escalated: N
digest: Stellar Edge Services/OtterQuote/Engineering/Dep-Upgrades/{datetime.date.today().strftime('%Y-%m-%d')}.md
status: complete
""", encoding='utf-8')
print(f"Handoff written: {handoff}")
```

---

## Stale PR Detection

During sweep mode, flag Dependabot PRs open >30 days with a comment:
`dep-upgrader: This PR has been open >30 days. If still relevant, rebase for fresh CI; if superseded, close it.`

---


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

## Changelog

**v1.0 — 2026-05-19 — HARDSHELL P4.S2:**
Claude Code adaptation of dep-upgrader-SKILL.md (Cowork v1.0). Removed request_cowork_directory. Added pathlib Path constants. Changed python3 → python. Added handoff file protocol. Direct pathlib.write_text() for all file operations. All GitHub MCP calls and protocol logic unchanged from Cowork version.
