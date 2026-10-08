# Pre-flight: gh2564_quotes_selected_price_lock (Tier 3B, DRAFT)

NOT APPLIED. Refs #2564. Decision: D-369 (Dustin, 2026-10-06, "Lock (Recommended)": "Price and fee freeze at selection; a different number means rescind and re-bid. Ships as its own change with the 24-hour notice."). Build ruling 6048924192 (CTO RUN 62). Requires `gh2519_quotes_server_set_fee.sql` applied first.

## What it does
It re-creates `public.quotes_guard_homeowner_columns()` as the gh2519 draft's body plus two blocks marked gh-2564. No function, trigger, table, policy or data change.

For client callers (`anon`/`authenticated`, not `service_role`, not an admin), on a bid whose `status` is `selected` before or after the write, a change to any of these is refused 42501: `total_price`, `fee_amount`, `fee_percentage`, `platform_fee_pct`, `platform_fee_basis`, `card_fee_cents`, `decking_price_per_sheet`, `full_redeck_price`, `per_trade_breakdown`.

- **Column list: the builder's proposal.** D-369 left "which columns and statuses" open. These are the eight price and fee columns named in ruling 6048924192 plus `per_trade_breakdown`, which holds the per-trade prices of a multi-trade bid. Dropping a column is deleting one line of the `IF`.
- **Status: `selected`.** `quotes_status_check` allows `draft`, `submitted`, `selected`, `declined`, `expired`; `awarded` is tested too because `apply_referral_commission()` and `switch-contractor` read it.
- **Still writable on a selected bid:** `notes`, `scope_summary`, warranty and value-add columns, `fee_accepted_at`, both signature stamps. A value re-sent unchanged is not a change, so "Update Bid" with the same numbers still saves (proof S8).
- **Who can still change the price and fee of a selected bid:** `service_role` (every Edge Function, including `docusign-webhook`, whose contract-price check halts a signing when the signed price differs), admins, and owner-level `SECURITY DEFINER` functions (proof S10, S11).

## What a contractor meets
`contractor-bid-form.html` and the React bid form still open "Change Bid" on a selected bid. Until the form change of #2564 item 2 ships, a contractor who changes the price there gets the database refusal in the form's existing error alert: `quotes: the price and fee of a selected bid are locked; to change them, rescind the bid and submit a new one (gh-2564)`. That sentence reaches a customer and needs the R-177 read.

## Two things that must be true before this is applied (D-369, 6021699133 items 2 and 3)
1. **The way out must work. On the evidence here it does not.** `supabase/functions/rescind-bid/index.ts` (main, L195-200) writes `bid_status = 'rescinded'`. Production's `quotes_bid_status_check` is `CHECK (bid_status = ANY (ARRAY['active', 'expired', 'superseded', 'cancelled']))` (pg_get_constraintdef, 2026-10-08). On the throwaway copy of that constraint the function's own UPDATE, run as `service_role` on a selected bid, fails `23514 new row for relation "quotes" violates check constraint "quotes_bid_status_check"`. Every selected bid on production carries `bid_status = 'active'`, which the function's status list accepts, so the request gets as far as that UPDATE. Not tested: a real call to the deployed function. Fix the function or the constraint, and show a rescind of an `is_test` selected bid succeeding, before the lock is applied.
2. **The bid form shows a plain message instead of "Change Bid" on a selected bid** (wording through R-177).

What a rescind after selection does to the claim (does it reopen for bids?) was left undecided by D-369.

## Before applying
- `gh2519_quotes_server_set_fee` is applied: `SELECT prosrc LIKE '%quotes_platform_fee_for(NEW.contractor_id%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure` is true and the body is byte for byte that draft's.
- `SELECT count(*) FROM public.quotes WHERE platform_fee_pct IS NOT NULL AND fee_amount IS DISTINCT FROM round(platform_fee_pct / 100.0 * total_price, 2)` is 0 (it is 0 on the 8 rows read 2026-10-08). On such a row the existing `quotes_normalize_fee_amount` trigger, which fires after the guard, would still correct `fee_amount` on any save.

## Rollback
`supabase/migrations_rollbacks/gh2564_quotes_selected_price_lock_rollback.sql` restores the gh2519 draft's body byte for byte. Proof pass 4 prints the same lines as pass 2. No data is lost.

## Proof
Shared with gh2519: `supabase/tests/gh2519_gh2564_fee_lock_proof_run.sh`, lines S0 to S12. S1 is the closes-on control pair: the same contractor UPDATE succeeds before selection (S0) and is refused after (S1).
