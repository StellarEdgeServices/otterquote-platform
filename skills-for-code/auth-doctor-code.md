---
name: auth-doctor-code
description: "Claude Code-native auth flow integrity validator for OtterQuote. Runs a fixed 9-scenario auth matrix (M-1 contractor + M-2 homeowner magic-link landing + 7 session/admin scenarios) against staging or production. M-1 and M-2 catch silent Supabase redirect_to override behavior (root cause of May 14 2026 D-225 launch-eve incident). Trigger phrases: 'run auth-doctor', 'test auth flows', 'auth flow check', 'check auth', 'auth matrix', 'test auth'. Invoke proactively after any auth-related code change."
version: "1.1"
tier: A
sentinel: auth-doctor-code-v1.1-2026-05-19
---

<!-- Claude Code-native adaptation of auth-doctor-SKILL.md (Cowork v1.1) -->
<!-- Key differences vs. Cowork version:
     - No request_cowork_directory — direct pathlib paths throughout
     - Uses `python` not `python3` (Windows PATH in Claude Code)
     - bash curl commands work natively (real shell in Claude Code)
     - Chrome MCP calls unchanged — same browser automation
     - Supabase admin API calls via bash curl (service role key from env or claude-memory)
     - Handoff protocol added
-->

# [auth-doctor-code v1.1]

Auth flow integrity validator for OtterQuote (Claude Code). Runs a fixed 9-scenario auth matrix on demand against staging or production via Supabase admin API + Chrome browser automation.

**Trigger phrases:** "run auth-doctor", "test auth flows", "auth flow check", "check auth", "auth matrix", "test auth"

---

## Path Constants

```python
import pathlib

REPO_ROOT        = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform")
CLAUDE_DOWNLOADS = pathlib.Path(r"C:\Users\Dustin Stohler\Downloads\Claude Downloads")
MEMORIES_DIR     = CLAUDE_DOWNLOADS / "Claude's Memories"
HANDOFFS_DIR     = REPO_ROOT / "handoffs"

SUPABASE_URL     = "https://yeszghaspzwwstvsrioa.supabase.co"
STAGING_URL      = "https://staging--jade-alpaca-b82b5e.netlify.app"
PRODUCTION_URL   = "https://otterquote.com"
```

---

## Environment Setup

```bash
# Service role key — read from claude-memory.md or environment
# grep for supabase_service_role in claude-memory.md, or use:
SUPABASE_SERVICE_KEY="<service-role-key-from-memory>"
SUPABASE_URL="https://yeszghaspzwwstvsrioa.supabase.co"
```

In Claude Code, read the service role key from `claude-memory.md` or the exec-cto-memory.md credentials section before running M-1/M-2.

---

## Step 0 — Select Environment

Ask Dustin (or default in scheduled/autonomous mode):
- **Staging:** `https://staging--jade-alpaca-b82b5e.netlify.app`
- **Production:** `https://otterquote.com`

Default in scheduled mode: production. Log environment in output header.

gh-2064: when running against production, the FIRST page navigated in Step 1 below
must carry `?oq_internal=1` (e.g. `https://otterquote.com/get-started?oq_internal=1`)
so this run's traffic is never counted as a visitor in GA4, Meta or Clarity. Staging
needs no such param — it is already outside every gate's host allowlist.

---

## Auth Matrix (9 Scenarios)

Scenarios M-1 and M-2 run via Supabase admin API (bash curl) + Chrome browser automation. Scenarios 1–7 run via Chrome browser automation. Report pass/fail for each.

---

### Scenario M-1: Fresh contractor magic-link landing — Supabase redirect_to honored

**Why:** Supabase Auth silently overrides `redirect_to` to `SITE_URL` regardless of `URI_ALLOW_LIST`. This catches the override at the source. (ADR-011, R-036, May 14 2026 D-225 launch-eve incident)

