---
name: sec-sweep-code
description: "Claude Code-native daily security vulnerability triage for OtterQuote. Aggregates findings from Snyk, Semgrep, Dependabot, and GitGuardian into a single prioritized digest with CVSS classification, business context, SLA assignment, and filed findings (GitHub issues for engineering, ClickUp CEO board for CEO-facing items, per R-098). Triggers: 'run sec-sweep', 'security scan', 'vuln digest', 'daily security sweep', 'check for vulnerabilities', 'security triage', 'check vulns'. Invoke proactively whenever a dependency update or security advisory is discussed, or when a deploy touches dependencies or auth code."
version: "1.1"
tier: A
sentinel: sec-sweep-code-v1.1-2026-06-09
owner: "StellarEdge"
skill: "sec-sweep-code"
updated: "2026-06-09"
---

<!-- Claude Code-native adaptation of sec-sweep-SKILL.md (Cowork v1.1) -->
<!-- Key differences vs. Cowork version:
     - No request_cowork_directory — direct pathlib paths throughout
     - Uses `python` not `python3` (Windows PATH in Claude Code)
     - Direct pathlib.write_text() for file operations
     - Handoff protocol added (writes to handoffs/ at session end)
     - No Cowork FUSE workarounds needed
     - All MCP tool calls unchanged — direct tool invocations
-->

# [sec-sweep-code v1.1]

Daily security vulnerability triage for OtterQuote (Claude Code). Consolidates SAST, SCA, secrets, and Dependabot findings into a single prioritized digest with CVSS classification, business-context scoring, and SLA assignments per CTO-OS §4.

**Triggers:** `run sec-sweep`, `security scan`, `vuln digest`, `daily security sweep`, `check for vulnerabilities`, `security triage`, `check vulns`

---

## Path Constants

```python
import pathlib, datetime

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
SECURITY_DIR      = CLAUDE_DOWNLOADS / "Stellar Edge Services" / "OtterQuote" / "Security" / "Digests"
SKILLS_OUTPUT     = CLAUDE_DOWNLOADS / "Skills Output"

today = datetime.date.today().strftime("%Y-%m-%d")
digest_path = SECURITY_DIR / f"{today}.md"
SECURITY_DIR.mkdir(parents=True, exist_ok=True)
```

---

## Hard Invariants

1. Never fix vulnerabilities autonomously — triage and file GitHub issues (or ClickUp CEO-board tasks for CEO-facing items only); never modify production code
2. Never suppress or downgrade a CVSS Critical or High finding
3. Secrets findings (GitGuardian) are always P0 — treat as live credential exposure until proven otherwise
4. SLA clock starts at finding creation date (from the tool), not the date this skill runs
5. Digest is append-only — never overwrite a previous day's file

---

## Tool Availability Check

At startup, check which tools are available:

```
Available:     Snyk MCP, GitGuardian MCP, GitHub MCP → use directly
Unavailable:   Fall back to bash equivalents where possible
Semgrep:       Always via bash — check with `which semgrep`
```

Log which sources were available vs. unavailable in the digest header. If ALL four sources are unavailable, file a GitHub issue (dedup-first, `exec:cto` label) flagging the toolchain gap and exit — GitHub MCP itself is not the unavailable tool in this case, so the R-098 GitHub-unavailable exception does not apply here.

---

## Protocol

### Step 0 — SETUP

```python
import pathlib, datetime

SECURITY_DIR = pathlib.Path(r"Stellar Edge Services/Otter Quotes/Security/Digests")  # relative to Claude Downloads (workspace root); corrected from stale pre-D-175 "OtterQuote" duplicate
SECURITY_DIR.mkdir(parents=True, exist_ok=True)

today = datetime.date.today().strftime("%Y-%m-%d")
digest_path = SECURITY_DIR / f"{today}.md"

# Initialize digest in memory (append to file at Step 5)
lines = [f"# Security Sweep — {today}\n"]
```

Set today's date for the digest filename: `YYYY-MM-DD.md`

---

### Step 1 — GATHER FINDINGS

Pull from each available source. Collect raw findings; do not filter yet.

**Source 1: GitHub Dependabot**

