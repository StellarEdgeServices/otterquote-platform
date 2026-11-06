<!--
STATUS (gh-1438, as of 2026-11-02): NOT APPLIED
FILE ROLE: pre-flight file of set gh3330_recruiter_v4_gate (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-11-02 under #3330; one production read-only SELECT (pg_get_functiondef + md5(prosrc)) the same day (project yeszghaspzwwstvsrioa). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3330_recruiter_v4_gate

Issue #3330. Authority: D-417, registered at #3330 comment 6667313714: "A recruiter must have accepted Partner Agreement v4 to earn the $50 recruit bonus, and the release path requires v4 (a recruiter who has not accepted v4 does not get the $50 released) (#3330)."
Its annotation of 2026-11-05 (comment 6668603250): the v4 requirement applies to partners who signed v3; no $50 accrues to any partner until they accept Partner Agreement v4.
Dustin's words, as recorded on #3330: "No." (2026-11-02 13:17 ET, comment 6584786600) and "Yes, v3 signers must accept v4 (Recommended)" (2026-11-05, comment 6668571465).
The record does not attribute "withheld rather than dropped" to him: it came from Marty's proposal 6582010408 and Ben's answer 6583394572, withdrawn at 6584765173. The code writes no bonus for a recruiter without v4 and logs it.
Whether a recruiter who accepts v4 later is paid for a referral that completed before they accepted is open on #3330 (Marty's Q 6673399375, item 1); the code pays nothing for it.
Money: Tier 3B. Needs REVIEW + LEGAL-READ + R-177 pair; R-097 notice. Exposure at drafting: $0 ever accrued, one recruited agent (test).

## Order
1. gh3239 (`partner_v4_accepted_at()`) and gh3245 (the body this restates) are already live: production body md5 = `2eba9b9601c731cb20f45ef5a18c742b` (12965 characters, 13009 bytes),
   equal to the gh3245 forward's body. The forward refuses any other body.
2. Run the read-only checks, apply the forward, run the post-apply checks.

## Read-only checks before apply
```sql
-- A. the audited body (expect 2eba9b9601c731cb20f45ef5a18c742b, true, {search_path=public, pg_temp})
SELECT md5(prosrc), prosecdef, proconfig FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure;
-- B. partner_v4_accepted_at exists (expect one row)
SELECT to_regprocedure('public.partner_v4_accepted_at(uuid)');
-- C. who would be withheld today: recruited agents whose recruiter has no v4 (#3330 read, 2026-11-02T16:09Z: 1 recruited agent, test)
SELECT rf.id AS referrer, rc.id AS recruiter, rc.agent_type, public.partner_v4_accepted_at(rc.id) AS recruiter_v4_at
  FROM public.referral_agents rf JOIN public.referral_agents rc ON rc.id = rf.recruited_by_id;
```

## Pre-apply count E: accrued-and-unpaid recruit bonus rows for recruiters without v4 (REVIEW 6667117215 note 1)
The gate stops NEW accruals only; it does not touch rows that already exist. A `commission_recruit` row accrued before the apply for a recruiter who has no v4 is
still paid by `approve-payout` / `mark-payout-paid` after the apply. Run E immediately before the apply. **Expected at drafting: 0 rows, $0** (#3330 read 2026-11-02: 0 `commission_recruit`
rows ever). A non-zero result is a decision for Ben before the apply (pay, reject, or hold those rows by hand), not something this migration does. "Unpaid" here is
status not in ('rejected', 'paid'): the `approve-payout` / `mark-payout-paid` Edge Functions move a row through `approved` to `paid`.
```sql
SELECT count(*)::int AS rows_unpaid, COALESCE(sum(p.amount), 0) AS dollars_unpaid,
       count(*) FILTER (WHERE COALESCE(p.is_test, false)) AS rows_test
  FROM public.payout_approvals p
  JOIN public.referral_agents rc ON rc.id = p.partner_id
 WHERE p.payout_type = 'commission_recruit'
   AND p.status NOT IN ('rejected', 'paid')
   AND rc.agent_type IS DISTINCT FROM 'home_inspector'
   AND public.partner_v4_accepted_at(rc.id) IS NULL;
```
Proof check E runs this exact text. BEFORE the gate it returns `4|200` (four of the five withheld cases were paid to a recruiter who still has no v4; the fifth, L, has accepted since; the negative control); AFTER it returns `0|0`.

## Post-apply checks
```sql
-- expect 7b9bc6957cb15534514f1e1ab9e32bbf, true, {search_path=public, pg_temp}
SELECT md5(prosrc), prosecdef, proconfig FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure;
```

## Query W: bonuses the gate withheld (for support, for the release decision, and for a rollback review)
Fixed after REVIEW FAIL 6584291693 blocker 1. The first version required `status = 'job_completed' AND commission_amount = 200`, which dropped a withheld bonus once
`approve-payout` moved the referral to `commission_paid`, and never listed a referral whose referrer is a home_inspector (no `commission_amount`). W now keys on what the
trigger leaves behind for every completed referral: `job_value` set (the trigger writes it; `reverse_referral_commission()` nulls it), a completed status, no bonus
accrued and no `commission_recruit` payout row, a recruiter who is not a home_inspector, and either a fee on the referral or a home_inspector referrer. A customer
referrer who was v4-gated (no fee, no bonus, a different rule) is excluded. `is_test` and both agent types are columns so the reader can filter.
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
 ORDER BY r.created_at;
```
Proof check H runs this exact text (the runner extracts the block above) and returns exactly the five withheld referrals in AFTER: an open $200, a $200 already moved to `commission_paid`,
and a home_inspector referrer, besides the never-accepted and customer recruiters; and none of the paid, inspector-recruiter and v4-gated-customer cases.
Rows whose `recruiter_v4_at` is now NOT NULL are the ones whose recruiter has since accepted v4. The code pays them nothing, and whether they are paid is open on #3330 (Marty's Q 6673399375, item 1). **Limits:** W cannot tell a bonus this gate withheld from a referral completed before the gate
shipped with a zero bonus for some other reason. Run it once before the apply and keep the referral ids; rows that appear afterwards are the gate's. At drafting the production count of
ever-accrued bonuses is 0 and the only recruited agent is a test row, so the expected pre-apply result is 0 rows.

## Re-fire of `completion_date` (REVIEW 6667117215 note 2)
The trigger fires on `completion_date` NULL to NOT NULL, so someone who clears and re-stamps the date runs the function a second time on the same claim. The review expected an inspector referrer to
re-evaluate the gate on that second run because `commission_amount` is never set for it. **The proof shows it does not**, and the reason is a different early return:
- **Non-inspector referrer:** `commission_amount > 0` after the first firing, so the function returns at its first idempotency check.
- **Home_inspector referrer:** `commission_amount` stays NULL, so that check does not trip, but the first completion leaves the referral at `status = 'job_completed'` and the gh-2479 status check
  (`NOT IN ('claim_submitted','bid_received','contract_signed')`) returns before the recruit branch. A withheld $50 is not released by a re-fire even after the recruiter accepts v4. (Proof checks O and P: recruiter has accepted v4, claim re-fired, outcome `0` accrued in both cases.)
- The only way a re-fire could pay is if someone first moves the referral's `status` back to an attributed status by hand. `reverse_referral_commission()` does not do that (it acts only when `commission_amount > 0`).

**Matches Ben's answer 6667102434?** It says "the release path requires Partner Agreement v4" and that a recruiter without v4 does not get the $50 released. It names no release mechanism. Under this code nobody without v4 is paid, and no automatic path releases a withheld bonus
after the recruiter accepts v4. Whether anyone pays those rows is open on #3330 (Marty's Q 6673399375, item 1). No code change was needed; the function body and its md5 are unchanged by this commit.

## What the apply writes
Nothing but the function body. No referral, payout or agent row is touched; the gate acts only when a claim is completed afterwards.

## Behaviour (the recruit-bonus branch only; the referrer's $200, its v4 gate and the home_inspector rules are unchanged)
| recruiter | referral completes | result |
|---|---|---|
| holds v4 (`partner_v4_accepted_at` not null) | any | $50 as today |
| no v4 (any non-inspector type, customers included) | any | $50 WITHHELD: `recruit_commission_amount` stays 0, no `recruit_earnings`, no payout row, one `RAISE LOG` naming recruiter, referral and referrer. The referrer still gets the $200 and the fee email |
| home_inspector | any | no bonus (D-333, unchanged) |

No cutoff date and no timing test (the ruling names none): the recruiter must hold v4 at the moment the referral completes.

**Timing gap, for the open release question (REVIEW 6584291693, last paragraph).** The gate reads v4 at completion, but v4 A4.3 and v3 Section 4 fire when the job is "approved for payout", and approval auto-runs about 7 days later
(`auto_approve_at`). A recruiter who accepts v4 inside that window qualifies on the agreement's text but is withheld. Nothing here changes it; it belongs to the same open question (Marty's Q 6673399375, item 1).

**Contract note from LEGAL-READ 6584296349 (not code).** D-417 and its annotation (comments 6667313714, 6668603250) are the authority for the gate; they answer the v3 Section 4.2 / Section 17 re-acknowledgment question the reader raised only as far as they say: no $50 accrues to any partner until they accept v4. `faq.html` and `partner-adjusters.html:1005`
still state the $50 without the v4 condition; this PR changes no public copy. Whether the dashboard notice and public copy change before the apply is open on #3330 (Marty's Q 6673399375, item 2).

## Open: release path (NOT built, open on #3330)
The code writes nothing for a recruiter without v4: the referral keeps `recruit_commission_amount = 0`, so query W finds it. D-417 sets a condition on any release (it requires v4) and Ben's answer 6667102434 names no mechanism.
**The code pays nothing, and whether a recruiter who accepts v4 later is paid for those referrals is open on #3330 (Marty's Q 6673399375, item 1).** No release path exists and none was invented. A recruiter who accepts v4 later is NOT paid by this code for referrals completed while they lacked it; the
trigger fires only on `completion_date` NULL to NOT NULL and returns early once `commission_amount > 0`, so nothing re-runs it. Proof check F pins this
(the later acceptance pays only the later referral). If a release is ruled, someone must build or run one of: (a) a `release_withheld_recruit_bonus(recruiter)` SECURITY DEFINER
function that applies the same accrual to query W's rows, called from `accept_partner_agreement_v4()` (touches the gh3239 function) or by an admin; or (b) a
manual payout per row. Questions that ruling would answer: does release pay every withheld referral or only those completed after some date; is a release automatic on
acceptance or an admin action; and should the withhold leave a durable ledger row (a new `payout_approvals` status needs the CHECK widened: ALTER, Tier 3B) rather than only a log line.

## Rollback
`gh3330_recruiter_v4_gate_rollback.sql`: restores the gh3245 body (md5 `2eba9b9601c731cb20f45ef5a18c742b`); runs only over the gh3330 body or the gh3245 body; writes no data.
Referrals withheld while the gate was on stay withheld; list them with query W.

## Withhold log assertion (REVIEW 6667117215 note 3)
The withhold writes one `RAISE LOG` and nothing else, so the log line is part of the record. The proof runner asserts it: after phase 2-AFTER it re-runs the proof transaction with `client_min_messages=log`
and requires exactly five `gh-3330 recruiter ... WITHHELD` lines (n, c, l1, p, bi) and one naming recruiter `dddddddd-...a3`, none for the holders or the inspector recruiter; BASELINE must show none. A mutant that deletes the `RAISE LOG` is killed by it.
It asserts the message through the client message stream, not the server log file (a throwaway server's log file is not under the runner's control).

## Proof
`PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3330_recruiter_v4_gate_proof_run.sh` on a throwaway Postgres 16: BASELINE / AFTER / ROLLBACK /
REAPPLIED, 17 checks each (BASELINE is the production body: its rows document today's behavior, including $50 to a recruiter with no v4), four mutants
(gate removed, inverted, gate on the referrer instead of the recruiter, withhold `RAISE LOG` deleted) each killed by a named check, and a forward run over the pre-gh3245 body that must refuse.
The AFTER expectations judged against the unchanged production body fail 11 of 17 (C, D, E, F, G, H, J, L, M, O, P).
