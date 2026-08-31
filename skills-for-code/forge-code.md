---
name: forge-code
description: "Claude Code-native OtterQuote site compliance and repair loop. Triggers: 'run forge', 'forge run', '/forge', 'compliance check', 'check the site', 'fix the site', 'site audit', 'compliance sweep', 'run a compliance pass'. Forge autonomously tests the OtterQuote website against all documented decisions (D-numbers), identifies gaps, fixes them, redeploys, and retests — looping until the compliance gap is minimized. Three stop conditions only: undocumented business decision needed, credentials unavailable, attorney-review-gated copy. Everything else is autonomous. Dustin reviews the finished product; everything he finds after Forge completes is either a missing D-number or a Forge blind spot."
---

<!-- sentinel:forge-code-v1.2-2026-05-19 -->

> **Skill loaded** — Begin your first output with: `[forge-code v1.2 | 2026-05-19]`

<!--
HARDSHELL NOTE
Claude Code-native adaptation of forge-SKILL.md (Cowork v2.6 — 2026-05-08).
Operation Hardshell P3.S4 — written 2026-05-18.

Key differences vs. Cowork version:
- No request_cowork_directory calls — Claude Code has direct Windows filesystem access
- No /sessions/*/mnt/ paths anywhere — all paths are Windows pathlib
- Uses `python` not `python3` (Windows PATH in Claude Code)
- OTTERQUOTE-DEPLOY EDIT RULES: direct pathlib.Path.write_text() for file operations
  The FUSE/bindfs truncation issue (Cowork-specific) does NOT apply here.
  However, the Post-Write Integrity Check still runs — it catches other corruption classes.
- commit_via_api.py path updated to Windows Tools location
- REPO_ROOT = C:\Users\Dustin Stohler\otterquote-platform (local clone, first cloned 2026-05-18)
- Handoff protocol added (writes to REPO_ROOT/handoffs/ at session end)
- Sub-agents used for read-only inspection passes (Layer 1 sweep, Layer 7 production sync)
  Sub-agents cannot modify memory files — parent handles all issue writes
-->

# Forge (Claude Code) — OtterQuote Site Compliance & Repair Loop

**Trigger phrases:** `run forge`, `forge run`, `/forge`, `compliance check`, `check the site`, `fix the site`, `site audit`, `compliance sweep`, `run a compliance pass`

**Purpose:** Autonomously test the OtterQuote website against all documented decisions (D-numbers), identify gaps, fix them, redeploy, and retest — looping until the compliance gap is minimized. Dustin reviews the finished product. Everything he finds after Forge completes is either (a) a missing documented decision or (b) an area for Forge improvement.

**Mode:** Full compliance+fix mode (default for manual invocations). See **Scout Mode** section below for scheduled/read-only mode (R-042).

---

## Path Constants

```python
import pathlib

REPO_ROOT        = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform")
CLAUDE_DOWNLOADS = pathlib.Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads")
MEMORIES_DIR     = CLAUDE_DOWNLOADS / "Claude's Memories"
TOOLS_DIR        = CLAUDE_DOWNLOADS / "Stellar Edge Services" / "OtterQuote" / "Tools"
SKILLS_OUTPUT    = CLAUDE_DOWNLOADS / "Skills Output"
HANDOFFS_DIR     = REPO_ROOT / "handoffs"

# Forge-specific
DEPLOY_DIR       = REPO_ROOT           # local clone IS the deploy dir
SUPABASE_FUNCS   = REPO_ROOT / "supabase" / "functions"
CODE_MAP_PATH    = CLAUDE_DOWNLOADS / "Stellar Edge Services" / "OtterQuote" / "Docs" / "code-map.json"
```

> **Windows runtime note:** `python3` is NOT on PATH. Use `python` (resolves to `C:\Python314\python.exe`, Python 3.14.0). All bash commands and inline scripts use `python`, not `python3`.

---

## OTTERQUOTE-DEPLOY EDIT RULES (Claude Code)

- **Direct file writes.** Use `pathlib.Path.write_text(content, encoding='utf-8')` — no /tmp staging, no FUSE workarounds. Claude Code writes directly to the Windows filesystem.
- **No bindfs truncation risk.** The Cowork FUSE/bindfs truncation issue does NOT apply to Claude Code's direct filesystem access. However, run the Post-Write Integrity Check after every write — it catches other corruption classes (null bytes, encoding errors, JS brace imbalance).
- **Python binary.** Always `python` — not `python3`. Claude Code runs on Windows.
- **commit_via_api.py** is the deploy chain. Path: `TOOLS_DIR / "commit_via_api.py"`. Import via `sys.path.insert(0, str(TOOLS_DIR))`.
- **Deploy target.** `REPO_ROOT` (local clone). `working_dir=str(REPO_ROOT)`.
- **Edge Functions.** Deploy via Supabase CLI — NOT the MCP `deploy_edge_function` tool. See Phase 3 for CLI invocation.
- **SKILL.md files in Skills Output/ are read-only.** Owned by the Cowork skill system. Changes require Dustin R-013 upload.

---

## Core Principles

**1. D-number = authorized.** If a documented decision (D-number) covers it, implement it autonomously — regardless of technical complexity, regardless of D-182 tier. The tiers were designed to prevent unilateral business decisions. If a D-number exists, the business decision is already made. The fix is purely engineering.

**2. Plan internally, execute continuously.** Forge plans before it acts — but the plan is internal. Never stop to ask Dustin to review the plan. Plan, then immediately execute.

**3. Batch all blockers.** When Forge encounters a blocker (undocumented business decision needed, credentials unavailable, attorney-review-gated copy), note the blocker and continue the queue. Never stop for a single blocker. Surface ALL blocked items together in one consolidated message after the entire queue is exhausted.

**4. Three and only three legitimate stop conditions:**
- An undocumented business decision is required (no D-number exists, and the correct answer requires Dustin's judgment)
- Credentials or external service access are unavailable and cannot be worked around
- Copy is specifically flagged attorney-review-gated in the D-number record

**5. No Forge Plan mode for Dustin.** If Forge needs a plan-first mode to perform better (it does), that planning is internal. Dustin does not review or approve plans during Forge execution.

---

---

## Scout Mode — Scheduled Read-Only Scan (R-042)

**R-042 mandate:** Scheduled Forge runs (via Windows Task Scheduler `run-forge.ps1`) MUST run in scout-only mode. They scan all 12 layers, file findings as GitHub issues, write done and handoff files — and make NO code changes and NO deploys.

**Mode detection — read immediately on load:**

| Signal | Mode |
|--------|------|
| Prompt contains `scout mode`, `--scout`, `scout-only`, or `read-only scan` | **Scout Mode** |
| Prompt was passed via `run-forge.ps1` (contains "scout mode" in prompt text) | **Scout Mode** |
| Manual `run forge` / `forge run` / `/forge` / any standard trigger phrase (no scout signal) | **Full Mode** |

**When in Scout Mode:** Skip Phase 0, Phase 2, Phase 3, Phase 4, Phase 6. Run Phase 1 (all 12 layers) in read-only mode only. Then execute the Scout Mode Output Protocol below.

---

### Scout Mode Output Protocol

**Step 1 — Run Phase 1 (all 12 layers) in read-only mode.** No file writes, no deploys, no `commit_via_api`, no `supabase functions deploy`. Smoke tests (Layer 6) may be run read-only (HTTP checks only — no state changes).

**Step 2 — Classify each finding:**

| Color | Meaning | Scout Action |
|-------|---------|-------------|
| GREEN | Compliant — no action needed | Log in done file only (no issue) |
| YELLOW | Gap exists, fix is non-blocking | File GitHub issue, `should` |
| RED | Gap exists, fix is urgent | File GitHub issue, `must` |
| GRAY | Cannot verify without live credentials | Log in done file only (no issue) |

**Step 3 — File one GitHub issue per RED or YELLOW finding:**

Findings from this skill are ENGINEERING findings, so they go to GitHub Issues on
`StellarEdgeServices/otterquote-platform` and nowhere else. Filing them to ClickUp is
prohibited by R-098 and R-157 — ClickUp has been personal/CEO-facing-only since
2026-08-24 and has no engineering reader, so a task filed there accumulates unseen.
This skill wrote to ClickUp list `901711730553` until gh-1362, where a Forge finding
was cross-filed as `86e3186vw` and sat in a queue nobody reads. Only an item needing a
Dustin decision or physical action belongs on the CEO board, and a compliance finding
is not that.

```python
# Issue title convention (mandatory):
issue_title = f"[FORGE SCOUT] [{severity}] — {description}"
# Examples:
# "[FORGE SCOUT] [RED] — D-087 'lead' copy violation in contractor-bid-form.html"
# "[FORGE SCOUT] [YELLOW] — Layer 10: submit-bid Edge Function missing idempotency marker"

# Search open issues FIRST and dedup — a repeat scan of an unfixed finding must
# comment on the existing issue, not open a second one.
#
# GitHub issue fields:
# repo:   StellarEdgeServices/otterquote-platform
# title:  issue_title (format above, mandatory)
# labels: ["env:code", "line:otterquotes", "forge-finding",
#          "must" if RED else "should",
#          size label, and an `exec:` owner — an issue filed with no `exec:`
#          label is an ORPHAN and is invisible until an executive run sweeps
#          for it (gh-1362 sat orphaned for 9 hours for exactly this reason).]
# body: (
#     f"**Layer {layer_num} — {layer_name}**\n\n"
#     f"**Finding:** {detail}\n\n"
#     f"**File(s):** {file_paths}\n\n"
#     f"**D-Number:** {d_number or 'N/A'}\n\n"
#     f"*Filed by Forge Code Scout Mode — {date_str}*"
# )
```

**Step 4 — Write done file (R-044):**

Write `In Flight/done/<session-thread-id>.md` (max 4 KB, no file contents pasted):

```
# Forge-Code Scout Done — <thread-id>
session_type: FORGE SCOUT
completed_at: <ISO UTC>
mode: scout-only (R-042)

## Findings Summary
Layer 1 (D-Numbers): RED: N, YELLOW: N, GREEN: N
Layer 2 (Copy): RED: N, YELLOW: N, GREEN: N
Layer 3 (JS Health): RED: N, YELLOW: N, GREEN: N
Layer 4 (Structural): RED: N, YELLOW: N, GREEN: N
Layer 5 (Pages Spec): RED: N, YELLOW: N, GREEN: N
Layer 6 (Smoke Tests): RED: N, YELLOW: N, GREEN: N
Layer 7 (Prod Sync): RED: N, YELLOW: N, GREEN: N
Layer 8 (React Parity): RED: N, YELLOW: N, GREEN: N
Layer 9 (Cross-Ref): RED: N, YELLOW: N, GREEN: N
Layer 10 (Latent Bugs): RED: N, YELLOW: N, GREEN: N
Layer 11 (Arch Coherence): RED: N, YELLOW: N, GREEN: N
Layer 12 (Post-Write Scan): RED: N, YELLOW: N, GREEN: N

## GitHub Issues Filed
[List issue numbers and titles — or "None"]

## GRAY Items (unverifiable without live credentials)
[List or "None"]

## Summary
<one paragraph: layers scanned, total findings, GitHub issues created>
```

**Step 5 — Write handoff file** (same template as Phase 6, with `Run type: FORGE SCOUT` and no Commits section).

**Step 6 — Terminate.** Do NOT attempt any fixes. Do NOT run Phase 2, 3, 4, or 6.

## Pre-Run Checklist (Before Starting Any Phase)

### 0. Sync local repo with origin/main (run before reading memory files)

```python
import subprocess, pathlib
REPO_ROOT = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform")

fetch = subprocess.run(["git", "fetch", "origin", "main"], cwd=str(REPO_ROOT), capture_output=True, text=True)
if fetch.returncode == 0:
    behind = subprocess.run(["git", "rev-list", "--count", "HEAD..origin/main"], cwd=str(REPO_ROOT), capture_output=True, text=True)
    n = int(behind.stdout.strip() or "0")
    if n > 0:
        print(f"Repo is {n} commit(s) behind — pulling with rebase...")
        pull = subprocess.run(["git", "pull", "--rebase", "origin", "main"], cwd=str(REPO_ROOT), capture_output=True, text=True)
        print("Sync complete." if pull.returncode == 0 else f"[WARN] pull failed: {pull.stderr.strip()}")
    else:
        print("Local repo up to date with origin/main.")
else:
    print(f"[WARN] git fetch failed: {fetch.stderr.strip()} — proceeding with local state")
```


Read these files before proceeding:

1. `MEMORIES_DIR / "otterquote-memory.md"` — current platform state, deploy procedures, smoke test location, known issues
2. `MEMORIES_DIR / "otterquote-reference.md"` — D-number master index
3. `MEMORIES_DIR / "otterquote-ref-product.md"` — product decisions (D-numbers)
4. `MEMORIES_DIR / "otterquote-ref-platform.md"` — platform/deploy decisions
5. `MEMORIES_DIR / "otterquote-ref-legal.md"` — legal decisions
6. `MEMORIES_DIR / "otterquote-ref-marketing.md"` — marketing/copy decisions
7. `MEMORIES_DIR / "otterquote-pages.md"` — page-by-page spec (authoritative source for what each page should contain)
8. `CODE_MAP_PATH` — indexed cross-reference map (for Layer 9; regenerate if older than 7 days)

Do not skip any of these. Forge is only as good as the decisions it knows about.

---

## Phase 0 — Pre-Authorization Audit

**Goal:** Identify everything Forge will touch before touching anything. Produce one consolidated request to Dustin. Wait for greenlight before any code changes.

**Steps:**

1. Read all memory files listed above.
2. Build a complete list of compliance items to check (see Phase 1 for the checklist layers).
3. Identify any items that will require Dustin's input BEFORE work can begin (credentials Forge will need, items that seem undocumented, attorney-gated copy).
4. Produce a single, scannable Pre-Authorization Message:

```
FORGE PRE-AUTHORIZATION

Items I will fix autonomously: [count]
Items I need from you before starting: [list]
Items I will flag at the end (cannot fully verify): [list]

Do you want me to proceed?
```

5. Wait for Dustin's greenlight before Phase 1.

**Exception:** If there are zero items requiring pre-authorization input, skip Phase 0 and start Phase 1 directly. Note this in the run log.

---

## Phase 1 — Build Compliance Checklist

**Goal:** Enumerate every compliance item across all layers. Produce an internal checklist. Do not show Dustin.

### Layer 1: D-Number Compliance

Map every active D-number to the file(s) it affects. For each D-number, ask:
- Is the correct behavior implemented in the current codebase?
- If it involves copy (user-facing text), does the copy match the decision?
- If it involves a UI flow, does the flow match the decision?
- If it involves a data model, does the schema match the decision?

Active D-numbers to check (from otterquote-reference.md — load the domain files for detail):
- All Active D-numbers from D-011 through the current highest D-number (update this ceiling each Forge run — do not hardcode)
- Skip all Superseded and Permanently Tabled D-numbers
- Flag all Deferred D-numbers (D-021, D-117) — do not implement, but note they are deferred

**Edge Function existence check:** When a D-number references a specific Edge Function by slug, verify that function exists and has status ACTIVE:
```bash
SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" supabase functions list --project-ref yeszghaspzwwstvsrioa
```
Flag as Red if a D-number-referenced function is missing or not ACTIVE.

**D-159 fee display compliance check:** Grep `bids.html` for the code that renders `fee_percentage` to the homeowner. Verify the render path caps the display value at 5% — look for `Math.min` or equivalent guard. If `fee_percentage` is rendered directly from the DB value without a cap, flag as Red.

```bash
grep -n "fee_percentage" bids.html
```
Confirm display is capped: `Math.min(Number(bid.fee_percentage), 5)` or equivalent. Flag Red if raw DB value is displayed.

**D-163 retail parity compliance check:** Grep `contractor-bid-form.html` for `renderInsuranceLineItems`. Verify the function contains an `isRetailJob` guard early in its body — insurance line items must never render for retail/cash jobs. Also grep `updateClaimSummary` — verify carrier name (`carEl`) is only set when `!isRetailJob`.

```bash
grep -A 10 "function renderInsuranceLineItems" contractor-bid-form.html | grep "isRetailJob"
grep -n "carEl.*textContent" contractor-bid-form.html
```
If Check 1 returns empty, flag Red. If Check 2 shows `carEl.textContent = carrierName` without `&& !isRetailJob`, flag Red.

**D-210/D-213 WC card compliance check:**

1. **WCE-1 path must have file upload (D-213):** The exemption radio option (`value="exemption"`) must reveal a div containing a file input and an expiry date field. A sentinel-only path (`wc_cert_file_ref = 'WCE-1-EXEMPT'` with no real upload) is non-compliant.
   ```bash
   grep -n "wce1-file-section\|wce1-upload\|wce1-expiry" contractor-pre-approval.html
   grep -n "WCE-1-EXEMPT" contractor-pre-approval.html
   ```
   If any of those IDs are absent, flag Red. If `'WCE-1-EXEMPT'` appears as a hardcoded value being written to `updateObj.wc_cert_file_ref`, flag Red.

2. **WC expiry must be required (D-210):** The expiry field label must NOT contain the word "optional".
   ```bash
   grep -n "wc-expiry\|Expiry Date" contractor-pre-approval.html
   ```
   If the label contains "(optional)" adjacent to expiry, flag Red.

3. **Light-card radio label text must use explicit dark colors:** Any `<span>` inside a `<label>` inside a `.doc-card` must use an explicit dark hex color — NOT `color: var(--navy)`. CSS variables can fail to resolve at the element level.
   ```bash
   grep -n "color: var(--navy)" contractor-pre-approval.html
   ```
   Any match inside a radio `<label>` element's inner `<span>` is Red — replace with hardcoded `#1e293b` or equivalent.

**DB constraint alignment check — quotes.status:** Grep all HTML/JS files for `.update({ status:` or `update({ status:`. Verify no file sets `quotes.status` to an invalid value. Known invalid values: `'awarded'`, `'accepted'`, `'rejected'`, `'pending'`. Valid values: `['draft', 'submitted', 'selected', 'declined', 'expired']`.

```bash
grep -rn "status.*awarded\|status.*accepted\|status.*rejected\|status.*pending" --include="*.html" --include="*.js" .
```
Any match in a context that updates `quotes` is Red. (Note: `claims.status` does NOT have a check constraint.)

### Layer 2: Copy Compliance Sweep

Grep every HTML, JS, and Edge Function file for violations of:

| Rule | D-Number | Banned terms |
|------|----------|-------------|
| No "lead/leads" in user-facing context | D-087 | lead, leads |
| No "vetted/approved/endorsed" contractor language | D-104 | vetted, approved, endorsed |
| No "certified/licensed" overclaims | D-167 | "certified contractors", "licensed contractors" (check context) |
| No response-time claims | D-168 | "respond within", "responds in", response time guarantees |
| Indiana-only positioning | D-169 | Claims of serving multiple states in marketing copy |
| Display name = "Otter Quotes" (two words) | D-175 | "OtterQuote" in user-facing headings and marketing copy |

### Layer 3: JS Health Sweep

For every JS file:
- Run `node --check [file]` to validate syntax
- Grep for onclick handlers referencing functions not defined in the file or its imports
- Grep for `document.getElementById()` and `document.querySelector()` calls — verify target IDs/selectors exist in corresponding HTML
- Check for duplicate `id=` attributes within each HTML file
- Check for script `src=` references — verify the source files exist

**Supabase auth timing check:** Grep all HTML/JS files for `addEventListener.*DOMContentLoaded`. For each match, check if the callback invokes `sb.auth.getSession()` or `supabase.auth.getSession()`. If so, flag as Red — this is the Supabase JS v2 race condition. The correct pattern is `sb.auth.onAuthStateChange(async (event, session) => { if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') { ... } })` with a `_initFired` boolean guard to prevent double-call.

**Auth.getSession() INITIAL_SESSION null guard check:** Grep `js/auth.js` for the `INITIAL_SESSION` null-finish condition inside `getSession()`. The guard must use `!session` — NOT `!hasStoredSession` — as the null-resolution predicate.

```bash
grep -n "INITIAL_SESSION" js/auth.js
```

Read the `finish(null)` call site. Correct pattern: `event === 'INITIAL_SESSION' && !session && !hasAuthInUrl`. If the condition contains `!hasStoredSession` instead of `!session`, flag as Red and replace accordingly.

**cookie-storage.js load order check:** For every HTML file that loads `js/config.js`, verify: (1) `js/cookie-storage.js` also appears in the file, and (2) it appears on an earlier line than config.js.

```python
import pathlib

deploy = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform")
missing = []
order_bugs = []
for f in deploy.glob("*.html"):
    lines = f.read_text(encoding="utf-8", errors="ignore").splitlines()
    cfg_ln = next((i for i, l in enumerate(lines) if "config.js" in l), None)
    cks_ln = next((i for i, l in enumerate(lines) if "cookie-storage.js" in l), None)
    if cfg_ln is not None and cks_ln is None:
        missing.append(f.name)
    elif cfg_ln is not None and cks_ln is not None and cks_ln > cfg_ln:
        order_bugs.append(f.name)

if missing:
    print("MISSING cookie-storage.js:", missing)
if order_bugs:
    print("ORDER BUG (loads after config.js):", order_bugs)
if not missing and not order_bugs:
    print("PASS")
```

Flag as Red any page where config.js is present but cookie-storage.js is missing or loads after it.

**Supabase storage bucket existence check:** Grep all HTML/JS files for `.storage.from('...')` calls and extract every bucket name referenced in code. Then verify each name against the actual Supabase project bucket list.

```python
import pathlib, re

deploy = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform")
buckets = set()
for ext in ("*.html", "*.js"):
    for f in deploy.rglob(ext):
        for m in re.findall(r"\.storage\.from\('([^']+)'\)", f.read_text(encoding="utf-8", errors="ignore")):
            buckets.add(m)
print("Buckets referenced in code:", sorted(buckets))
# Then verify each against: SELECT name FROM storage.buckets ORDER BY name;
```

Known-good buckets: `cert-letters`, `claim-documents`, `contractor-documents`, `contractor-templates`, `e2e-artifacts`, `partner-photos`. Flag Red for any bucket name in code not in this list.

**config.js window-attachment check:** Grep `js/config.js` for `^const CONFIG`. If found, flag as Red — `const` declarations do not attach to `window`. Must be `var CONFIG`.

**CSS contrast check:** Grep all inline `<style>` blocks for `color: var(--navy)` appearing inside any rule whose selector includes `.selected`, `.active`, or any state with a dark background. Flag Yellow — dark navy text on dark background is invisible.

**Literal non-ASCII encoding check:** Grep all HTML files for literal multi-byte UTF-8 characters (`—`, `–`, `…`). If found, flag Yellow. Fix: verify `netlify.toml` has `charset=UTF-8` (Layer 4 primary fix), then convert to HTML entities in content regions (not inside `<script>` or `<style>` blocks).

```bash
grep -rn "—\|–\|…" --include="*.html" .
```

### Layer 4: Structural Sweep

For every HTML file:
- Confirm valid closing `</html>` tag
- Confirm no truncated content (file ends cleanly)
- Confirm all linked CSS files exist
- Confirm all linked image/asset files exist

**Null-byte sweep (v2.6 extended):** Check ALL text-source files for null-byte contamination before deploying any fix:

```python
import pathlib

deploy = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform")
extensions = ('.html', '.js', '.css', '.json', '.ts', '.toml', '.txt', '.svg')
hits_full = []
hits_tail = []
for ext in extensions:
    for f in deploy.rglob(f"*{ext}"):
        try:
            content = f.read_bytes()
            rel = str(f.relative_to(deploy))
            if b'\x00' in content:
                hits_full.append(rel)
            tail = content[-1024:] if len(content) > 1024 else content
            if b'\x00' in tail and rel not in hits_full:
                hits_tail.append(rel)
        except Exception:
            pass
if hits_full or hits_tail:
    if hits_full:
        print("RED — null bytes detected in:", hits_full)
    if hits_tail:
        print("RED — null bytes in file TAIL (truncation signature) in:", hits_tail)
else:
    print("PASS — no null bytes detected")
```

Flag as RED any file containing null bytes. In Claude Code, re-fetch from the GitHub API or from the local git history (`git checkout HEAD -- <file>`) and rewrite using `pathlib.Path.write_text()`.

**Git remote URL check:** From `REPO_ROOT`, run `git remote get-url origin` and assert the URL contains `otterquote-platform`. If it contains `claimshield-platform` or any other repo name, flag as Red.

**netlify.toml charset check:** Verify that `netlify.toml` exists in `REPO_ROOT` AND contains a `[[headers]]` block with `for = "/*.html"` and `Content-Type` value containing `charset=UTF-8`.

### Layer 5: otterquote-pages.md Spec Sweep

Load `MEMORIES_DIR / "otterquote-pages.md"`. For every page defined in the spec:
- Does the page exist at the expected URL/filename?
- Does it contain the required sections/elements specified?
- Does it display the correct user roles (homeowner vs. contractor routing per D-072)?

### Layer 6: Smoke Test Baseline

```bash
cd "C:\Users\Dustin Stohler\otterquote-platform"
bash scripts/smoke-test.sh
```

Note all 4 deploy-gate tests (homepage 200, Supabase auth health, Edge Function not-500, Stripe reference present). All 4 must pass before continuing.

**Important:** This is the entire automated deploy gate. Layers 1–5 plus Layers 7–12 below are what produce real coverage; smoke-test.sh is intentionally lightweight.

---

### Layer 7: Production Sync Check

**Goal:** Detect drift between the live production site and the local source of truth.

**Target pages:** public marketing surface only. Authoritative list at `SKILLS_OUTPUT / "forge-layer-7-targets.txt"`.

**Extracts to compare:** `<title>`, `<meta name="description">`, all OG tags, all h1-h3 text, all ld+json blocks, brand-mention count.

**Classification:** GREEN (match) / YELLOW (whitespace/formatting only) / RED (semantic difference).

**On RED:** Determine drift direction (local-ahead vs production-ahead vs bidirectional). Local-ahead → deploy. Production-ahead or bidirectional → STOP, log error, surface to Dustin.

---

### Layer 8: React vs. Static HTML Parity

**Goal:** For each page that has been migrated to the React app surface, verify that the React output is functionally and visually equivalent to the static HTML source before the static page is retired.

**When to run:** Any Forge pass that occurs after a D-211 React page has been shipped to staging or production. Skip silently if `react-migration-parity.md` has no entries yet.

**Manifest source:** `CLAUDE_DOWNLOADS / "Stellar Edge Services" / "OtterQuote" / "Docs" / "react-migration-parity.md"`

Each entry follows the format:
```
| Page slug | Static URL | React URL | Auth required | Status |
|-----------|-----------|-----------|---------------|--------|
| get-started | https://otterquote.com/get-started.html | https://app.otterquote.com/get-started | no | in-progress |
```

Run Layer 8 only for entries with `Status = in-progress`.

**Procedure (per page):**

1. **Load static page.** Use web fetch on the static URL. Confirm HTTP 200. Extract: page `<title>`, all `<h1>/<h2>/<h3>` text, all `<button>/<a class="btn">` labels, GA4 event calls in inline `<script>` blocks, Supabase insert/update calls.

2. **Load React page.** Use web fetch on the React URL. Confirm HTTP 200. Extract the same elements. Note: if Next.js client-only (no SSR), web fetch returns a shell — flag Yellow, visual verification via Claude in Chrome required.

3. **Auth guard check:** Attempt to load the React URL without auth cookies. If page requires auth: confirm redirect to login. Mismatch between static and React auth behavior → flag Red.

4. **Classification:**
   - **GREEN:** All headings/CTAs/form fields present and matching; no console errors; auth guard matches; GA4 events present.
   - **YELLOW:** Minor visual differences; non-critical console warnings; GA4 events present but wording differs slightly.
   - **RED:** Missing critical form field, missing CTA, auth guard mismatch, JS errors on load, Supabase call missing.
   - **GRAY:** Auth session required to verify; or React page is client-only shell with no SSR content.

5. **On GREEN:** Update the page's `Status` in `react-migration-parity.md` to `parity-verified`.

6. **On RED:** Block Phase 2 cutover. Comment the specific finding on the relevant GitHub issue.

---

### Layer 9: Cross-Reference / Call-Graph Validation

**Depends on:** `CODE_MAP_PATH` (generated by scheduled task; see task 86e17x7bv).

**Goal:** Before deploying a change that modifies an Edge Function, SQL table, or shared JS module, validate that the change doesn't break documented cross-references.

**Code map freshness check:**
```python
import json, datetime, pathlib

code_map_path = pathlib.Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads\Stellar Edge Services\OtterQuote\Docs\code-map.json")
cm = json.loads(code_map_path.read_text(encoding="utf-8"))
generated = datetime.date.fromisoformat(cm['generated'])
age_days = (datetime.date.today() - generated).days
if age_days > 7:
    print(f"WARNING: code-map.json is {age_days} days old — regenerate before running Layer 9")
```

**Procedure:**
1. Load `code-map.json` and index by entity name.
2. For each proposed fix modifying an Edge Function, SQL table, or shared JS module:
   - **Edge Function:** Look up in `edge_functions[]` → find `called_by_pages` and `called_by_functions` → verify change is backward-compatible
   - **SQL table:** Look up in `sql_tables[]` → verify column additions have defaults, removals don't break callers, renames are propagated
   - **Shared JS module:** Cross-reference in `pages[]` → verify function names and global variable exports are preserved

3. **Classify:** RED (breaks documented cross-reference, block) / YELLOW (modifies surface callers depend on) / GREEN (no impact).

---

### Layer 10: Latent Bug Probe

**Goal:** Probe for bug classes that haven't manifested yet — the holes Sentry won't catch until a user hits them.

**Checks:**

1. **Edge Function input validation.** For each Edge Function, grep for the request body parse line (`await req.json()`). Verify the next ~30 lines include explicit guards on every required field. Functions that pass parsed input straight into Stripe/DocuSign/Hover/Supabase write without guards → flag Red.

   ```bash
   for fn in supabase/functions/*/index.ts; do
     grep -n "req\.json\(\)" "$fn" && head -n 40 "$fn"
   done
   ```

2. **Error response presence.** Every Edge Function entrypoint must be wrapped in a try/catch that returns a structured JSON error (`{ error: string, code?: string }`) with HTTP status >= 400. Functions with no top-level try/catch → flag Red.

3. **Idempotency on mutating Edge Functions.** Any Edge Function that creates a chargeable or signed artifact must either (a) accept and check an idempotency key, (b) rely on a unique DB constraint, or (c) carry an explicit `// idempotent: [reason]` comment. Missing all three → flag Yellow.

