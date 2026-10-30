<!--
STATUS (gh-1438, as of 2026-10-30T13:30:00Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3229_partner_measurement_fee (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3229; production read-only queries the same day (project yeszghaspzwwstvsrioa). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3229_partner_measurement_fee

Issue #3229 (P18). Money: Tier 3B. Needs REVIEW + LEGAL-READ + R-177 pair; CTO applies after R-097.

## What it changes
1. `platform_settings`: seeds `partner_measurement_fee_cents` = 500 and `partner_payout_minimum_cents` = 2500 (insert, no overwrite).
2. `payout_approvals_payout_type_check` gains `measurement_fees_monthly` (drop and re-add; the table is small).
3. New table `partner_fee_events` with RLS (partner reads own, admin all, no client writes; grants: authenticated SELECT only, anon none).
4. Triggers on `hover_orders` (accrue on a homeowner-paid order; AFTER INSERT only, so editing an older order never accrues; `create-measurement-order` writes role, payment, amount and claim in one INSERT on every path) and on `payout_approvals` (a batch payout that becomes paid flips its events to paid; rejected or deleted releases them to accrued). No refund trigger: the job-completion rebate does not void the $5 (CEO ruling on #3236).
5. Functions: `get_partner_dashboard_stats()`, `create_monthly_fee_batch(date)`, `partner_fee_events_mark_paid(uuid)` plus three trigger functions. None is executable by anon.

## Live state read (2026-10-30, read-only)
- `hover_orders`: no `is_test`; columns used: `requested_by_role`, `homeowner_stripe_payment_intent_id`, `stripe_payment_id`, `homeowner_charge_amount`, `rebate_paid_at`. Only trigger today: `trg_hover_orders_updated`.
- Refund signal: the only recorded refund is `process-hover-rebate` setting `rebate_paid_at` (job completion); by ruling it does not void the $5. `stripe-webhook` has no `charge.refunded` handler, so a refund issued by hand in the Stripe dashboard is not detected (known gap, follow-up issue). To correct one by hand: `update partner_fee_events set status='void', voided_at=now() where hover_order_id = ... and status='accrued'`.
- `payout_approvals.referral_id` is nullable. No auto-approve exists (D-293); rows wait in `pending_approval`.
- `referral_attribution_window()` is IMMUTABLE 30 days today; PR #3226 (#3219) replaces it with a STABLE platform_settings read (seed 90). This set only calls it, so either order of applying works; the accrual window follows whichever is live.
- `partner_fee_events.payment_ref` (PaymentIntent id, else charge id) is UNIQUE: production has no unique index on `hover_orders.homeowner_stripe_payment_intent_id`, so two concurrent retries of one PaymentIntent can create two order rows; only one fee accrues. (Follow-up: a unique partial index on that column.)
- Batch month boundaries are midnight America/New_York; only past months can be batched.
- Today `hover_orders` has 3 rows (2 homeowner, 1 contractor); no backfill is done: only orders recorded after the apply accrue.

## Order with the open P18 sets
- gh3217 (#3225) revokes table SELECT on `referrals` from `authenticated`. `get_partner_dashboard_stats()` is SECURITY DEFINER and does not need that grant; apply in either order.
- gh3219 (#3226) adds `claims_lock_referral`; the accrual reads `claims.referral_id` after it, so the locked partner is the one paid.

## Verify
Run `supabase/tests/gh3229_partner_measurement_fee_proof.sql` (single rolled-back batch; result in the final exception). Local: `supabase/tests/gh3229_partner_measurement_fee_local_run.sh after|before|mutant|rollback`.

## Rollback
`gh3229_partner_measurement_fee_rollback.sql`. Refuses while any batched or paid event or any `measurement_fees_monthly` payout exists.
