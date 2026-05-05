# OtterQuote Deploy Review Checklist

## PRE-CHECKLIST: Static Analysis Gate

**Run BEFORE this checklist on every push:**
```bash
bash scripts/pre-push-check.sh
```

Failures (FAIL count > 0) block the push unless a `[LINT-WAIVER: <reason>]` is present in the commit message. Warnings (WARN) are non-blocking.

*Added: 2026-05-05 per task 86e17x80r*

---


Run this checklist before every push to staging or main. **CRITICAL items block always. HIGH items block absent an explicit written waiver from Dustin in the session.**

Mark each item ✅ (pass) / ❌ (fail — stop) / N/A (genuinely not applicable — explain why).

---

## CRITICAL — Always Blocks

### Pre-Deploy Site Health
- [ ] **Site is up.** `web_fetch https://otterquote.com` returns HTML with "Stop chasing contractors" in body. If down → halt and diagnose before doing anything.
  - *Why: April 27, 2026 — Netlify billing pause caused 9.5-hour outage undetected by backend monitoring. Code pushing to a down site wastes the deploy slot and masks the real problem.*

### D-196 Drift Check
- [ ] **Drift check passed.** After rsync, ran `bash scripts/drift-check.sh "<intended files>"` in `$DEPLOY_DIR` and it exited 0. No unexpected files in `git status --short`.
  - *Why: Local-repo drift (uncommitted changes not part of this deploy) can accidentally ride along on a push. D-196 makes this visible before it hits production.*

### Tier Classification
- [ ] **Tier correctly identified.** Determined Tier 1/2/3 per D-182 rules (see claude-memory.md). If any doubt, escalate to Tier 2+.

### Tier 1 Legal / Brand Exclusions
*(Skip if Tier 2 or 3 — those have their own review gates.)*
- [ ] **No legally-sensitive copy touched.** Verified the changeset does NOT include:
  - D-151 TOS provisions
  - D-170 IC 24-5-11 attestation text
  - D-147 HICA compliance text
  - D-123 homeowner disclosure at signing
  - D-166 background-check framing
  - D-104 vetting language
  - D-177 fee basis language
  - D-175 brand claims or tone-altering copy
  - D-168 marketing claim thresholds
  - DocuSign templates or generated PDFs
- [ ] **No use of prohibited terminology.** Verified no "leads," "ClaimShield" (as product name), or "Otter Quotes" (two words) in changed files.

### Large File Safety
- [ ] **No banned-file edits via Cowork Edit tool.** If any of the following files were modified, confirmed that Python/bash patch was used — NOT the Cowork Edit tool:
  - `contractor-profile.html`
  - `contractor-bid-form.html`
  - `supabase/functions/create-docusign-envelope/index.ts`
  - `js/auth.js`
  - Any file over ~1,500 lines (check: `wc -l <file>`)

### SQL Migration Gate
*(Skip if no schema changes in this deploy.)*
- [ ] **Companion rollback script committed.** Every SQL migration file (`sql/vN-*.sql`) has a corresponding `sql/vN-rollback-*.sql` committed alongside it.
- [ ] **Migration classified Tier 3.** Any deploy touching the database is Tier 3 — confirmed 2-hour window or explicit Dustin approval exists.

## D-211 Dual-Surface Gate

### CRITICAL — Dual-Surface Safety
- [ ] **Which surface does this change affect: static HTML, React app, or both?** Explicitly identify the target surface(s) before proceeding.
  - *Why: D-211 parallel-track architecture (static HTML + React app at app.otterquote.com) means deploys must hit the right surface. Missing this can ship incomplete changes or break production.*
- [ ] **If both surfaces: are paired PRs prepared and is the same change ready to ship to both surfaces simultaneously?** Verify both PRs are in identical states and merge sequentially without intervening commits.
  - *Why: Shipping to one surface before the other creates transient inconsistencies and risks data loss or UX breakage.*

### HIGH — Dual-Surface Verification
- [ ] **Smoke tests run on both surfaces (when applicable)?** After staging deploy, test the changed pages on both `staging.otterquote.com` (static HTML surface) and `app-staging.otterquote.com` (React app surface) if this change touches both.
  - *Why: A change may pass on one surface and break on the other due to platform differences (DOM APIs, CSS scope, routing patterns).*
- [ ] **Forge Layer 8 parity audit passing for any React page being changed that has a static HTML counterpart?** Run Forge parity audit to confirm the React port matches the static HTML behavior and visuals.
  - *Why: React port correctness is enforced by parity checks. Shipping mismatched surfaces breaks the user's path.*

### NORMAL — Tracking
- [ ] **ClickUp `react-port` tag applied if this change touches an authenticated page that hasn't yet been converted to React?** If modifying static HTML for an auth-required page, tag it `react-port` to signal the page still needs React migration.
  - *Why: Tracks which authenticated pages are outstanding for React conversion, unblocks D-211 Phase 2 planning.*

---

## HIGH — Block Absent Explicit Waiver

### Auth Pattern
*(Check only if new authenticated pages added or auth code modified.)*
- [ ] **F-007 pattern applied.** All new/modified authenticated pages use `onAuthStateChange` + `INITIAL_SESSION`/`SIGNED_IN` guard + `_initFired` boolean. No `DOMContentLoaded + sb.auth.getSession()` pattern introduced.

### Config Scope
*(Check only if config.js or any file referencing CONFIG/sb was modified.)*
- [ ] **`var CONFIG` (not `const`/`let`).** `config.js` uses `var CONFIG` so `window.CONFIG` works across classic `<script>` tags.
- [ ] **Bare `sb` used, not `window.sb`.** `let sb` is top-level accessible as `sb`, but `window.sb` is NOT defined. Verified no `window.sb` references added.

### New Pages
*(Check only if new HTML pages were added.)*
- [ ] **`otterquote-pages.md` updated** with the new page's details (URL, auth requirements, tier, page purpose).

### Edge Function Changes
*(Check only if Edge Functions were modified.)*
- [ ] **Edge Function tested in staging.** Verified function responds correctly before merging to main.
- [ ] **No large-file truncation.** If `create-docusign-envelope/index.ts` or any large function was modified, confirmed Python/bash patch was used — not Cowork Edit tool.
  - *Recovery if truncated: `supabase functions download <function-name> --project-ref yeszghaspzwwstvsrioa`*

---

## Standard — Document Failures, Don't Block

### Smoke Tests (run against staging after push, before merging to main)
- [ ] `https://staging--jade-alpaca-b82b5e.netlify.app` returns 200
- [ ] Auth flow loads (login page renders without JS errors)
- [ ] Changed pages render without console errors
- [ ] If SQL migration: spot-check the migrated data or feature behavior in staging

### Post-Deploy Verification (run against production after merging to main)
- [ ] Production site returns 200 + "Stop chasing contractors" in body
- [ ] Changed pages render correctly
- [ ] No Sentry alerts triggered within 5 minutes of deploy
- [ ] If Stripe/DocuSign/Supabase affected: verify integration still responds

---

## Checklist Completion

```
Deploy date:
Tier:
Files in changeset:
Checklist run by: Claude (autonomous) / Dustin (manual review)
CRITICAL items: all passed ✅ / waiver granted for: [item]
HIGH items: all passed ✅ / waiver granted for: [item]
Staging smoke test: passed / N/A
Notes:
```

---

*Last updated: May 1, 2026 — Created as part of D-196 project-rules enforcement.*
*Referenced in claude-memory.md Base Deploy Steps, Step 5.*
