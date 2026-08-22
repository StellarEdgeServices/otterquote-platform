# Pre-Flight: gh1070_activity_log_grants_revoke

**Migration**: gh1070_activity_log_grants_revoke.sql
**Date**: 2026-08-21
**Author**: Code lane sub-agent (automated), run-work orchestration
**GitHub**: #1070 (round-4 reopening finding on #1028; sibling defect to #1041, found independently by two adversarial verifiers)
**Tier**: 3B — revokes live production grants and tightens an RLS policy's `with_check` on a table with production rows and an active write path. **DRAFT ONLY. NOT APPLIED.** This session's OVERDRIVE rail holds ALL Tier 3B work to drafted-and-noticed, never applied, for tonight specifically — even though this change is arguably eligible for R-134's protective-control fast path (pure grant reduction, no new capability, no schema change, no destructive DDL). The R-097 notice on #1070/#1206 names the fast-path eligibility explicitly and states this session is holding it to the full window anyway per the hard rail, not because the change fails the fast-path test on its own merits.
**Status**: DRAFT — no `apply_migration` call was made against `yeszghaspzwwstvsrioa` to produce this file or verify it beyond read-only queries.

---

## Change Summary

Two changes to `public.activity_log`, both scoped to the AC1 enumeration's Category C finding for this specific table (see the full-class comment on #1070):

1. **Grant revoke.** `anon` loses all 7 privileges (`DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE`) — no policy on this table can ever be satisfied by an unauthenticated caller, so the grant is pure excess. `authenticated` loses `DELETE, REFERENCES, TRIGGER, TRUNCATE, UPDATE` (5 of 7) and keeps only `SELECT` and `INSERT`, the two privileges its two existing policies actually gate.
2. **AC3: `with_check` tightening on the INSERT policy.** `"Users can insert own activity"` changes from `with_check: (auth.uid() = user_id)` to `with_check: ((auth.uid() = user_id) AND (is_test = false))`.

---

## AC3 Decision and Reasoning

**Decision: tighten `with_check` (option a). Direct-client INSERT is NOT revoked.**

The issue's own "Data integrity" section frames the risk as forgery — "the `with_check` says nothing about `is_test`... That path is still open" — and lists constraining `with_check` before revoking INSERT, but does not rule definitively between the two; AC3 requires the implementer to decide and justify.

Read live before deciding, per the dispatch: `grep is_test supabase/functions/` shows all 17 files that reference `is_test`, of which those touching `activity_log` writes are the 14 Edge Functions #1028 fixed. Every one of them authenticates with `SUPABASE_SERVICE_ROLE_KEY` (confirmed by direct read of e.g. `supabase/functions/rescind-bid/index.ts` line 4: `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")`), which bypasses RLS and table grants entirely — **the grant/policy change in this migration has zero effect on any of the 14 Edge Functions.** RLS on `activity_log` only ever governed the *browser-facing* direct-client path.

That path is not hypothetical. A repo-wide search for `activity_log').insert(` (not scoped to `supabase/functions/`) found four live call sites using the browser's authenticated Supabase client:

| File | Event | Sets `is_test`? |
|---|---|---|
| `react-app/app/contractor/dashboard/page.tsx` (~line 393) | `cpa_accepted` | No |
| `react-app/app/contractor/bid/[claimId]/bid-form.tsx` (~line 336) | `bid_updated` | No |
| `contractor-bid-form.html` (~line 5448) | `bid_updated` | No |
| `contractor-dashboard.html` (~line 1167) | `cpa_accepted` | No |

None of the four ever sets `is_test` — all rely on the column's `NOT NULL DEFAULT false`. Revoking direct-client INSERT (option b) would break all four of these working, currently-shipping write paths — an **availability regression**, which the issue's own Tier section names as the condition that voids the R-134 fast path. Tightening `with_check` to require `is_test = false` closes the actual vulnerability (an authenticated caller crafting a raw `insert({..., is_test: true})` to forge a permanently-untagged contamination row) without touching any of the four call sites, since none of them ever attempts to set that column at all. This is also the more architecturally consistent choice: the codebase already treats "privileged server write" (service_role, bypasses RLS) and "client-authenticated write" (RLS-gated, ownership-scoped) as two distinct, intentional paths — option (a) preserves that split; option (b) would collapse it by forcing a client-authenticated feature through a server round-trip that doesn't exist for it today.

