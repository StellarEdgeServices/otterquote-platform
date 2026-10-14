# Pre-flight: gh2626_claims_award_columns_guard (Tier 3B)

NOT APPLIED. Refs #2626 (SECURITY, MONEY PATH). Follow-up that Ben's condition D on PR #2623 (comment 6066956273) requires before #2623 is applied. Protective only (R-134): it only removes capability from the browser roles. R-097 notice applies.

## What it does
Adds `public.claims_guard_award_columns()` (SECURITY INVOKER, `search_path = public, pg_temp`) and the trigger `claims_guard_award_columns` (`BEFORE UPDATE ON public.claims`). For client callers (`current_user` is `anon` or `authenticated`, JWT role not `service_role`, caller not an admin email), an UPDATE is refused with SQLSTATE 42501 when it:
1. moves `status` away from `contract_signed`;
2. moves `status` to `awarded` from anything other than `active` or `bidding`;
3. changes `selected_contractor_id` or `selected_bid_amount`, or moves `status` to `awarded`, unless the resulting `selected_contractor_id` has a live quote on the claim (`quotes.status` = `submitted`; `bid_status` `active` or NULL) whose `total_price` equals `selected_bid_amount`. Clearing an existing `selected_contractor_id` is refused.
A value re-sent unchanged is not a change. `service_role`, admins and owner-level sessions (`accept_bid()`, SECURITY DEFINER, postgres-owned) are untouched. No policy, grant, existing trigger or data changes. (`accept_bid()` and `quotes_guard_homeowner_columns()` are re-created; see the section added after the review.)

## Every client write to the award columns at main (5de52ea), and what the rule does to it
Enumeration: `grep -rn -A6 -E "from\(['\"]claims['\"]\)" --include=*.html --include=*.tsx --include=*.ts .` excluding tests and `supabase/functions`, filtered to `status:` and `selected_`: the only client writes that carry an award column are the ones below; every other hit is a read (`.select`) or a status write of `waitlisted` / `submitted`.

| Path | Caller | Columns | After the rule |
|---|---|---|---|
| `react-app/app/(homeowner)/bids/actions.ts` L110-116 `awardClaimToContractor` | claim owner | `selected_contractor_id` = the bid's contractor, `selected_bid_amount` = the bid's `total_price`, `status` = `awarded`, while the bid is `submitted` | Allowed when the claim is `active`/`bidding` (proof R1); today it is refused by the payment guard for every homeowner until #2623 is applied (gh-2620, proof pass 1) |
| `bids.html`, `contractor-about.html`: `rpc('accept_bid')` | claim owner | inside the RPC | Untouched: definer owned by postgres (proof R3) |
| `dashboard.html` L1919, `dashboard/actions.ts` L244 | claim owner | `status` = `waitlisted` | Allowed (proof R4), unless the claim is `contract_signed` |
| `repair-intake.html` L1328, `use-repair-intake-data.ts` L178 | claim owner | `status` = `submitted` | Allowed, unless the claim is `contract_signed` |
| `supabase/functions/*` (switch-contractor, rescind-bid, webhooks) | service-role client | any | Untouched (proof S1) |

## Added after REVIEW: FAIL 6155135164 (F1, F2) and Ben's rulings DECIDED 1 and 2

The forward file now also re-creates two existing functions from their LIVE bodies (verbatim from `supabase/migrations/20260908180021_gh1532_accept_bid_payment_guard.sql` and `supabase/migrations/20261006170000_gh2519_quotes_fee_columns_guard.sql`, plus the lines marked `gh-2626`):
- `accept_bid(uuid, uuid)` (SECURITY DEFINER): refuses a bid whose `bid_status` is not active/NULL or whose `status` is not submitted or declined (a `selected` quote, e.g. a switched-away and refunded one, is refused; review 6155821752 B1) (P0001 `bid_not_awardable`; DECIDED 1), and its claim UPDATE only matches a claim in `active` or `bidding` (P0001 `claim_not_awardable`; DECIDED 2). Behaviour change to know about: a second `accept_bid()` on an already `awarded` claim is now refused (it used to re-award silently); switching the winning bid before signing needs `switch-contractor` (service_role), not `accept_bid()`.
- `quotes_guard_homeowner_columns()`: a client caller cannot change `bid_status` unless it is the quote's own contractor; the claim owner can set `status = 'selected'` only from a `submitted` bid whose `bid_status` is active/NULL, and `status = 'declined'` only from a `submitted` or `selected` bid (review 6155821752 B2).