4. **Empty-state UI branches.** For each page that lists records — `bids.html`, `dashboard.html`, `admin-payouts.html`, `contractor-bid-form.html` — verify the render path has a visible `if (rows.length === 0)` branch with a user-facing empty-state message. Pages that just render an empty `<div>` on no-results → flag Yellow.

5. **Stale-state refresh after mutations.** For each page with status-changing actions (accept bid, sign contract, mark complete, cancel), verify the success handler either refetches the underlying data or explicitly updates the affected DOM. Pages that mutate and don't refresh → flag Yellow.

**Classification:** RED (missing top-level try/catch; raw user input to Stripe/DocuSign/Hover/Supabase write) / YELLOW (missing input guard, missing idempotency, missing empty-state) / GRAY (minimal but present validation — informational only).

---

### Layer 11: Architecture Coherence

**Goal:** Verify that `Docs/architecture.md` reflects the current state of the deployed codebase.

**Checks:**

1. **Commit SHA currency.**
   ```bash
   arch_sha=$(grep 'Commit SHA' Docs/architecture.md | grep -oP '[0-9a-f]{40}')
   repo_sha=$(git rev-parse HEAD)
   [ "$arch_sha" = "$repo_sha" ] && echo GREEN || echo "YELLOW: arch=$arch_sha repo=$repo_sha"
   ```

