<!--
STATUS (gh-1438, as of 2026-11-05): NOT APPLIED
FILE ROLE: pre-flight file of set gh3321_no_fee_states (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-11-05 under #3321 on top of PR #3337. Built from the repo and a throwaway Postgres; no production read and no database write were made to produce this file. The production facts it quotes come from the #3321 thread (Kevin's 2026-11-04 read and Marty's CTO RUN 94).
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3321_no_fee_states

Issue #3321. Rule: D-401 item 7, D-387, D-392 and Partner Agreement v4 A4.4: no partner fee in OK, AR, KS, NE or MS. Ruling: Dustin, through Ben (CEO RUN 145), #3321 comment 6664032518, verbatim:
**"Blank accrues; $50 withheld too (Recommended)"**; option text shown to him: "A blank state accrues and gets checked at monthly batch review before anyone is paid. The $50 is treated as a partner fee and withheld in those five states."
Ben: build on top of #3326 and #3337. Money and legal: Tier 3B; needs REVIEW + LEGAL-READ + R-177 pair (label `r177:legal-read`); R-097 notice. Whether D-401 gets an annotation is Ben's.
Finding behind it (Marty, CTO RUN 94; Kevin, 2026-11-04): `apply_referral_commission` never read `claims.property_state`; no Edge Function creates the fee; `homeowner_blocked_states` (FL, LA, TX) is a different rule and is not reused.

## Order
1. Apply PR #3337 (gh3330) first, with #3326's set per Ben's ruling 6667102434 (24 h R-097 notice, then apply together). Production body must be the gh3330 body, md5 `7b9bc6957cb15534514f1e1ab9e32bbf`. The forward refuses any other body.
2. Run the read-only checks, apply the forward, run the post-apply checks.
3. Compatibility with #3326 (`cto92/3245-referral-code-v4-gate`): it replaces `get_or_create_customer_referral_code()` only; its six files do not mention `apply_referral_commission` (checked with `git grep` on that branch, 2026-11-05). No shared object and no ordering constraint between the two, only this file's dependency on #3337.

## Read-only checks before apply
```sql
-- 1. the audited body (expect 7b9bc6957cb15534514f1e1ab9e32bbf, true, {search_path=public, pg_temp})
SELECT md5(prosrc), prosecdef, proconfig FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure;
-- 2. claims.property_state exists and is text (expect one row: text)
SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'claims' AND column_name = 'property_state';
-- 3. what the states look like today (expect only two-letter codes, NULL or blank; a spelled-out name would NOT be matched by the function)
SELECT upper(btrim(property_state)) AS state, count(*) FROM public.claims WHERE COALESCE(is_test, false) = false GROUP BY 1 ORDER BY 2 DESC;
```

## Query A: pre-apply count of accrued-and-unpaid commission rows already attached to claims in the five states
The exclusion stops NEW accruals only. A `commission_referral` or `commission_recruit` row accrued before the apply on a claim in these states would still be paid by `approve-payout` / `mark-payout-paid`.
Run A immediately before the apply. **Expected at drafting: 0 rows, $0** (Kevin's 2026-11-04 read: 0 non-test claims in these states; 1 `commission_referral` row ever, $200). Non-zero goes to Ben before the apply.
```sql
SELECT count(*)::int AS rows_unpaid, COALESCE(sum(p.amount), 0) AS dollars_unpaid,
       count(*) FILTER (WHERE COALESCE(p.is_test, false)) AS rows_test
  FROM public.payout_approvals p
  JOIN public.referrals r ON r.id = p.referral_id
 WHERE p.payout_type IN ('commission_referral', 'commission_recruit')
   AND p.status NOT IN ('rejected', 'paid')
   AND EXISTS (SELECT 1 FROM public.claims c WHERE c.referral_id = r.id AND upper(btrim(c.property_state)) IN ('OK', 'AR', 'KS', 'NE', 'MS'));
```

## Post-apply checks
```sql
-- expect fed947cd0851aa492e9217c1f9855597, true, {search_path=public, pg_temp}
SELECT md5(prosrc), prosecdef, proconfig FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure;
```

## What the apply writes
Nothing but the function body. No referral, payout, claim or agent row is touched; the exclusion acts only when a claim is completed afterwards.

## Behaviour
| claim `property_state` (upper, btrim) | referrer | result |
|---|---|---|
| OK, AR, KS, NE, MS | any | no $200, no $50, no fee email; one `RAISE LOG` naming the state, referral and claim; referral ledgered like the D-333 / gh-3245 no-fee branches (`job_value` set, status `job_completed`, `commission_amount` stays NULL) |
| NULL or blank | any | as today: $200 (subject to the gh-3245 and D-333 rules) and the $50 (subject to the gh3330 recruiter-v4 gate and D-333) accrue |
| any other state | any | as today |

The five states are a constant in the function body. Not matched: a spelled-out name ("Oklahoma"); intake writes two-letter codes (check 3 above shows what is actually stored). The state is read when the claim is completed: a claim whose state is corrected afterwards is not re-evaluated (batch review below).

## Query B: batch review of blank-state rows (the half that needs a surface)
Dustin's answer sends blank-state accruals to "monthly batch review before anyone is paid". Payments are manual (D-293: nothing auto-approves; every commission waits in `pending_approval` for a person in `admin-payouts.html`), so the hold already exists. What does NOT exist is anything
that shows the reviewer a claim's state: `admin-payouts.html` has no state column and no flag. **Nothing was invented.** Query B is the list the reviewer runs by hand. A `Q:` to Marty on #3321 asks whether a page change is wanted (recommended default: no, run B at the monthly review).
```sql
SELECT p.referral_id AS referral, p.id AS payout, p.payout_type, p.amount, p.status, COALESCE(p.is_test, false) AS is_test, c.id AS claim_id, c.property_state
  FROM public.payout_approvals p
  JOIN public.referrals r ON r.id = p.referral_id
  JOIN public.claims c ON c.referral_id = r.id
 WHERE p.payout_type IN ('commission_referral', 'commission_recruit')
   AND p.status NOT IN ('rejected', 'paid')
   AND (btrim(COALESCE(c.property_state, '')) = ''
        OR upper(btrim(c.property_state)) IN ('OK', 'AR', 'KS', 'NE', 'MS'))   -- blank now, or blank at completion and filled in as a no-fee state since
 ORDER BY p.created_at;
```
For each row the reviewer finds the property's real state and, if it is one of the five, rejects the payout by hand. B also catches the other gap: a claim completed with a blank state whose state was filled in later as one of the five (fixed after LEGAL-READ 6667606960, which found the first B dropped such a row; proof fixture `filled`). Run on the pre-apply database, B also lists any payable row already attached to a claim in the five states, the same rows query A counts.

## Query C: referrals ledgered with no fee in the five states (audit, and the list to read before a rollback)
```sql
SELECT r.id AS referral, r.created_at, r.job_value, r.status, c.id AS claim_id, c.property_state
  FROM public.referrals r
  JOIN public.claims c ON c.referral_id = r.id
 WHERE r.job_value IS NOT NULL
   AND COALESCE(r.commission_amount, 0) = 0
   AND upper(btrim(c.property_state)) IN ('OK', 'AR', 'KS', 'NE', 'MS')
 ORDER BY r.created_at;
```
C also lists a home_inspector referral in those states (it never carries a fee, D-333).

## Query W2: query W of PR #3337, minus the excluded states
#3337's query W lists a referral whose $50 was withheld for lack of v4 so it can be released once the recruiter accepts. After this file is applied a withheld bonus on a claim in the five states is not owed at all, so W would list a row that must never be released.
W2 is W with one more condition. **Use W2, not W, once this migration is live.** Everything else in W is unchanged (and W's own limits in the #3337 pre-flight still hold).
```sql
SELECT r.id AS referral, r.created_at, r.job_value, r.status, COALESCE(r.is_test, false) AS is_test,
       rf.id AS referrer, rf.agent_type AS referrer_type, rc.id AS recruiter, rc.agent_type AS recruiter_type,
       public.partner_v4_accepted_at(rc.id) AS recruiter_v4_at
  FROM public.referrals r
  JOIN public.referral_agents rf ON rf.id = r.referral_agent_id
  JOIN public.referral_agents rc ON rc.id = rf.recruited_by_id
 WHERE r.status IN ('job_completed', 'commission_paid')
   AND r.job_value IS NOT NULL
   AND COALESCE(r.recruit_commission_amount, 0) = 0
   AND r.created_at >= rf.recruited_at
   AND rc.agent_type IS DISTINCT FROM 'home_inspector'
   AND (COALESCE(r.commission_amount, 0) > 0 OR rf.agent_type = 'home_inspector')
   AND NOT EXISTS (SELECT 1 FROM public.payout_approvals p WHERE p.referral_id = r.id AND p.payout_type = 'commission_recruit')
   AND NOT EXISTS (SELECT 1 FROM public.claims c WHERE c.referral_id = r.id AND upper(btrim(c.property_state)) IN ('OK', 'AR', 'KS', 'NE', 'MS'))   -- gh-3321: excluded by state, not a release candidate
 ORDER BY r.created_at;
```

## Fee-promising email: the second sender (LEGAL-READ 6667606960)
The trigger's own call to `send-partner-status-email` is skipped in the five states, but `mark-job-complete/index.ts` (line 448, called from `contractor-dashboard.html`) calls the same Edge Function directly after writing `completion_date`, and that function read neither `property_state` nor `commission_amount`.
Stage 5 ("Payment for this referral is on its way.") is the only stage with payment language. **Fixed in this PR, Edge Function only, no migration:** `send-partner-status-email` selects `claims.property_state` and skips stage 5 when it is one of the five
(`isStageBlockedForState` in `templates.ts`, same shape as the D-333 `isStageBlockedForAgentType` gate, skipped before the stage stamp so nothing is burned). It is the one place every sender passes through. Stages 1 to 4 and a blank or NULL state are unchanged.
Callers checked on main (`git grep send-partner-status-email`): `mark-job-complete` (direct call); the `apply_referral_commission` trigger (skipped in the five states by this migration); the `claims_advance_referral` trigger (gh916; catch-up mode, so it also lands on the gate). No page or other function calls it.
Deploy order: this Edge Function is independent of the migration and safe to deploy first (it only withholds an email in the five states). Not in scope: a blank-state partner still gets stage 5 before the batch review, as Dustin's blank-accrues answer implies.
Proof for the Edge Function: Deno unit tests in `templates.test.ts` (each of the five states blocked, padded and lower case blocked, IN/TX/FL/CA not blocked, blank/NULL not blocked, stages 1 to 4 never blocked) and a wiring test that the handler selects `property_state` and applies the gate before the stage stamp. Proof check N in the SQL proof still covers only the trigger's own calls.

## Rollback
`gh3321_no_fee_states_rollback.sql`: restores the gh3330 body (md5 `7b9bc6957cb15534514f1e1ab9e32bbf`); runs only over the gh3321 body or the gh3330 body; writes no data. Referrals completed while the exclusion was on keep their no-fee ledger; list them with query C.

## Proof
`PGUSER=root PGHOST=/var/run/postgresql bash supabase/tests/gh3321_no_fee_states_proof_run.sh` on a throwaway Postgres 16 (base chain of the gh3330 proof, then the gh3330 forward, then a `claims.property_state` column): BASELINE / AFTER / ROLLBACK / REAPPLIED, 20 checks each.
BASELINE is the gh3330 body, whose rows are the negative controls (a job in OK earns $200 and $50 today). The tests the ruling asks for: a job in each of OK, AR, KS, NE, MS earns no fee and no $50 (checks A to E);
Indiana and Texas earn both (G, H); a blank and a NULL state accrue both (I, J). Further: the padded/lower-case form (F), inspector referrers (K, L), the no-fee ledger (M), no fee email (N), and the pre-flight queries A, B, C, W2 run verbatim (O, P, Q, R).
Mutants (each killed by a named check): the state test removed from the $200 branch only; removed from the $50 branch only; blank treated as excluded (fail closed); the COALESCE removed so a NULL state fails closed (the bug the first draft had, caught by check J); MS missing from the list; the withhold `RAISE LOG` deleted (killed by a log assertion that counts the lines on a `client_min_messages=log` re-run).
A forward run over any body other than the gh3330 body must refuse. The AFTER expectations judged against the unchanged gh3330 body fail 12 of 20 (A, B, C, D, E, F, K, N, O, P, Q, S).
