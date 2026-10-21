<!-- STATUS (gh-1438, as of 2026-10-19): NOT APPLIED -->
<!-- FILE ROLE: pre-flight of set gh2819_quotes_client_select_refused (the STATUS is the set's; it describes the forward migration) -->
<!-- EVIDENCE: drafted without database access; the writer search below is from Kevin's pre-flight on #2819 comment 6253767326 -->
<!-- REPO COPY: none -->
<!-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md -->

# Pre-flight: gh2819_quotes_client_select_refused (Tier 3B, NOT APPLIED)

Issue #2819. Forward: `gh2819_quotes_client_select_refused.sql`. Rollback: `gh2819_quotes_client_select_refused_rollback.sql`. Proof: `supabase/tests/gh2819_quotes_client_select_refused_proof.sql`.

## What changes
1. New function `public.quotes_refuse_client_select_status()` (SECURITY INVOKER, `search_path = public, pg_temp`), EXECUTE revoked from PUBLIC, anon, authenticated.
2. New trigger `quotes_refuse_client_select_status`, BEFORE UPDATE on `public.quotes`, firing only when `NEW.status = 'selected'` and `OLD.status` is not `selected`.
3. Nothing else. `quotes_guard_homeowner_columns()` is not re-created, so there is no composition with gh2564 (applied) or PR #2863 (gh-2803).

## Apply order (Marty ruling 6272462274)
1. The React fix merges and deploys first: `awardClaimToContractor` (`react-app/app/(homeowner)/bids/actions.ts`) calls `supabase.rpc('accept_bid', ...)`. Today its step 2 writes `quotes.status = 'selected'` directly (actions.ts:135) and would fail 42501 after this migration. (It already cannot complete in production: its step 1 claims write is refused by gh2626.)
2. Then this file. The in-file gate raises unless `accept_bid(uuid,uuid)` exists and is SECURITY DEFINER.

## Homeowner writers of quotes.status (Kevin's search, #2819 comment 6253767326, main d914d8e5)
Only `react-app/app/(homeowner)/bids/actions.ts:135` (`selected`) and `:152` (`declined`, not affected by this trigger). Static `bids.html:2019` and `contractor-about.html:1008` award through `rpc('accept_bid')`. Re-run the search at apply time.

## Checks at apply time (read-only)
- `SELECT prosecdef FROM pg_proc WHERE oid = 'public.accept_bid(uuid,uuid)'::regprocedure;` is true.
- Existing selected rows are unaffected (census 2026-10-18: 3 selected/active quotes, all test).

## Proof and expected flip
Run `supabase/tests/gh2819_quotes_client_select_refused_proof.sql` on production (it ends in a forced rollback). BEFORE-1 prints `rows=1 ACCEPTED` (the defect), AFTER-1 prints `REJECTED 42501 ... (gh-2819)`, AFTER-2 (accept_bid) prints ACCEPTED, and the negative controls (decline, contractor note edit) stay ACCEPTED. The #2620 proof then shows AFTER-5b REJECTED and AFTER-6 ACCEPTED.

## Rollback
`DROP TRIGGER` and `DROP FUNCTION` (sibling rollback file). No data is changed either way.