2. **Edge Function count.** Count `supabase/functions/` subdirectories; compare to count in architecture.md Section 4. Delta > 0 → Yellow.

3. **D-number index completeness.** Highest D-number in `otterquote-ref-*.md` must appear in architecture.md Section 8. Missing → Yellow.

---

### Layer 12: Post-Write Truncation Scan

**Goal:** Detect files that were silently truncated before those bytes reach a commit.

**Checks:**

1. **Size regression vs. git history.** Files where current size < 60% of last committed size with no corresponding feature-removal → flag Red.
   ```bash
   git ls-files '*.html' '*.js' '*.css' | while read f; do
     curr=$(wc -c < "$f")
     prev=$(git show HEAD:"$f" 2>/dev/null | wc -c || echo 0)
     [ "$prev" -gt 0 ] && [ "$curr" -lt $(( prev * 60 / 100 )) ] && echo "REGRESSION: $f curr=$curr prev=$prev"
   done
   ```

2. **Null-byte scan on working tree.** (Same script as Layer 4 — run against full working tree.)

3. **Zero-byte file check.** Any tracked file with 0 bytes → flag Red.
   ```bash
   git ls-files | xargs -I{} bash -c '[ ! -s "{}" ] && echo "ZERO BYTES: {}"'
   ```

**Fix action for RED truncation:**
1. Restore from git: `git checkout HEAD -- <file>`
2. Restore from GitHub API: `GET /repos/StellarEdgeServices/otterquote-platform/contents/<path>` + decode base64 content
3. Restore Edge Functions: `supabase functions download [slug] --project-ref yeszghaspzwwstvsrioa`
4. After restore, run null-byte + size check before re-committing

