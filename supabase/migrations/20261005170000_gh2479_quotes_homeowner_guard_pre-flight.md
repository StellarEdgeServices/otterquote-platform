# Pre-flight: 20261005170000_gh2479_quotes_homeowner_guard (Tier 3B)

NOT APPLIED. Refs #2479 (CLOSE-REVIEW: FAIL, comment 5998207363) and #2519. Protective only (R-134). Tier 3B because it adds a trigger on a money-path table (`quotes`) and one on `referral_agents`: R-097 notice applies.

## What it does
- `public.quotes_guard_homeowner_columns()` + trigger `quotes_guard_homeowner_columns` `BEFORE UPDATE ON public.quotes FOR EACH ROW`. For client callers (`current_user` is `anon`/`authenticated`, JWT role is not `service_role`, caller is not an admin):
  - `claim_id`, `contractor_id`: can never change.
  - `total_price`: can change only when the caller is the quote's own contractor.
  - `status`: can change only when the caller owns the quote's claim, and only to `selected` or `declined`.
  - A refused write raises 42501. A value re-sent unchanged is not a change.
- `public.referral_agents_guard_agent_type()` + trigger `referral_agents_guard_agent_type` `BEFORE UPDATE ON public.referral_agents FOR EACH ROW`: client callers cannot change `agent_type`.
- No GRANT, REVOKE, policy, column, index or data change. Both functions are SECURITY INVOKER. Nothing existing is replaced, so the rollback only drops the two triggers and two functions.

## Every write to `quotes` at main (1fd6fc44), and what the guard does to it

