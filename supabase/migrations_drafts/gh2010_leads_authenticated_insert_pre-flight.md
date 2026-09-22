# Pre-flight — gh2010_leads_authenticated_insert

**Issue:** #2010 — `/start` Step 1 fails for any signed-in visitor.
**Tier:** 3b (D-182/D-261). 24h notice window WAIVED — Dustin, verbatim, in
chat 2026-09-17: *"Go on 2010."* (issue comment 5720578332). Authorized
narrowly by Ben, CEO RUN 50, claim `ceo-2026-09-17T20:25:00Z` (issue comment
5720783144).

## What changes

One `ALTER POLICY` statement on `public.leads`:

```sql
ALTER POLICY "Allow anonymous inserts" ON public.leads
  TO anon, authenticated;
```

Widens the existing permissive INSERT policy's role list from `{anon}` to
`{anon, authenticated}`. `WITH CHECK (true)` is untouched — it already
permits any row for `anon`; this migration only adds `authenticated` to the
same policy, under the same check.

No other DDL. No other table, policy, grant, trigger, or function is
touched.

## Why this is safe

- **Net exposure is ~zero.** `public.leads` is already INSERT-open to
  anyone unauthenticated (`WITH CHECK true`, no per-row ownership check
  possible on an anonymous insert by design). Letting a signed-in session
  do the exact same insert does not open a new capability — it removes an
  arbitrary distinction between "has an account" and "doesn't."
- **No read exposure changes.** `leads_admin_select` (the only SELECT
  policy on this table) is untouched, still scoped to `is_admin_email()`.
  A signed-in non-admin visitor still cannot read any row in `leads`,
  their own included — this migration is INSERT-only.
- **No cross-tenant risk.** `leads` holds no foreign key to any other
  tenant-scoped table this migration reads or writes, and rows are
  identified by a client-generated UUID the visitor already controls the
  entire content of.
- **Confirmed against the live table before drafting this migration** —
  `pg_policy` for `public.leads` (2026-09-17, this run):
  ```
  {Allow anonymous inserts, cmd=a, permissive=true, roles={anon},          with_check=true}
  {leads_admin_select,      cmd=r, permissive=true, roles={authenticated}, using=is_admin_email()}
  ```
  Exactly matches issue #2010's own repro. No drift between the issue's
  claim and the database's actual state.

## Rollback

`supabase/migrations_drafts/gh2010_leads_authenticated_insert_rollback.sql`
— a single `ALTER POLICY ... TO anon` restoring the pre-migration role
list. Verified to be the exact inverse: same policy name, same `WITH
CHECK`, only the role list reverts. Running it re-introduces the 42501
this migration fixes for signed-in visitors — intentional, since that is
the entire effect being rolled back.

## Verification (run after apply)

```sql
select polname, polcmd, polpermissive,
       polroles::regrole[]::text[] as roles,
       pg_get_expr(polwithcheck, polrelid) as with_check
from pg_policy where polrelid = 'public.leads'::regclass;
```

Expect:
```
{Allow anonymous inserts, cmd=a, permissive=true, roles={anon,authenticated}, with_check=true}
{leads_admin_select,      cmd=r, permissive=true, roles={authenticated},     with_check=NULL}
```

Then the negative-control pair required by Ben's closing criteria (issue
comment 5720783144): a signed-in submit on `/start` returning 201 with a
row observed in `public.leads` and Step 2 rendered, pasted beside the
403/42501 it replaces.
