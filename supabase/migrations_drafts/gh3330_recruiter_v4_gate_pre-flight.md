<!--
STATUS (gh-1438, as of 2026-11-02): NOT APPLIED
FILE ROLE: pre-flight file of set gh3330_recruiter_v4_gate (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-11-02 under #3330; one production read-only SELECT (pg_get_functiondef + md5(prosrc)) the same day (project yeszghaspzwwstvsrioa). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3330_recruiter_v4_gate

Issue #3330. Ruling: Ben, 2026-11-02T17:12Z (comment 6583394572): a recruiter must hold Partner Agreement v4 to earn the $50, withheld rather
than dropped. Money: Tier 3B. Needs REVIEW + LEGAL-READ + R-177 pair; R-097 notice. Exposure at drafting: $0 ever accrued, one recruited agent (test).

## Order
1. gh3239 (`partner_v4_accepted_at()`) and gh3245 (the body this restates) are already live: production body md5 = `2eba9b9601c731cb20f45ef5a18c742b` (12965 bytes),
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
-- expect 82c4f0a13589236016b4ec4e1a22d428, true, {search_path=public, pg_temp}
SELECT md5(prosrc), prosecdef, proconfig FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure;
```

## Query W: bonuses the gate withheld (for support, for the release decision, and for a rollback review)
```sql
SELECT r.id AS referral, r.created_at, r.job_value, rf.id AS referrer, rc.id AS recruiter, rc.agent_type, public.partner_v4_accepted_at(rc.id) AS recruiter_v4_at
  FROM public.referrals r
  JOIN public.referral_agents rf ON rf.id = r.referral_agent_id
  JOIN public.referral_agents rc ON rc.id = rf.recruited_by_id
 WHERE r.status = 'job_completed' AND r.commission_amount = 200 AND COALESCE(r.recruit_commission_amount, 0) = 0
   AND r.created_at >= rf.recruited_at AND rc.agent_type IS DISTINCT FROM 'home_inspector';
```
Proof check H runs this shape and returns exactly the three withheld referrals. Rows whose `recruiter_v4_at` is now NOT NULL are the ones owed once a release path exists.

## What the apply writes
Nothing but the function body. No referral, payout or agent row is touched; the gate acts only when a claim is completed afterwards.

## Behaviour (the recruit-bonus branch only; the referrer's $200, its v4 gate and the home_inspector rules are unchanged)
| recruiter | referral completes | result |
|---|---|---|
| holds v4 (`partner_v4_accepted_at` not null) | any | $50 as today |
| no v4 (any non-inspector type, customers included) | any | $50 WITHHELD: `recruit_commission_amount` stays 0, no `recruit_earnings`, no payout row, one `RAISE LOG` naming recruiter, referral and referrer. The referrer still gets the $200 and the fee email |
| home_inspector | any | no bonus (D-333, unchanged) |

No cutoff date and no timing test (the ruling names none): the recruiter must hold v4 at the moment the referral completes.

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
REAPPLIED, 11 checks each (BASELINE is the production body: its rows document today's behavior, including $50 to a recruiter with no v4), three mutants
(gate removed, inverted, gate on the referrer instead of the recruiter) each killed by a named check, and a forward run over the pre-gh3245 body that must refuse.
The AFTER expectations judged against the unchanged production body fail 6 of 11 (C, D, F, G, H, J).
