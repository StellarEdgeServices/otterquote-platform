# Pre-Flight: gh969_hover_rebate_trigger_completion

**Migration**: gh969_hover_rebate_trigger_completion.sql
**Date**: 2026-08-20
**Author**: Code lane (run-work, rw-f22-20260820T204228-ec09), `bridge-overdrive-20260820T1928Z`, SG-3
**D-numbers**: D-291 (locked 2026-08-17, trigger half), D-182 (Tier 3 approval required)
**GitHub**: #969 — reopened twice today (both times by the `Closes #969` PR-body keyword, see SG-7). No R-097 notice has been posted for this migration.
**Status**: DRAFT ONLY — NOT APPLIED. No `apply_migration`, no `db push`, no branch test. Requires a posted, provably-expired R-097 notice and Dustin's Tier 3 approval before execution.

---

## Change Summary

Moves the hover/RoofScope $15 rebate trigger from firing on **contractor platform-fee charge success at contract signing** (`quotes.payment_status` transitioning to `'succeeded'`, trigger `after_quote_paid_rebate`) to firing on **job completion** (`claims.completion_date` transitioning from `NULL` to set, new trigger `after_claim_completed_rebate`). This is the exact same retarget gh-1050/D-283 already applied to production for the sibling referral-commission trigger (`20260819225113_gh1050_commission_accrual_job_completion.sql`) — same signal, same reasoning, different downstream function.