---

## Live Pre-Verification (captured fresh this session, 2026-08-21, against `yeszghaspzwwstvsrioa`)

1. **Grants** (`information_schema.role_table_grants`, `table_name='activity_log'`): `anon` = 7/7, `authenticated` = 7/7, `postgres` = 7/7, `service_role` = 7/7. No `PUBLIC` pseudo-role grant on this table — the excess grants are direct to `anon`/`authenticated`, not inherited via `PUBLIC`, so no additional `REVOKE ... FROM PUBLIC` is needed.
2. **Policies** (`pg_policies`, `tablename='activity_log'`): exactly 2 — `"Users can insert own activity"` (INSERT, `with_check: auth.uid() = user_id`) and `"Users can view own activity"` (SELECT, `qual: auth.uid() = user_id`). No policy for DELETE, UPDATE, or any role beyond `{public}` (which for these two evaluates false for `anon` since `auth.uid()` is null under the anon role).
3. **RLS status** (`pg_class.relrowsecurity`): `true`. Not forced (`relforcerowsecurity: false` — irrelevant here, no table-owner bypass path in scope).
4. **Row census**: `count(*) = 1037`, `is_test = true` count = `1034`, `is_test = false` count = `3`. `event_type` distinct values: `bid_confirmation_email_sent, bid_submitted, bid_updated, loss_sheet_parsed, welcome_email_sent`. (`cpa_accepted` has zero rows to date — the call sites exist and are live-shipping code, but that specific event has not yet fired against this table; still counted as a live write path since the code executes it.)
5. **Column definition** (`information_schema.columns`): `is_test boolean NOT NULL DEFAULT false`. Confirms the with_check tightening (`is_test = false`) can never spuriously reject a legitimate insert that omits the column — the default already satisfies it.

---

## Row Count Estimate

| Table | Row Count | Source |
|-------|-----------|--------|
| activity_log | 1,037 (1,034 test / 3 real) | `execute_sql` this session, 2026-08-21 |

---

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|--------------------|
| `REVOKE ... FROM anon` / `REVOKE ... FROM authenticated` | Catalog-only (`pg_class`/ACL update), no table rewrite | < 5ms |
| `ALTER POLICY ... WITH CHECK (...)` | Catalog-only (`pg_policy` update), no table rewrite, no row re-validation on existing rows (with_check only applies to new INSERTs) | < 5ms |

No `ACCESS EXCLUSIVE` lock on the table itself is required for either statement class; both are pure catalog metadata changes. 1,037 existing rows are never read, written, or re-validated by this migration.

---

## Danger Pattern Check

| # | Pattern | Triggered? | Override? |
|---|---------|-----------|-----------|
| 1 | NOT NULL column without DEFAULT | No — no column added | — |
| 2 | NOT NULL on table > 100K rows | No — no column added; table has 1,037 rows regardless | — |
| 3 | DROP COLUMN | No | — |
| 4 | Type change requiring table rewrite | No | — |
| 5 | Index without CONCURRENTLY on hot table | No — no index touched | — |
| 6 | RENAME TABLE or RENAME COLUMN | No | — |
| 7 | TRUNCATE or DELETE all rows | No — grant revoke removes the *privilege* to TRUNCATE/DELETE, it does not TRUNCATE or DELETE anything itself | — |
| 8 | CASCADE DROP | No | — |

**All 8 patterns clear. No overrides required.** The one genuinely load-bearing risk in this migration is not on the standard danger list: **breaking a live write path via the `with_check` change or the INSERT revoke.** Addressed directly in the AC3 reasoning above — INSERT is retained specifically because it's live, and the four call sites are re-verified line-by-line to confirm none of them sets `is_test`, so the tightened check cannot reject them.

---

## Code Path Impact Analysis