---

## Phase 2 — Internal Fix Plan

**Goal:** Classify every compliance item found in Phase 1. Produce an internal execution plan. Do not show Dustin.

| Color | Meaning | Action |
|-------|---------|--------|
| Green | Gap confirmed, fix is clear, no blocker | Fix immediately |
| Yellow | Gap confirmed, fix requires investigation | Fix with extra care |
| Red | Gap confirmed, but blocked | Queue for Phase 5 |
| Gray | Cannot verify without live credentials | Note in Phase 5 |

**Fix ordering:** Copy violations → Structural → JS health → Feature/flow gaps → Schema/data model gaps → Latent bug guards (Layer 10).

---

## Phase 3 — Fix Loop

**Goal:** Execute all Green and Yellow fixes. Deploy. Run smoke tests. Loop if tests fail.

### Write Method (Claude Code)

In Claude Code, write directly with `pathlib.Path.write_text()` — no /tmp staging, no shutil.copy2 workaround (that was a Cowork FUSE-specific pattern). However, the Post-Write Integrity Check still runs after every write.

```python
import pathlib

# Example: write a patched HTML file
target = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform\bids.html")
target.write_text(new_content, encoding="utf-8")
# Then run Post-Write Integrity Check (see below) before git add
```

### Post-Write Integrity Check

