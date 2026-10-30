<!--
STATUS (gh-1438, as of 2026-10-30T16:00:00Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3245_customer_fee_v4_gate (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3245; production read-only queries the same day (project yeszghaspzwwstvsrioa). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3245_customer_fee_v4_gate

Issue #3245, refs #3243 (Dustin "YES", chat 2026-10-30 10:45 ET). Money: Tier 3B. Needs REVIEW + LEGAL-READ + R-177 pair; R-097 notice.

## Order
1. `gh3239_partner_agreement_v4` (PR #3242) is applied and partner-agreement.html v4 is live. This file refuses to run without
   `partner_v4_accepted_at()`.
2. Decide the cutoff. The forward seeds `platform_settings.partner_agreement_v4_published_at` = the apply time, but only if the key is
   absent. If this applies later than the v4 publish, first insert the key with the real publish time (the #3242 deploy time):
   ```sql
   INSERT INTO public.platform_settings (key, value) VALUES ('partner_agreement_v4_published_at', to_jsonb('<v4 publish ISO-8601 UTC>'::text));
   ```
   Otherwise every customer referral created between the v4 publish and this apply is honoured under the old program (lenient, not unsafe).
3. Run the read-only checks, apply the forward, then the post-apply checks.

## Read-only checks before apply
```sql
-- A. the audited body (expect 7f7d0419c59b9853d4082a713258ddd6) and its trigger
SELECT md5(prosrc), prosecdef, proconfig FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure;
SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgfoid = 'public.apply_referral_commission()'::regprocedure;
-- B. gh3239 is applied (expect one row)
SELECT to_regprocedure('public.partner_v4_accepted_at(uuid)');
-- C. the cutoff key (expect no row, unless step 2 set it)
SELECT key, value FROM public.platform_settings WHERE key = 'partner_agreement_v4_published_at';
-- D. customer referrals still open (record them on the issue; 2026-10-30: 2 customer agents, 5 customer referrals)
SELECT r.id, r.status, r.created_at, a.id AS agent, a.partner_agreement_version
  FROM public.referrals r JOIN public.referral_agents a ON a.id = r.referral_agent_id
 WHERE a.agent_type = 'customer' AND r.status IN ('clicked','registered','claim_submitted','bid_received','contract_signed');
```

## Post-apply checks
```sql
-- expect 2eba9b9601c731cb20f45ef5a18c742b, true, {search_path=public, pg_temp}
SELECT md5(prosrc), prosecdef, proconfig FROM pg_proc WHERE oid = 'public.apply_referral_commission()'::regprocedure;
-- expect the cutoff
SELECT value FROM public.platform_settings WHERE key = 'partner_agreement_v4_published_at';
```
G. After apply, customer referrals the gate withheld (for support and for a rollback review):
```sql
SELECT r.id, r.created_at, r.job_value, a.id AS agent
  FROM public.referrals r JOIN public.referral_agents a ON a.id = r.referral_agent_id
 WHERE a.agent_type = 'customer' AND r.status = 'job_completed' AND r.commission_amount IS NULL;
```

## What the apply writes
One platform_settings row. No referral, payout or agent row is touched; the gate acts only when a claim is completed afterwards.

## Behaviour (customer referrers only; every other agent_type is unchanged)
| referral created (click) | customer accepted v4 | result |
|---|---|---|
| before the cutoff | any | $200 as today (old program) |
| on/after the cutoff | at or before the claim carrying the referral was filed (claims.created_at; Ben, reading (b), Agreement §9.3) | $200 |
| on/after the cutoff | never, or after the claim was filed | no fee, no recruit bonus, no fee email; referral marked job_completed |
| any (cutoff key missing or unreadable) | any | gated, logged (fails closed) |

## Rollback
`gh3245_customer_fee_v4_gate_rollback.sql`: restores the audited body (md5 checked) and deletes the cutoff key. Before the delete it prints
`NOTICE: gh3245 rollback: deleting platform_settings.partner_agreement_v4_published_at = <value>`. **Copy that value onto #3245** (or read it
first with query C) so a re-apply can restore the same cutoff with the step 2 INSERT. Withheld referrals are not
re-accrued (the trigger fires only on completion_date NULL -> NOT NULL); list them with query G and decide by hand. Roll back before gh3239.

## Proof
`PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3245_customer_fee_v4_gate_proof_run.sh` on a throwaway Postgres 16:
BASELINE / AFTER / ROLLBACK / REAPPLIED, 16 checks each, and four mutants, each killed by a named check: acceptance compared with the click
(D), acceptance timing dropped (D2), `> cutoff` for `>= cutoff` (K), fee email left ungated (B3). The forward refuses without gh3239.
