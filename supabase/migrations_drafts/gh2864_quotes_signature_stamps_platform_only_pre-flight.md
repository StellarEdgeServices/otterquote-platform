<!-- STATUS (gh-1438, as of 2026-10-19): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh2864_quotes_signature_stamps_platform_only (the STATUS is the set's; it describes the forward migration) -->
<!-- EVIDENCE: drafted with read-only database access (trigger list, guard definition, signed-stamp census, 2026-10-19); the writer search below was run on main b5579ee -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh2864_quotes_signature_stamps_platform_only (Tier 3B, NOT APPLIED)

Issue #2864 (ruling comment 6274566683; window closes 2026-10-20T18:40:35Z). Forward: `gh2864_quotes_signature_stamps_platform_only.sql`. Rollback: `gh2864_quotes_signature_stamps_platform_only_rollback.sql`. Proof: `supabase/tests/gh2864_quotes_signature_stamps_platform_only_proof.sql`.

## What changes
1. New function `public.quotes_refuse_client_signature_change()` (SECURITY INVOKER, `search_path = public, pg_temp`), EXECUTE revoked from PUBLIC, anon, authenticated.
2. New trigger `quotes_refuse_client_signature_change`, BEFORE UPDATE on `public.quotes`, firing only when `homeowner_signed_at` or `contractor_signed_at` changes in any way (clear, overwrite, or NULL-to-value first stamp).
3. Nothing else. `quotes_guard_homeowner_columns()` is not re-created, so there is no composition with gh2564 (applied), PR #2863 (gh-2803) or PR #2913 (gh-2819).

## Live trigger list on quotes (read-only, 2026-10-19), and firing order
BEFORE triggers fire in name order: `quotes_guard_homeowner_columns` (INSERT OR UPDATE), `quotes_normalize_fee_amount` (INSERT OR UPDATE), then the new `quotes_refuse_client_signature_change`, then `set_updated_at_quotes`. (`quotes_refuse_client_select_status` from #2913, if applied, sorts between normalize and this one.) The new trigger never changes NEW, so order does not affect results. The other BEFORE UPDATE triggers touch no signature column.

## Apply order
Merge and deploy the page/React change in this PR first, then apply the migration, after #2913 and the #2863 trigger (live since ledger 20261019191903), by ruling. The file composes with either in any order.

## Who writes the stamps (grep on main 0d509b8, 2026-10-19; corrects the first draft of this file)
- `supabase/functions/docusign-webhook/index.ts:544` (contractor_signed_at, guarded `.is(..., null)`) and `:583` (homeowner_signed_at, guarded `.is(..., null)`): service_role client. Passes.
- `supabase/functions/admin-reissue-contract/index.ts` (clears both on a re-issue): service_role client. Passes.
- BROWSER writers that existed on main and are REMOVED IN THIS PR (review 6275332957 B1): `contract-signing.html` `onSigningComplete()` (updated `<role>_signed_at` from the browser on every signing) and the React twin `react-app/app/(homeowner)/contract-signing/use-contract-signing-data.ts` `recordHomeownerSigned()` (called from `page.tsx`). Deploy this PR's page/React change BEFORE applying the migration, or a signing would still try the browser write and be refused (the write is log-only on the static page, so the signer is not interrupted, but the page would log an error).
- Everything else only reads the stamps: `contract-signing.html` (init gate, `recheckSigningState`), `contractor-dashboard.html:1473` (sign CTA), `react-app` contractor sign page and dashboard, `resolveSignGate`.
- What changes for users: the stamp now appears when the webhook lands (seconds), not instantly. Contractor dashboard: for that gap the Won row can still show the "sign" CTA (`contractor-dashboard.html:1659`); a click opens contract-signing, which reads the fresh quote and shows already-signed. A homeowner arriving before the contractor's stamp lands sees the existing waiting state and uses "Check Again". The `contract_signed` GA4 event on the React page now fires on the DocuSign completion callback (once-guarded) rather than after a successful stamp write.
- SQL functions mentioning either column on production: `update_selected_bid_notes(uuid,text)` (SECURITY DEFINER, reads), `quotes_guard_homeowner_columns()`, and #2863's `quotes_refuse_signed_notes_change` (live, ledger 20261019191903; reads).
Re-run the search at apply time: `grep -rnE "(homeowner|contractor)_signed_at" --include=*.html --include=*.ts --include=*.tsx --include=*.js .` and confirm no `.update(` of either stamp outside `supabase/functions/`.

## Checks at apply time (read-only)
- `SELECT tgname FROM pg_trigger WHERE tgrelid='public.quotes'::regclass AND NOT tgisinternal;` still lists the guard and no trigger of this name.
- Existing stamped rows are untouched (census re-read 2026-10-19 after #2863: 8 quotes, 2 with homeowner_signed_at, 3 with contractor_signed_at, 0 stamped quotes are non-test).
- After apply, walk one is_test signing (docusign-webhook sets both stamps via service_role) and confirm both stamps record.

## Proof and expected flip
Run `supabase/tests/gh2864_quotes_signature_stamps_platform_only_proof.sql` on production (it ends in a forced rollback; every write is undone). BEFORE-1 to BEFORE-3 (clear, clear, NULL-to-value) print `rows=1 ACCEPTED` (the defect), AFTER-1 to AFTER-4 and AFTER-8 (NULL-to-value, both stamps) print `REJECTED 42501 ... (gh-2864)`, AFTER-5 (service_role) and AFTER-6 (SECURITY DEFINER) print ACCEPTED, and the negative controls stay ACCEPTED.

## Scope decision
Marty CTO RUN 72 extended the rule to NULL-to-value (a client forging a first signature): stamps are platform-only by design and both writers are service_role, so no legitimate client path is lost. Only a value re-sent unchanged passes.

## Rollback
`DROP TRIGGER` and `DROP FUNCTION` (sibling rollback file). No data is changed either way.