- **14 Edge Functions** (`supabase/functions/{switch-contractor, stripe-webhook, send-welcome-email, send-bid-confirmation, rescind-bid, reject-warranty-drift, record-warranty-upload, record-attestation, process-hover-rebate, process-coi-reminders, process-auto-bids, parse-loss-sheet, mark-job-complete, docusign-webhook, create-invoice, counter-sig-reminders, approve-warranty-drift}` minus the 3 without `activity_log` writes) — **zero impact**. All confirmed on `SUPABASE_SERVICE_ROLE_KEY`, which is not subject to RLS policies or the `anon`/`authenticated` grants touched here.
- **4 direct-client call sites** (table above) — **zero impact by design**. Ownership predicate (`auth.uid() = user_id`) unchanged; none sets `is_test`, so the new `AND (is_test = false)` clause is always satisfied for these paths.
- **Any future/unaudited direct-client caller that tries to set `is_test = true`** — **now blocked**, which is the fix's entire point. No such caller was found in this repo scan; this closes a path that's currently only theoretical but was flagged as the live-contamination mechanism #1028 exists to prevent.
- **`anon` (unauthenticated) callers** — no change in observable behavior. Both policies already evaluated false for `anon` (predicate requires `auth.uid()`, which is null); the grant was inert. Revoking it removes a no-op privilege, not a working capability.

---

## Supabase Branch Test Results

**Not run.** This migration is draft-only per the hard rail — no `apply_migration` call, branch or production, was made this session. The change is two catalog-only ACL/policy statements on an existing table with a well-understood, fully-enumerated caller set (14 service-role functions + 4 client call sites, all traced above); a branch test is not judged necessary to validate correctness before Dustin's approval, though nothing prevents running one at apply time if the eventual applier prefers to.

---

## Post-Apply Verification (for whoever applies this after the window/approval)

1. `information_schema.role_table_grants` for `activity_log` — `anon` must have zero rows; `authenticated` must show exactly `INSERT, SELECT`.
2. `pg_policies` for `activity_log`, policy `"Users can insert own activity"` — `with_check` must read `(((SELECT auth.uid()) = user_id) AND (is_test = false))`.
3. Functional smoke test: from an authenticated session, insert a row into `activity_log` with `user_id = auth.uid()` and no `is_test` field — must succeed (uses default `false`). Attempt the same insert with `is_test: true` explicitly — must be rejected by RLS.
4. Confirm the four direct-client call sites still function: exercise the CPA-acceptance flow and a bid-update flow in a non-production/staging pass if available, or monitor Sentry/Postgres logs for `activity_log` insert errors for ~15 minutes post-apply.
5. Read the applied version from `supabase_migrations.schema_migrations` directly, not the git filename (per the repo's own R-145 lesson, cited in gh1021's pre-flight).

---

## Deploy Notes

- **Tier**: 3B. R-097 24-hour notice posted on #1070 and cross-posted to #1206 (see issue comments). **This session does not apply the migration under any circumstance** — the hard rail for this dispatch is drafted-and-noticed only, full stop, regardless of the fast-path eligibility named in the notice.
- **R-134 fast-path note**: this change is a pure grant reduction with no new capability and no schema change — the paradigm case R-134 exists for. Named explicitly in the R-097 notice as a recommendation for whoever applies it next; this session's rail overrides that recommendation for tonight only and does not set precedent for future sessions.
- **Deploy path once unblocked**: PR → required CI green → merge (files-only, no production effect on merge — no CI deploy-on-merge in this repo for `supabase/migrations_drafts/`) → single manual `apply_migration` call against `yeszghaspzwwstvsrioa`, gated on R-097 window expiry + Dustin's D-182 Tier-3 approval.
- **Rollback pre-authorized**: yes — `gh1070_activity_log_grants_revoke_rollback.sql`. No destructive-data guard needed (unlike gh1021's paid-row guard) since re-granting privileges and loosening a `with_check` clause cannot destroy data or violate a narrower constraint against existing rows.
- **Monitoring**: watch Postgres logs / Sentry for `activity_log` insert/select errors for ~15 minutes post-apply, focused on the `cpa_accepted` and `bid_updated` client paths.
- **Follow-on work (named, not fixed here)**: the AC1 enumeration on #1070 lists every other table in `public` carrying the same excess-grant shape — Categories A (deny-all-yet-fully-granted: `admin_dispute_queue`, `disputes`, `hover_tokens`, `imported_hover_jobs`, `stripe_webhook_events`, `support_tickets`), B (service-role-only: `rate_limit_config`, `rate_limits`), C (same shape as `activity_log`: 26 more tables), D (partial-open-by-design: 7 tables), and F (views with full CRUD grants: 7 objects). All named on #1070 for the Bridge to file as separate follow-up issues; none fixed in this dispatch, which is scoped to `activity_log` only.

---

## Danger Overrides

None.
