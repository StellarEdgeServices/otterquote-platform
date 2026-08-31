---
name: perf-doctor-code
description: "Claude Code-native performance budget enforcement for OtterQuote. Runs the fixed 12-scenario performance matrix from CTO-OS Sec. 3 against staging or production, reports pass/fail per surface with traces for failures, files GitHub issues tagged perf-regression for each fail, and falls through to bug-killer for novel regressions. Direct analog of auth-doctor-code. Trigger phrases: 'run perf-doctor', 'perf check', 'performance audit', 'check performance', 'perf matrix', 'performance budget'. Invoke proactively: post-every-deploy (Forge Layer 9), weekly comprehensive sweep, before closing any task that touched critical-path HTML/JS/CSS files or Edge Functions."
version: "1.0"
tier: A
sentinel: perf-doctor-code-v1.0-2026-05-18
---

# [perf-doctor-code v1.0]

Claude Code-native performance budget enforcement for OtterQuote. Runs the fixed 12-scenario performance matrix from CTO-OS §3 on demand against staging or production, reports pass/fail per surface, files regressions to GitHub Issues.

**Tier: A** (auto-trigger required). Master lives at `Claude Downloads/Skills Output/perf-doctor-code-SKILL.md`.

**Trigger phrases:** "run perf-doctor", "perf check", "performance audit", "check performance", "perf matrix", "performance budget", or proactively post-deploy and weekly.

---

## Path Constants

```python
from pathlib import Path
import os

# Workspace root — adjust if REPO_ROOT differs
WORKSPACE = Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads")
PERF_REPORTS_DIR = WORKSPACE / "Stellar Edge Services" / "OtterQuote" / "Engineering" / "Perf-Reports"
MEMORIES_DIR = WORKSPACE / "Claude's Memories"
PERF_BASELINES_FILE = MEMORIES_DIR / "perf-baselines.md"
HANDOFFS_DIR = WORKSPACE / "handoffs"

PERF_REPORTS_DIR.mkdir(parents=True, exist_ok=True)
HANDOFFS_DIR.mkdir(parents=True, exist_ok=True)
```

---

## When to Invoke

- On demand: any time Dustin says a trigger phrase
- Proactively (Forge Layer 9): after any deploy that touches homeowner HTML/JS/CSS, contractor dashboard, or API Edge Functions
- Weekly scheduled sweep: Fridays 8:00 AM ET (before engineering metrics package runs)
- Before closing any task tagged `perf-regression` — verify the fix actually resolved the regression

---

## Step 0 — Select Environment

In interactive mode, ask Dustin:
> "Run against staging or production?"
> - Staging: `https://staging--jade-alpaca-b82b5e.netlify.app`
> - Production: `https://otterquote.com`

Default: staging if available, production if staging is unreachable.

In scheduled/unsupervised mode: run production. Log environment in output header.

---

## Performance Matrix

Twelve scenarios across five surfaces. Run browser scenarios via Claude in Chrome using the Web Performance API and PerformanceObserver injection. Run API scenarios via timed bash `curl` calls (p90 approximated over 10 consecutive requests).

### Browser Surfaces (Scenarios 1–8)

Run via Claude in Chrome MCP (`mcp__Claude_in_Chrome__javascript_tool` and `mcp__Claude_in_Chrome__navigate`).

#### Surface A — Homeowner Landing (`/`)

**Budget:** LCP < 1.8s on simulated 3G Fast, JS bundle < 200 KB gzip

**Scenario 1: LCP — Homeowner landing**

```javascript
// Inject via mcp__Claude_in_Chrome__javascript_tool after navigating to target root URL
const lcp = await new Promise(resolve => {
  new PerformanceObserver(list => {
    const entries = list.getEntries();
    resolve(entries[entries.length - 1].startTime);
  }).observe({type: 'largest-contentful-paint', buffered: true});
  // Fallback timeout
  setTimeout(() => resolve(null), 10000);
});
return lcp;
```

**Pass:** LCP ≤ 1800ms | **Fail:** LCP > 1800ms

Note: Chrome DevTools throttling (3G Fast = 1.6 Mbps down, 750 Kbps up, 150ms RTT) should be set if available. If throttling is not available, record the unthrottled LCP and flag as "unthrottled measurement — apply 1.4× adjustment factor for 3G estimate."

**Scenario 2: JS Bundle Size — Homeowner landing**

