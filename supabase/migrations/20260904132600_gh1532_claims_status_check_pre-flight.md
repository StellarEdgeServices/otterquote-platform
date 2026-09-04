# Pre-Flight: 20260904132600_gh1532_claims_status_check

**Migration**: 20260904132600_gh1532_claims_status_check.sql
**Date**: 2026-09-04
**Author**: Claude Code (run-work dispatch rw-drain-f22-20260904T121030-p3wk / worker-1532)
**D-numbers**: D-182 Tier 3B (R-097 24h window; approved), D-261 (ALTER-class change)
**Issue**: gh-1532 (`claims.status` has no CHECK constraint; MONEY path)

## Change Summary

Adds `claims_status_check`, a `CHECK (status IN (...))` constraint on
`public.claims`, applied `NOT VALID` then `VALIDATE CONSTRAINT` as a
separate step (per the CTO's binding ruling on the issue, same shape as
gh-1387). Today `claims.status` accepts arbitrary text with no server-side
enforcement at all.

This migration covers **only** the CHECK-constraint half of gh-1532. The
issue's second half -- guarding `accept_bid()` with the payment-method
check it never reads -- is explicitly out of scope for this file (this
session's dispatch scoped it to "add the CHECK constraint the issue
specifies"; the CTO's own ruling on the issue separately says the guard
should not wait on this migration's ceremony).

## Allowed Value Set — How It Was Derived

The issue's approval-comment ruling (2026-09-04T13:12:41Z) requires the
allowed set be built from "the product's own state machine — the statuses
the code can actually set — not from `SELECT DISTINCT status FROM
claims`", with the live enumeration used only as a diff/safety check
against that set, and any disagreement resolved explicitly before the
constraint ships.

The set used here is the **union of 8** established in the issue's first
comment (2026-09-03T13:11:00Z, CTO run 18, itself a SELECT-only + repo-grep
session against `main@4de6138`) and never revised by the two follow-up
comments — those comments raised a methodology question (is a live-value
enumeration a strong enough spec?) and the approval comment answered it by
endorsing exactly this code-write-sites-plus-DEFAULT construction, not by
changing the 8 values themselves:

| Value | Code write site(s) |
|---|---|
| `draft` | `repair-intake.html:1310` (update); `dashboard.html:1746` (insert), `dashboard.html:3029`'s sibling insert path, demo-mode mock at `dashboard.html:1524`; `react-app/app/(homeowner)/dashboard/use-dashboard-data.ts:92` (insert); `react-app/app/(homeowner)/repair-intake/utils.ts:202` (`buildClaimInsert`) |
| `submitted` | `repair-intake.html:1357` (update); `react-app/app/(homeowner)/repair-intake/use-repair-intake-data.ts:164` (update) |
| `active` | `dashboard.html:3029` (`submitForBids`, via `submitUpdate`); `react-app/app/(homeowner)/dashboard/actions.ts:41` |
| `waitlisted` | `dashboard.html:1839` (D-178 state gate); `react-app/app/(homeowner)/dashboard/actions.ts:216` (`joinExpansionWaitlist`) |
| `bidding` | `supabase/functions/switch-contractor/index.ts:372`; `supabase/functions/process-dunning/index.ts:745` (reset-to-bidding path) |
| `contract_signed` | `supabase/functions/docusign-webhook/index.ts:1002,1121,1206,1402`; `supabase/functions/process-dunning/index.ts:706` (restore-signed path) |
| `awarded` | `react-app/app/(homeowner)/bids/actions.ts:113` (`awardClaimToContractor`); `accept_bid()` RPC, `supabase/migrations/20260830192051_v116_accept_bid_rpc.sql:42` |
| `documents_needed` | No code write site — the column's own `DEFAULT`: `supabase/migrations/20260101000000_v000_baseline_schema.sql:186` — `status text DEFAULT 'documents_needed'::text`. Its own finding, as the issue body predicted; kept in the list because it is real (claims land here by column default, not by an explicit write) |

`submitted` and `waitlisted` are code-writable but carry **zero** live rows
today (see enumeration below) — kept in the set per the union-of-8
construction; they are legal states the product can reach, not yet
reached in this data.

No disagreement between this spec and the live enumeration was found (see
below), so there was nothing to resolve on the issue before shipping.

## Live Enumeration (re-run this session, prod, read-only, 2026-09-04)

```sql
select status, count(*) from claims group by status order by count(*) desc;
```
```json
[{"status":"active","count":5},{"status":"bidding","count":3},{"status":"documents_needed","count":3},{"status":"draft","count":2},{"status":"contract_signed","count":2},{"status":"awarded","count":1}]
```
16 rows total, 6 distinct values — matches the issue thread's prior two
enumerations (2026-09-03T13:11:00Z and 2026-09-03T22:18:09Z) exactly.

```sql
select status, count(*) from claims where is_test = true group by status order by count(*) desc;
```
```json
[{"status":"active","count":4},{"status":"bidding","count":3},{"status":"contract_signed","count":2},{"status":"awarded","count":1}]
```
10 test rows.

```sql
select status, count(*) from claims where is_test is distinct from true group by status order by count(*) desc;
```
```json
[{"status":"documents_needed","count":3},{"status":"draft","count":2},{"status":"active","count":1}]
```
6 non-test (`is_test` false or null) rows — includes the single live
`awarded` row's sibling non-test claims but the `awarded` row itself is
in the `is_test = true` bucket above (1 of 1). Cross-check: 10 + 6 = 16,
matches the ungrouped total.

**Does every existing row satisfy the proposed constraint? YES.** All 6
distinct live values (`active`, `bidding`, `documents_needed`, `draft`,
`contract_signed`, `awarded`) are members of the 8-value allowed set.
`submitted` and `waitlisted` are in the allowed set but have 0 live rows
(not a violation — CHECK constraints don't require every allowed value to
be in use). No live value falls outside the set. No row would be rejected
by `VALIDATE CONSTRAINT`.

## Writer Enumeration (this session, read-only grep against the worktree, `main@9f567ba`)

Every `.from('claims')` chained directly into `.update(...)` / `.insert(...)`
/ `.upsert(...)` with a literal `status:` in the argument, across
`*.html`, `*.js`, `*.ts`, `*.tsx` (Python AST-adjacent scan, not a bare
grep, specifically to avoid conflating `claims.status` with `quotes.status`,
`contractors.status`, `referrals.status`, `contractor_templates.status`,
and `payment_failures.dunning_status`, all of which share the generic
column name `status` and all of which appeared in an initial broad grep
before this narrowing):

```
('.\dashboard.html', 1746, 'insert', ['draft'])
('.\dashboard.html', 1839, 'update', ['waitlisted'])
('.\repair-intake.html', 1357, 'update', ['submitted'])
('.\react-app\app\(homeowner)\bids\actions.ts', 109, 'update', ['awarded'])
('.\react-app\app\(homeowner)\dashboard\actions.ts', 216, 'update', ['waitlisted'])
('.\react-app\app\(homeowner)\dashboard\use-dashboard-data.ts', 89, 'insert', ['draft'])
('.\react-app\app\(homeowner)\repair-intake\use-repair-intake-data.ts', 164, 'update', ['submitted'])
('.\supabase\functions\docusign-webhook\index.ts', 1002, 'update', ['contract_signed'])
('.\supabase\functions\docusign-webhook\index.ts', 1121, 'update', ['contract_signed'])
('.\supabase\functions\docusign-webhook\index.ts', 1206, 'update', ['contract_signed'])
('.\supabase\functions\docusign-webhook\index.ts', 1402, 'update', ['contract_signed'])
('.\supabase\functions\process-dunning\index.ts', 706, 'update', ['contract_signed'])
('.\supabase\functions\process-dunning\index.ts', 745, 'update', ['bidding'])
('.\supabase\functions\switch-contractor\index.ts', 372, 'update', ['bidding'])
```

Plus three sites where the `.update()`/`.insert()` argument is built via a
named variable rather than an inline literal (not caught by the chain
scan above; verified individually by reading the surrounding function):

- `dashboard.html:3029` — `submitForBids()`: `const submitUpdate = { status: 'active', ... }` then `.from('claims').update(submitUpdate)`.
- `react-app/app/(homeowner)/repair-intake/utils.ts:202` — `buildClaimInsert()` returns `{ ..., status: 'draft', ... }`, consumed by the repair-intake insert path.
- `dashboard.html:1524` — `currentClaim = { ..., status: 'draft', ... }`, DEMO_MODE-only client-side mock object, never reaches the database.
- `accept_bid()` RPC (`supabase/migrations/20260830192051_v116_accept_bid_rpc.sql:42`) — raw SQL `UPDATE claims SET ... status = 'awarded' ...`, not a supabase-js call, found separately via SQL-pattern grep.

**Every literal cross-checked against the allowed 8-value set: no writer
emits a value outside it.**

### False positives eliminated (initial broad grep, before table-scoping)

An initial broad grep for `status:`/`NEW.status =`/`UPDATE claims SET`
across the repo surfaced additional apparent values — `declined`,
`selected`, `sent`, `commission_paid`, `pending_validation`, `failed`,
`cancelled` — all of which were traced to **other tables' own `status`
columns**, not `claims.status`:

- `declined` / `selected` — `quotes.status` (bid status), written by
  `react-app/app/(homeowner)/bids/actions.ts:118,123` (`awardClaimToContractor`,
  same function that writes `claims.status='awarded'` on the line above),
  `accept_bid()` RPC lines 46/48, and `process-dunning/index.ts` (restores
  `quotes.status='submitted'` where it was `'declined'`).
- `sent` — not a database write at all; it is the HTTP response body's
  `status: "sent"` field in `supabase/functions/create-docusign-envelope/index.ts:2427-2436`. The actual `claims` `.update()` call two lines above writes only `contract_sent_at` / `*_envelope_id` fields, no `status`.
- `commission_paid` — `referrals.status`, written via the
  `update_referral_stats()` trigger (`sql/v7-referral-system.sql:175`,
  baseline schema line ~2850), fires on the `referrals` table, unrelated
  to `claims`.
- `pending_validation` — `contractor_templates.status`, written via
  `enforce_template_privileged_columns()` (baseline schema line ~1887,
  `20260708214138_v89_fix_template_privileged_guard.sql`), fires on
  `contractor_templates`, unrelated to `claims`.
- `awarded` (as a `NEW.status` trigger condition, separately from the
  confirmed `claims.status` writer above) and `failed` /
  `cancelled` — all traced to the `log_bid_accepted()` trigger and related
  code paths on the **`quotes`** table (`sql/v13-activity-log.sql:74`,
  baseline schema ~2114, `20260703222148_v87_...`, `20260818224203_gh1028_...`,
  `20260827024432_v114_...`, `20260901132754_gh1304_v115_...`, and their
  rollback files), and `switch-contractor/index.ts`'s `quotes.status =
  'cancelled'` write. Migration `v114`'s own header confirms this
  explicitly: *"log_bid_accepted() checked NEW.status = 'awarded', a value
  quotes_status_check has never permitted and that no code path ever
  writes to quotes... Fix: fire on the value the app actually writes
  ('selected')"* — i.e. this is entirely the `quotes` table's status
  column and its own separate `quotes_status_check` constraint, not
  `claims.status`.

None of these eliminated values belong to `claims.status`; none change
the allowed set above.

## Related finding (not actioned by this migration)

The CTO's approval comment flags that `storage.objects`' `"Contractors can
view biddable claim docs"` policy keys on `claims.status IN ('active',
'bidding','pending')` — i.e. this table's status is load-bearing for a
storage access decision, not just reporting. Note `'pending'` is **not**
in the 8-value allowed set built here (it has no code write site and is
not the column default) — the storage policy's `'pending'` branch is
already permanently unreachable given `claims.status` never holds
`'pending'` in this codebase. This migration does not change that policy;
flagging it here as the CTO's own observation, for whoever picks up the
storage-policy angle (issue references `#1412`).

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|---------------------|
| `ADD CONSTRAINT ... NOT VALID` | Brief `ACCESS EXCLUSIVE` (metadata-only; no table scan) | Near-instant at 16 rows |
| `VALIDATE CONSTRAINT` | `SHARE UPDATE EXCLUSIVE` (permits concurrent reads/writes) | One scan of `claims`; trivial at 16 rows |

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
| 9 | New/replaced function EXECUTE grants | No | No function created |
| — | CHECK constraint on a live table with unverified data | **Mitigated** | `NOT VALID` + separate `VALIDATE CONSTRAINT` per the CTO's ruling; pre-flight confirms 100% of live rows already satisfy it, so `VALIDATE` is expected to succeed, not merely fail safely |