**Protocol:**
```bash
# Step 1: Generate test email
TEST_EMAIL="dustin+authdoctor-contractor-$(date +%s)@stellaredgeservices.com"
echo "Test email: $TEST_EMAIL"

# Step 2: Generate magic link via admin API
RESPONSE=$(curl -s -X POST \
  "${SUPABASE_URL}/auth/v1/admin/generate_link" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"magiclink\",\"email\":\"${TEST_EMAIL}\",\"options\":{\"redirect_to\":\"https://otterquote.com/contractor-pre-approval.html\",\"data\":{\"role\":\"contractor\"}}}")

# Step 3: Extract redirect_to from action_link
ACTION_LINK=$(echo "$RESPONSE" | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('action_link',''))")
REDIRECT_TO=$(python -c "from urllib.parse import urlparse,parse_qs; u=urlparse('$ACTION_LINK'); q=parse_qs(u.query); print(q.get('redirect_to',[''])[0])")

# Step 4: Check PASS criterion A
if [ "$REDIRECT_TO" = "https://otterquote.com/contractor-pre-approval.html" ]; then
  echo "M-1 criterion A: PASS — redirect_to honored"
else
  echo "M-1 criterion A: FAIL — redirect_to overridden to: $REDIRECT_TO"
  echo "See ADR-011 — Supabase override active. Ensure bounce script intact in index.html."
fi
```

**Step 5–7:** Open `action_link` in Chrome via `mcp__Claude_in_Chrome__navigate`. Wait for redirect chain.
- **PASS criterion B:** Final URL pathname starts with `/contractor-pre-approval.html`
- **PASS criterion C:** Pre-approval page renders Step 2 (License & Insurance) with no console errors

**Cleanup:**
```bash
USER_ID=$(echo "$RESPONSE" | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('user',{}).get('id',''))")
curl -s -X DELETE \
  "${SUPABASE_URL}/auth/v1/admin/users/${USER_ID}" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}"
echo "Test user deleted: $USER_ID"
```

---

### Scenario M-2: Fresh homeowner magic-link landing — Supabase redirect_to honored

**Protocol:**
```bash
TEST_EMAIL="dustin+authdoctor-homeowner-$(date +%s)@stellaredgeservices.com"

RESPONSE=$(curl -s -X POST \
  "${SUPABASE_URL}/auth/v1/admin/generate_link" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"magiclink\",\"email\":\"${TEST_EMAIL}\",\"options\":{\"redirect_to\":\"https://otterquote.com/trade-selector.html\",\"data\":{\"role\":\"homeowner\"}}}")

ACTION_LINK=$(echo "$RESPONSE" | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('action_link',''))")
REDIRECT_TO=$(python -c "from urllib.parse import urlparse,parse_qs; u=urlparse('$ACTION_LINK'); q=parse_qs(u.query); print(q.get('redirect_to',[''])[0])")

if [ "$REDIRECT_TO" = "https://otterquote.com/trade-selector.html" ]; then
  echo "M-2 criterion A: PASS"
else
  echo "M-2 criterion A: FAIL — homeowner magic-link override active. redirect_to: $REDIRECT_TO"
fi
```

Open `action_link` via Chrome. **PASS criterion B:** Final URL pathname is `/trade-selector.html`.

Cleanup: DELETE test user (same as M-1).

---

### Scenario 1: Magic-link signup → homeowner dashboard (UI flow check)

Navigate to `/get-started?oq_internal=1` (or `app.otterquote.com/get-started?oq_internal=1`; gh-2064 — sets the internal-traffic opt-out cookie before anything else on the page loads). Complete page 1 with a test email. Verify the magic-link-sent confirmation state renders without errors and no console errors fire.

---

### Scenario 2: Google OAuth → homeowner dashboard

Navigate to `/login.html` or `/get-started`, click "Sign in with Google". Verify OAuth redirect initiates correctly with proper state params and redirect URI. Verify redirect URL is correct and no auth errors appear.

---

### Scenario 3: Logout clears all auth state

