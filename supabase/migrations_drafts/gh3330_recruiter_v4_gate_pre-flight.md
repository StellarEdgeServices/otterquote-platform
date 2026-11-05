<!--
STATUS (gh-1438, as of 2026-11-02): NOT APPLIED
FILE ROLE: pre-flight file of set gh3330_recruiter_v4_gate (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-11-02 under #3330; one production read-only SELECT (pg_get_functiondef + md5(prosrc)) the same day (project yeszghaspzwwstvsrioa). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3330_recruiter_v4_gate

Issue #3330. Ruling: Dustin, 2026-11-02 13:17 ET (recorded on #3330, comment 6584786600), asked "should a recruiter who hasn't accepted the v4 agreement earn the
$50 bonus?": "No." A recruiter must hold Partner Agreement v4 to earn the $50, withheld rather than dropped. (Ben's earlier answer 6583394572 was retracted at 6584765173:
the bonus predates v4, v3 Section 4 / D-139; the gate is Dustin's ruling, not a v3 term.) Money: Tier 3B. Needs REVIEW + LEGAL-READ + R-177 pair; R-097 notice. Exposure at drafting: $0 ever accrued, one recruited agent (test).

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
Rows whose `recruiter_v4_at` is now NOT NULL are the ones owed once a release path exists. **Limits:** W cannot tell a bonus this gate withheld from a referral completed before the gate
shipped with a zero bonus for some other reason. Run it once before the apply and keep the referral ids; rows that appear afterwards are the gate's. At drafting the production count of
ever-accrued bonuses is 0 and the only recruited agent is a test row, so the expected pre-apply result is 0 rows.

## What the apply writes
Nothing but the function body. No referral, payout or agent row is touched; the gate acts only when a claim is completed afterwards.

## Behaviour (the recruit-bonus branch only; the referrer's $200, its v4 gate and the home_inspector rules are unchanged)
| recruiter | referral completes | result |
|---|---|---|
| holds v4 (`partner_v4_accepted_at` not null) | any | $50 as today |
| no v4 (any non-inspector type, customers included) | any | $50 WITHHELD: `recruit_commission_amount` stays 0, no `recruit_earnings`, no payout row, one `RAISE LOG` naming recruiter, referral and referrer. The referrer still gets the $200 and the fee email |
| home_inspector | any | no bonus (D-333, unchanged) |

No cutoff date and no timing test (the ruling names none): the recruiter must hold v4 at the moment the referral completes.

**Timing gap, for the release-path ruling (REVIEW 6584291693, last paragraph).** The gate reads v4 at completion, but v4 A4.3 and v3 Section 4 fire when the job is "approved for payout", and approval auto-runs about 7 days later
(`auto_approve_at`). A recruiter who accepts v4 inside that window qualifies on the agreement's text but is withheld. Nothing here changes it; it belongs to the same ruling as the release path.

**Contract note from LEGAL-READ 6584296349 (not code).** Dustin's ruling settles the question the reader raised (v3 Section 4.2 / Section 17 re-acknowledgment, no D-number behind the gate, no cutoff). `faq.html` and `partner-adjusters.html:1005`
still state the $50 without the v4 condition; this PR changes no public copy. The CEO decides whether the D-registry entry and any copy follow.

## Open: release path (NOT built, needs a ruling)
"Withheld rather than dropped" is satisfied only as far as the data stays recoverable: the withheld referral keeps `recruit_commission_amount = 0`, so query W
finds it. **No release path exists and none was invented.** A recruiter who accepts v4 later is NOT paid for referrals completed while they lacked it; the
trigger fires only on `completion_date` NULL to NOT NULL and returns early once `commission_amount > 0`, so nothing re-runs it. Proof check F pins this
(the later acceptance pays only the later referral). To pay a withheld bonus someone must build one of: (a) a `release_withheld_recruit_bonus(recruiter)` SECURITY DEFINER
function that applies the same accrual to query W's rows, called from `accept_partner_agreement_v4()` (touches the gh3239 function) or by an admin; or (b) a
manual payout per row. Open questions for the ruling: does release pay every withheld referral or only those completed after some date; is a release automatic on
acceptance or an admin action; and should the withhold leave a durable ledger row (a new `payout_approvals` status needs the CHECK widened: ALTER, Tier 3B) rather than only a log line.

## Rollback
`gh3330_recruiter_v4_gate_rollback.sql`: restores the gh3245 body (md5 `2eba9b9601c731cb20f45ef5a18c742b`); runs only over the gh3330 body or the gh3245 body; writes no data.
Referrals withheld while the gate was on stay withheld; list them with query W.

## Proof
`PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3330_recruiter_v4_gate_proof_run.sh` on a throwaway Postgres 16: BASELINE / AFTER / ROLLBACK /
REAPPLIED, 14 checks each (BASELINE is the production body: its rows document today's behavior, including $50 to a recruiter with no v4), three mutants
(gate removed, inverted, gate on the referrer instead of the recruiter) each killed by a named check, and a forward run over the pre-gh3245 body that must refuse.
The AFTER expectations judged against the unchanged production body fail 8 of 14 (C, D, F, G, H, J, L, M).
