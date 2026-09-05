# Pre-Flight: 20260904233727_gh1532_accept_bid_payment_guard

**Migration**: 20260904233727_gh1532_accept_bid_payment_guard.sql
**Date**: 2026-09-04
**Author**: Claude Code (run-work dispatch `rw-f22-20260904T231551-wgnu`, CTO dispatch `[RW-DISPATCH: cto-2026-09-04T18:26:08Z | for lane rw-drain-f22-20260904T182711-rnkw | gh-1532 second half]`, comment `5545336759` @ 2026-09-04T19:13:53Z)
**D-numbers**: D-182 Tier 3B (money path), D-261 (function/trigger-class change)
**Issue**: gh-1532 second half (`accept_bid` has no payment-method check; MONEY path)

## Change Summary

This is the second, higher-priority half of gh-1532 (the CHECK-constraint half shipped separately as PR #1627 / migration `20260904132600_gh1532_claims_status_check`). Per the CTO's ruling: *"The constraint is hygiene; this is the live money defect... if the constraint PR and this one contend, this one ships first."*

Adds:
1. `claims_enforce_payment_method_on_award()` — a `BEFORE UPDATE` trigger function on `public.claims`, firing only on the transition into `status='awarded'`, that refuses the update with a readable exception if the winning contractor (`NEW.selected_contractor_id`) does not have `has_payment_method = true`.
2. The same check inlined into `accept_bid(p_claim_id, p_quote_id)` before its status-flip `UPDATE`, so the RPC's own HTML callers get a readable refusal without depending on how the trigger's exception surfaces back through the nested `SECURITY DEFINER` call. `accept_bid`'s `SECURITY DEFINER` posture and every other line are byte-for-byte unchanged from the live body.

**Not in scope**: `bids.html`, `contractor-about.html`, `react-app/` — untouched. The refusal already surfaces through the exception (trigger for the React path, RPC-side check for the HTML callers); UI copy for displaying it is a separate change per the dispatch.

## How The Winning Contractor Is Identified On The Claim Row (the columns relied on)

```sql
select column_name, data_type from information_schema.columns where table_schema='public' and table_name='claims' order by ordinal_position;
```
Relevant columns confirmed live (full 113-column list captured, not reproduced here): `status text`, `selected_contractor_id uuid`, `selected_bid_amount numeric`, `user_id uuid`.

```sql
select column_name, data_type from information_schema.columns where table_schema='public' and table_name='contractors' and column_name in ('id','has_payment_method');
```
```json
[{"column_name":"id","data_type":"uuid"},{"column_name":"has_payment_method","data_type":"boolean"}]
```

**`NEW.selected_contractor_id` is derivable directly from the row being updated, in both writer paths, in the same statement that flips `status`:**

- `accept_bid()` (`supabase/migrations/20260830192051_v116_accept_bid_rpc.sql`): `UPDATE claims SET selected_contractor_id = v_contractor, selected_bid_amount = v_amount, status = 'awarded', updated_at = now() WHERE id = p_claim_id AND user_id = v_uid;` — one statement, both columns.
- React path, `react-app/app/(homeowner)/bids/actions.ts` (`awardClaimToContractor`, line ~109-114, verified by reading the file this session):
  ```ts
  const { error: claimErr } = await supabase
    .from('claims')
    .update({
      selected_contractor_id: bid.contractor_id,
      selected_bid_amount: bid.total_price,
      status: 'awarded',
    })
    .eq('id', claim.id);
  ```
  Confirms the CTO's dispatch description verbatim: this is one of three unbatched `.update()` calls in `awardClaimToContractor`, and it never calls `accept_bid`.

Because both writers set `selected_contractor_id` in the very UPDATE that sets `status='awarded'`, the trigger reads it off `NEW` with no join through `quotes` and no dependency on which of the two writer paths performed the write — this is what makes the single `BEFORE UPDATE` trigger cover both surfaces.

## Writer-Path Trace

- `accept_bid()` RPC callers: `bids.html:2106`, `contractor-about.html:963` (both existing call sites, unchanged this migration).
- React direct-update path: `react-app/app/(homeowner)/bids/actions.ts`, `awardClaimToContractor()` — three direct `.update()` calls (`claims` → `awarded`, winning `quotes` → `selected`, other `quotes` → `declined`); never calls `accept_bid`. This is the gap the CTO's 2026-09-03 ruling on the issue named and the reason the guard is a trigger rather than an RPC-body check alone.

## Test Convention Check

```
grep -rl "accept_bid" supabase/tests    -> no matches
grep -rl "accept_bid" tests             -> no matches
find . -iname "*.test.ts" | xargs grep -l "accept_bid"  -> no matches
```
**No existing SQL/pgTAP or Deno test convention references `accept_bid`** (or any RPC, on inspection of `supabase/tests` and repo-wide `*.test.ts`). No test file is added by this PR; the negative/positive proof below is the deliverable in its place, per the dispatch's own fallback ("if there is none, say so... and rely on the transcript").

## Proof: Single Rolled-Back Transaction Against Production (`yeszghaspzwwstvsrioa`)

### Transaction-semantics probe (run first)

```sql
BEGIN; CREATE TEMP TABLE rw_probe(x int); INSERT INTO rw_probe VALUES (1); SELECT * FROM rw_probe; ROLLBACK;
```
→ returned `[{"x":1}]` (the SELECT's rows came back). A separate, later call to `select * from rw_probe;` returned `ERROR 42P01: relation "rw_probe" does not exist` — confirming (a) statements inside one `execute_sql` call run in one session/transaction and intermediate `SELECT`s ARE visible in that call's result, and (b) `ROLLBACK` truly discards everything, since a brand-new call in a fresh session sees no trace of the temp table.

**One further wrinkle found while building the real experiment, stated per the dispatch's instruction to state which pattern was used and why:** with *many* statements in one call (the full proof below has ~15 `SELECT`/`INSERT...SELECT` steps), the tool returns **only the last result-producing statement's rows**, not every intermediate one — confirmed empirically (a first attempt with multiple bare `SELECT`s scattered through the script returned only the final `SELECT`'s single row). The `DO $$ ... RAISE EXCEPTION USING MESSAGE = <evidence text>` pattern the dispatch offered as a fallback was not needed: instead, every step's evidence was written as a row into a `CREATE TEMP TABLE test_log(seq serial, step text, result text)` via `INSERT INTO test_log(step, result) SELECT ...`, and the script ends with exactly one `SELECT seq, step, result FROM test_log ORDER BY seq;` immediately before `ROLLBACK;` — so the single result set returned by the call is the complete, ordered transcript. This also sidesteps needing `RAISE EXCEPTION` to force an abort-with-message, since an explicit `ROLLBACK;` at the end of the same call already discards everything (proven by the probe above).

### Full transcript (single call, one transaction, ended in `ROLLBACK`)

| seq | step | result |
|---|---|---|
| 1 | PREFLIGHT_awarded_count_before | `1` |
| 2 | PREFLIGHT_contractors | `2bc792be-...:is_test=true:has_pm=true` then 12 more, all `is_test=true:has_pm=false` (ids: `986ce2b6-`, `ee452a12-`, `f3350ae0-`, `136d1a1d-`, `8f2ecbf8-`, `573b2525-`, `5e76adc9-`, `848798cc-`, `5ece9e69-`, `8fa0d121-`, `8e90ff23-`, `bb07fc40-`) |
| 3 | PREFLIGHT_accept_bid_md5_before | `8566312d2c64...` (12-char prefix of the 32-char md5; recompute via `md5(pg_get_functiondef('public.accept_bid'::regproc))`) |
| 4 | PREFLIGHT_claims_total_count | `15` |
| 5 | MIGRATION_accept_bid_md5_after_guard_added | `0fae69977066...` (12-char prefix of the 32-char md5) |
| 6 | MIGRATION_trigger_created | `claims_payment_method_guard` |
| 7 | **NEG1_RPC** (via `accept_bid()`, claim `38ffb84a-...`, quote `ca91add4-...`, contractor `848798cc-...` has_pm=false, caller uid `6b183fbd-...` = claim owner) | `REFUSED sqlstate=P0001 message=contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet` |
| 8 | NEG1_RPC_claim_after | `status=active selected_contractor_id=NULL` (unchanged) |
| 9 | **NEG2_DIRECT** (via direct `UPDATE claims SET selected_contractor_id=..., status='awarded'` — the React `.update()` shape — claim `ba90c501-...`, contractor `5e76adc9-...` has_pm=false) | `REFUSED sqlstate=P0001 message=contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet` |
| 10 | NEG2_DIRECT_claim_after | `status=active selected_contractor_id=NULL` (unchanged) |
| 11 | **POS1_RPC** (via `accept_bid()`, claim `82f5dff4-...` reset to `active`/quote `7ceed80e-...` reset to `submitted` as in-txn fixture setup, contractor `2bc792be-...` has_pm=true, caller uid `92d669a8-...` = claim owner) | `SUCCEEDED` |
| 12 | POS1_RPC_claim_after | `status=awarded selected_contractor_id=2bc792be-b677-4ac1-bc68-94b1561d9757` |
| 13 | **POS2_DIRECT** (via direct `UPDATE claims SET selected_contractor_id='2bc792be-...', status='awarded'` — React shape — claim `474af0fc-...`, contractor `2bc792be-...` has_pm=true) | `SUCCEEDED` |
| 14 | POS2_DIRECT_claim_after | `status=awarded selected_contractor_id=2bc792be-b677-4ac1-bc68-94b1561d9757` |
| 15 | EXISTING_awarded_row_untouched | `id=f3bfb1f9-8d5a-42fb-9b35-11167957842a status=awarded selected_contractor_id=NULL` (the one pre-existing `awarded` row; unchanged, not retro-invalidated, since the trigger only fires on the transition INTO `awarded`) |

**Negative refused: 2/2 (RPC path + React direct-update path). Positive succeeded: 2/2 (same two paths).** Every negative attempt targeted an `is_test=true` claim/contractor; every positive attempt targeted the one `is_test=true` contractor with `has_payment_method=true`.

Auth simulation note: `accept_bid()` is `SECURITY DEFINER` and calls `auth.uid()` (`select coalesce(nullif(current_setting('request.jwt.claim.sub', true),''), (nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'sub'))::uuid`). Each RPC test ran with `SET LOCAL request.jwt.claim.sub = '<claim owner's user_id>'` so the RPC's own ownership check (`c.user_id = v_uid`) passed and the payment-method guard, not the ownership guard, is what was exercised.

### Post-rollback verification (separate call, fresh session)

```json
{
  "claims_triggers": "after_claim_completed,after_claim_completed_rebate,claims_updated_at,trg_claims_advance_referral",
  "accept_bid_md5_now": "8566312d2c64... (12-char prefix; recompute via md5(pg_get_functiondef('public.accept_bid'::regproc)))",
  "claims_count_now": 15,
  "claim_82f5dff4_status_now": "contract_signed",
  "claim_474af0fc_status_now": "active",
  "claim_38ffb84a_status_now": "active",
  "claim_ba90c501_status_now": "active",
  "quote_7ceed80e_status_now": "selected",
  "test_log_visible_now": null
}
```

- **`claims_triggers` does NOT include `claims_payment_method_guard`** — only the four pre-existing triggers remain.
- **`accept_bid_md5_now` (`8566312d2c64...`, 12-char prefix) equals `PREFLIGHT_accept_bid_md5_before`** exactly, and differs from `MIGRATION_accept_bid_md5_after_guard_added` (`0fae69977066...`, 12-char prefix) — the guard is gone, the original function is back. Recompute either full 32-char value via `md5(pg_get_functiondef('public.accept_bid'::regproc))` at the respective point in the transaction.
- **`claims_count_now` (15) unchanged.**
- Every claim touched by the in-transaction tests is back to its pre-transaction state: `82f5dff4` → `contract_signed` (its real original status, not the `active` this transaction set mid-flight, not the `awarded` the positive test produced); `474af0fc`, `38ffb84a`, `ba90c501` → `active` (untouched throughout, since both negative attempts were refused before any write landed).
- The `test_log` temp table is gone (session-scoped and the session ended, consistent with `ROLLBACK` + connection close).

**PERSISTED: none.**

## Danger Pattern Check

| # | Pattern | Triggered? | Notes |
|---|---------|-----------|-------|
| 1 | NOT NULL, no DEFAULT | No | — |
| 2 | NOT NULL on >100K rows | No | — |
| 3 | Drop column | No | — |
| 4 | Type change rewrite | No | — |
| 5 | Index without CONCURRENTLY | No | Not an index |
| 6 | RENAME | No | — |
| 7 | TRUNCATE/DELETE all | No | — |
| 8 | CASCADE DROP | No | — |
| 9 | New/replaced function EXECUTE grants | **Reviewed** | `accept_bid` is `CREATE OR REPLACE` (same signature, grants preserved by Postgres across replace; explicit `REVOKE ALL ... FROM PUBLIC, anon` / `GRANT EXECUTE ... TO authenticated` reissued anyway, matching the original migration's own defensive pattern). The new trigger function has no direct grants to manage (trigger functions are invoked by the table owner's privileges during `UPDATE`, not called directly by client roles). |
| — | Existing rows retro-invalidated by a new guard on a status transition | **Mitigated** | Trigger condition is `OLD.status IS DISTINCT FROM 'awarded' AND NEW.status = 'awarded'` — fires only on the transition, never on an already-`awarded` row being re-saved or merely selected. Confirmed: the 1 live `awarded` row was untouched by the proof transaction. |
| — | RPC guard silently no-ops or 500s instead of a readable refusal | **Mitigated** | Both enforcement points use `RAISE EXCEPTION` with a human-readable message and `ERRCODE='P0001'` (this codebase's existing convention for trigger-raised business-rule gates); demonstrated refusing cleanly in both NEG1/NEG2 above, never a silent no-op. |

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|---------------------|
| `CREATE OR REPLACE FUNCTION` ×2 | Brief catalog-only lock | Near-instant |
| `CREATE TRIGGER` | Brief `ACCESS EXCLUSIVE` on `claims` (metadata-only, no table rewrite/scan) | Near-instant at 15 rows |

## Supabase Branch Test Results

**Not performed.** Per the dispatch's hard rails, `apply_migration` is never called and no DDL runs against prod or any branch outside a transaction that is rolled back. The `BEGIN...ROLLBACK` proof above (run directly against production, per the dispatch's explicit instruction to do so) is the verification; the file's `CREATE OR REPLACE FUNCTION` / `CREATE TRIGGER` statements are the exact text executed and rolled back in that proof.

## Deploy Notes

- **D-182 Tier**: 3B, MONEY path. `tier:3b` and `tier:3b-approved` are both on issue #1532 (verified live before this session's work began).
- **Application**: **NOT performed by this session.** `apply_migration` was never called; nothing was applied to production or to any branch. This PR ships the authored forward + rollback + pre-flight files only.
- **This does not merge or apply on lane authority.** Per the CTO's dispatch: merge/apply is `@exec:cto`'s after Dustin's R-120 signed review; the R-120 signed review required check is expected to be red until signed (`supabase/migrations/` is in the R-120 SQL path set).
- **`closes-on`** (per the CTO's dispatch, restated): the trigger + RPC diff (this file); the negative test refused (above); the positive test showing the `has_payment_method=true` contractor still completes an award (above); the pre-flight showing no existing `awarded` row is retro-invalidated (above). This PR does not close issue #1532 (`Refs #1532`, never `Closes`) — the issue also covers the separately-shipped CHECK-constraint half (#1627).
- **Rollback pre-authorized**: Yes — run `20260904233727_gh1532_accept_bid_payment_guard_rollback.sql` (drops the trigger + trigger function, restores `accept_bid()`'s exact prior body, byte-verified identical to the source that produced md5 prefix `8566312d2c64...` (recompute the full 32-char value via `md5(pg_get_functiondef('public.accept_bid'::regproc))`)) if this needs to be removed for any reason. Reversible with no data loss.

## Danger Overrides

None.