**When this runs:** After every file write via `pathlib.Path.write_text()` during Phase 3. Executes BEFORE commit.

```python
import pathlib, sys

def check_file_integrity(filepath, original_size=None, expected_domcontentloaded=False):
    """
    Post-write integrity validation.
    Returns: (pass: bool, message: str)
    """
    fp = pathlib.Path(filepath)

    # Check 1: Null bytes
    try:
        content = fp.read_bytes()
        if b'\x00' in content:
            byte_count = content.count(b'\x00')
            return False, f'FAIL: {byte_count} null bytes in {filepath}'
    except Exception as e:
        return False, f'FAIL: cannot read {filepath} ({e})'

    # Check 2: Truncated HTML
    if filepath.endswith('.html'):
        try:
            tail = fp.read_bytes()[-500:].decode('utf-8', errors='ignore').lower()
            if '</html>' not in tail:
                return False, f'FAIL: truncated HTML in {filepath}'
        except Exception as e:
            pass  # WARN only

    # Check 3: File size delta
    if original_size and original_size > 100:
        new_size = fp.stat().st_size
        if new_size < (original_size * 0.5):
            print(f'WARN: file size dropped from {original_size} to {new_size} bytes')

    # Check 4: JS brace balance (heuristic)
    if filepath.endswith('.js'):
        try:
            code = fp.read_text(encoding='utf-8', errors='ignore')
            if code.count('{') != code.count('}'):
                print(f'WARN: brace imbalance in {filepath}')
        except Exception:
            pass

    # Check 5: DOMContentLoaded retention
    if filepath.endswith('.html') and expected_domcontentloaded:
        try:
            if 'DOMContentLoaded' not in fp.read_text(encoding='utf-8', errors='ignore'):
                return False, f'FAIL: DOMContentLoaded removed from {filepath}'
        except Exception:
            pass

    return True, f'PASS: {filepath} integrity verified'

# Usage during Phase 3 fix loop:
# 1. Before write: had_dom = 'DOMContentLoaded' in target.read_text(encoding='utf-8', errors='ignore')
# 2. Write: target.write_text(new_content, encoding='utf-8')
# 3. Check: passed, msg = check_file_integrity(str(target), original_size=original_size, expected_domcontentloaded=had_dom)
# 4. If not passed: re-fetch from git / GitHub API, re-write, re-check
```

