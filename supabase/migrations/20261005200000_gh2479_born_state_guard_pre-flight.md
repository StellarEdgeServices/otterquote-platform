# Pre-flight: 20261005200000_gh2479_born_state_guard (Tier 3B)

NOT APPLIED. Refs #2479 (CLOSE-REVIEW: FAIL, comment 6000637783, routes E1, E3, E7). Protective only (R-134). Tier 3B because it replaces two guard trigger functions on money-path tables (`claims`, `quotes`) and widens one trigger: R-097 notice applies.

## What it does
It extends the two guard functions that already exist. It adds no function and no trigger.

- `public.claims_guard_referral_columns()` (trigger `claims_guard_referral_columns`, `BEFORE INSERT OR UPDATE ON public.claims`, unchanged). For client callers (`current_user` is `anon`/`authenticated`, JWT role is not `service_role`, caller is not an admin):
  - Kept: `created_at := now()` on INSERT; `referral_id`, `completion_date`, `created_at` frozen on UPDATE.
  - New, INSERT: `status` must be `documents_needed` or `draft`; `selected_contractor_id`, `selected_bid_amount`, `completion_date`, `contract_signed_at` must be NULL. `referral_id` on INSERT stays allowed.
  - New, UPDATE: `status` can change only to `active`, `waitlisted`, `submitted` or `awarded`.
- `public.quotes_guard_homeowner_columns()` (trigger `quotes_guard_homeowner_columns`, widened in place from `BEFORE UPDATE` to `BEFORE INSERT OR UPDATE ON public.quotes` with `CREATE OR REPLACE TRIGGER`).
  - Kept: the three UPDATE rules of `20261005170000`.
  - New, INSERT: `contractor_id` must be a contractor row of the caller; `status = 'submitted'`; `bid_status = 'active'`; `is_auto_bid` not true; `renewed_from_quote_id`, `homeowner_signed_at`, `contractor_signed_at`, `payment_status` NULL.
- A refused write raises 42501. A value re-sent unchanged is not a change.
- No GRANT, REVOKE, policy, column, index or data change. Both functions stay SECURITY INVOKER.

Why the UPDATE rule on `claims.status` is in a "born-state" migration: without it the INSERT rule is empty. The owner would INSERT the claim in its initial state and then `UPDATE claims SET status = 'contract_signed'` (proof E3u: `commission=200.00` before, refused after).

## Every client INSERT into `claims` at main (f97f8f1), and what the guard does to it

| Path | Caller | Late-state columns sent | After the guard |
|---|---|---|---|
| `trade-selector.html` ~L1465 | homeowner | none (`user_id`, funding, policy, trades, job type, address, `referral_source`, `referral_agent_id`, `referral_code`, `referral_id` when a click chain exists, `is_test`, `created_at`) | Allowed; `status` takes the column default `documents_needed` (proof L1, X0) |
| `react-app/app/trade-selector/page.tsx` ~L1016 | homeowner | none (the same plus `property_city`, `property_zip`, `referrer_updates_opt_out`) | Allowed, with and without `referral_id` (proof L2) |
| `react-app/app/(homeowner)/repair-intake/utils.ts` `buildClaimInsert()` | not called (gh-2004 removed the INSERT from both repair-intake pages) | `status: 'draft'` | Would be allowed (proof X3) |

Enumeration: every `.from('claims')` followed by `.insert(` or `.upsert(` in the static pages, `js/` and `react-app/` (2 hits, both above); no `.upsert(` on `claims`; no raw `/rest/v1/claims` call. `tests/e2e/seed/seed.mjs` inserts claims with the service-role key and is exempt.

## Every client write of `claims.status` at main

| Path | Caller | Value | After the guard |
|---|---|---|---|
| `dashboard.html` ~L3231, `react-app/app/(homeowner)/dashboard/actions.ts` ~L41 (submit for bids) | homeowner | `active` | Allowed (proof Y1, L4) |
| `dashboard.html` ~L1919, `react .../dashboard/actions.ts` ~L244 (state gate) | homeowner | `waitlisted` | Allowed (proof Y3, L16) |
| `repair-intake.html` ~L1326, `react .../repair-intake/use-repair-intake-data.ts` ~L176 | homeowner | `submitted` | Allowed (proof Y4, L17) |
| `react-app/app/(homeowner)/bids/actions.ts` ~L111 (React award) | homeowner | `awarded` with `selected_contractor_id`, `selected_bid_amount` | Allowed by this guard; refused today, before and after, by the existing gh-1532 defect (proof Y-awarded, R1) |
| `bids.html`, `contractor-about.html`: `rpc('accept_bid')` | homeowner | `awarded` (inside the RPC) | Untouched: `accept_bid()` is SECURITY DEFINER owned by `postgres` (proof L10) |

The other 27 client `.from('claims').update(...)` sites (dashboard saves and uploads, help-estimate / help-materials / help-measurements, project-info-*, project-confirmation, color-selection, trade-selector, video upload, the two admin-measurements writes and their React twins) send no `status`.

