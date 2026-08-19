# Pre-Flight: gh1050_commission_accrual_job_completion

**Migration**: gh1050_commission_accrual_job_completion.sql
**Date**: 2026-08-19
**Author**: Code lane sub-agent (automated), run-work orchestration (rw-1050-f22-b6cm)
**D-numbers**: D-283 (locked 2026-08-14, code half), D-182 (Tier 3B approval required)
**GitHub**: #1050 — R-097 24h notice window opened 2026-08-14T16:44:53Z, closed 2026-08-15T16:44:53Z, no objection. Execution permitted; D-182 approval still required before `apply_migration` runs against production.
**Status**: DRAFT ONLY — NOT APPLIED. Requires a D-182 approval task before execution.

---

## Change Summary

Moves commission accrual from firing on **homeowner/platform-fee deposit success at contract signing** (`quotes.payment_status` transitioning to `'succeeded'`, trigger `after_quote_paid`) to firing on **job completion** (`claims.completion_date` transitioning from `NULL` to set, new trigger `after_claim_completed`). Every partner-facing surface (Partner Referral Agreement Sec 4.2, `partner-re.html`, `partner-dashboard.html`) already states commissions are owed once the job is done; the code owed it at deposit. `payout_approvals` = 0 rows and `total_commission_paid` = $0.00 (re-verified live 2026-08-19T20:4x) — no live money to misroute.

`apply_referral_commission()` is retargeted from a `quotes` row to a `claims` row: `referral_id` is read directly off `claims` (simpler than the old `claims`-lookup-via-`quotes.claim_id` indirection), and the $10K qualifying-job floor (D-139) plus `job_value` are resolved from the winning quote (`status IN ('selected','awarded')` — the same predicate `mark-job-complete` itself uses) inside the function body, since a trigger `WHEN` clause on `claims` cannot reference `quotes` columns.

---

## Completion Signal — Chosen and Why

**Chosen: `claims.completion_date` via a DB trigger (`after_claim_completed`), not an explicit call added inside `mark-job-complete`.**

Confirmed live (2026-08-19, this session) that `claims.completion_date` has **exactly one write path** in the codebase: `supabase/functions/mark-job-complete/index.ts`. It is contractor-authenticated, requires the claim to already be in `('contract_signed', 'awarded')`, and is itself idempotent (a repeat call returns the existing timestamp with `already_complete: true`, no second write). Grepped the full `supabase/functions/` tree and `sql/*.sql` for `completion_date` writers — no other Edge Function, trigger, cron job, or admin surface sets this column. (Readers of it: `approve-payout`'s completion gate, `get-payout-completion-status`, `send-home-profile-prompt`, `send-partner-status-email` stage 5, `record-warranty-upload`'s gate — none write it.)

A DB trigger was chosen over adding the accrual call directly inside `mark-job-complete` for the same reason the original v40 migration gives for using a trigger over a scheduled function: this is an event ("a job was marked complete"), not a time-series job, and a trigger gets ACID guarantees for free in the same transaction as the `completion_date` write. It also does not depend on every future code path that might someday set `completion_date` remembering to also call the accrual logic — the existing referral/commission subsystem in this repo is triggers-on-event throughout (`after_quote_paid`, `after_quote_refunded`, `trg_claims_advance_referral`), and this keeps the new site consistent with that pattern rather than introducing a one-off EF-level call as the sole accrual site.

---

## Every Code Path That Can Legitimately Mark a Job Complete

Per the AC1 requirement to name every completion path: there is **one**.

| Path | File | Notes |
|---|---|---|
| `mark-job-complete` Edge Function | `supabase/functions/mark-job-complete/index.ts` | Contractor-authenticated (JWT). Requires an owned quote with status `selected`/`awarded`. Requires `claims.status IN ('contract_signed','awarded')`. Idempotent (`completion_date` already set → returns existing timestamp, no write). This is the only writer. |

No admin surface, cron job, or webhook sets `completion_date`. This was confirmed by grepping `completion_date` across `supabase/functions/` and `sql/` — every other hit is a *reader* (`approve-payout`, `get-payout-completion-status`, `send-home-profile-prompt`, `send-partner-status-email`, `record-warranty-upload`), never a writer.

---

## Live Trigger/Function Definitions (captured 2026-08-19, this session, via `pg_get_functiondef`/`pg_get_triggerdef` against production `yeszghaspzwwstvsrioa`)

**Old firing point (`after_quote_paid`, dropped by this migration):**
```sql
CREATE TRIGGER after_quote_paid AFTER UPDATE OF payment_status ON public.quotes
FOR EACH ROW WHEN (((new.payment_status = 'succeeded'::text)
  AND (old.payment_status IS DISTINCT FROM 'succeeded'::text)
  AND (COALESCE(new.total_price, (0)::numeric) >= (10000)::numeric)))
EXECUTE FUNCTION apply_referral_commission()
```

