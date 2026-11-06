# Runbook: release a held $5 partner fee on an 'unspecified' measurement order

Issue #3460 (P18), parent #3447. Tier 3B money path: an admin runs this; nothing here is automatic.
Prerequisite: the migration `gh3460_held_fee_release` (and `gh3229_partner_measurement_fee`) is applied. Until then this runbook does not work.

## When
`platform_alerts_log` has a `buyer_role_unresolved` row (a paid order recorded with `requested_by_role = 'unspecified'`, PR #3455), or `admin-measurements.html` shows `unspecified` in the role column. The $5 is ON HOLD: it is owed only if the buyer proves to be the referred homeowner (Partner Agreement v4 A4.1).

## 1. Decide who bought it
Look at the order, its claim and the PaymentIntent in Stripe (the alert names the order, payment_intent and claim). Settle on one of: the claim's homeowner, a contractor (note which), or unknown. If unknown, stop; the order stays held and the ready email stays suppressed.

If `product_code` is `roof_upgrade_detailed`, settle it to a contractor or leave it held: the upgrade is contractor-only (D-317) and earns no $5.

Check the PaymentIntent for a refund or chargeback. A refund with `hover_orders.rebate_paid_at` set is the job-completion rebate and does not affect the fee (A4.1). For any other full refund or chargeback, settle the role, then ask the CTO the same day to void the fee row before the next monthly batch (Partner Agreement 10.1; D-401 annotation, choice 8). Settling to homeowner accrues a qualifying fee either way, so the void is what removes it. For a partial refund, stop and raise it with the CEO.

## 2. Set the role
The function refuses (SQLSTATE 42501) any session that is not a clear admin or the service role. The dashboard SQL editor and MCP `execute_sql` run as a database superuser with NO JWT, so a bare call from there is refused on purpose. Two ways in:

**A. SQL editor / `execute_sql`: set the admin claims in the same transaction, then call.** Use your own admin email (the one `is_admin_email()` accepts); it is written to the audit line. `set_config(..., true)` lasts only for the transaction, so send BEGIN ... COMMIT as one run.
```sql
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"authenticated","email":"<your admin email>"}', true);
-- the buyer is the referred homeowner: records the role AND accrues the $5 through the same checks as a normal order
SELECT public.admin_settle_order_buyer_role('<order uuid>', 'homeowner', NULL, '<one line: how you confirmed it>');
-- the buyer is a contractor: records role + contractor, no fee
-- SELECT public.admin_settle_order_buyer_role('<order uuid>', 'contractor', '<contractor uuid>', '<note>');
-- the buyer is the homeowner and step 2 already refused for a reason you can name: records the role with no fee required. A fee still accrues if the checks pass; this form cannot withhold one.
-- SELECT public.admin_settle_order_buyer_role('<order uuid>', 'homeowner', NULL, '<note>', false);
COMMIT;
```
**B. Service-role RPC** (`POST /rest/v1/rpc/admin_settle_order_buyer_role` with the service-role key, body `{"p_order_id": "...", "p_role": "homeowner", "p_note": "..."}`); the audit line then names `service_role`, so put who you are in `p_note`.

Result is JSON: `fee_cents` / `fee_status` for a homeowner settlement that accrued; `already_settled: true` if it had been done (running it again is safe, a second fee is never created). If `already_settled` comes back with `fee_status: "void"`, the fee for that order was voided earlier and this function does not reopen it: do not insert a new one; raise it with the CTO as a manual correction.

A refusal (SQLSTATE 22023, "does not qualify for the partner fee under the accrual checks") means the accrual checks said no (no credited referral, click outside the attribution window, excluded state, home inspector partner, partner had not accepted v4 by the order, is_test mismatch, or that payment already carried a fee). Nothing was changed: the order is still `unspecified` and the $5 is still held. Use the third form only when you can name the reason from that list and the buyer really is a homeowner. If you cannot name it, stop and raise it with the CTO: a refusal can also come from a missing fee setting or a fee-side error, the fee may still be owed, and the third form ends the hold for good. Do not insert into `partner_fee_events` by hand.

## 3. Send the ready email
Only after a settlement to `homeowner`. Reload `admin-measurements.html` first: every save writes `admin_notes` from the form, so a tab opened before step 2 erases the audit line. Then open the order (Edit) and Save without changing the notes. A save of an already delivered order calls `send-measurement-ready`, which now sees a settled role and sends once per order (a `notifications` row guards repeats). Do this only after step 2: while the role is `unspecified` the function suppresses the send and writes a `ready_email_suppressed_unspecified_role` alert. An order not yet delivered gets its email when it is delivered.

A `contractor` settlement sends nothing: the function skips contractor orders, and this path does not notify the contractor.

## 4. Where the fee goes next
An accrued fee joins the normal monthly batch (`create_monthly_fee_batch`, $25 minimum, admin approval, `mark-payout-paid`). Nothing else to do here.

## Audit
Each settlement appends a line to `hover_orders.admin_notes` (who, when, your note).