Server writes of `claims.status` (service-role client, exempt, proof S1, S5, S6, S7, L13): `docusign-webhook` and `process-dunning` (`contract_signed`), `switch-contractor` and `process-dunning` (`bidding`), `process-dunning` (`submitted`). `mark-job-complete` writes `completion_date` only (proof S9, L15).

## Every client INSERT into `quotes` at main

| Path | Caller | Guarded columns sent | After the guard |
|---|---|---|---|
| `contractor-bid-form.html` ~L5578 (`quoteData`) | contractor | `contractor_id` = own; `is_auto_bid: false`; no `status`, `bid_status`, renewal, signing or payment column | Allowed (proof Q0, L5, L7) |
| `react-app/app/contractor/bid/[claimId]/bid-form.tsx` ~L358 (`buildQuoteInsert()` in `utils.ts`) | contractor | the same | Allowed |

No `.upsert(` on `quotes`; no raw `/rest/v1/quotes` call. Server INSERTs (service role, exempt, proof S2, S3, S4b): `process-auto-bids` (`is_auto_bid: true`), `process-bid-expirations` (`renewed_from_quote_id`).

SQL functions in the live schemas that INSERT into or UPDATE `claims` or `quotes` (pg_proc scan 2026-10-05): `accept_bid`, `record_first_touch_attribution`, `set_bid_window_on_first_bid`. All three are SECURITY DEFINER owned by `postgres`, so they never reach either guard. None INSERTs.

## Residual (NOT closed by this migration; say so on the issue)
- **The same single user can still accrue $200 through the product's own award.** A user who is both the claim owner and an active contractor with a payment method on file creates the claim from the funnel with a referral, bids on it, accepts their own bid (`accept_bid()` or the React award) and marks the job complete. The claim is then `awarded`, which `mark-job-complete` accepts (`COMPLETABLE_STATES = ["contract_signed", "awarded"]`), and no contract was signed and no platform fee charged. Proof E3p and E3q: `commission=200.00` before and after. The extra hurdle compared with the route this migration closes is the payment method on file (`has_payment_method`, which the contractor cannot set: `enforce_contractor_privileged_columns()`). Closing it is not a born-state rule. It needs one of: `mark-job-complete` accepting only `contract_signed` (with this migration, a status only service_role can set); the commission requiring `claims.contract_signed_at` or a paid platform fee; or a rule that a contractor cannot bid on a claim they own. The last is a business rule next to the self-referral question on #2479 (5999296292). Not built here.
- #2519, unchanged: the claim owner setting a losing bid of at least $10,000 to `selected` (refuter E4); the fee columns (PR #2538).
- Other columns a client can still set at INSERT: `claims.is_test`, `ready_for_bids`, the `*_bid_released_at` stamps; `quotes.is_test`, `payment_intent_id`, `docusign_envelope_id`, fee columns.
- The FROM state of a `claims.status` change is not restricted (an owner can still move a `contract_signed` claim to `active`; proof Y11 shows `bidding` is refused).
- Existing defects seen in the proof run, unchanged by this migration: the auto-renew INSERT in `process-bid-expirations` sends no `fee_percentage` and is refused 23502 (proof S4; S4b is the same INSERT with the fee columns); `rescind-bid` writes `bid_status = 'rescinded'`, refused 23514 (proof L8); the React award is refused `contractor_no_payment_method` (proof R1, Y-awarded).

## Danger-pattern check
- No new trigger. `CREATE OR REPLACE TRIGGER` takes a ShareRowExclusiveLock on `quotes` for the length of the transaction (two function replacements and one trigger statement). `quotes` has 8 rows and `claims` 29 on production (read 2026-10-05).
- The function is replaced before the trigger is widened, in one transaction, so the old body (which reads `OLD`) is never called for an INSERT. The rollback does the reverse order.
- Trigger order on a `quotes` INSERT (BEFORE triggers fire in name order): `quotes_enforce_bid_can_submit`, `quotes_guard_homeowner_columns`, `quotes_normalize_fee_amount`, `trg_enforce_bid_window_expiry`. A bid refused by the D-199 gate is still refused by it first. BEFORE triggers fire ahead of the RLS `WITH CHECK`, so an INSERT naming another contractor now reads `quotes: a bid can only be created by the contractor it names` instead of the RLS message; the SQLSTATE (42501) and the outcome are the same (proof Q14, Q15).
- An upsert (`INSERT ... ON CONFLICT DO UPDATE`) runs the INSERT arm on the proposed row first. No client upserts `claims` or `quotes`. A future client upsert of an existing late-state row would be refused (proof Q17): write it as an UPDATE.
- `status` on a client INSERT relies on the column defaults (`claims.status` `documents_needed`, `quotes.status` `submitted`, `quotes.bid_status` `active`). Changing a default to a value outside the allowed set would refuse every client INSERT, loudly (42501). Section 1 checks the defaults.
- The contractor lookup on INSERT runs under the caller's RLS (`Contractors can read own record`). If that policy were removed the lookup would find no row and the guard would refuse (fails closed).
- SECURITY DEFINER functions owned by `postgres` bypass both guards by design. A future definer function that INSERTs `claims` or `quotes`, or sets `claims.status`, from client input must do its own checks.
- Coordination: PR #2538 (#2519, fee columns) must not add a second guard trigger on `quotes`. It adds its fee-column rule to the UPDATE arm of `quotes_guard_homeowner_columns()`, starting from the body in this file if this file merges first (and this file is rebased onto its body otherwise). `tests/gh2479-static-born-state-guard.mjs` reads the latest definition of each function and fails if a later migration drops any rule above or adds a second guard trigger on `quotes`.

