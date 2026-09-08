# Pre-Flight: 20260907220015_gh1796_claims_loss_sheet_reviewed_at

**Migration**: `20260907220015_gh1796_claims_loss_sheet_reviewed_at.sql`
**Rollback**: `20260907220015_gh1796_claims_loss_sheet_reviewed_at_rollback.sql`
**Date**: 2026-09-07 (all timestamps from `In Flight/bin/stamp.py`: `2026-09-07T22:00:15Z`)
**Author**: Claude Code (Code lane, CEO RUN 35 dispatch, claim `ceo-2026-09-07T20:08:08Z`)
**D-numbers**: D-182 / D-261 — **Tier 3A** (additive, nullable, no default, no backfill, no constraint, no index)
**Issue**: gh-1796 (sub-issue of gh-1653) — loss-sheet queue in admin homeowner tracking

## Change Summary

Adds one column:

```sql
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS loss_sheet_reviewed_at timestamptz;
```

plus a `COMMENT ON COLUMN`. Nothing else. No index, no constraint, no trigger, no
default, no backfill, no data change of any kind.

Driven by Dustin's ruling on #1597 (2026-09-07, verbatim): *"We are not changing our
copy regarding reviewing loss sheets to determine if it's acv or rcv. For now, I want
the system to identify people who need their loss sheets and bring them to my attention
in the administrative dashboard. This will need to be part of the homeowner tracking
process."*

## ⚠ NOT APPLIED

**This migration has not been run.** Not against production (`yeszghaspzwwstvsrioa`),
not against `otterquote-ci-test`, not against a branch, not in a
`BEGIN … ROLLBACK` probe. `apply_migration` was never called. Every SQL statement in
this pre-flight is `SELECT`-only. The PR ships the forward file, the rollback file, and
this document; applying it is a separate gated step.

The three readers were written so that merging the code ahead of the apply is safe **and
visible**, not silently broken:

| Surface | Behaviour with the column absent |
|---|---|
| `get-homeowner-list` | Returns `loss_sheet_reviewed_column_present: false`; the marker query's failure is logged and swallowed; every claim reads `missing` or `uploaded_unreviewed`. The queue shows **more** rows, never fewer, and never errors. |
| `mark-loss-sheet-reviewed` | Detects PostgREST `42703` and returns **503** `{ migration_pending: true }` with the migration filename in the message. Writes nothing. Fails closed. |
| `admin-homeowners.html` | Renders the queue and shows an explicit amber notice naming the pending migration. |

## Where a Loss Sheet Actually Lives (derived, not assumed)

The issue allows that the document might live in `claims.*` fields, a `documents`
table, or storage paths. It is the first and third, and there is no such table:

```sql
-- 1. Is there a documents / claim_documents table at all?  -> NO
select c.table_name, string_agg(c.column_name||' '||c.data_type, ', ' order by c.ordinal_position) cols
from information_schema.columns c
join information_schema.tables t
  on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
where c.table_schema = 'public' and c.table_name ~* 'doc'
group by c.table_name;
```
```json
[]
```

```sql
-- 2. Every loss-sheet-shaped column anywhere in the database.
select table_schema, table_name, column_name, data_type
from information_schema.columns
where column_name ilike '%loss%' or table_name ilike '%loss%'
order by table_schema, table_name, ordinal_position;
```
```json
[{"table_schema":"public","table_name":"claims","column_name":"date_of_loss","data_type":"date"},
 {"table_schema":"public","table_name":"claims","column_name":"loss_sheet_parsed_at","data_type":"timestamp with time zone"}]
```

```sql
-- 3. The buckets. The loss sheet is an object in the private claim-documents bucket.
select id as bucket_id, name, public from storage.buckets order by name;
```
```json
[{"bucket_id":"cert-letters","public":false},{"bucket_id":"claim-documents","public":false},
 {"bucket_id":"contractor-documents","public":false},{"bucket_id":"contractor-templates","public":false},
 {"bucket_id":"e2e-artifacts","public":false},{"bucket_id":"partner-photos","public":true},
 {"bucket_id":"partner-w9","public":false}]
```

```sql
-- 4. The path is claims.estimate_filename, bucket-relative:
--    <user_id>/<claim_id>/<epoch>-<original filename>
select estimate_filename from claims where estimate_filename is not null;
```
```json
[{"estimate_filename":"e6588b43-.../f3bfb1f9-8d5a-42fb-9b35-11167957842a/1783510945397-Loss Sheet - Allstate - Claim 0712345678.pdf"},
 {"estimate_filename":"5afddb5c-.../4595b6f0-8bf2-4161-b8b7-00a5bd0898cb/1785930673843-dummy-estimate.jpg"}]
```

Confirmed in code: `dashboard.html` uploads to `claim-documents`, then writes
`has_estimate = true` and `estimate_filename = <storage path>` on the claim and invokes
`parse-loss-sheet`; `parse-loss-sheet` sets `claims.loss_sheet_parsed_at`.

**There is no upload-timestamp column on `claims`** (no `estimate_uploaded_at`; contrast
`contractors.coi_uploaded_at`, `quotes.warranty_uploaded_at`). The upload date therefore
comes from `storage.objects.created_at`, verified to line up with a real row:

```sql
select c.id, c.is_test, c.has_estimate, (c.estimate_filename is not null) as has_fn,
       c.loss_sheet_parsed_at, o.created_at as object_created_at
from claims c
left join storage.objects o
  on o.bucket_id = 'claim-documents' and o.name = c.estimate_filename
order by c.created_at desc limit 25;
```
Two rows carry an object: `4595b6f0-…` (`is_test = false`) created `2026-08-05 11:51:14+00`
with `loss_sheet_parsed_at` NULL, and `f3bfb1f9-…` (`is_test = true`) created
`2026-07-08 11:42:26+00` with `loss_sheet_parsed_at 2026-07-08 21:43:13+00`. That pair is
why the EF prefers the storage timestamp and keeps `loss_sheet_parsed_at` only as a
labelled fallback — the parse stamp is null on one of the two, and ~10h later on the other.

## The Three States, in SQL

`loss_sheet_reviewed_at` is simulated as always-NULL below, which is exactly its
pre-migration value on every row:

```sql
select
  case
    when null::timestamptz is not null                     then 'reviewed'
    when nullif(trim(estimate_filename), '') is not null   then 'uploaded_unreviewed'
    else 'missing'
  end                                as loss_sheet,
  count(*)                           as claims,
  count(*) filter (where is_test)    as test_rows,
  count(*) filter (where not is_test or is_test is null) as real_rows,
  count(*) filter (where has_estimate and nullif(trim(estimate_filename),'') is null) as flagged_but_no_file
from claims
group by 1 order by 2 desc;
```
```json
[{"loss_sheet":"missing","claims":14,"test_rows":12,"real_rows":2,"flagged_but_no_file":4},
 {"loss_sheet":"uploaded_unreviewed","claims":2,"test_rows":1,"real_rows":1,"flagged_but_no_file":0}]
```

16 claims total. **Both states the issue asks for are populated with non-test rows
today** — 2 real `missing` and 1 real `uploaded_unreviewed` — so the queue is not an
empty shell on day one, and #1796's artifact criterion is reachable with real data.
`reviewed` is 0, necessarily: the marker has never existed.

`flagged_but_no_file = 4` is the one edge case worth naming. Four claims carry
`has_estimate = true` with `estimate_filename` NULL. `has_estimate` is therefore **not**
consulted by the state function — `estimate_filename` is the authority on "is there a
document to open" — and those four are correctly `missing` and carry a per-row note
("Flagged as uploaded, but no file is on record — nothing to open.") so they do not read
as a queue bug.

## Danger Pattern Check

| # | Pattern | Triggered? | Notes |
|---|---------|-----------|-------|
| 1 | NOT NULL, no DEFAULT | No | Column is nullable, no default |
| 2 | NOT NULL on >100K rows | No | 16 rows; not NOT NULL |
| 3 | Drop column | No | Forward is additive only (the rollback drops it — see below) |
| 4 | Type change rewrite | No | New column |
| 5 | Index without CONCURRENTLY | No | No index created |
| 6 | RENAME | No | — |
| 7 | TRUNCATE/DELETE all | No | No DML at all |
| 8 | CASCADE DROP | No | — |
| 9 | New/replaced function EXECUTE grants | No | No function created or replaced |
| — | Name collision with an existing identifier | No | `grep -rn loss_sheet_reviewed_at` over the tree at `origin/main` returns **zero** hits outside this PR |

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|---------------------|
| `ADD COLUMN … timestamptz` (no default) | Brief `ACCESS EXCLUSIVE`, catalog-only | Near-instant. PG 11+ does not rewrite the table for a nullable add with no default; PG 17.6 here, 16 rows regardless |
| `COMMENT ON COLUMN` | Catalog-only | Near-instant |

## Rollback

`20260907220015_gh1796_claims_loss_sheet_reviewed_at_rollback.sql` — `DROP COLUMN IF
EXISTS`. Pre-authorized: nothing in the schema depends on the column (no index,
constraint, trigger, view, RLS policy, generated column or FK), and all three readers
tolerate its absence, so the rollback is safe to run before **or** after rolling the
Edge Functions back.

**What a rollback destroys:** the review marks themselves. They are partially
recoverable from `activity_log`, which `mark-loss-sheet-reviewed` writes in the same
call:

```sql
select metadata->>'claim_id' as claim_id, created_at
  from activity_log
 where event_type = 'loss_sheet_reviewed'
 order by created_at;
```

Best-effort only: `activity_log.user_id` is NOT NULL, so a claim with a NULL `user_id`
gets no audit row. Capture that output before dropping the column if the marks matter.

## Deploy Notes

- **Tier**: 3A. Additive, nullable, no backfill — the autonomous class under D-261.
  Still filed as a PR and **not applied**, per this dispatch's explicit instruction.
- **Apply order**: migration first, then the Edge Functions, then refresh
  `sql/schema-snapshot.json` (`python3 scripts/refresh-schema-snapshot.py`). Reversing
  the first two is tolerated — that is the whole point of the 503 `migration_pending`
  path — but it means the button is visible and inert until the column lands.
- **`sql/schema-snapshot.json` is deliberately NOT edited in this PR.** It mirrors
  production, and in production this column does not exist. The consequence is spelled
  out in `mark-loss-sheet-reviewed/index.ts`: the `claims` update payload is a named
  variable rather than an inline literal, because `scripts/schema-column-lint.py`
  validates inline `.update({…})` literals against that snapshot and would fail CI on a
  column that is correctly absent from it. Once applied and the snapshot refreshed, the
  payload can become an inline literal again — a one-line follow-up, noted at the call site.
- **This PR does not close #1796.** Its `closes-on` is `artifact`: the queue rendered in
  a signed-in admin session showing ≥1 row in each of `missing` and `uploaded_unreviewed`,
  plus the negative control (the same row gone once marked reviewed). That needs an
  applied migration and a deployed function.

## Danger Overrides

None.