```javascript
// Inject via mcp__Claude_in_Chrome__javascript_tool
const totalJS = window.performance.getEntriesByType('resource')
  .filter(r => r.initiatorType === 'script')
  .reduce((sum, r) => sum + r.transferSize, 0);
return (totalJS / 1024).toFixed(1) + ' KB';
```

**Pass:** Total JS ≤ 200 KB gz | **Fail:** Total JS > 200 KB gz

---

#### Surface B — Homeowner Flow (`/get-started`)

**Budget:** LCP < 2.5s, TBT < 200ms

**Scenario 3: LCP — Homeowner flow**

Same PerformanceObserver injection as Scenario 1, targeting `/get-started`.
**Pass:** LCP ≤ 2500ms | **Fail:** LCP > 2500ms

**Scenario 4: TBT — Homeowner flow**

```javascript
// Inject via mcp__Claude_in_Chrome__javascript_tool after navigating to /get-started
let tbt = 0;
new PerformanceObserver(list => {
  list.getEntries().forEach(e => { tbt += Math.max(0, e.duration - 50); });
}).observe({type: 'longtask', buffered: true});
await new Promise(r => setTimeout(r, 5000));
return tbt;
```

**Pass:** TBT ≤ 200ms | **Fail:** TBT > 200ms

---

#### Surface C — Contractor Dashboard (`/dashboard.html`)

**Budget:** LCP < 3.0s (authenticated context, heavier load acceptable), TBT < 300ms

**Scenario 5: LCP — Contractor dashboard (authenticated)**

1. Navigate to `/dashboard.html` via `mcp__Claude_in_Chrome__navigate`
2. If redirected to login: mark as SKIP (not FAIL), note "auth required; test as authenticated user manually"
3. If authenticated session available: inject PerformanceObserver, capture LCP
4. **Pass:** LCP ≤ 3000ms | **Skip:** Auth required (document separately)

**Scenario 6: TBT — Contractor dashboard**

Same Long Task injection as Scenario 4, on `/dashboard.html`.
**Pass:** TBT ≤ 300ms (lenient; authenticated dashboard is heavier) | **Fail:** TBT > 300ms

---

#### Surface D — API Performance (Scenarios 7–8)

**Budget:** Quote Submission API p90 < 800ms; Bid Confirmation API p90 < 500ms

These are approximated via 10 consecutive synthetic requests. True p95 requires production observability tooling (Sentry/Datadog). In the absence of Datadog, this is a directional proxy — note in output.

**Note:** There are no Netlify functions in OtterQuote. All API endpoints are Supabase Edge Functions at `https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/`. Updated 2026-05-16.

**Scenario 7: Quote Submission API latency**

Run via Claude Code bash:

```bash
TARGET="https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-contractors"
ANON="sb_publishable_mKmYIsRMc6dCG8ZrGGbyyw_l_MOTwZP"
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{time_starttransfer}\n" \
    -X POST "$TARGET" \
    -H "Authorization: Bearer $ANON" \
    -H "Content-Type: application/json" \
    -d '{"test":true,"synthetic":true}' 2>/dev/null || echo "error"
done | sort -n | awk 'NR==9{printf "p90: %.0fms\n", $1*1000} NR==10{printf "p100: %.0fms\n", $1*1000}'
```

**Pass:** p90 < 800ms | **Fail:** p90 ≥ 800ms

Note: Synthetic payload returns HTTP 400. Latency is measured as TTFB (time_starttransfer) — captures function cold-start + auth + request parsing time. "Response validation excluded" as payload is intentionally malformed.

**Scenario 8: Bid Confirmation API latency**

```bash
TARGET="https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/send-bid-confirmation"
ANON="sb_publishable_mKmYIsRMc6dCG8ZrGGbyyw_l_MOTwZP"
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{time_starttransfer}\n" \
    -X POST "$TARGET" \
    -H "Authorization: Bearer $ANON" \
    -H "Content-Type: application/json" \
    -d '{"test":true,"synthetic":true}' 2>/dev/null || echo "error"
done | sort -n | awk 'NR==9{printf "p90: %.0fms\n", $1*1000} NR==10{printf "p100: %.0fms\n", $1*1000}'
```

**Pass:** p90 < 500ms | **Fail:** p90 ≥ 500ms

Note: Synthetic payload returns HTTP 401 (missing valid JWT). Latency measured as TTFB. Updated 2026-05-16.

---

