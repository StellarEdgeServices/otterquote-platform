<!-- STATUS (gh-1438, as of 2026-10-19): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh2864_quotes_signature_stamps_platform_only (the STATUS is the set's; it describes the forward migration) -->
<!-- EVIDENCE: drafted with read-only database access (trigger list, guard definition, signed-stamp census, 2026-10-19); the writer search below was run on main b5579ee -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh2864_quotes_signature_stamps_platform_only (Tier 3B, NOT APPLIED)

Issue #2864 (ruling comment 6274566683; window closes 2026-10-20T18:40:35Z). Forward: `gh2864_quotes_signature_stamps_platform_only.sql`. Rollback: `gh2864_quotes_signature_stamps_platform_only_rollback.sql`. Proof: `supabase/tests/gh2864_quotes_signature_stamps_platform_only_proof.sql`.

## What changes
1. New function `public.quotes_refuse_client_signature_change()` (SECURITY INVOKER, `search_path = public, pg_temp`), EXECUTE revoked from PUBLIC, anon, authenticated.
2. New trigger `quotes_refuse_client_signature_change`, BEFORE UPDATE on `public.quotes`, firing only when a non-null `homeowner_signed_at` or `contractor_signed_at` changes (NULL included).
3. Nothing else. `quotes_guard_homeowner_columns()` is not re-created, so there is no composition with gh2564 (applied), PR #2863 (gh-2803) or PR #2913 (gh-2819).

## Live trigger list on quotes (read-only, 2026-10-19), and firing order
BEFORE triggers fire in name order: `quotes_guard_homeowner_columns` (INSERT OR UPDATE), `quotes_normalize_fee_amount` (INSERT OR UPDATE), then the new `quotes_refuse_client_signature_change`, then `set_updated_at_quotes`. (`quotes_refuse_client_select_status` from #2913, if applied, sorts between normalize and this one.) The new trigger never changes NEW, so order does not affect results. The other BEFORE UPDATE triggers touch no signature column.

## Apply order
After #2913 and the #2863 trigger (same surface, gh2564 order), by ruling. The file composes with either in any order.

## Who writes the stamps (grep on main b5579ee, 2026-10-19)
- `supabase/functions/docusign-webhook/index.ts:544` (contractor_signed_at, guarded `.is(..., null)`) and `:583` (homeowner_signed_at, guarded `.is(..., null)`): service_role client (`SUPABASE_SERVICE_ROLE_KEY` secret path). Passes.
- `supabase/functions/admin-reissue-contract/index.ts` (clears both on a re-issue, `reissue-plan.ts` QUOTE_CLEAR): service_role client. Passes.
- No `.html`, `react-app` or other client code writes either stamp; `contract-signing.html:1349` only reads `contractor_signed_at`.
- SQL functions mentioning either column on production: `update_selected_bid_notes(uuid,text)` (SECURITY DEFINER, owner postgres; reads, does not write) and `quotes_guard_homeowner_columns()`.
Re-run the search at apply time: `grep -rnE "(homeowner|contractor)_signed_at" --include=*.html --include=*.ts --include=*.tsx --include=*.js .`

## Checks at apply time (read-only)
- `SELECT tgname FROM pg_trigger WHERE tgrelid='public.quotes'::regclass AND NOT tgisinternal;` still lists the guard and no trigger of this name.
- Existing stamped rows are untouched (census 2026-10-19: 8 quotes, 2 with homeowner_signed_at, 3 with contractor_signed_at, 0 of them non-test).
- After apply, walk one is_test signing (docusign-webhook sets both stamps via service_role) and confirm both stamps record.

## Proof and expected flip
Run `supabase/tests/gh2864_quotes_signature_stamps_platform_only_proof.sql` on production (it ends in a forced rollback; every write is undone). BEFORE-1 and BEFORE-2 print `rows=1 ACCEPTED` (the defect), AFTER-1 to AFTER-4 print `REJECTED 42501 ... (gh-2864)`, AFTER-5 (service_role) and AFTER-6 (SECURITY DEFINER) print ACCEPTED, and the negative controls stay ACCEPTED.

## Open question (does not block the draft)
The ruling covers changing a NON-NULL stamp. A client can still set a NULL stamp to a value (forge a first signature); no client code does. Recommended default: leave it as ruled and file a follow-up to extend the WHEN clause to NULL-to-value, after the signing walk shows no client write.

## Rollback
`DROP TRIGGER` and `DROP FUNCTION` (sibling rollback file). No data is changed either way.
