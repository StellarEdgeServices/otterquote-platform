# OtterQuote E2E Flow-Test Suite

Authenticated flow tests for OtterQuote. Covers the contractor and homeowner
journeys against the staging environment using Playwright + Supabase admin API
for magic-link injection.

Built: April 28, 2026 (D-196 followup — authenticated dashboard coverage)

---

## Quick Start

```bash
# 1. Install dependencies
cd tests/e2e
npm install

# 2. Install Playwright browsers (first time only)
npx playwright install chromium

# 3. Configure credentials
cp .env.test.example .env.test
# Edit .env.test with your SUPABASE_SERVICE_ROLE_KEY

# 4. Seed test accounts and test claim
npm run seed

# 5. Run all tests
npm test

# 6. Teardown test data after run
npm run teardown
```

---

## Prerequisites

### 1. Credentials in `.env.test`

Copy `.env.test.example` to `.env.test` and fill in:

| Variable | Value |
|---|---|
| `BASE_URL` | `https://staging--jade-alpaca-b82b5e.netlify.app` |
| `SUPABASE_URL` | `https://yeszghaspzwwstvsrioa.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (in `otterquote-memory.md`) |

**Never commit `.env.test`.** It is gitignored.

### 2. Supabase Auth redirect allowlist

The magic link injection sends a `redirect_to` URL pointing at the staging site.
Supabase will reject redirects to URLs not on the allowlist.

Verify that the following URL is in **Supabase → Authentication → URL Configuration → Additional Redirect URLs**:
```
https://staging--jade-alpaca-b82b5e.netlify.app
```

If it is missing: add it, wait ~30 seconds, then re-run.

### 3. SQL migration v61 applied

The `profiles.is_test` column must exist before the seed script runs.
Check: `SELECT column_name FROM information_schema.columns WHERE table_name='profiles' AND column_name='is_test';`

If missing, apply: `sql/v61-test-accounts.sql` (already applied April 28, 2026).

---

## Test Accounts

The seed script creates two persistent test accounts on staging:

| Role | Email | Notes |
|---|---|---|
| Homeowner | `test-homeowner@otterquote-internal.test` | `profiles.is_test = true` |
| Contractor | `test-contractor@otterquote-internal.test` | `profiles.is_test = true`, `contractors.status = active` |

These are real Supabase auth users with `email_confirm = true` (no OTP required).
They persist across runs — the seed script is idempotent and upserts them.

The **test claim** is deleted and recreated fresh on every `npm run seed` run to
prevent cross-run contamination.

### Test Account Isolation

Both accounts have `profiles.is_test = true` (SQL v61). This flag:

- Excludes them from production analytics queries (add `WHERE is_test = false` to analytics joins)
- Prevents dunning from firing on the test contractor (add `is_test` check to `process-dunning` Edge Function — currently a TODO, tracked in CI_INTEGRATION.md)
- Prevents contractor network reporting from counting the test contractor

**Known limitation:** The test claim is visible to real contractors during the
~30-second window a test run is active. At current pre-revenue/pre-launch status
this is negligible. Post-launch fix: filter `is_test` claims from contractor
opportunities queries (add `JOIN profiles ON claims.user_id = profiles.id WHERE profiles.is_test = false`).

---

## What Each Test Covers

### Flow A — Contractor Journey (`flows/contractor-journey.spec.ts`)

| Test | What It Checks |
|---|---|
| A1 | `contractor-join.html` loads, name + email fields visible |
| A2 | Magic link → auth → redirect to contractor dashboard |
| A3 | Dashboard renders heading, no JS errors |
| A4 | `contractor-profile.html` loads in authenticated state |
| A5 | Service area section visible on profile page |
| A6 | Opportunities page loads, renders "opportunit" text |
| A7 | Bid form loads for test claim, price input visible |
| A8 | Bid submitted via UI, persisted in `quotes` table (DB verification) |

### Flow B — Homeowner Journey (`flows/homeowner-journey.spec.ts`)

Phase 1 stub — authenticated page load coverage only.

| Test | What It Checks |
|---|---|
| B1 | `get-started.html` loads, email + phone fields visible |
| B2 | Magic link → auth → redirect to homeowner dashboard |
| B3 | Dashboard renders without errors, test claim in DB is `bidding` |
| B4 | `bids.html` loads in authenticated state for test claim |

Full homeowner flow (B5–B10) deferred to Phase 2. See TODO comments in the spec.

---

## Explicitly Skipped (TODOs)

| Feature | Why Skipped | Fix Required |
|---|---|---|
| Stripe payment method (contractor onboarding page 4) | Live Stripe account — test transactions would pollute live dashboard | Configure staging-specific Stripe test mode keys |
| Hover measurement purchase ($79 payment) | Same — live Stripe | Stripe test mode keys |
| DocuSign contract signing | 40 env/month production limit, no sandbox wired | DocuSign sandbox app + separate credentials |
| Full homeowner intake flow (B5–B10) | DocuSign + Stripe both blocked | Resolve both above first |
| Dunning exclusion for test contractor | Edge Function change required | Add `is_test` check to `process-dunning` |

---

## Adding New Tests

1. Create a new spec file in `flows/` (e.g., `flows/partner-journey.spec.ts`).
2. Import `generateMagicLink` and `getTestState` from `../helpers/auth.js`.
3. Add a seed step in `seed/seed.mjs` if your test needs new test data.
4. Add cleanup to `seed/teardown.mjs` for any records your test creates.
5. Run the new spec: `npx playwright test flows/your-spec`.

**Pattern for any authenticated test:**

```typescript
import { generateMagicLink, getTestState } from '../helpers/auth.js';

test('your test', async ({ page }) => {
  const state = getTestState();
  const magicLink = await generateMagicLink(
    state.contractorEmail,
    `${state.baseUrl}/some-page.html`
  );
  await page.goto(magicLink);
  await page.waitForURL(/some-page/, { timeout: 30_000 });
  // ... your assertions
});
```

---

## Running Against Production

Not recommended. The seed script targets the same Supabase project that powers
both staging and production (there is no separate staging database). Running
against production means:

- Test accounts (`is_test = true`) will appear in the production auth user list
- The test claim will briefly appear in the contractor opportunities list
- No real financial transactions are triggered (Stripe skipped per plan)

If production smoke testing is ever required, add a `ALLOW_PRODUCTION_RUN=true`
guard to the seed script and get explicit approval before running.

---

## Stability Requirement

Before merging any changes to the test suite, run it 3 times consecutively and
confirm no flaky failures:

```bash
for i in 1 2 3; do
  npm run seed && npm test && npm run teardown
  echo "Run $i complete"
done
```

Two consecutive flaky failures with no clear cause are a structural issue —
stop and escalate per D-196 stop conditions.

---

## Architecture Notes

- **Auth strategy:** Supabase `admin.generateLink({ type: 'magiclink' })` returns
  the raw magic link URL. Playwright navigates to it directly — no email inbox
  needed. This avoids IMAP/Gmail scraping and is the officially recommended approach
  for Supabase E2E testing.
- **Workers:** Set to `1` (serial). Test accounts share DB state; parallel workers
  would cause race conditions on the shared test claim.
- **Retries:** 2 retries per test before marking flaky. Network latency to staging
  makes occasional timeouts expected.
- **State file:** `.test-state.json` written by seed, read by specs. Contains UUIDs
  needed to reference the test claim and accounts. Gitignored.
