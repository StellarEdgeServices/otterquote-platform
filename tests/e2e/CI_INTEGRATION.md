# CI Integration Plan — OtterQuote E2E Flow Tests

**Status:** PROPOSED — not yet wired. This document is the plan for Dustin's approval.
**Decision required before implementation:** Dustin reviews and approves via Decision Protocol.

Built: April 28, 2026 (companion to flow-test suite, D-196 followup)

---

## Proposed Architecture

The flow-test suite runs as a **post-deploy gate on the staging branch**,
not on the production branch. Production deploy is not blocked by E2E tests —
only staging is.

```
Push to staging branch
  → Netlify builds staging deploy
  → Netlify deploy webhook fires
  → GitHub Actions E2E job triggers
  → npm run seed (creates fresh test claim)
  → npx playwright test (runs against staging URL)
  → npm run teardown
  → If FAIL: post comment to commit, block PR merge to main
  → If PASS: allow PR to merge to main → production deploy
```

---

## Proposed GitHub Actions Workflow

File: `.github/workflows/e2e.yml`

```yaml
name: E2E Flow Tests

on:
  deployment_status:          # fires when Netlify deploy completes
  workflow_dispatch:          # manual trigger for debugging

jobs:
  e2e:
    if: github.event.deployment_status.state == 'success' &&
        contains(github.event.deployment_status.environment, 'staging')
    runs-on: ubuntu-latest
    timeout-minutes: 15

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: tests/e2e/package-lock.json

      - name: Install dependencies
        working-directory: tests/e2e
        run: npm ci

      - name: Install Playwright browsers
        working-directory: tests/e2e
        run: npx playwright install chromium --with-deps

      - name: Write .env.test
        working-directory: tests/e2e
        run: |
          cat > .env.test << EOF
          BASE_URL=${{ secrets.STAGING_URL }}
          SUPABASE_URL=${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY=${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          EOF

      - name: Seed test data
        working-directory: tests/e2e
        run: npm run seed

      - name: Run E2E tests
        working-directory: tests/e2e
        run: npm test

      - name: Teardown test data
        working-directory: tests/e2e
        if: always()           # run teardown even if tests fail
        run: npm run teardown

      - name: Upload Playwright report
        uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: tests/e2e/playwright-report/
          retention-days: 7
```

---

## GitHub Secrets Required

These secrets must be added to the `StellarEdgeServices/otterquote-platform`
repository settings before the workflow is active:

| Secret Name | Value | Where to Find |
|---|---|---|
| `STAGING_URL` | `https://staging--jade-alpaca-b82b5e.netlify.app` | Netlify dashboard |
| `SUPABASE_URL` | `https://yeszghaspzwwstvsrioa.supabase.co` | Supabase project settings |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key | `otterquote-memory.md` → Key Infrastructure Details |

**Security note:** The service role key bypasses all Supabase RLS policies. It
must never be in code or logs. GitHub Actions secrets are encrypted at rest and
masked in logs — this is the appropriate storage mechanism.

---

## Integration with Smoke Tests

The existing `Docs/smoke-test.sh` (4 tests) runs **before** the E2E suite as
part of the Netlify deploy process (called in the deploy checklist). The E2E
suite runs **after** Netlify confirms the staging deploy is live.

Proposed order of gates (staging branch):
1. `smoke-test.sh` — 4 curl checks (homepage 200, Supabase up, Edge Function not-500, Stripe present)
2. Netlify staging deploy confirmed
3. E2E flow-test suite — authenticated journeys (this suite)
4. Merge to main → production deploy

---

## Phase 2 Extensions (Post-Approval)

These extensions require additional setup before they can be added to CI:

### Stripe Test Mode for Staging

Currently the staging site points to the live Stripe account (live mode keys
in Supabase secrets). To test payment flows:

1. Create a separate set of Supabase secrets for staging: `STRIPE_SECRET_KEY_TEST`
2. Update `create-payment-intent` Edge Function to detect `APP_ENV=staging`
   and use the test key
3. Add Stripe test card `4242 4242 4242 4242` in contractor onboarding (A-TODO)
4. Add Hover payment step assertion in homeowner journey (B-TODO)

### DocuSign Sandbox

To test contract signing in CI:

1. Register a separate DocuSign sandbox app (free developer account)
2. Store sandbox credentials as separate GitHub secrets
3. Update `create-docusign-envelope` to use sandbox base URI when `APP_ENV=staging`
4. Add contract signing assertions to Flow B (B9)

### Dunning Exclusion for Test Contractor

Currently the `process-dunning` Edge Function will fire against the test
contractor if they have a payment failure. Short-term fix: ensure test
contractor always has `has_payment_method = true` (set by seed script).
Long-term fix: add `JOIN profiles ... WHERE is_test = false` to dunning query.

### Test Claim Visibility Guard

Currently the test claim appears briefly in contractor-opportunities.html for
real contractors. Post-launch fix: add `is_test` filtering to the opportunities
query:

```sql
-- Add to contractor-opportunities.html query (JS services layer)
AND claims.user_id NOT IN (
  SELECT id FROM profiles WHERE is_test = true
)
```

---

## Decisions Required Before Wiring

The following items need Dustin's explicit approval (run through Decision Protocol)
before CI integration is activated:

1. **Proceed with the proposed GitHub Actions architecture** (deployment_status trigger)
2. **Staging-specific Stripe test mode configuration** (requires Supabase secret changes → Tier 3)
3. **Whether to block PR merges to main on E2E failure** (recommended: yes, after Phase 1 stability confirmed)
4. **Service role key storage in GitHub Actions secrets** (security posture confirmation)

This document serves as the briefing for that approval conversation.