### Deploy via commit_via_api.py (D-221)

```python
import sys, pathlib

tools_dir = pathlib.Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads\Stellar Edge Services\OtterQuote\Tools")
sys.path.insert(0, str(tools_dir))
from commit_via_api import commit_files

result = commit_files(
    file_paths=changed_files,           # list of absolute path strings that were changed
    commit_message=commit_msg,          # e.g. "[Forge-Code v1.0] Fix: <D-number> <description>"
    branch="main",
    working_dir=r"C:\Users\Dustin Stohler\otterquote-platform"
)
if not result["success"]:
    raise RuntimeError(f"commit_files failed: {result['error']}")
print(f"Committed: {result['sha']}")
```

**Revert on failure:** If smoke tests fail post-commit, use `commit_via_api.revert_commit(sha=result['sha'], branch='main', working_dir=...)` to restore the previous state before filing the failed entry.

**Edge Function deploy:**
```bash
cd "C:\Users\Dustin Stohler\otterquote-platform"
SUPABASE_ACCESS_TOKEN="$SUPABASE_ACCESS_TOKEN" supabase functions deploy [slug] --project-ref yeszghaspzwwstvsrioa --no-verify-jwt
```

**CRITICAL:** Never deploy Edge Functions via Management API POST with TypeScript body — causes BOOT_ERROR.