While authenticated, trigger logout. Verify redirect to landing page. Check localStorage, sessionStorage, and cookies via Chrome JS injection — confirm no auth tokens remain.

---

### Scenario 4: Hard refresh while authenticated

Navigate to `/dashboard.html`, wait for full auth. Perform hard refresh. Verify dashboard reloads without bounce to `/login.html` or auth flickering.

---

### Scenario 5: Cross-page navigation while authenticated

From `/dashboard.html`, navigate to another authenticated page (`/bids.html`, `/settings.html`). Verify no re-auth prompt, no bounce, no flicker.

---

### Scenario 6: Admin gate — three sub-cases

**6a — Unauthenticated:** Visit `/admin-contractors.html` unauthenticated. Verify redirect to `/login.html?reason=admin_required`.

**6b — Non-admin:** Authenticated non-admin → `/admin-contractors.html`. Verify redirect + visible banner message.

**6c — Admin:** Sign in as admin (`dustinstohler1@gmail.com`), visit `/admin-contractors.html`. Verify admin content loads.

---

### Scenario 7: Session expiry → graceful re-auth

With active session, manually clear auth cookie or localStorage tokens. Navigate to authenticated page. Verify graceful re-auth prompt or redirect (not a crash or blank page).

---

## Output Format

```
Auth Matrix — [target URL] — [date]

| # | Scenario | Result | Notes |
|---|----------|--------|-------|
| M-1 | Fresh contractor magic-link (redirect_to honored) | PASS/FAIL | |
| M-2 | Fresh homeowner magic-link (redirect_to honored) | PASS/FAIL | |
| 1 | Magic-link signup UI flow | PASS/FAIL | |
| 2 | Google OAuth redirect | PASS/FAIL | |
| 3 | Logout clears auth state | PASS/FAIL | |
| 4 | Hard refresh while authed | PASS/FAIL | |
| 5 | Cross-page nav while authed | PASS/FAIL | |
| 6a | Admin gate: unauthenticated | PASS/FAIL | |
| 6b | Admin gate: non-admin user | PASS/FAIL | |
| 6c | Admin gate: admin user | PASS/FAIL | |
| 7 | Session expiry graceful re-auth | PASS/FAIL | |

Overall: [GREEN — all pass] / [RED — N failures]
```

**M-1 / M-2 FAIL is BLOCKING for launch readiness** per R-037. Do not mark D-225 criterion 1 PASS until M-1/M-2 pass.

For each FAIL:
```
❌ Scenario [N] FAILED
Observed: [what happened]
Expected: [what should have happened]
Likely cause: [diagnosis]
Action: [how to fix]
```

---

## Handoff File

```python
import pathlib, datetime

HANDOFFS_DIR = pathlib.Path(r"C:\Users\Dustin Stohler\otterquote-platform\handoffs")
HANDOFFS_DIR.mkdir(parents=True, exist_ok=True)
ts = datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
handoff = HANDOFFS_DIR / f"auth-doctor-{ts}.md"
handoff.write_text(f"""# auth-doctor Handoff — {ts}
completed_at: {ts}
environment: [staging|production]
overall: [GREEN|RED]
failures: N
status: complete
""", encoding='utf-8')
print(f"Handoff written: {handoff}")
```

---

## Integration

- **Forge Layer 8:** When Forge detects changes to auth-related files (`js/auth.js`, `admin-gate.js`, `auth-callback.html`), invoke auth-doctor before marking compliance pass complete.
- **D-211 gate:** All D-211 Phase 0 auth tasks require auth-doctor GREEN before considered accepted.

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

**v1.1 — 2026-05-19 — HARDSHELL P4.S2:**
Claude Code adaptation of auth-doctor-SKILL.md (Cowork v1.1). Removed request_cowork_directory. Added pathlib Path constants. Changed python3 → python. Added bash curl commands for M-1/M-2 Supabase admin API calls (real shell available). Added handoff file protocol. Chrome MCP calls unchanged. All 9 scenarios preserved.
