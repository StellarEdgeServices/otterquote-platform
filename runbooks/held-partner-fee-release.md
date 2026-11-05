# Runbook: release a held $5 partner fee on an 'unspecified' measurement order

Issue #3460 (P18), parent #3447. Tier 3B money path: an admin runs this; nothing here is automatic.
Prerequisite: the migration `gh3460_held_fee_release` (and `gh3229_partner_measurement_fee`) is applied. Until then this runbook does not work.

## When
`platform_alerts_log` has a `buyer_role_unresolved` row (a paid order recorded with `requested_by_role = 'unspecified'`, PR #3455), or `admin-measurements.html` shows `unspecified` in the role column. The $5 is ON HOLD: it is owed only if the buyer proves to be the referred homeowner (Partner Agreement v4 A4.1).

## 1. Decide who bought it
Look at the order, its claim and the PaymentIntent in Stripe (the alert names the order, payment_intent and claim). Settle on one of: the claim's homeowner, a contractor (note which), or unknown. If unknown, stop; the order stays held and the ready email stays suppressed.

## 2. Set the role (SQL editor, signed in as an admin; or the service role)
```sql
-- the buyer is the referred homeowner: records the role AND accrues the $5 through the same checks as a normal order
SELECT public.admin_settle_order_buyer_role('<order uuid>', 'homeowner', NULL, '<one line: how you confirmed it>');
-- the buyer is a contractor: records role + contractor, no fee
SELECT public.admin_settle_order_buyer_role('<order uuid>', 'contractor', '<contractor uuid>', '<note>');
-- the buyer is the homeowner but the claim has no credited partner / the fee does not apply: records the role only, no fee
SELECT public.admin_settle_order_buyer_role('<order uuid>', 'homeowner', NULL, '<note>', false);
```
Result is JSON: `fee_cents` / `fee_status` for a homeowner settlement that accrued; `already_settled: true` if it had been done (running it again is safe, a second fee is never created).

A refusal (SQLSTATE 22023, "does not qualify for the partner fee under the accrual checks") means the accrual checks said no (no credited referral, click outside the attribution window, excluded state, home inspector partner, partner had not accepted v4 by the order, is_test mismatch, or that payment already carried a fee). Nothing was changed: the order is still `unspecified` and the $5 is still held. If the buyer really is a homeowner and no fee is owed, use the third form. Do not insert into `partner_fee_events` by hand.

## 3. Send the ready email
Open `admin-measurements.html`, open the order (Edit) and Save. A save of an already delivered order calls `send-measurement-ready`, which now sees a settled role and sends (once per order; the activity_log row guards repeats). Do this only after step 2: while the role is `unspecified` the function suppresses the send and writes a `ready_email_suppressed_unspecified_role` alert.

## 4. Where the fee goes next
An accrued fee joins the normal monthly batch (`create_monthly_fee_batch`, $25 minimum, admin approval, `mark-payout-paid`). Nothing else to do here.

## Audit
Each settlement appends a line to `hover_orders.admin_notes` (who, when, your note).
