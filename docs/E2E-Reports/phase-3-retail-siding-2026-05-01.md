# E2E Phase 3 — Retail Siding (Hover Design Flow)
**Date:** 2026-05-01
**Tester:** Ram (AI Technical Co-Founder)
**ClickUp Task:** [86e132b40](https://app.clickup.com/t/86e132b40)
**Staging URL:** https://staging--jade-alpaca-b82b5e.netlify.app
**Supabase Project:** yeszghaspzwwstvsrioa

---

## Summary

| Metric | Count |
|---|---|
| Flow steps evaluated | 9 |
| Steps passed | 5 |
| Steps with defects | 4 |
| Critical/High defects | 3 |
| Medium defects | 2 |
| Low defects | 1 |
| **Total defects filed** | **6** |

**Verdict: BLOCKED — 3 HIGH defects prevent siding bids from ever being released. Flow cannot complete end-to-end in current state.**

---

## Flow Under Test

Homeowner intake → Trade selector (siding/cash) → Help-measurements ($79 Hover payment, D-181) → Hover 3D design → D-164 gate releases bids → Contractor bids → Homeowner picks → DocuSign signing → Contract delivered.

---

## Pass/Fail Table

| Step | Component | Result | Notes |
|---|---|---|---|
| 1. Homeowner intake | trade-selector.html | ✅ PASS | Cash path correctly skips policy step; 3-step flow (Funding → Trades → Repair/Replace). Siding trade card present. `job_type: 'retail'` set correctly for cash funding. |
| 2. Returning-user guard | trade-selector.html | ✅ PASS | Existing-claim users redirected to dashboard. |
| 3. $79 Stripe payment + Hover order | help-measurements.html | ❌ FAIL | **D-P3-001**: `deliverable_type_id` hardcoded to `2` (Roof Only). Siding jobs get a roof-only Hover order — 3D siding design is never enabled. **D-P3-006**: Deprecated auth bootstrap (DOMContentLoaded) instead of F-007. |
| 4. Hover order creation (backend) | create-hover-order EF | ❌ FAIL | **D-P3-002**: EF also hardcodes `deliverable_type_id=2` at the backend level with no trade-based override. Frontend fix alone insufficient. |
| 5. Hover 3D design | Hover portal | ⚠️ UNTESTABLE | Cannot simulate real Hover 3D design completion in staging. Marked N/A for this run. |
| 6. D-164 gate (design completion check) | check-siding-design-completion EF | ❌ FAIL | **D-P3-005**: Resolves `hover_job_id` from `measurements_filename` regex only; does not query `hover_orders.hover_job_id`. Live test confirmed: claim with valid `hover_orders` row returns `reason: "no_hover_job"`. |
| 7. Dashboard — D-164 CTA | dashboard.html | ✅ PASS | "Design your siding on Hover" card present with amber border; links to `hover.to/jobs/{hoverJobId}`. "Siding design locked in" state also implemented. Bid release pills driven by `*_bid_released_at` columns. |
| 8. Contractor bid form — siding section | contractor-bid-form.html | ✅ PASS | Dedicated `sidingTradeSection` implemented. Per-square install pricing, trim, window wrap, teardown/disposal inputs present. `sidingWallSquares` populated from Hover data. `sidingTradeActive = hasSiding && isRetailJob` guard correct. |
| 9. Post-contract color selection | color-selection.html | ❌ FAIL | **D-P3-003**: `loadClaimData()` queries `.eq('homeowner_id', userId)` — column is `user_id` — page returns no data for any user. **D-P3-004**: `requestColorBoardVisit()` insert uses `type:` (should be `notification_type:`), non-existent `status` and `contractor_id` columns. |

*Note: DocuSign signing and contract delivery (steps inherited from Phase 1/2) were not re-tested in this pass — those paths were validated in prior E2E runs and have not changed.*

---

## Defect Register

### HIGH — Blocks siding bid release

#### D-P3-001 · [86e16d7vw](https://app.clickup.com/t/86e16d7vw)
**File:** `help-measurements.html`
**Issue:** `deliverable_type_id` hardcoded to `2` (Roof Only) in two places. Siding jobs get a roof-only Hover order; 3D siding design is never enabled; D-164 gate can never clear.
**Fix:** Determine correct `deliverable_type_id` for siding from Hover API. Select at runtime based on `claim.trades`.

#### D-P3-002 · [86e16d7xd](https://app.clickup.com/t/86e16d7xd)
**File:** `supabase/functions/create-hover-order/index.ts`
**Issue:** Backend also defaults `deliverable_type_id=2` with no trade override. Frontend fix (D-P3-001) is insufficient without this.
**Fix:** Accept `deliverable_type_id` or `trades` parameter; map to correct Hover deliverable type.

#### D-P3-003 · [86e16d7yq](https://app.clickup.com/t/86e16d7yq)
**File:** `color-selection.html`
**Issue:** `loadClaimData()` queries `.eq('homeowner_id', userId)` — column is `user_id`. Page loads without error but returns zero claim data for all users. Entire post-contract color flow non-functional.
**Fix:** Change `homeowner_id` → `user_id`. Scan for other occurrences.

---

### MEDIUM — Functional defects, workarounds exist or impact is partial

#### D-P3-004 · [86e16d7zv](https://app.clickup.com/t/86e16d7zv)
**File:** `color-selection.html`
**Issue:** `requestColorBoardVisit()` insert: `type:` should be `notification_type:`; `status` and `contractor_id` columns don't exist. Insert silently fails; contractor never notified.
**Fix:** Correct column names; verify full `notifications` schema before applying.
**Note:** Masked by D-P3-003 — fix D-P3-003 first to make this observable.

#### D-P3-005 · [86e16d80a](https://app.clickup.com/t/86e16d80a)
**File:** `supabase/functions/check-siding-design-completion/index.ts`
**Issue:** Resolves `hover_job_id` from `measurements_filename` regex only; does not query `hover_orders.hover_job_id`. Claims with a valid `hover_orders` row but no `measurements_filename` are silently skipped.
**Fix:** Query `hover_orders.hover_job_id` first; fall back to filename parsing.

---

### LOW — Non-blocking, should fix opportunistically

#### D-P3-006 · [86e16d850](https://app.clickup.com/t/86e16d850)
**File:** `help-measurements.html`
**Issue:** Deprecated `DOMContentLoaded + getSession()` auth bootstrap instead of F-007 pattern. Intermittent race condition on Supabase JS v2.
**Fix:** Replace with `onAuthStateChange + INITIAL_SESSION/SIGNED_IN + _initFired` pattern. Bundle with D-P3-001 fix (same file).

---

## Test Data (Staging — Safe to Delete)

| Resource | ID / Value |
|---|---|
| Test user | `test-qa-siding-{timestamp}@otterquote-test.com` |
| Test profile | `full_name: 'Test QA Siding'` |
| Claim State A (hover ordered, no measurements) | `a1a1a1a1-0001-0001-0001-000000000001` |
| Claim State B (has_measurements=true, gate pending) | `a1a1a1a1-0002-0002-0002-000000000002` |
| hover_orders rows | `is_test=true` — safe to delete |

All test rows inserted with `is_test=true` per pre-authorization scope.

---

## Recommended Fix Order

1. **D-P3-001 + D-P3-002** (bundle) — Determine siding `deliverable_type_id` from Hover, fix both frontend and EF together. This is the critical path blocker.
2. **D-P3-003** — One-line fix, high impact. Fix immediately.
3. **D-P3-005** — EF fix, adds `hover_orders` lookup before filename fallback.
4. **D-P3-004** — Fix after D-P3-003 so it's testable. Correct column names in notification insert.
5. **D-P3-006** — Bundle with D-P3-001 (same file, same PR).

After fixes: re-run full E2E Phase 3 with a real Hover account to validate 3D design completion → D-164 gate → bid release end-to-end.

---

## Blocker: Stripe Staging Keys

The $79 Hover payment step (D-181) could not be interactively tested — staging Stripe key configuration was not confirmed. Before re-running Phase 3 post-fix, verify that staging Netlify env has `STRIPE_PUBLISHABLE_KEY` pointing to Stripe test mode keys, and that `create-hover-payment-intent` EF uses the test secret key.

---

*Report generated by Ram. Parent task: [86e132b40](https://app.clickup.com/t/86e132b40). Task left open — critical defects unresolved.*
