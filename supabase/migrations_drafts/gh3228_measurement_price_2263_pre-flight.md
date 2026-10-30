<!--
STATUS (gh-1438, as of 2026-10-30): NOT APPLIED
FILE ROLE: pre-flight file of set gh3228_measurement_price_2263 (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3228; production read-only SELECT 2026-10-30 showed both price keys at 1500. Nothing was applied or written.
REPO COPY: none. When applied, file the forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# gh-3228 / P18 pre-flight: homeowner measurement fee $15 -> $22.63 (2263 cents)

Status: NOT APPLIED. Tier 3B money + legal copy. D-291 amendment pending: do not apply before it exists.

Authority: Dustin, chat 2026-10-30 09:17 ET. Still rebated on job completion (D-291). The rebate refunds `hover_orders.homeowner_charge_amount` (what was charged), so a $15 order is refunded $15 and a $22.63 order $22.63.

## Runbook (CTO, in this order)

1. Merge the PR; wait for the Netlify production deploy to go green.
2. Deploy edge functions at the merged head: `create-payment-intent` (idempotency key now includes the amount), `stripe-webhook`, `send-homeowner-next-steps`, `send-lead-next-step-reminder`. (Comment-only changes in `create-measurement-order`, `create-hover-order`, `create-docusign-envelope` may ride along or wait.)
3. Apply `gh3228_measurement_price_2263.sql` within minutes, in a quiet hour. **Never apply the SQL before steps 1 and 2 are live.** Record the apply time `T`.
4. Right after the apply, cancel every open 1500-cent measurement PaymentIntent (see "Cancel open intents").
5. Run the succeeded-without-order sweep (see below) at T+1h and again at T+24h. REQUIRED.
6. Run the post-apply checks (below) and post the results on #3228.
7. If the merge lands after 2026-10-30, bump the Effective Dates on `terms.html` and `privacy.html` to the deploy date. That is a copy change and needs a fresh LEGAL-READ before it merges.

## Why the steps are required

Measurement PaymentIntents are captured automatically (no `capture_method: manual` in `supabase/functions`) and `create-measurement-order` runs only after the PaymentIntent has `succeeded`. A homeowner who confirms a PaymentIntent created at 1500 after the apply is charged $15; the order call then refuses it (verified amount must equal 2263). Result: a charge with no `hover_orders` row, no report and no rebate record. The form's "Retry Order" retries into the same refusal.

Root cause, fixed in code: `create-payment-intent` used the idempotency key `hover_measurement-<claim_id>`, and Stripe pins a key to its first body for 24 hours, so a reload after the change returned the stale $15 intent (or a 400 and a 500 from the function for 24 hours). The key is now `hover_measurement-<claim_id>-<amount_cents>`: a reload after the change creates a fresh $22.63 intent, and the same amount still reuses the same intent. This is why `create-payment-intent` must be live (step 2) before the apply.

## Cancel open intents (right after T)

```
stripe payment_intents search --live \
  --query "status:'requires_payment_method' AND amount:1500 AND currency:'usd' AND metadata['type']:'hover_measurement' AND created>=<T-7d epoch>"
# repeat for status 'requires_confirmation' and 'requires_action', and for metadata['type']:'measurement_order'
stripe payment_intents cancel <pi_id> --live     # for each result
```

## Succeeded-without-order sweep (7 days before T through now; run at T+1h and again at T+24h)

Stripe (live mode), `metadata.type` is `measurement_order` or the legacy `hover_measurement`:

```
stripe payment_intents search --live \
  --query "status:'succeeded' AND amount:1500 AND currency:'usd' AND metadata['type']:'hover_measurement' AND created>=<T-7d epoch>"
# repeat with metadata['type']:'measurement_order'
```

Then, in the database (read-only), keep only the PaymentIntents with no order:

```sql
select p.pi_id
from (values ('pi_...'), ('pi_...')) as p(pi_id)   -- paste the ids from the Stripe search
where not exists (
  select 1 from public.hover_orders h where h.homeowner_stripe_payment_intent_id = p.pi_id
);
```

Intents succeeded BEFORE T that already have an order are fine (they are 1500 orders, rebated at 1500); the ones to act on are those with no order. For each id returned: refund it in full in Stripe, OR create its order by hand at 1500 with `rebate_due = true` (so the completion rebate still refunds the $15 actually charged). Record each id and its disposition on #3228, and record an empty result too.

## Post-apply checks

```sql
select key, value from platform_settings where key in ('hover_measurement_price','measurement_products');
-- expect hover_measurement_price = 2263 and measurement_products.roof_basic.homeowner_price_cents = 2263
```

- A test-mode PaymentIntent for an `is_test` homeowner measurement is created for 2263 (paste it).
- Grep of the served HTML shows zero `$15` measurement hits (paste it).
- Negative control: a non-completed order is not refunded; a completed order refunds `homeowner_charge_amount`.
- Meta CAPI: one post-apply test purchase is not skipped with `not_usd_2263`.

## Rollback

`gh3228_measurement_price_2263_rollback.sql` restores both keys to 1500 (guarded: both must read 2263). Apply it before redeploying the previous code and edge functions. Orders charged 2263 keep their recorded amount and are still rebated at 2263.
