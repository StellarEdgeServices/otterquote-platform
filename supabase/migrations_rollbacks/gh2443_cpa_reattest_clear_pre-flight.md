# gh-2443 pre-flight: contractors_freeze_privileged_columns clear-only exception for needs_cpa_reattestation

Tier 3B (loosens a privileged-column pin; ruling on #2443 comment 6021139082, build order 6023419535). NOT APPLIED. R-097 24-hour notice, then apply, before any CPA version is published.

## What changes
One statement in the UPDATE branch of `public.contractors_freeze_privileged_columns()` (the existing BEFORE INSERT OR UPDATE trigger `contractors_freeze_privileged_columns`; no second trigger, no new function). The pin `NEW.needs_cpa_reattestation := OLD.needs_cpa_reattestation` becomes:

```
CASE WHEN OLD.needs_cpa_reattestation = true
      AND NEW.needs_cpa_reattestation = false
      AND NEW.cpa_version = (SELECT cv.version_label FROM public.cpa_versions cv WHERE cv.is_current LIMIT 1)
     THEN false ELSE OLD.needs_cpa_reattestation END
```
Everything else in the function (including the INSERT branch and the admin / service_role exemptions) is byte for byte the production body (md5 `ba1ec8b8…`, first 8 characters); the diff adds the CASE and a 3-line comment. `enforce_contractor_privileged_columns()` is not touched (it never mentioned the flag).

## How far the guard loosens
A contractor session (role authenticated, non-admin) can now turn OFF only its own flag (RLS `Contractors can update own profile` limits the row to user_id = auth.uid()), only when the flag is currently true, only in a write whose `cpa_version` equals the one current agreement version (a stored version that is already current also qualifies, which heals the stuck state). It cannot set the flag true, cannot clear it with a stale, invented or NULL value, cannot clear it when no version is current (the subquery is NULL: the safe failure), and cannot change any other guarded column in the same write (proof C8). `cpa_versions` is readable by authenticated (`cpa_versions_read_authenticated`, USING true, read live 2026-10-06); at most one is_current row (unique partial index `cpa_versions_single_current`).

## How it composes with the acceptance evidence (#2444, PR #2562)
PR #2562 records IP (`record_cpa_ip` RPC) and the `cpa_accepted` activity_log row from the browser, in non-fatal calls made after the row-checked contractors UPDATE succeeds. They are separate statements, so a BEFORE UPDATE trigger on contractors cannot make them atomic with the flag clear, and this change does not try to: the flag clears in the same UPDATE that writes `cpa_version` (the contractor-writable acceptance fields already on the row), and the evidence calls follow. Consequence: a contractor who writes the current version directly through the API clears the flag without IP or log evidence, exactly as that same contractor can already write cpa_version and cpa_accepted_at today. The flag gate only decides whether the page lets them in; the legal record is cpa_version / cpa_accepted_at plus the evidence rows. The two PRs touch different files and do not conflict. Making the evidence mandatory would be a different, larger change (a definer RPC that does the update and the evidence together); not part of this ruling.

## Client write sites of needs_cpa_reattestation (unfiltered `grep -rn needs_cpa_reattestation .`, no page change needed)
- contractor-dashboard.html:1108 (first acceptance) and :1158 (re-acceptance): `.update({... cpa_version: CURRENT_CPA_VERSION ..., needs_cpa_reattestation: false})` on the contractor's own row. Start working once this is applied.
- react-app/app/contractor/dashboard/page.tsx:356 and :388: same payload.
- admin-cpa.html:535: `.update({ needs_cpa_reattestation: true }).neq('cpa_version', label)`, admin only, unaffected.
- contractor-dashboard.html:1194: in-memory assignment only.
- Readers (gates, unchanged): contractor-auto-bids.html:639, contractor-bid-form.html:3582, contractor-dashboard.html:1469, contractor-opportunities.html:509, contractor-profile.html:1435, contractor-settings.html:2680, react-app/.../cpa-guard.ts:45, use-contractor-record.ts:24; admin counts admin-cpa.html:415, :425. `cpa-guard.test.ts:43` keeps asserting the flag blocks.
- Coupling to note for the CPA publish: every page hard-codes `CURRENT_CPA_VERSION = 'v1-2026-04'` (six pages and cpa-guard.ts). The trigger compares the written version to the DB `is_current` label, so when a new version is published the pages must ship the matching constant, or their write carries the old label and the flag stays pinned.

## Proof (rolled back, production unchanged): supabase/tests/gh2443_cpa_reattest_clear_proof.sql
Three phases in one BEGIN ... ROLLBACK on production with role-switched writes on two is_test contractors: PRE (live body, negative control), FIXED (forward applied in the transaction), ROLLBACK (rollback body applied; its md5 equals the live md5). Cases C1-C10 cover every row of the ruling plus cross-contractor, other-column, NULL, admin and service_role writes. Expected: 60 rows, 0 failing.

## Apply (not done by this PR)
1. R-097 notice window closes; PR merged with REVIEW + LEGAL-READ + R-177.
2. Apply the forward SQL (strip nothing; it has no BEGIN/COMMIT) through the Tier 3B apply path, record the ledger version, file it under `supabase/migrations/<version>_gh2443_cpa_reattest_clear.sql`, move the draft per `supabase/migrations_drafts/README.md`.
3. Verify: `select md5(pg_get_functiondef('public.contractors_freeze_privileged_columns'::regproc))` differs from ba1ec8b8..., and the closes-on test (flag one is_test row, re-accept through the page, list before and after) per the ruling.
## Rollback
Run `supabase/migrations_rollbacks/gh2443_cpa_reattest_clear_rollback.sql` (one CREATE OR REPLACE FUNCTION). Verify the md5 returns to the value the proof's PRE step recorded before the change (it starts `ba1ec8b8…`).