If GitHub MCP available:
- Query open Dependabot alerts for `StellarEdgeServices/otterquote-platform`
- Extract: package name, severity (CVSS score if available), ecosystem, affected version, patched version, CVE ID, created date
- Also query `StellarEdgeServices/otter-crm`. Do NOT assume a fixed cause for a non-200 response
  (GitHub #1380). This repo has been observed to fail in more than one way — a real sweep run
  recorded a 404 alongside separate 403s, and the CTO ruling on that thread (comment 5518451236)
  explicitly retracted "PAT scope" as the blanket explanation: "the token works, the features are
  switched off on the target repo... not a scope error" in that case. Do NOT treat any of this as
  "no findings" — a repo the sweep cannot see, or cannot get a real answer from, must never render
  the same as a clean repo. Classify the *observed* response and emit the matching line, never a
  guessed one, in the digest body, carrying the same status code and cause on the
  `scanner-telemetry.md` row (`Claude's Memories/scanner-telemetry.md`) for this run:
  - `404` → `otter-crm: NOT MEASURED (404, repo not visible to this token — fine-grained PAT
    scope, or repo does not exist)`
  - `403` → `otter-crm: NOT MEASURED (403, repo visible but forbidden — token lacks the
    permission, or SSO/authorization not granted)`
  - `200` with Dependabot alerts disabled, or the alerts response empty/feature-off →
    `otter-crm: NOT MEASURED (200, Dependabot alerts not enabled on repo — not a token problem)`
  - anything else → `otter-crm: NOT MEASURED (<observed status>, <raw response body snippet,
    unclassified>)` — report what was actually observed, never an assumed cause
  Per gh-1419: UNMEASURED MUST FAIL AS LOUDLY AS STALE — and per PR #1603 review 5533662551, a
  confidently wrong reason is worse than none, so the cause is always derived from the response
  actually received (matching `scripts/drift-detector-age.py`'s `detail` field, which likewise
  reports the HTTP status/reason it actually saw rather than assuming one), never hardcoded.

**Source 2: Snyk**

If Snyk MCP available:
- Pull open issues for the OtterQuote project
- Extract: issue ID, CVSS score, title, affected package, fix available (yes/no), created date, issue type

**Source 3: Semgrep (bash)**

```bash
which semgrep && semgrep --config=auto --json 2>/dev/null | python -c "
import json, sys
data = json.load(sys.stdin)
for r in data.get('results', []):
    print(r['check_id'], r['path'], r['start']['line'], r['extra']['severity'])
" || echo "semgrep unavailable"
```

**Source 4: GitGuardian**

If GitGuardian MCP available:
- Pull open incidents (secrets in commits)
- Extract: detector name, repository, commit SHA, file path, line, status, created date

---

### Step 2 — CLASSIFY AND PRIORITIZE

For each finding, assign:

**CVSS Severity:**
- Critical: CVSS 9.0–10.0
- High: CVSS 7.0–8.9
- Medium: CVSS 4.0–6.9
- Low: CVSS 0.1–3.9
- Informational: No CVSS / style / config

**Business Context Score:**
1. Is this code in the production path? (auth, payment, onboarding, API) → +1 tier
2. Is this customer-facing or touches PII? → +1 tier
3. Is a patch available now?
4. Is the vulnerable code actually called at runtime?

**SLA Assignment (CTO-OS §4):**

| Adjusted Severity | SLA | Action |
|-------------------|-----|--------|
| Critical | < 24 hours | Tier 2 GitHub issue |
| High | < 7 days | Tier 1 GitHub issue |
| Medium | < 30 days | Tier 1 GitHub issue |
| Low | Next sprint | Digest only |
| Informational | Backlog | Digest only |

**Secrets override:** Always Critical regardless of CVSS.

**Deduplication:** If same CVE in Dependabot and Snyk, merge. Keep higher severity.

---

### Step 3 — FILE FINDINGS (R-098)

For each Critical or High finding (and Medium if patch is trivially available), file per the R-098 engineering-findings split. sec-sweep-code findings are engineering findings (vulnerabilities, exposed secrets, patch gaps) — they file to **GitHub issues** on `StellarEdgeServices/otterquote-platform`, never to ClickUp. The only exception is a CEO-facing item (money/legal/brand decision, vendor action) — those go to the ClickUp CEO board.

**MANDATORY: SEARCH OPEN ISSUES FIRST (no-recreate/dedup-at-creation) — this is the #1 duplicate-flood root cause. Do not skip this step.**

**DMARC IDEMPOTENCY CHECK (run before filing any DMARC finding):**

Before filing a GitHub issue for a DMARC report finding, search for an existing open issue
with the same provider and report date:

```
Search key: provider + report date  (e.g., "Google DMARC 2026-06-04" or "Microsoft DMARC 2026-06-04")

Step A — Search open issues on StellarEdgeServices/otterquote-platform:
  search_issues(
    query="repo:StellarEdgeServices/otterquote-platform is:issue is:open \"<Provider> DMARC <YYYY-MM-DD>\""
  )

Step B — Evaluate result:
  - If one or more matching open issues found:
      → Do NOT create a new issue.
      → Add a comment to the existing issue with the new finding details:
          add_issue_comment(
            issue_number=<existing issue number>,
            body="[sec-sweep YYYY-MM-DD re-run] Additional DMARC report received for <Provider> <report-date>.\n<finding details>"
          )
      → Record "appended to existing issue <issue URL>" in the digest instead of "created issue".
  - If no matching open issue found:
      → Proceed with issue creation as normal (Step C below).

Step C — Create issue (only if no duplicate found):
```

**General dedup (all non-DMARC findings):** Before creating any GitHub issue, run `search_issues` for the CVE ID / rule ID / package name against `StellarEdgeServices/otterquote-platform` open issues. If a match exists, add a comment to that issue instead of creating a new one — record "appended to existing issue <URL>" in the digest.

Create a GitHub issue on `StellarEdgeServices/otterquote-platform` (only if no duplicate found):
```
Title:   [SEC] {CVE-ID or rule-ID}: {package/file} — {one-line description}
Labels:  model:sonnet (standard patches) OR model:opus (architectural issues); lane:auto; env:code; triage (if judgment-blocked); incident (production incidents only)

Body:
## Finding
Source: {Snyk/Dependabot/Semgrep/GitGuardian}
Severity: {Critical/High/Medium} | CVSS: {score}
Package: {name} {affected_version} → fix: {patched_version or "no patch available"}

## Business Context
{1-2 sentences: is this in prod path? customer-facing? actually callable?}

## SLA
{date} — {X} days from detection

## Remediation
{Specific action: upgrade command, config change, or "rotate secret + audit access log"}

## References
{CVE link, advisory link, or Semgrep rule docs}

## Acceptance Criteria
- [ ] CVE/finding patched or secret rotated
- [ ] Package upgraded to patched version (or mitigating config applied)
- [ ] CI green; no regression introduced
- [ ] GitGuardian alert resolved (secrets findings only)
- [ ] Closure includes evidence (PR link, commit SHA, or verification note) per CTO-Operating-Model-v2 §6 — never close without it

## Files Touched
{Dependency manifest file(s) (package.json, requirements.txt, etc.) + the code file(s) importing the vulnerable package. For secrets findings: the file containing the exposed secret. Never empty — use "[REQUIRES INVESTIGATION — reason]" if indeterminate.}
```

**Cross-filing is prohibited (R-098).** An engineering finding never gets a ClickUp task; a CEO-facing item never gets a GitHub issue. Do not merge the two into one filing.

**CEO-facing exception:** If a finding requires a money/legal/brand decision or a vendor action, search the ClickUp CEO board for an existing open task first (dedup), then file there instead of GitHub — do not cross-file.

**Secrets special handling:** Use the `incident` label if it's a live production credential exposure. Include secret type (NOT the actual value), commit SHA, file path, and "rotate the credential immediately" — attach rotation evidence before closing, per CTO-Operating-Model-v2 §6.

---

### Step 4 — WRITE DIGEST

```python
import pathlib, datetime

SECURITY_DIR = pathlib.Path(r"Stellar Edge Services/Otter Quotes/Security/Digests")  # relative to Claude Downloads (workspace root); corrected from stale pre-D-175 "OtterQuote" duplicate
SECURITY_DIR.mkdir(parents=True, exist_ok=True)
today = datetime.date.today().strftime("%Y-%m-%d")
digest_path = SECURITY_DIR / f"{today}.md"

digest_content = f"""# Security Sweep — {today}

**Run at:** {datetime.datetime.utcnow().isoformat()}Z
**Sources available:** [list]
**Sources unavailable:** [list if any]

## Summary

| Severity | Count | GitHub Issues Filed |
|----------|-------|----------------------|
| Critical | N | N |
| High | N | N |
| Medium | N | N |
| Low | N | 0 |
| Informational | N | 0 |

## Findings
[findings here — each with GitHub issue URL or "appended to existing issue <URL>", or ClickUp CEO board URL if CEO-facing]

## Coverage Gaps
[any source gaps]

## Toolchain Status
| Tool | Status | Notes |
|------|--------|-------|
| Snyk MCP | status | |
| Semgrep (bash) | status | |
| GitGuardian MCP | status | |
| GitHub Dependabot (MCP) | status | |
"""

# Append-only — never overwrite
if digest_path.exists():
    with open(digest_path, 'a') as f:
        f.write(f"\n\n## Re-Run {datetime.datetime.utcnow().isoformat()}Z\n")
        f.write(digest_content)
else:
    digest_path.write_text(digest_content, encoding='utf-8')

print(f"Digest written: {digest_path}")
```

---

### Step 5 — FILE AND COMPLETE

Verify digest is readable and non-empty:

```python
content = pathlib.Path(str(digest_path)).read_text(encoding='utf-8')
assert len(content) > 100, "Digest is suspiciously short"
print(f"Digest verified: {len(content)} bytes")
```

Append to shift log:
```python
shift_log = pathlib.Path(r"Claude's Memories/atc-shift-log.md")  # relative to Claude Downloads (workspace root)
import datetime
ts = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M")
# ATC writes atc-shift-log.md — append summary to ClickUp instead for sec-sweep
```

Write handoff file:
```python
import pathlib, datetime

HANDOFFS_DIR = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform\handoffs")
HANDOFFS_DIR.mkdir(parents=True, exist_ok=True)
ts = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
handoff = HANDOFFS_DIR / f"sec-sweep-{ts}.md"
handoff.write_text(f"""# sec-sweep Handoff — {ts}
completed_at: {ts}
digest: Stellar Edge Services/Otter Quotes/Security/Digests/{datetime.date.today().strftime('%Y-%m-%d')}.md
status: complete
""", encoding='utf-8')
print(f"Handoff written: {handoff}")
```

---

## SLA Reference (CTO-OS §4)

| Severity | SLA | Escalation |
|----------|-----|------------|
| Critical | 24 hours | Dustin review always |
| High | 7 days | Claude autonomous if patch available + non-auth/payment |
| Medium | 30 days | Claude autonomous |
| Low | Next sprint | Digest only |
| Secrets (any) | Immediate | Rotate + confirm; Tier C if payment/auth credentials |

---

## Digest Location

`Stellar Edge Services/Otter Quotes/Security/Digests/YYYY-MM-DD.md`

One file per day. Never overwrite. Second sweep same day → append `## Re-Run {timestamp}` section.

---

## Relationship to Other Skills

- **bug-killer-code:** If a finding is actively exploited or caused an incident, invoke bug-killer instead.
- **ATC:** ATC may invoke sec-sweep via shift log if security scan is overdue.
- **migration-author-code:** If a finding requires a DB schema fix, use migration-author for that step.

---

## Changelog

**2026-07-06 — R-098 filing cutover (consolidation sprint):**
Step 3 rewritten from "CREATE CLICKUP TASKS" to "FILE FINDINGS (R-098)". Engineering findings now file to GitHub issues on StellarEdgeServices/otterquote-platform, not ClickUp — search open issues first (mandatory dedup, the #1 duplicate-flood root cause), comment on an existing match instead of recreating. CEO-facing items (money/legal/brand/vendor) file to the ClickUp CEO board instead, dedup-checked separately. Cross-filing prohibited. Closure now requires attached evidence (PR/commit/verification note) per CTO-Operating-Model-v2 §6. Digest wording updated from "ClickUp Tasks Created" to "GitHub Issues Filed".

**v1.1 — 2026-06-09 — DMARC idempotency check (task 86e1rd798):**
Added DMARC idempotency check to Step 3. Before creating a DMARC task, sec-sweep-code now searches list 901711730553 for existing open tasks keyed on provider + report date. If a match is found, a comment is appended to the existing task instead of creating a duplicate. Addresses insight-loop finding 2026-06-07 (4 duplicate DMARC tasks filed on 2026-06-04: 86e1qgmuq/86e1qgmak/86e1qgmg3/86e1qgmfw).

**v1.0 — 2026-05-19 — HARDSHELL P4.S2:**
Claude Code adaptation of sec-sweep-SKILL.md (Cowork v1.0). Removed request_cowork_directory. Added pathlib Path constants. Changed python3 → python. Added handoff file protocol. Direct file writes via pathlib.write_text(). All MCP tool calls and protocol logic unchanged from Cowork version.
