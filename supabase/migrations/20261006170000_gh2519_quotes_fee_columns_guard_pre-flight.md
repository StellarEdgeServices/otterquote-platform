# Pre-flight: 20261006170000_gh2519_quotes_fee_columns_guard (Tier 3B)

NOT APPLIED. Refs #2519. Supersedes PR #2538 (REVIEW: FAIL 6020152846, LEGAL-READ: FAIL 6020156346, returned by the CEO in 6020250023). Protective only (R-134): it only removes capability from the claim owner. Tier 3B because it replaces a guard function on a money-path table: R-097 notice applies.

## What it does
It adds one rule INSIDE the existing `public.quotes_guard_homeowner_columns()` (trigger `quotes_guard_homeowner_columns`, `BEFORE INSERT OR UPDATE ON public.quotes`, unchanged). No function and no trigger is added; every earlier rule is kept byte for byte.

For client callers (`current_user` is `anon`/`authenticated`, JWT role is not `service_role`, caller is not an admin), an UPDATE that changes `fee_amount`, `fee_percentage`, `platform_fee_pct` or `platform_fee_basis` is refused 42501 unless the caller is the quote's own contractor (`contractors.id = OLD.contractor_id AND user_id = auth.uid()`), the same exception the `total_price` rule makes. A value re-sent unchanged is not a change. service_role, admins and SECURITY DEFINER functions owned by postgres (`accept_bid()`) are untouched. The refusal text: `quotes: fee_amount, fee_percentage, platform_fee_pct and platform_fee_basis can only be changed by the bidding contractor, service_role or an admin (gh-2519)`. It introduces no price, promise or consent text.

## Every client write to `quotes` at main (5d1b364), and what the new rule does to it
Enumeration: a scan of every `.html`, `.js`, `.ts`, `.tsx` outside `supabase/functions` and `tests/` for `.from('quotes')` or `/rest/v1/quotes` with `.update(`, `.insert(`, `.upsert(` or `.delete(` within 14 lines: 10 hits, listed below (the 11th text hit is a comment in a test). No `.upsert(` and no `.delete(` on `quotes`.

| Path | Caller | Guarded fee columns sent | After the rule |
|---|---|---|---|
| `contractor-bid-form.html` L5513 `_changeBidPayload` (change bid / renewal) | the bid's contractor | all four | Allowed (contractor exception; proof L1, L2) |
| `react-app/app/contractor/bid/[claimId]/bid-form.tsx` L326 `buildQuoteUpdate()` (utils.ts) | the bid's contractor | all four | Allowed |
| `contractor-bid-form.html` L5575, `bid-form.tsx` L358 (INSERT) | contractor | all four | Not an UPDATE; INSERT is unchanged by this migration |
| `react-app/app/(homeowner)/bids/actions.ts` L135, L152 | claim owner | none (`status` selected / declined) | Allowed (proof L3, L4) |
| `contract-signing.html` L2029, L2039; `use-contract-signing-data.ts` L335, L354 | owner or contractor | none (`homeowner_signed_at` / `contractor_signed_at`) | Allowed (proof L5) |
| `bids.html`, `contractor-about.html`: `rpc('accept_bid')` | claim owner | inside the RPC | Untouched: definer owned by postgres (proof L8) |

Because a raising BEFORE UPDATE guard rejects the whole row write, the question is whether any client UPDATE that carries a guarded column is sent by a caller who is not the quote's contractor. The only UPDATEs that carry the four columns are the two contractor change-bid payloads; the owner's UPDATEs carry none. Server writes (Edge Functions) use service_role and are exempt.

## Not in this migration
- A lock on the bidding contractor's price and fee columns after the quote is selected (PR #2538's status clause). No decision backs it; the CEO sent it to Dustin as its own question (#2536).
- The bidding contractor's own `platform_fee_pct` / `fee_percentage` before selection, and the fee values the browser sends on INSERT. Closing either needs a server-held rate to compare against (the form reads it from the fee config in the browser and `QUOTE_FEE_PERCENTAGE` is 5.0 in the React form while `fee_amount` is computed on a base the form chooses), which is a design choice, not a column freeze. Proof line K1 shows the residual: the contractor lowers own `platform_fee_pct` to 4, ACCEPTED before and after.
- `payment_status`, `payment_intent_id`, `is_test`, `bid_status` and the other columns of `quotes` (reviewer residual 3 on #2519, 5999827566).
- The owner setting a losing bid of $10,000 or more to `selected` beside the real winner (residual 1).

## Rollback
`supabase/migrations_rollbacks/20261006170000_gh2519_quotes_fee_columns_guard_rollback.sql` restores the function to the body of `20261005200000_gh2479_born_state_guard.sql`, byte for byte, with its comment. The trigger is untouched. If the migration was applied, also delete its `schema_migrations` row.

## Proof
`supabase/tests/gh2519_quotes_fee_columns_guard_proof.sql`: one forced-rollback `DO` block on production, `is_test` rows only; the forward and rollback halves run in the same block (raw output in the PR body). CI check: `tests/gh2519-static-fee-columns-guard.mjs` (with a negative control against the born-state migration).