Client writes (browser, caller's own JWT):

| Path | Caller | Columns written | After the guard |
|---|---|---|---|
| `bids.html` ~L2137, `contractor-about.html` ~L1008: `rpc('accept_bid')` | homeowner | `status` -> `selected` / `declined` (inside the RPC) | Untouched: `accept_bid()` is SECURITY DEFINER owned by `postgres`, so `current_user` is not a client role (proof H4) |
| `react-app/app/(homeowner)/bids/actions.ts` ~L135: `.update({ status: 'selected' })` | homeowner | `status` | Allowed (proof H2b) |
| `react-app/app/(homeowner)/bids/actions.ts` ~L152: `.update({ status: 'declined' })` on the claim's other quotes | homeowner | `status` | Allowed (proof H2c) |
| `contract-signing.html` ~L2029 / ~L2039 | homeowner or contractor | `homeowner_signed_at` or `contractor_signed_at` | Not a guarded column (proof H1, K3) |
| `react-app/app/(homeowner)/contract-signing/use-contract-signing-data.ts` ~L335 / ~L354 | homeowner | `homeowner_signed_at` | Not a guarded column (proof H1) |
| `contractor-bid-form.html` ~L5516 (change bid / renew) | the quote's contractor | `total_price`, fee columns, scope, notes, warranty columns, `updated_at`; on renew also `bid_status`, `expired_at`, `expires_at`, `renewals_count` | `total_price` allowed for the quote's own contractor (proof K1, K2b). No `claim_id`, `contractor_id` or `status` in the payload |
| `react-app/app/contractor/bid/[claimId]/bid-form.tsx` ~L326 (`buildQuoteUpdate`) | the quote's contractor | same as the row above | same |
| `contractor-bid-form.html` ~L5578, `bid-form.tsx` ~L358: `.insert(...)` | contractor | new row | INSERT is not guarded (the trigger is BEFORE UPDATE only) |

Every other `from('quotes')` in the static pages, `js/` and `react-app/` is a SELECT (`bids.html`, `dashboard.html`, `project-confirmation.html`, `contractor-dashboard.html`, `contractor-opportunities.html`, `contractor-profile.html`, `contractor-about.html`, and their React twins, `use-bid-updates.ts`, `Messaging.tsx`). There is no raw `/rest/v1/quotes` fetch.

Server writes (service-role client, untouched by the guard, proof S1): Edge Functions `create-docusign-envelope` (+ `boldsign-readiness.ts`), `create-payment-intent`, `docusign-webhook`, `process-auto-bids`, `process-bid-expirations`, `process-dunning`, `record-warranty-upload`, `rescind-bid`, `stripe-webhook`, `switch-contractor`; `tests/e2e/helpers/db.ts` and `tests/e2e/seed/teardown.mjs`.

SQL functions in the live `public` schema that write `quotes` (pg_proc scan 2026-10-05): `accept_bid` only (SECURITY DEFINER, owner `postgres`).

No client path changes `claim_id` or `contractor_id`. No contractor client path writes `status`. So refusing those for every client caller breaks nothing that exists.

## Every write to `referral_agents.agent_type`
| Path | Caller | After the guard |
|---|---|---|
| `admin-referrals.html` ~L853, `react-app/app/admin/referrals/page.tsx` ~L211 | admin (`is_admin_email()`) | Exempt (proof A3) |
| `register_partner()` | SECURITY DEFINER, INSERT only | Not an UPDATE |
| `partner-dashboard.html` ~L2899, `react-app/app/partner/dashboard/page.tsx` ~L774 (profile save) | partner | Payload is name, email, phone, company, service_area, website, bio. No `agent_type` (proof A2) |
| `react-app/app/lib/partner-record.ts` ~L86 | partner | `user_id` only |
| Edge Functions (`partner-invite-accept`, `partner-email-optout`, `submit-partner-w9`, `process-payout-reminders`) | service role | None writes `agent_type`; exempt anyway (proof A4) |

## Danger-pattern check
- Two new BEFORE UPDATE row triggers; no data change, no lock beyond the brief `CREATE TRIGGER` lock on each table. `quotes` has 8 rows and `referral_agents` 78 on production (read 2026-10-05).
- Trigger order on `quotes`: BEFORE triggers fire in name order. `quotes_guard_homeowner_columns` sorts before `quotes_normalize_fee_amount` and `set_updated_at_quotes`, so it sees the caller's values.
- The two ownership lookups run under the caller's RLS (`Users can view own claims`, `Contractors can read own record`). If either policy were removed, the lookup would return no row and the guard would refuse (fails closed, loud 42501), not allow.
- SECURITY DEFINER functions owned by `postgres` bypass the guard by design (`current_user` is the owner). Any future definer function that writes `quotes.claim_id`, `total_price` or `status` from client input must do its own authorization, as `accept_bid()` does.

## Residuals (not closed by this migration; say so on the issues)
- The homeowner UPDATE policy still leaves every other `quotes` column writable by the claim owner: `fee_amount`, `fee_percentage`, `platform_fee_pct`, `platform_fee_basis`, `payment_status`, `bid_status`, `is_test`, `expires_at`, the signature stamps and so on. #2519's body names the fee columns. This migration guards only the three columns the commission and the quote-move attack read. A column allow-list for the homeowner is the complete fix and needs its own enumeration.
- A contractor can still change `total_price` on their own quote after it was selected. #2519's fix shape (a) suggested freezing price past submission; that is a contractor-side rule and is not decided here.
- Self-referral (referrer is the claim owner) still accrues through the legitimate path. Business decision, not built.
- Two existing defects seen in the proof run, unchanged by this migration: the client bid-renewal payload sends `bid_status='submitted'`, which `quotes_bid_status_check` refuses (proof K2); and `claims_enforce_payment_method_on_award()` reads `public.contractors` as the homeowner, who cannot SELECT it, so the React direct award is refused even when the contractor has a payment method (proof H2a). The static pages use `accept_bid()` and are not affected.

## 1. Before applying (read-only)
```sql
SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'quotes' ORDER BY policyname;
-- Expected: 5 policies; "Homeowners can update quotes for their claims" UPDATE with qual and with_check
-- "claim_id IN (SELECT claims.id FROM claims WHERE claims.user_id = (SELECT auth.uid()))".

SELECT tgname FROM pg_trigger
 WHERE tgrelid IN ('public.quotes'::regclass, 'public.referral_agents'::regclass) AND NOT tgisinternal ORDER BY 1;
-- Expected: no quotes_guard_homeowner_columns and no referral_agents_guard_agent_type yet.

SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
   AND pg_get_functiondef(p.oid) ~* '(update|insert into|delete from)\s+(public\.)?quotes\M';
-- Expected: accept_bid | true | postgres, and nothing else. A new row here is a writer this note has not
-- considered: stop and read it.

SELECT pg_get_functiondef('public.is_admin_email()'::regprocedure);
-- Expected: (auth.jwt() ->> 'email') IN the two admin addresses.
```

## 2. Negative control: paste BEFORE applying
Run `supabase/tests/gh2479_quotes_guard_proof.sql` alone. It always ends in an ERROR (the forced rollback). Expected lines: `V2 ... rows=1 ACCEPTED`, `V3 RESULT ... commission=200.00 | payout_approvals rows=1`, `P1 ... rows=1 ACCEPTED -> total_price=99999.00`, `A1 ... rows=1 ACCEPTED`.

## 3. Apply
`supabase/migrations/20261005170000_gh2479_quotes_homeowner_guard.sql`. No ordering dependency on another unapplied migration. It is effective on its own; it relies on 20261003193000 (applied 2026-10-05, ledger `20261005151842`) for the `claims` side.

## 4. After applying: paste the same file again
Expected: `V2 ... REJECTED 42501 quotes: claim_id and contractor_id can only be changed by service_role or an admin (gh-2479)`, `V3 RESULT ... commission=null | payout_approvals rows=0`, `P1 ... REJECTED 42501 ... -> total_price=15000.00`, `A1 ... REJECTED 42501`, and every line the proof header lists as "the SAME before and after" unchanged.

## 5. Rollback
`supabase/migrations_rollbacks/20261005170000_gh2479_quotes_homeowner_guard_rollback.sql`. It re-opens both issues. If the migration was applied, also delete its `supabase_migrations.schema_migrations` row.