## Supabase Branch Test Results

**Not performed — out of scope for this session by explicit dispatch
instruction.** The dispatch brief for this task states: *"DO NOT APPLY THE
MIGRATION. Do not call apply_migration. Do not run the ALTER against prod
or any branch... Read-only SQL for the pre-flight is expected and
required; any write is out of scope."* This also rules out the
`BEGIN...ROLLBACK` proof-run against production that the issue body's
original instructions call for ("proven in `BEGIN … ROLLBACK` against
production first") — that is itself a write attempt against the
money-path table and is explicitly out of scope for this dispatch. The
`SELECT`-only pre-flight above is complete; the `BEGIN...ROLLBACK` proof
and the actual apply are both left to the separate gated step the
dispatch names.

## Deploy Notes

- **D-182 Tier**: 3B — R-097 24h window opened 2026-09-03T13:11:00Z,
  closed 2026-09-04T13:11:00Z with no objection; `tier:3b-approved`
  applied by CTO run `cto-2026-09-04T12:07:50Z`.
- **Application**: **NOT performed by this session.** This PR ships the
  authored forward + rollback migration files and this pre-flight only.
  MIGRATION NOT APPLIED — requires a separate gated apply step (orchestrator
  or CTO), per the dispatch's explicit instruction not to call
  `apply_migration` or run the ALTER against prod or any branch.
- **`closes-on`** (from the issue, verbatim): `select conname from
  pg_constraint where conrelid='public.claims'::regclass and
  conname='claims_status_check'` → 1 row; plus the (out-of-scope-for-this-PR)
  `accept_bid` payment-method-guard closes-on items. This PR does not
  close the issue.
- **Rollback pre-authorized**: Yes — run
  `20260904132600_gh1532_claims_status_check_rollback.sql` (`DROP
  CONSTRAINT IF EXISTS claims_status_check`) if the constraint needs to be
  removed for any reason. Reversible with no data loss.

## Danger Overrides

None.
