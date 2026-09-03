# Pre-Flight: 20260903184350_gh1544_contractors_email_lower_uniq

**Migration**: 20260903184350_gh1544_contractors_email_lower_uniq.sql
**Date**: 2026-09-03
**Author**: Claude Code (run-work dispatch rw-f22-20260903T183505-cfn1)
**D-numbers**: D-182 Tier 3A (additive index, D-261/R-097 — autonomous), D-221 (Path A)
**Issue**: gh-1544 (contractor signup does not detect an existing application by email)

## Change Summary

Adds a partial unique index on `lower(email)` for non-test `contractors`
rows, so two contractor applications for the same email cannot both exist
in production. This is the server-side backstop for the app-layer
duplicate-email gates already shipped in PR #1557 (`check-email-exists`,
called before insert on `contractor-join.html` and
`contractor-pre-approval.html`) — it closes the race window between that
check and the actual insert. Approved as Tier 3A (autonomous) by the CTO
in issue comment 5518184628 (2026-09-02T23:57:30Z), which also made a
SQLSTATE `23505` handler on the insert paths a hard condition of shipping
this index (see companion change to `contractor-pre-approval.html` in the
same PR).

## Row Count / Enumeration

Re-run by the CTO live on 2026-09-02T23:58Z (issue comment 5518184628):

```sql
select (select count(*) from contractors)                                                    as total_rows,
       (select count(*) from contractors where is_test is not true)                          as non_test_rows,
       (select count(*) from contractors where email is null)                                as null_emails,
       (select count(*) from (select lower(email) from contractors where is_test is not true
                              and email is not null group by 1 having count(*)>1) x)          as nontest_dup_groups,
       (select count(*) from (select lower(email) from contractors
                              where email is not null group by 1 having count(*)>1) y)        as all_dup_groups,
       (select count(*) from information_schema.columns where table_name='contractors'
        and column_name='is_test' and is_nullable='YES')                                     as is_test_nullable;
```
```
[{"total_rows":13,"non_test_rows":0,"null_emails":0,"nontest_dup_groups":0,"all_dup_groups":1,"is_test_nullable":0}]
```

`is_test` is `NOT NULL`, so the partial predicate `where is_test = false` is
exactly equivalent to `is_test is not true` — no three-valued-logic hole.
Zero null emails, zero non-test duplicate groups. The index applies cleanly
against the current data. `non_test_rows = 0` (every contractor row today
is a test row, per gh-1491) means the index currently constrains an empty
set — the CTO's stated reason to ship now, before that stops being true.
The one `all_dup_groups` hit is the known Stohler Roofing pair
(`8e90ff23`, `ee452a12`), both `is_test = true`, excluded by the partial
predicate.

This session did not re-run the enumeration itself — no `SUPABASE_SERVICE_ROLE_KEY`
or equivalent credential was available in this worktree/session (per the
dispatch's explicit environment facts), so the table above is the CTO's
own live re-verification, quoted rather than re-derived. Application of
this migration to production is likewise pending a session with that
credential — this PR ships the authored file only.

## Lock Duration Estimate

| Operation | Lock Type | Estimated Duration |
|-----------|-----------|---------------------|
| `CREATE UNIQUE INDEX CONCURRENTLY` | `SHARE UPDATE EXCLUSIVE` (permits concurrent reads/writes; blocks other DDL on the table) | Two passes over `contractors`; trivial at 13 rows total, 0 of which are non-test (the partial predicate scans to near-zero matching rows) |

No `ALTER TABLE`, no table rewrite. `CONCURRENTLY` is used specifically so
this does not take the blocking lock a plain `CREATE UNIQUE INDEX` would.

## Danger Pattern Check

| # | Pattern | Triggered? | Notes |
|---|---------|-----------|-------|
| 1 | NOT NULL, no DEFAULT | No | — |
| 2 | NOT NULL on >100K rows | No | — |
| 3 | Drop column | No | — |
| 4 | Type change rewrite | No | — |
| 5 | Index without CONCURRENTLY | **N/A — CONCURRENTLY used** | `CREATE UNIQUE INDEX CONCURRENTLY` as required by pattern 5's own remedy |
| 6 | RENAME | No | — |
| 7 | TRUNCATE/DELETE all | No | — |
| 8 | CASCADE DROP | No | — |
| 9 | New/replaced function EXECUTE grants | No | No function created |

**Non-transactional requirement**: `CREATE INDEX CONCURRENTLY` (and its
`DROP INDEX CONCURRENTLY` rollback counterpart) cannot run inside a
`BEGIN...COMMIT` block. Both this file and the rollback file intentionally
omit the transaction wrapper and contain exactly one statement each, per
the migration-author-code skill's documented CONCURRENTLY pattern ("Make
this a separate migration file from any other schema changes").

**Failure mode to know before applying**: if the `CREATE INDEX
CONCURRENTLY` run fails partway (e.g. a concurrent write it cannot see
around), Postgres does **not** roll it back automatically — it leaves an
`INVALID` index behind (`pg_index.indisvalid = false`) that continues to
consume space and must be dropped (via the rollback file) before retrying
the forward migration.

## Supabase Branch Test Results

**Not performed.** This session (run-work dispatch rw-f22-20260903T183505-cfn1,
worktree `gh1544-rw`) has no Supabase MCP / branch-creation credential
available — the dispatch's own environment facts state no
service-role key is present. Per the CTO's live re-verification above, the
enumeration this migration depends on has already been re-run directly
against production (not a branch) as of 2026-09-02T23:58Z and is current
as of this filing. No branch test was substituted for that.

## Deploy Notes

- **D-182 Tier**: 3A (additive index, D-261/R-097) — autonomous, no 24h
  notice window, per CTO ruling in issue comment 5518184628.
- **D-221 Deploy Path**: GitHub PR → merge → Supabase migration auto-run.
- **Application**: pending. This session cannot apply migrations to
  production directly (no service-role key) — authoring the file and
  opening the PR is this session's full scope per its dispatch. The
  orchestrator/next credentialed session must apply and then paste
  `select indexdef from pg_indexes where indexname='contractors_email_lower_uniq'`
  (or `\d+ contractors`) showing the index live with `indisvalid = true`,
  per the CTO's amended `closes-on: artifact` item 3.
- **Hard condition**: per the CTO ruling, this index must not land without
  the SQLSTATE `23505` handler on the `contractors` insert paths. That
  handler ships in the same PR (`contractor-pre-approval.html`) — see the
  PR diff. `contractor-join.html` was investigated and has no insert into
  `contractors` at all (it only calls `checkEmailExists()` and sends a
  magic-link OTP); the handler therefore applies only to
  `contractor-pre-approval.html`'s two insert sites (the `init()` create
  path and the `submitStep2()` stub-fallback create path).
- **Rollback pre-authorized**: Yes — run
  `20260903184350_gh1544_contractors_email_lower_uniq_rollback.sql` if the
  index is found `indisvalid = false` after a failed apply, or if the
  index needs to be removed for any other reason. Dropping the index does
  not remove the app-layer `check-email-exists` gate from PR #1557, which
  remains the primary (fail-open) guard.
- **Monitoring**: after apply, watch for any `23505` surfaced from a real
  contractor signup (should now render the "Application Already Exists"
  panel instead of a raw error) and confirm `indisvalid = true` on the new
  index.

## Danger Overrides

None.