This transition is written by `supabase/functions/stripe-webhook/index.ts` on `payment_intent.succeeded` for `metadata.type === 'platform_fee'` — the platform-fee ACH charge finalizing, which per the webhook's own `gh-948` routing comment happens at **contract signing**, not job completion. `apply_referral_commission()`'s live body already carries this exact correction in its own comments (v94, GitHub #567): the trigger fires on the fee charge, and the referral status it wrote was corrected from the (false) label `'job_completed'` to `'contract_signed'` for that reason — but the underlying **timing** of the `payout_approvals` row / `commission_amount` write was left untouched by that fix. This migration is the follow-through: it moves the write itself, not just its status label, to the real completion event.

`reverse_referral_commission()` / `after_quote_refunded` (v42/v102, unchanged by this migration) already voids pending `payout_approvals` rows and zeroes `referrals.commission_amount` on a refund — confirmed live-matching `sql/v102-fix-reverse-referral-commission-payout-approvals.sql` verbatim (v102 is applied to production, closed via PR #660 per #651).

---

## Interaction With the Existing Completion Gate (`approve-payout`)

`supabase/functions/approve-payout/index.ts` (lines ~291-331) **already** holds payout release on an incomplete job (`claims.completion_date IS NULL`) unless an admin explicitly passes `override_incomplete: true`. This migration does not touch that gate — it fixes the earlier problem: the `payout_approvals` **ledger entry itself**, and `referrals.commission_amount` being non-zero, existing before completion at all. Before this migration, real money could not move early (the release gate already blocked it), but partner dashboards and admin review already showed amounts "owed" before the job was done, and an admin approving early had to click through an override warning that should not need to exist for the common case.

---

## Row Count Estimate (live, checked 2026-08-19)

| Table | Row Count | Source |
|-------|-----------|--------|
| `payout_approvals` | 0 | `execute_sql` this session |
| `referral_agents` (`total_commission_paid` sum) | $0.00 across all rows | `execute_sql` this session |
| `referral_agents` (`total_commission_earned` sum) | $0.00 across all rows | `execute_sql` this session |
| `referrals` | 8 (`commission_amount`/`commission_paid_at` all NULL/0) | `execute_sql` this session |

All tables tiny; this is a `CREATE OR REPLACE FUNCTION` / `DROP`+`CREATE TRIGGER` migration — no table structure change, no data migration.

---

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|--------------------|
| `DROP TRIGGER after_quote_paid` | `ACCESS EXCLUSIVE`, briefly | < 5ms (4-row `quotes` table per gh916's own count) |
| `CREATE OR REPLACE FUNCTION` | none (function definition swap) | negligible |
| `CREATE TRIGGER after_claim_completed` on `claims` | `ACCESS EXCLUSIVE`, briefly | < 5ms (12-row `claims` table) |

No `ALTER TABLE`, no index build, no data migration.

---

## Danger Pattern Check

| # | Pattern | Triggered? | Override? |
|---|---------|-----------|-----------|
| 1 | NOT NULL column without DEFAULT | No — no columns added | — |
| 2 | NOT NULL on table > 100K rows | No | — |
| 3 | DROP COLUMN | No | — |
| 4 | Type change requiring table rewrite | No | — |
| 5 | Index without CONCURRENTLY on hot table | No — no index added | — |
| 6 | RENAME TABLE or RENAME COLUMN | No | — |
| 7 | TRUNCATE or DELETE all rows | No | — |
| 8 | CASCADE DROP | No | — |

**All 8 patterns clear. No overrides required.**

Additional risk called out explicitly because this is on the real payment/commission path:

- **The accrual write itself moves tables** (was on `quotes`, now on `claims`) — this is a bigger structural change than a typical trigger-body edit (compare gh916, which only appended a step to the existing body without moving the firing table). Mitigated by the branch test below, which exercises both the old-path-now-no-op and new-path-fires-once cases directly against the retargeted function.
- **The $10K floor check moves from the trigger `WHEN` clause into the function body** because `claims` doesn't carry `total_price`. A floor-miss (sub-$10K job) is exercised on the branch (see below) and correctly no-ops.
- **`reverse_referral_commission()` is unaffected** — it operates purely on `referrals`' current ledger state via `claim_id`, not on where the accrual write came from.

---

## Code Path Impact Analysis

- **`apply_referral_commission()` callers**: only the new `after_claim_completed` trigger post-migration (the old `after_quote_paid` caller is dropped in the same transaction, so there is no window where both are attached).
- **`mark-job-complete`'s own non-fatal referral-advance write** (`referrals.status = 'job_completed'`, guarded `.not("status","in",'("job_completed","commission_paid")')`): unaffected by this migration, still runs, becomes a no-op in the common case because the new trigger already sets that same status inside the same DB transaction as the `completion_date` UPDATE — before `mark-job-complete`'s later separate Supabase-client round-trip executes its own advance call.
- **`reverse_referral_commission()` / `after_quote_refunded`**: unmodified, unaffected.
- **`approve-payout`'s completion gate**: unmodified, unaffected — continues to hold on `completion_date IS NULL` regardless of where the ledger entry originated.
- **`get-payout-completion-status`, `send-home-profile-prompt`, `send-partner-status-email`, `record-warranty-upload`**: all pure readers of `completion_date` — unaffected.

---

## Supabase Branch Test Results (RUN — this is a completed branch test, not a pending one)

Branch `gh1050-commission-accrual-timing` (`mephbyxgfvaggdlkoflw`) created off production `yeszghaspzwwstvsrioa`, migration applied via `apply_migration`, then exercised directly (synthetic fixtures: one `referral_agents` row, one `contractors` row, one `claims` row, one `referrals` row, two `quotes` rows — one $15,000/`selected`, one $4,000/`selected`; a synthetic `auth.users` row was inserted directly since branches don't carry over `auth` data and `claims.user_id` has a live FK to `auth.users`). Branch deleted after testing.

**1. Old deposit-success path — confirmed no longer accrues:**
```sql
UPDATE quotes SET payment_status = 'succeeded' WHERE id = '5555...';
-- Result: referrals.commission_amount = NULL, payout_approvals rows = 0,
--         referrals.status unchanged ('contract_signed')
```

**2. New completion path — confirmed exactly one accrual, at the right moment:**
```sql
UPDATE claims SET completion_date = now() WHERE id = '3333...';
-- Result: referrals.commission_amount = 200.00, referrals.job_value = 15000.00,
--         referrals.status = 'job_completed', payout_approvals rows = 1
--         (status='pending_approval', amount=200, trigger_event='Job completed — referral ... (claim ...)')
```

**3. Idempotency — a second write to `completion_date` does not double-accrue** (trigger `WHEN` clause requires `OLD.completion_date IS NULL`, so it never re-fires once set):
```sql
UPDATE claims SET completion_date = now() WHERE id = '3333...'; -- second write
-- Result: payout_approvals rows still = 1, commission_amount still = 200.00
```

**4. $10K floor miss — a sub-floor job never accrues on completion** (second synthetic claim/referral/quote, $4,000):
```sql
UPDATE claims SET completion_date = now() WHERE id = '7777...';
-- Result: referrals.commission_amount = NULL, payout_approvals rows = 0
```

All four assertions passed as expected.

---

## Deploy Notes

- **D-182 Tier**: 3B — SQL migration touching the payment/commission-adjacent trigger function `apply_referral_commission()`. Requires explicit Dustin approval before execution. Per D-283 and the R-097 window closure, execution is *permitted* pending that D-182 sign-off — the two are separate gates.
- **Deploy path**: GitHub PR → merge → approved manual `apply_migration` against `yeszghaspzwwstvsrioa` (matches the `v88`/`gh916` precedent — merging the PR does NOT apply this migration).
- **Rollback pre-authorized**: yes, once re-confirmed at apply time that `payout_approvals` is still 0 rows (true as of this draft) — run `gh1050_commission_accrual_job_completion_rollback.sql`. It restores `apply_referral_commission()` to its exact current live (gh-752) body and `after_quote_paid` to its exact current live definition, and drops `after_claim_completed`. **If any accrual has occurred under the new regime by the time a rollback is needed, STOP and hand-reconcile those specific rows before running the rollback file** — it assumes zero accrued rows, same precondition as the forward migration.
- **Monitoring**: watch Postgres logs (`RAISE LOG` lines prefixed `apply_referral_commission:`) for the first real completion event post-apply, and confirm `admin-payouts.html` / `admin-referrals.html` show the expected single `payout_approvals` row at the expected time.

---

## Known Coordination Item — gh916 (unrelated, unapplied draft)

`supabase/migrations_drafts/gh916_progressive_partner_status_triggers.sql` also modifies `apply_referral_commission()` (adds a step-9 partner-status-email `pg_net` call), written against the OLD quotes-triggered body, and is itself still an unapplied D-182-pending draft as of 2026-08-19. **If gh916 is approved and applied to production before this migration, gh1050's `CREATE OR REPLACE FUNCTION` will silently drop gh916's step-9 addition** (a full function-body replace, not a patch). Whichever of gh916 / gh1050 is approved and applied **second** must be rebased against the other's already-live function body before applying. Flagged on GitHub #1050 and #916 (comment) and in the PR body for this migration.

---

## Danger Overrides

None.