#### Surface E — SLO Availability Proxy (Scenarios 9–10)

These are synthetic uptime checks, not true 30-day SLO measurements. They verify the service responds within budget at time of test. True SLO tracking requires Datadog synthetics or equivalent.

**Scenario 9: Homeowner web read availability**

```bash
for i in $(seq 1 5); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://otterquote.com/ 2>/dev/null)
  TIME=$(curl -s -o /dev/null -w "%{time_total}" https://otterquote.com/ 2>/dev/null)
  echo "Request $i: HTTP $STATUS in ${TIME}s"
done
```

**Pass:** All 5 return 200/304, all response times < 1.0s | **Fail:** Any non-2xx or any response > 1.0s

**Scenario 10: Homeowner submit endpoint reachability**

```bash
curl -s -o /dev/null -w "HTTP %{http_code} | TTFB %{time_starttransfer}s | Total %{time_total}s\n" \
  -X POST https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-contractors \
  -H "Authorization: Bearer sb_publishable_mKmYIsRMc6dCG8ZrGGbyyw_l_MOTwZP" \
  -H "Content-Type: application/json" \
  -d '{"test":true,"synthetic":true}' 2>/dev/null
```

**Pass:** HTTP 4xx (function alive, auth/payload validation working), TTFB < 2.0s | **Fail:** 5xx or timeout or TTFB ≥ 2.0s

Note: 4xx confirms function is deployed and processing. 5xx = function runtime error = treat as reachability failure. Updated 2026-05-16.

---

#### Bundle Regression Check (Scenarios 11–12)

**Scenario 11: Main bundle no >5% regression vs. last recorded baseline**

```python
from pathlib import Path
import re

PERF_BASELINES_FILE = Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads\Claude's Memories\perf-baselines.md")

# current_js_kb = result from Scenario 2 measurement
def check_bundle_regression(current_js_kb: float) -> str:
    if not PERF_BASELINES_FILE.exists():
        # Write new baseline
        baseline_content = f"# Perf Baselines\n\nlast-updated: {__import__('datetime').datetime.utcnow().isoformat()}Z\n"
        PERF_BASELINES_FILE.write_text(baseline_content, encoding='utf-8')
        return f"BASELINE_SET — {current_js_kb:.1f} KB recorded as initial baseline"
    
    content = PERF_BASELINES_FILE.read_text(encoding='utf-8')
    match = re.search(r'Homeowner landing.*?JS bundle.*?\|\s*([\d.]+)', content)
    if not match:
        return f"BASELINE_SET — {current_js_kb:.1f} KB recorded (no prior JS baseline found)"
    
    baseline = float(match.group(1))
    drift = (current_js_kb - baseline) / baseline * 100
    if drift > 10:
        return f"FAIL — {drift:.1f}% regression (CRITICAL: deploy blocker, page Dustin immediately)"
    elif drift > 5:
        return f"FAIL — {drift:.1f}% regression (HIGH: file GitHub issue)"
    else:
        return f"PASS — {drift:.1f}% drift from baseline ({baseline:.1f} KB → {current_js_kb:.1f} KB)"
```

**Pass:** drift ≤ 5% | **Fail:** drift > 5% (blocks merge per CTO-OS §3)

**Scenario 12: CSS bundle size sanity**

```javascript
// Inject via mcp__Claude_in_Chrome__javascript_tool
const totalCSS = window.performance.getEntriesByType('resource')
  .filter(r => r.name.endsWith('.css'))
  .reduce((sum, r) => sum + r.transferSize, 0);
return (totalCSS / 1024).toFixed(1) + ' KB';
```

**Pass:** CSS ≤ 50 KB gz | **Warning:** CSS > 50 KB (file task but do not block)

---

## Output Format

