<!--
STATUS (gh-1438, as of 2026-10-30T15:00:00Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3239_partner_agreement_v4 (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3239; production read-only queries the same day (project yeszghaspzwwstvsrioa). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3239_partner_agreement_v4

Issue #3239 (P18), refs #3238. Tier 3B (money gate) and Tier C (legal: Partner Agreement v4). Apply only on Dustin's final publish OK,
in the same window as the partner-agreement.html v4 deploy, after REVIEW + LEGAL-READ + R-177 pair.

## Order
1. Merge the PR (Netlify deploys partner-agreement.html v4, partner-agreement-v3.html, the dashboard notice, refer-a-friend).
   The dashboard and refer-a-friend handle the RPC being absent (they show a retry error and record nothing), so the page deploy may lead by minutes.
2. Run the read-only checks below. Every one must match.
3. Apply `gh3239_partner_agreement_v4.sql` (one transaction; it aborts on any drift).
4. Deploy the `partner-invite-accept` Edge Function (it stamps v4-2026-10 for non-inspector invites).
5. Re-run the post-apply checks. Then the #3236 accrual gate (see the PR body) may be applied; it calls `partner_v4_accepted_at()`.

## Read-only checks before apply (production, SELECT only)
```sql
-- A. register_partner body is the audited one (expect 042da30fdc75423c32383035b27f2fa4, 1)
SELECT md5(prosrc), (length(prosrc) - length(replace(prosrc, 'v_agreement_version CONSTANT text := ''v3-2026-09'';', '')))
         / length('v_agreement_version CONSTANT text := ''v3-2026-09'';')
  FROM pg_proc WHERE oid = 'public.register_partner(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text,text,text,boolean,text,text,text,text)'::regprocedure;
-- B. none of the new objects exist yet (expect 0 rows)
SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
   AND proname IN ('accept_partner_agreement_v4','partner_v4_accepted_at','partner_agreement_current_version','referral_agents_guard_agreement_columns');
SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.referral_agents'::regclass AND tgname = 'referral_agents_guard_agreement_columns';
-- C. no client code writes the agreement columns directly (repo check, not SQL): only supabase/functions/partner-invite-accept (service role)
--    writes them; grep -rn "partner_agreement_" --include=*.html --include=*.js . finds no .update() of them.
-- D. one row per user (expect dup_users = 0); the accept RPC updates every row of the caller
SELECT count(*) FILTER (WHERE n > 1) AS dup_users FROM (SELECT user_id, count(*) n FROM public.referral_agents WHERE user_id IS NOT NULL GROUP BY 1) t;
-- E. baseline distribution (record it on the issue; 2026-10-30: v3-2026-09 57, v2-2026-08 2, NULL 16, of which is_test=false: v3 1, v2 1)
SELECT agent_type, is_test, COALESCE(partner_agreement_version, '(null)'), count(*) FROM public.referral_agents GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

## Post-apply checks
```sql
-- register_partner rewritten (expect f4affeb5b17e2b4d242ce452686ada4d), still DEFINER with search_path public, pg_temp
SELECT md5(prosrc), prosecdef, proconfig FROM pg_proc
 WHERE oid = 'public.register_partner(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,text,text,text,boolean,text,text,text,text)'::regprocedure;
-- accept RPC: DEFINER, pinned path, authenticated only
SELECT prosecdef, proconfig, has_function_privilege('anon', oid, 'EXECUTE') anon, has_function_privilege('authenticated', oid, 'EXECUTE') authd
  FROM pg_proc WHERE oid = 'public.accept_partner_agreement_v4()'::regprocedure;
-- E again: identical to before (the apply writes no row)
```
Then the closes-on probe (a test account, `@example.test` / is_test): sign up a test partner and see `v4-2026-10`; sign in as a test
v3 partner, click "I accept" on the dashboard, and see `partner_agreement_version = 'v4-2026-10'` with `partner_agreement_accepted_at` and the
`v4-2026-10` attestation key.

## What the apply writes
No row. Two functions are created, one helper, one trigger; register_partner() changes one initializer. Existing partners stay on
whatever they accepted until they click.

## Risks
- A direct browser PATCH of the four agreement columns is refused after the apply (42501), admins included. No page does this today (check C).
- record_partner_agreement_reacceptance(uuid, text) (gh-1059, no caller) still accepts any version string; it is left untouched. Recommend
  revoking it from `authenticated` in a follow-up, since `partner_v4_accepted_at()` would honor a v4 key it writes (it stamps server time, so
  it cannot back-date).

## Rollback
`gh3239_partner_agreement_v4_rollback.sql`: drops the trigger and functions and restores register_partner() to md5 042da30f... (checked).
Recorded acceptances are kept. Roll back the #3236 gate first if it is applied.

## Proof
`PGHOST=... PGPORT=... PGUSER=postgres bash supabase/tests/gh3239_partner_agreement_v4_proof_run.sh` on a throwaway Postgres 16:
BASELINE / AFTER / ROLLBACK / REAPPLIED, 22 checks each, plus a drifted-body negative control.