**After every deploy:** Run `bash scripts/smoke-test.sh` from REPO_ROOT. All 4 tests must pass before continuing.

---

## Phase 4 — Retest Loop

After all Green/Yellow fixes deployed and smoke tests pass, re-run all 12 checklist layers against current deployed files. Loop until only Red and Gray items remain, then proceed to Phase 5.

---

## Phase 5 — Batch Blocked Items

**ACTIVE PRODUCTION FAILURE ROUTING (Layer 6 / Layer 7):**
If Layer 6 smoke tests fail OR Layer 7 returns RED with no corresponding local change, flag explicitly:

```
ACTIVE PRODUCTION FAILURE — invoke Bug Killer before next Forge sweep
Layer: [6 or 7]
Evidence: [specific failing test / production URL / HTTP status / diff excerpt]
```

Bug Killer requires observable evidence. The smoke test failure output or Layer 7 production response IS that evidence — include it verbatim in the Bug Killer handoff note. Do not attempt to fix active production failures inside Forge's Phase 2/3 loop.

Surface all remaining blocked items in one consolidated message:

```
FORGE COMPLETE — BLOCKED ITEMS REQUIRING YOUR INPUT

Run summary: [X] fixed, [Y] smoke tests passing, [Z] blocked

BUSINESS DECISIONS NEEDED (no D-number exists): ...
CREDENTIALS/ACCESS REQUIRED: ...
ATTORNEY-REVIEW-GATED COPY: ...
PERMANENTLY UNVERIFIABLE: DocuSign signing, Stripe payment, Twilio SMS, Hover OAuth, magic link email
```

---

## Phase 6 — Final Deploy and Archive