```
Perf Matrix — [target URL] — [date] — [env: staging|production]

| # | Surface | Scenario | Budget | Measured | Result |
|---|---------|----------|--------|----------|--------|
| 1  | Homeowner landing | LCP | <1800ms | Xms | PASS/FAIL |
| 2  | Homeowner landing | JS bundle | <200 KB gz | X KB | PASS/FAIL |
| 3  | Homeowner flow | LCP | <2500ms | Xms | PASS/FAIL |
| 4  | Homeowner flow | TBT | <200ms | Xms | PASS/FAIL |
| 5  | Contractor dashboard | LCP | <3000ms | Xms | PASS/SKIP |
| 6  | Contractor dashboard | TBT | <300ms | Xms | PASS/FAIL |
| 7  | Quote Submission API | p90 latency | <800ms | Xms | PASS/FAIL |
| 8  | Matching API | p90 latency | <500ms | Xms | PASS/FAIL |
| 9  | Homeowner read SLO | Availability | 5/5 200s, <1s | X/5, Xms | PASS/FAIL |
| 10 | Homeowner submit | Reachability | TTFB <2s | Xs | PASS/FAIL |
| 11 | Bundle regression | JS drift | ≤5% | X% | PASS/FAIL/BASELINE_SET |
| 12 | CSS size | Sanity | ≤50KB gz | X KB | PASS/WARNING |

Overall: [GREEN — all pass] / [YELLOW — N warnings, 0 fails] / [RED — N failures]
```

For each FAIL, add a structured blocker:
```
❌ Scenario [N] FAILED — [Surface]
Budget: [what the limit is]
Measured: [what was observed]
Delta: [how far over budget]
Likely cause: [diagnosis — bundle bloat, slow Edge Function, network issue, etc.]
Severity: [Critical | High | Medium] per:
  - LCP/TBT failures: High (user-visible)
  - API latency failures: High (functional impact)
  - Bundle regression >10%: Critical (blocks deploy)
  - Bundle regression 5-10%: High
  - CSS warning: Medium
Action: [GitHub issue filed / escalate to bug-killer / defer to next PR review]
GitHub issue: [issue URL if filed]
```

If all pass:
```
✓ Perf matrix GREEN — all 12 scenarios passed on [target URL]
```

---

## Filing Regressions to GitHub

For every FAIL (not WARNING):

1. Search GitHub issues (`search_issues`, repo `StellarEdgeServices/otterquote-platform`, open, label `env:code`) for an existing issue tagged `perf-regression` with a matching surface/scenario name (avoid duplicate issues)
2. If no existing issue → create new GitHub issue on `StellarEdgeServices/otterquote-platform`:
   - Title: `[PERF] [Surface] — [Scenario] regression — [measured value] vs [budget]`
   - Labels: `env:code`, `perf-regression`, `exec:cto` (an issue filed with no `exec:` label is an orphan)
   - Priority: High (or Urgent if bundle regression >10% and deploy is in-flight) — note in the issue body
   - Body:
     ```
     [Paste structured blocker block from output above]

     **Tier**: 1 (High/Medium regressions with a clear fix) or 2 (Critical, novel, or requires architectural decision)
     **Model**: Sonnet (default)

     ##Acceptance Criteria
     - [ ] Budget metric passes: [specific metric] < [budget threshold] (e.g. LCP < 1800ms, JS bundle < 200KB gzip)
     - [ ] No regression vs. baseline in perf-baselines.md (within 3% tolerance)
     - [ ] CI green; no unrelated regression introduced

     ##Files Touched
     [The HTML/JS/CSS/Edge Function file causing the regression — e.g. "index.html", "js/bundle.js", "netlify/functions/notify-contractors.js". Never empty — use "[REQUIRES INVESTIGATION — reason]" if indeterminate.]
     ```
3. If existing issue found → add comment with new measurement + timestamp
4. Post issue URL in perf-doctor output

**Escalation to bug-killer:** If a regression is novel (first occurrence) AND High/Critical severity → immediately invoke `bug-killer` with the structured blocker as initial evidence. Do not wait for next scheduled sweep.

---

## Baseline Management

Perf-doctor maintains a lightweight baseline record at `perf-baselines.md` in the memories dir.

```python
from pathlib import Path
import datetime

PERF_BASELINES_FILE = Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads\Claude's Memories\perf-baselines.md")

def write_baselines(measurements: dict) -> None:
    """Write or update perf-baselines.md with current measurements."""
    now = datetime.datetime.utcnow().isoformat() + 'Z'
    lines = [
        "# Perf Baselines\n\n",
        f"last-updated: {now}\n",
        "env: production\n\n",
        "| Surface | Metric | Baseline | Recorded |\n",
        "|---------|--------|----------|----------|\n",
    ]
    for surface, metric, value, date in measurements:
        lines.append(f"| {surface} | {metric} | {value} | {date} |\n")
    
    content = "".join(lines)
    PERF_BASELINES_FILE.write_text(content, encoding='utf-8')
```

On first run: create this file with measured values as baselines. Tag each row `INITIAL`.

