# Pre-Flight: gh1026_drop_admin_contractor_last_logins

**Migration**: gh1026_drop_admin_contractor_last_logins.sql
**Date**: 2026-08-21
**Author**: Code lane sub-agent (automated), run-work orchestration
**GitHub**: #1026
**Tier**: 3B — destructive DDL (`DROP VIEW`). Treated conservatively per this
session's standing rail even though the object is empty-by-definition,
already SELECT-revoked for `authenticated`, and has zero code consumers.
**Status**: DRAFT — no `apply_migration` call was made against
`yeszghaspzwwstvsrioa` to produce or verify this beyond read-only queries.

---

## Issue Premise Correction

The issue frames `admin_contractor_last_logins` as a **table** that a
trigger/cron/Edge Function should have been writing rows into and never did.
That premise is false. Live-verified this session:

```sql
SELECT table_schema, table_name FROM information_schema.tables
WHERE table_name = 'admin_contractor_last_logins';
-- {"table_schema":"public","table_name":"admin_contractor_last_logins"}

SELECT pg_get_viewdef('public.admin_contractor_last_logins'::regclass, true);
--  SELECT c.id AS contractor_id, u.last_sign_in_at
--    FROM contractors c
--    LEFT JOIN auth.users u ON c.user_id = u.id
--   WHERE ((SELECT auth.email() AS email)) = 'dustinstohler1@gmail.com'::text;
```

It is a **VIEW**, created by `sql/v41-admin-last-login-view.sql` (Session
191, 2026-05-18ish). Views compute live on every query — there is no
"writer" step for a trigger, cron job, or Edge Function to perform, and
there never was one to remove. `pg_trigger`, `pg_proc.prosrc`, and
`cron.job` were all queried live and confirmed empty of any reference to
this object.

## Why It Reads As "0 rows, all time"

The view's own WHERE clause gates every row on `auth.email() = 'dustinstohler1@gmail.com'`.
`auth.email()` resolves from the JWT claims of the actual PostgREST request
session. Any query issued outside a live, authenticated-as-admin browser
session — including the Bridge's reporting query, and every query run to
investigate this issue, including this session's own `execute_sql` calls —
has no such JWT context, so `auth.email()` evaluates to `NULL`, the WHERE
clause is never satisfied, and the view returns 0 rows unconditionally.
This is indistinguishable from "no contractor ever logged in" to anyone who
doesn't know the view's internals — which is exactly the failure mode #1026
describes, just one level removed from what the issue assumed.

## The Real Cause: Superseded, Not Broken

`admin-incomplete-profiles.html` (the view's only-ever consumer, confirmed
by full-repo grep) does not query the view. Its inline comment (lines
680–682) states outright:

> `get_contractor_last_logins()` is a SECURITY DEFINER RPC that replaces
> the revoked `admin_contractor_last_logins` view (Session 349 security
> fix, 86e11fa1g).

That RPC (defined in `supabase/migrations/20260101000000_v000_baseline_schema.sql`
lines 1952–1969) runs the identical `contractors LEFT JOIN auth.users` query,
gated by an explicit `RAISE EXCEPTION` instead of a silently-filtering WHERE
clause — a strictly safer pattern for exactly the reason #1026 objects to
(a denial that raises is legible; a denial that returns zero rows is not).
Live-verified this session: `information_schema.role_table_grants` for the
view shows `authenticated` no longer holds `SELECT` (only `service_role`
and `postgres` do) — the grant that made direct client access possible was
already revoked, corroborating the code comment even though no migration
file in `supabase/migrations/` documents that revoke explicitly (it appears
to have been done ad hoc or squashed into the baseline dump; the standalone
`v53_admin_last_logins_rpc` migration named in this dispatch's brief does
not exist as a file — only the baseline dump and the `sql/v41-*` pair exist).

**Cause, in the terms #1026 asked for**: closer to (a) than (b) — it *was*
wired (as a directly-queried view, not a table with a writer), and was
later replaced by a safer RPC as part of an unrelated security fix. It was
never dropped after being superseded, leaving a dead, ungoverned,
zero-consumer object that also happens to be permanently un-queryable by
its own original access path.

## Consumer Enumeration (fresh, not inherited)

Full-repo grep (case-insensitive) for `admin_contractor_last_logins` across
the entire working tree (excluding `node_modules`/`.git`), plus
`Claude's Memories/` at `C:\Users\Dustin Stohler\Downloads\Claude Downloads\Claude's Memories`:

| File | What it is |
|---|---|
| `supabase/migrations/20260101000000_v000_baseline_schema.sql` | Squashed baseline dump — contains the `CREATE OR REPLACE VIEW` (line 3265) and the `get_contractor_last_logins()` RPC (line 1952). No later migration in this directory touches either object. |
| `sql/v41-admin-last-login-view.sql` | Original forward migration that created the view. |
| `sql/v41-rollback-admin-last-login-view.sql` | Paired rollback (`DROP VIEW IF EXISTS`), already written, dated 2026-05-18. |
| `sql/v0-base-schema.sql` | Comment noting the view is intentionally excluded from that base-schema file (created later). |
| `sql/schema-snapshot.json` | Generated schema snapshot; lists the view's two columns. Confirms the view object still exists live as of today's snapshot run — consistent with this pre-flight's direct DB read. |
| `admin-incomplete-profiles.html` | The only application file that ever referenced it. Does **not** query it — calls `get_contractor_last_logins()` RPC instead, with an inline comment documenting the view as revoked. |

No hits in any Edge Function (`supabase/functions/`), no hits in any other
admin/React/JS/TS file, no hits in any `.md` doc anywhere in the repo, no
hits in `Claude's Memories/`. **Zero consumers need repointing** — the one
historical consumer already repointed itself before this issue was filed.

## Dependency Check

```sql
-- No other view/object depends on admin_contractor_last_logins:
SELECT dependent_view.relname FROM pg_depend
JOIN pg_rewrite ON pg_depend.objid = pg_rewrite.oid
JOIN pg_class dependent_view ON pg_rewrite.ev_class = dependent_view.oid
JOIN pg_class source_table ON pg_depend.refobjid = source_table.oid
WHERE source_table.relname = 'admin_contractor_last_logins'
  AND dependent_view.relname != 'admin_contractor_last_logins';
-- [] (empty)
```

No RLS on the view/base tables is bypassed by dropping it (`relrowsecurity = false`,
no `pg_policy` rows for this relation).

## Decision: DROP

`auth.users.last_sign_in_at` already works and is already the fallback in
production use (via the `get_contractor_last_logins()` RPC, which reads it
live with a safer access gate). No genuine reason found for the view to
exist that the RPC doesn't already cover — it has no historical-retention
property `auth.users` lacks (both read the same live column), and no
admin-specific need beyond what the RPC already serves to the one page that
needs it. Dropping is the honest outcome the issue itself anticipated.

## Row Count / Lock Impact

The view holds no rows of its own (views never do). `DROP VIEW` on an
object with no dependents is a catalog-only operation — no table rewrite,
no lock contention on `contractors` or `auth.users`, sub-millisecond.

## Danger Pattern Check

| # | Pattern | Triggered? |
|---|---------|-----------|
| 1 | NOT NULL column without DEFAULT | No |
| 2 | NOT NULL on table > 100K rows | No |
| 3 | DROP COLUMN | No |
| 4 | Type change requiring rewrite | No |
| 5 | Index without CONCURRENTLY | No |
| 6 | RENAME TABLE/COLUMN | No |
| 7 | TRUNCATE/DELETE all rows | No — view holds no rows |
| 8 | CASCADE DROP | No — plain `DROP VIEW IF EXISTS`, no CASCADE needed (zero dependents confirmed) |

All 8 clear. No overrides required.

## Documentation Note (Acceptance Criterion 3)

No dedicated "contractor-login reporting" doc exists anywhere in the repo
(grepped for one; none found). This pre-flight file plus the #1026 comment
serve as the durable record. Recommend the Bridge add a one-line note to
whatever surface tracks Site Activity Report internals (the report that
originally flagged this) pointing at `get_contractor_last_logins()` as the
only sanctioned source, so nobody recreates `admin_contractor_last_logins`
as a "fix."

## Deploy Notes

- **Deploy path once unblocked**: PR → CI green → merge (files-only, no
  deploy-on-merge for `supabase/migrations_drafts/`) → single manual
  `apply_migration` call against `yeszghaspzwwstvsrioa`, gated on the R-097
  window expiry + Dustin's D-182 Tier-3 approval.
- **R-097 notice**: posted on #1026 and cross-posted to #1206, timestamped
  via `stamp.py`: UTC 2026-08-21T22:59:43Z / 18:59 ET Fri Aug 21. 24h window
  expires 2026-08-22T22:59:43Z.
- **Rollback pre-authorized**: yes — `gh1026_drop_admin_contractor_last_logins_rollback.sql`.
  Recreates the view verbatim; lossless since the view held no data.
- **This session does not apply the migration under any circumstance.**