The Edge Function half of D-291 is **already deployed** (`process-hover-rebate` v33, 2026-08-20T19:44:09Z, PR #1098) and already gates the refund on `claims.completion_date`. That redeploy did not touch the DB trigger. Today the trigger fires at signing, wakes v33, v33 finds `completion_date` unset, and declines — and nothing fires it again at actual completion. **Net effect: the rebate never pays**, which this migration fixes.

---

## Completion Signal — Chosen and Why

**Chosen: `claims.completion_date` via a DB trigger, not a call added inside `mark-job-complete`.** Identical reasoning to the gh-1050 precedent, re-verified independently this session rather than assumed:

`claims.completion_date` has exactly one write path — `supabase/functions/mark-job-complete/index.ts:404`, `.from("claims").update({ completion_date: completionDate })`. That function is idempotent (`index.ts:383`: if already set, returns the existing timestamp, no second write). No other Edge Function, trigger, cron job, or admin surface writes this column (confirmed by the same grep gh-1050's pre-flight ran, re-run this session: every other hit under `supabase/functions/` and `sql/` is a reader).

A DB trigger keeps the accrual/notify site consistent with the existing triggers-on-event pattern already in this schema (`after_claim_completed` for commission, `after_quote_refunded`, `trg_claims_advance_referral`) and gets the same-transaction ACID guarantee gh-1050's pre-flight argues for, rather than depending on every future `completion_date` writer remembering to also call the rebate notify.

---

## Live Trigger/Function Definitions (captured 2026-08-20, this session, `pg_get_functiondef`/`pg_get_triggerdef` against production `yeszghaspzwwstvsrioa`)

**Old firing point (`after_quote_paid_rebate`, dropped by this migration):**
```sql
CREATE TRIGGER after_quote_paid_rebate AFTER UPDATE OF payment_status ON public.quotes
FOR EACH ROW WHEN (((new.payment_status = 'succeeded'::text)
  AND (old.payment_status IS DISTINCT FROM 'succeeded'::text)))
EXECUTE FUNCTION notify_hover_rebate()
```

This transition is written by `stripe-webhook` on the platform-fee charge succeeding — contract signing, per D-127 — not job completion. Unlike gh-1050's `after_quote_paid`, this trigger carries **no $10K floor** in its `WHEN` clause, so no floor-check migrates into the function body; the rebate applies to every hover order regardless of job size, unchanged by this migration.

---

## Every Code Path That Can Legitimately Mark a Job Complete

One, unchanged from the gh-1050 precedent's own finding (re-verified, not inherited):

| Path | File | Notes |
|---|---|---|
| `mark-job-complete` Edge Function | `supabase/functions/mark-job-complete/index.ts` | Contractor-authenticated (JWT). Idempotent — a repeat call returns the existing timestamp, no second write. Sole writer of `claims.completion_date`. |

---

## Interaction With `process-hover-rebate` (already deployed, v33)

The Edge Function itself already re-checks `claims.completion_date IS NOT NULL` on every invocation (`index.ts:99-104`) regardless of what woke it, and separately guards on `hover_orders.rebate_due=true AND rebate_paid_at IS NULL` before refunding. This migration only changes *when the function is called*, not the function's own idempotency — a duplicate or premature invocation from any residual old-trigger race is a no-op inside the function itself, not a double-refund risk.

---

## Row Count / Live Exposure (live, checked 2026-08-20T20:4xZ, this session — not carried forward from the 19:43Z draft report)

| Query | Result |
|---|---|
| `select count(*) from hover_orders` | 0 |
| `select count(*) from hover_orders where rebate_due AND rebate_paid_at IS NULL` | 0 |
| `select count(*) from quotes where payment_status='succeeded'` | 1 |
| `select count(*) from claims where completion_date IS NOT NULL` | 1 |

`hover_orders` is empty — neither the old nor the new trigger has any row to act on today. Zero live exposure. Not a reason this stops being Tier 3.

---

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|--------------------|
| `DROP TRIGGER after_quote_paid_rebate` | `ACCESS EXCLUSIVE`, briefly | negligible (`quotes` is a handful of rows) |
| `CREATE OR REPLACE FUNCTION notify_hover_rebate` | none (definition swap) | negligible |
| `CREATE TRIGGER after_claim_completed_rebate` on `claims` | `ACCESS EXCLUSIVE`, briefly | negligible (`claims` is a handful of rows) |

No `ALTER TABLE`, no index build, no data migration.

---

## Danger Pattern Check

| # | Pattern | Triggered? |
|---|---------|-----------|
| 1 | NOT NULL column without DEFAULT | No |
| 2 | NOT NULL on table > 100K rows | No |
| 3 | DROP COLUMN | No |
| 4 | Type change requiring table rewrite | No |
| 5 | Index without CONCURRENTLY on hot table | No |
| 6 | RENAME TABLE or RENAME COLUMN | No |
| 7 | TRUNCATE or DELETE all rows | No |
| 8 | CASCADE DROP | No |

**All 8 clear. No overrides required.**

Additional risk called out because this is on a Stripe-refund path: the trigger now fires from a **different table** (`claims` instead of `quotes`) than it did before, exactly as gh-1050's did — this is a structural move, not a body-only edit. Mitigated by the naming check below and by `process-hover-rebate`'s own re-verification of `completion_date` on every call regardless of caller.

---

## Trigger-Name Collision Check (claims already carries one AFTER-UPDATE-OF-completion_date trigger)

`public.claims` already has `after_claim_completed` (gh-1050, calls `apply_referral_commission()`) firing on the identical `WHEN` condition this migration adds. This migration's trigger is named `after_claim_completed_rebate` — distinct name, same table, same column, same WHEN shape. Postgres fires all matching `AFTER` triggers on a row in trigger-name alphabetical order within the same statement; both are independent, single-purpose, SECURITY DEFINER functions with their own `BEGIN/EXCEPTION` swallow blocks, so one firing cannot block or fail the other. No shared state between them.

---

## Branch Test — NOT RUN, and why

**This migration is NOT branch-tested.** Preview-branch creation is confirmed broken in this project as of today (`#728`, `#1022`, `#1069`, named explicitly in SG-3 on the lane file) — this was not attempted and re-attempting it was out of scope for this draft. This is a materially weaker verification state than the gh-1050 precedent, which WAS branch-tested (4 assertions, all passed) before being applied. **Whoever applies this migration should either fix branch-preview first and test there, or accept applying without a branch test and verify immediately post-apply** using the queries in "Verification At Deploy" below, against the zero-live-exposure window confirmed above.

---

## Code Path Impact Analysis

- **`notify_hover_rebate()` callers**: only the new `after_claim_completed_rebate` trigger post-migration — the old `after_quote_paid_rebate` caller is dropped in the same transaction, so there is no window where both are attached.
- **`process-hover-rebate` (v33)**: unmodified by this migration, unaffected — already deployed and already checks the right column.
- **`mark-job-complete`**: unmodified — this migration attaches a new trigger to an UPDATE it already performs; no code change to the function itself.
- **gh-1050's `after_claim_completed` / `apply_referral_commission()`**: unmodified, unaffected — separate trigger, separate function, same table/column, verified not colliding (see above).

---

## Deploy Notes

- **D-182 Tier**: 3 — SQL migration on a Stripe-refund-adjacent trigger. Requires explicit Dustin approval before execution, and a posted R-097 24h notice with a provably expired window (none posted as of this draft).
- **Deploy path**: PR → merge → approved manual `apply_migration` against `yeszghaspzwwstvsrioa` (matches the v88/gh916/gh1050 precedent — merging the PR does NOT apply this migration).
- **Rollback pre-authorized**: no — same convention as gh-1050, rollback needs the same re-confirmation this pre-flight used (hover_orders still 0) immediately before running it, not inherited from this draft. If any rebate has been paid under the new trigger by the time a rollback is needed, STOP and hand-reconcile before running the rollback file — it assumes zero paid rows, same precondition as the forward migration.
- **Monitoring**: watch Postgres logs for `notify_hover_rebate pg_net call failed` lines after the first real completion event post-apply; confirm the rebate actually pays for that order (`hover_orders.rebate_paid_at` set).

---

## Verification At Deploy

1. `pg_get_triggerdef` — `after_claim_completed_rebate` exists on `public.claims`, `after_quote_paid_rebate` gone from `public.quotes`.
2. `pg_get_functiondef(notify_hover_rebate)` — body reads `NEW.id`, no `NEW.claim_id`.
3. Manually set `completion_date` on a synthetic/test claim with a matching `hover_orders` row (`rebate_due=true`, `rebate_paid_at IS NULL`) and confirm exactly one `process-hover-rebate` invocation, ending in `rebate_paid_at` set.
4. Re-run the four live-exposure queries above; hover_orders count should be unchanged unless the test in step 3 was against a real row.

---

## Danger Overrides

None.