On subsequent runs: compare vs. baseline. If passing but trending (>3% degradation from baseline, still under budget): add WARNING comment to the GitHub perf-regression issue or create a new low-priority tracking issue.

---

## Write Session Report

After completing all 12 scenarios:

```python
import shutil, datetime
from pathlib import Path

PERF_REPORTS_DIR = Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads\Stellar Edge Services\OtterQuote\Engineering\Perf-Reports")
PERF_REPORTS_DIR.mkdir(parents=True, exist_ok=True)

now = datetime.datetime.utcnow()
week_str = now.strftime('%Y-W%V')
report_path = PERF_REPORTS_DIR / f"{week_str}.md"

# Write report content to report_path
# report_path.write_text(report_content, encoding='utf-8')

# Null-byte gate
with open(report_path, 'rb') as f:
    data = f.read()
assert data.count(b'\x00') == 0, f"NULL BYTES in {report_path}"
print(f"null-byte: PASS — {report_path}")
```

---

## Handoff Protocol

If Claude Code session ends before completion, write a handoff file:

```python
from pathlib import Path
import datetime

HANDOFFS_DIR = Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads\handoffs")
HANDOFFS_DIR.mkdir(exist_ok=True)

handoff_path = HANDOFFS_DIR / f"perf-doctor-{datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%S')}.md"
handoff_content = """# Perf Doctor Handoff

status: interrupted
env: production
scenarios_completed: [list]
scenarios_pending: [list]
partial_measurements: [dict]
github_issues_filed: [list]
resume_from: Scenario [N]
"""
handoff_path.write_text(handoff_content, encoding='utf-8')
```

---

## Integration

**Forge Layer 9:** When Forge detects changes to any of the following files, it invokes perf-doctor before marking the compliance pass complete:
- `index.html`, `get-started.html`, `dashboard.html`, `contractor-signup.html`
- Any `.js` bundle file in the repo root or `/js/`
- Any Supabase Edge Function serving a critical-path endpoint (notify-contractors, send-bid-confirmation, create-payment-intent)

**Post-deploy hook:** Any Wingman task that deploys to production should add the comment "perf-doctor validation pending" rather than marking the task fully complete. A subsequent perf-doctor sweep (within 30 min of deploy) closes the loop.

**Weekly scheduled sweep:** Runs Fridays 8:00 AM ET. Results filed to `Stellar Edge Services/OtterQuote/Engineering/Perf-Reports/YYYY-WW.md` and posted as comment on a persistent "Weekly Perf Matrix" GitHub issue.

**Escalation chain:** FAIL → GitHub issue filed → if novel High/Critical → bug-killer → if Sev1 latency or availability → immediate Dustin page (Tier C escalation).

---

## Hard Invariants

- **Never suppress a FAIL.** If measurement exceeds budget, file it. No exceptions for "it's close" or "it was a fluke."
- **Never auto-fix.** Perf-doctor diagnoses and files. It does not modify code, configs, or bundles. All fixes route through normal deploy flow or bug-killer.
- **API synthetic tests are directional only** without Datadog. Always note "directional measurement — install Datadog Synthetics for true p95 tracking" until Datadog MCP is installed.
- **Bundle regression >10% is a deploy blocker.** File as Urgent, page Dustin immediately if a deploy is in-flight.
- **Baseline drift rule:** If 3 consecutive sweeps show degradation trending toward budget breach, file a Medium task even if still passing. Trend is data.

---

<!-- v1.0 — 2026-05-18 — Claude Code port of perf-doctor-SKILL.md v1.0 (2026-05-12 / 86e1afqa0) -->
<!-- Adaptations: removed request_cowork_directory, added Path constants (Windows), python→python, bash curl commands explicit, handoff protocol added, Claude in Chrome via mcp__Claude_in_Chrome__javascript_tool -->
<!-- 2026-08-31 — gh-1368 ClickUp→GitHub conversion (Code lane, rw-f22-20260831T1222-gh1368): this file had diverged from the master perf-doctor-code twin and never received the "Filing Regressions to GitHub" port — description, Scenario 11 severity string, blocker template, "Filing Regressions" section, baseline-trend note, handoff field, and Integration section all converted from ClickUp task filing to mcp__github__issue_write (dedup-first via search_issues, labels env:code + perf-regression + exec:cto). Dropped the ClickUp custom-field-ID paragraph; Tier/Model now carried in the issue body instead, matching migration-author-code's pattern. -->

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