Every client or service writer of `quotes.status` / `quotes.bid_status` at main (5de52ea), found with `grep -rnE -A4 "from\(['\"]quotes['\"]\)" --include=*.html --include=*.js --include=*.ts --include=*.tsx . | grep -E "\.(update|upsert|insert)\("` (tests excluded) and `grep -rnE "bid_status\s*[:=]" ...`:

| Writer | Role | Writes | After the rules |
|---|---|---|---|
| `react-app/app/(homeowner)/bids/actions.ts` L136 / L153 | claim owner | `status = 'selected'` (the winning bid, `submitted`), `status = 'declined'` (the others) | allowed (proof R6, R8) |
| `bids.html` L2137, `contractor-about.html`: `rpc('accept_bid')` | claim owner, definer | selected / declined inside the RPC | allowed on a live bid and an open claim (R3, R7); refused otherwise (W1 to W4) |
| `contractor-bid-form.html` L5541, `react-app/app/contractor/bid/[claimId]/utils.ts` L509 (renew: `bid_status`), `bid-form.tsx` L326/L358 | the bidding contractor | the bid-form columns, `bid_status` on renew | allowed: own-contractor exception (proof Q1). Note: the renew value `'submitted'` is not in `quotes_bid_status_check` as read 2026-10-13 (active, expired, superseded, cancelled); that is a separate existing refusal, unchanged |
| `supabase/functions/rescind-bid` (`bid_status = 'rescinded'`), `process-bid-expirations` (`superseded`, `expired`), `process-dunning` (`status` submitted / declined), `switch-contractor` (`status = 'cancelled'`), `docusign-webhook`, `create-payment-intent`, `stripe-webhook`, `create-docusign-envelope` | service_role | status, bid_status, payment and envelope columns | untouched (proof S2) |
| `contract-signing.html`, `use-contract-signing-data.ts` | claim owner / contractor | `homeowner_signed_at`, `contractor_signed_at` only | untouched (no status or bid_status) |

No owner-side page writes `quotes.bid_status`.

### Conflict with the other unapplied drafts
`gh2519_quotes_server_set_fee.sql` and `gh2564_quotes_selected_price_lock.sql` re-create `quotes_guard_homeowner_columns()` (and gh2519 `accept_bid()`) from the same live body without the `gh-2626` lines. Applied after this set they remove those lines. Carry the lines into them first, or apply this set last. After any later migration that touches either function, both of these must return `true`:
```sql
SELECT prosrc LIKE '%gh-2626%' FROM pg_proc WHERE oid = 'public.accept_bid(uuid,uuid)'::regprocedure;
SELECT prosrc LIKE '%gh-2626%' FROM pg_proc WHERE oid = 'public.quotes_guard_homeowner_columns()'::regprocedure;
```

## Production read behind this (Supabase MCP, SELECT only, 2026-10-13)
`pg_trigger` on `public.claims`: 11 user triggers, none checks a quote. `pg_policy`: "Users can update own claims" `UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid())`, no column restriction. The blast radius from the issue (0 real claims in `bidding` or `awarded`, 2026-10-08) was not re-measured here.

## Order with PR #2623
Independent in function. Until #2623 is applied the React award is refused by the payment guard anyway; once it is applied, this guard is what stops an award to a contractor with no bid (proof pass 4 shows D2 and D3 ACCEPTED with #2623 alone, pass 5 shows them REFUSED with both). Either order is safe; the pair is complete only with both.

## Not in this migration
- The bidding contractor's own price after the award, and the other claim columns the owner can write.

## Rollback
`supabase/migrations_rollbacks/gh2626_claims_award_columns_guard_rollback.sql` drops the trigger and the function and restores `accept_bid()` and `quotes_guard_homeowner_columns()` to the live bodies (do not run the restores if gh2519 or gh2564 has been applied since). If applied through the ledger, also delete its `schema_migrations` row.

## Proof
`supabase/tests/gh2626_claims_award_columns_guard_proof.sql`, run by `supabase/tests/gh2626_claims_award_columns_guard_proof_run.sh` on a throwaway Postgres in six passes (TODAY, GUARD-ONLY, ROLLBACK, WITH-2623, WITH-2623-AND-GUARD, ROLLBACK). Negative controls: D1 to D8 are ACCEPTED before and REJECTED 42501 after; R1, R3 to R6 (the app's own writes) are ACCEPTED after. Raw output is in the PR body.