1. Run smoke tests one final time (all 4 must pass).
2. Open a GitHub issue for each blocked item: "Forge blocked: [description]" on
   `StellarEdgeServices/otterquote-platform` (R-098/R-157 — never ClickUp; see Step 3 of
   Scout Mode for the label set, including the mandatory `exec:` owner).
3. **Write done file (R-044)** to `In Flight/done/forge-code-<YYYY-MM-DD>.md`:

   ```python
   import pathlib, datetime

   inflight_done = pathlib.Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads\In Flight\done")
   inflight_done.mkdir(exist_ok=True)

   ts = datetime.datetime.now().strftime("%Y-%m-%d")
   done_path = inflight_done / f"forge-code-{ts}.md"

   done_content = f"""# Forge-Code Done — {ts}
   skill: forge-code
   completed_at: {datetime.datetime.utcnow().isoformat()}Z
   session_type: FORGE FULL

   ## Summary
   <one paragraph: what was fixed, what was blocked, smoke test result>

   ## Items Fixed: N
   <list D-numbers and descriptions — or "none">

   ## Items Blocked: N
   <list with GitHub issue numbers — or "none">

   ## Items Gray: N
   <see Known Forge Limitations section>

   ## Commits Made
   <list commit SHAs and messages — or "none">

   ## D-Number Candidates
   <decisions made that may warrant a D-number — or "none">
   """

   done_path.write_text(done_content, encoding="utf-8")
   print(f"Done file written: {done_path}")
   ```

   Done file size must be ≤ 4 KB. Do NOT paste file contents into it. ATC reads this file and compiles the session-archive entry — Forge does not write to session-archive.md directly (R-045).

4. Log proposed memory update in handoff (R-045): if `otterquote-memory.md` needs updating, write the proposed change to the handoff file under `## Memory Updates Required` — do not write directly to `otterquote-memory.md`.
5. Update `otterquote-memory.md` if any new platform state is relevant. *(Retained for manual/interactive Forge runs where Dustin is present — in scheduled/Code runs prefer handoff route per R-045.)*
6. Write handoff file (see Handoff Protocol below).

---

## Compliance Gap Definition

Forge is successful when:
- Compliance gap for Green/Yellow items = 0%
- All 4 smoke tests pass
- Layer 7 reports GREEN or YELLOW only
- Layer 9 reports no RED cross-reference violations for deployed changes
- Layer 10 reports no RED findings (no Edge Function lacks top-level try/catch; no raw user input flows into payment/signing/Supabase-write paths)
- Layer 11 reports no YELLOW findings (architecture.md commit SHA matches HEAD; Edge Function count matches documented inventory)
- Layer 12 reports no RED findings (no null bytes in working tree; no zero-byte tracked files; no >40% size regressions)
- All blocked items documented as GitHub issues

---

## Known Forge Limitations (Gray Items — Always)

1. DocuSign envelope signing flow
2. Stripe payment processing
3. Twilio SMS delivery
4. Hover OAuth token refresh
5. Magic link email delivery
6. DocuSign signing_complete auth race (E2E only)
7. Modal DOM corruption through error paths (E2E only)
8. Trade+jobType scope text concatenation redundancy (runtime data only)
9. Modal state persistence through error+retry sequences (E2E only)

---

## Relationship to Temper

Forge is the automated compliance engine. Temper is the feedback integration and self-improvement loop. If Dustin finds something after a Forge run → invoke Temper (in Cowork). Do not update this SKILL.md directly based on Forge findings — route all improvements through Temper.

---

## Handoff Protocol (Claude Code)

At session end, write a handoff file so Cowork can pick up state:

```python
import pathlib, datetime

handoffs_dir = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform\handoffs")
handoffs_dir.mkdir(exist_ok=True)

ts = datetime.datetime.now().strftime("%Y-%m-%d-%H-%M")
handoff_path = handoffs_dir / f"{ts}-forge.md"

handoff_content = f"""# Forge-Code Handoff — {ts}

## Session Summary
- Run type: Forge compliance sweep
- Items fixed: [X]
- Items blocked: [Y]
- Smoke tests: [PASS/FAIL]

## Commits Made
[List commit SHAs and descriptions]

## Blocked Items (Tier C / Undocumented)
[List with GitHub issue numbers]

## Memory Updates Required
[Any otterquote-memory.md or other file updates for Cowork to apply]

## Next Steps
[What Cowork or next Code session should pick up]
"""

handoff_path.write_text(handoff_content, encoding="utf-8")
print(f"Handoff written: {handoff_path}")
```

---

*Converted from forge-SKILL.md (Cowork v2.6 — 2026-05-08) as part of Operation Hardshell P3.S4*
*Claude Code skill version: 1.2 — Updated 2026-05-19 (added done file to Phase 6 per R-044)*
*Source backup: Skills Output/forge-code-SKILL.md*
*Sentinel: forge-code-v1.2-2026-05-19*


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

## Closeout Protocol (R-048)

Before terminating, every run of this skill MUST complete the following steps:

1. **File GitHub issues** for all recommendations, findings, and action items not already
   tracked, on `StellarEdgeServices/otterquote-platform`.
   - Search open issues first (dedup) — a repeat finding comments on the existing issue.
   - Apply `env:code`, `line:*`, `must`/`should`, a size label, and an `exec:` owner.
   - **Never file engineering work to ClickUp** (R-098, R-157). Only an item that needs a
     Dustin decision or a physical action goes to the ClickUp CEO board, and that is the
     only ClickUp write this skill may make.
2. **Write operational data** to designated log: as comments on the GitHub issue the run
   is filed under (post findings as a structured comment).
3. **Emit closing statement:** "All outputs stored. Thread safe to close."
   - If any storage step failed, open a GitHub issue describing the failure instead.

Never defer storage to the archive skill or any external process. Scheduled sessions have no archive pass.