## 1. Before applying (read-only)
```sql
SELECT table_name, column_name, column_default FROM information_schema.columns
 WHERE table_schema = 'public' AND (table_name, column_name) IN (('claims','status'), ('quotes','status'), ('quotes','bid_status'));
-- Expected: claims.status 'documents_needed'::text ; quotes.status 'submitted'::text ; quotes.bid_status 'active'::text

SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
 WHERE tgname IN ('claims_guard_referral_columns', 'quotes_guard_homeowner_columns') AND NOT tgisinternal;
-- Expected: claims_guard_referral_columns BEFORE INSERT OR UPDATE ON public.claims ;
--           quotes_guard_homeowner_columns BEFORE UPDATE ON public.quotes  (both from the two earlier migrations)

SELECT md5(pg_get_functiondef('public.claims_guard_referral_columns()'::regprocedure)),
       md5(pg_get_functiondef('public.quotes_guard_homeowner_columns()'::regprocedure));
-- Read on production 2026-10-05T19:06Z: 928def74075e346f0ed3f47f5689f931 , 2a8f6e0327a97a4768bdd27afb79b3b1.
-- A different value means another migration replaced a guard since this file was written (PR #2538?):
-- stop, and rebase this file onto that body.

SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind IN ('f', 'p')
   AND p.prosrc ~* '(insert\s+into|update)\s+(only\s+)?(public\.)?(claims|quotes)\M';
-- Expected: accept_bid, record_first_touch_attribution, set_bid_window_on_first_bid, each true | postgres.
-- A new row, or one that is not SECURITY DEFINER, is a writer this note has not considered: stop and read it.

SELECT status, count(*) FROM public.claims GROUP BY 1;
SELECT status, bid_status, count(*) FROM public.quotes GROUP BY 1, 2;
-- Informational. Existing rows are not touched: the guard looks only at new writes.
```

## 2. Negative control: paste BEFORE applying
Run `supabase/tests/gh2479_born_state_guard_proof.sql` alone. It always ends in an ERROR (the forced rollback). Expected lines: `E1 RESULT ... commission=200.00`, `E7 RESULT ... commission=200.00`, `E3 RESULT ... commission=200.00`, `E3u RESULT claim status=contract_signed | ... commission=200.00`, `X2 ... rows=1 ACCEPTED`, `Y2 ... rows=1 ACCEPTED`, `Q2 ... rows=1 ACCEPTED`, `Q9 ... rows=1 ACCEPTED`.

## 3. Apply
The migration file as it stands (it carries its own `BEGIN;` / `COMMIT;`), then the `supabase_migrations.schema_migrations` row.

## 4. After applying
```sql
SELECT tgname, pg_get_triggerdef(oid), tgenabled FROM pg_trigger
 WHERE tgname IN ('claims_guard_referral_columns', 'quotes_guard_homeowner_columns') AND NOT tgisinternal;
-- Expected: both BEFORE INSERT OR UPDATE, both enabled (O).
SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.quotes'::regclass AND NOT tgisinternal AND tgname LIKE '%guard%';
-- Expected: 1.
```
Run the proof file alone again. Expected: `E1`, `E7`, `E3`, `E3u` RESULT lines read `commission=null | payout_approvals rows=0`; `X2`, `X4` to `X8`, `X10` to `X14`, `Y2`, `Y5` to `Y8`, `Y11`, `Q2` to `Q13`, `Q17` read `REJECTED 42501`; every `L`, `R` and `S` line and `X0`, `X1`, `X3`, `Y1`, `Y3`, `Y4`, `Y9`, `Y10`, `Y12`, `Y13`, `Q0`, `Q1` read exactly as in section 2; `L RESULT` reads `commission=200.00`. `E3p` and `E3q` still read `commission=200.00` (the residual above).

## 5. Rollback
`supabase/migrations_rollbacks/20261005200000_gh2479_born_state_guard_rollback.sql`, then delete the ledger row. It restores both functions (bodies and comments) and the `BEFORE UPDATE` trigger exactly; it re-opens E1, E3, E7. It leaves the guards of `20261003193000` and `20261005170000` in place.

## Proof
Production `yeszghaspzwwstvsrioa`, Management API, one statement batch whose last statement is a single `DO` block ended by a forced `RAISE EXCEPTION`: the scenario, then the migration body through `EXECUTE`, the scenario again, the rollback body through `EXECUTE`, the scenario a third time, and a catalog snapshot (every function in `public` with owner, ACL and comment, every trigger, policy, table ACL and constraint; 675 entries) at each stage. `is_test` rows only. Results are in the PR body.
