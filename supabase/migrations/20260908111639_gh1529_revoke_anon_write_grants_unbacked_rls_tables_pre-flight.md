# Pre-flight — gh-1529 TABLE HALF (`20260908111639_gh1529_revoke_anon_write_grants_unbacked_rls_tables.sql`)

⛔ **NOT APPLIED.** `apply_migration` has not been called. Everything below is read-only SQL plus one
`DO $proof$ … RAISE EXCEPTION $proof$` block whose only exit is a forced full rollback.

## 1. Why this file exists at all

#1529's `closes-on` has **two** conjuncts. The function half (PR #1634, merged `2026-09-07T22:51:31Z`, still
unapplied) satisfies the first. **The second — "the grants join returns 0 RLS tables granting `anon` more than
SELECT without a matching anon policy" — had no migration anywhere.** CTO RUN 28 named that explicitly on the
issue: *"the table half, which is NOT in #1634 and must not be closed over … Closing this issue on the function
half alone is a two-conjunct criterion reduced to one — the exact move that killed the #1549 closure twice."*
This is that missing half.

## 2. Enumeration, live (project `yeszghaspzwwstvsrioa`, 2026-09-08)

```sql
with rls as (select c.oid,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
             where n.nspname='public' and c.relkind='r' and c.relrowsecurity),
cmds(cmd) as (values ('INSERT'),('UPDATE'),('DELETE')),
g as (select r.relname,cmds.cmd from rls r cross join cmds
      where has_table_privilege('anon',r.oid,cmds.cmd))
select g.relname, g.cmd from g
where not exists (select 1 from pg_policies p
                  where p.schemaname='public' and p.tablename=g.relname
                    and (p.roles && array['anon','public']::name[])
                    and (p.cmd=g.cmd or p.cmd='ALL'))
order by 1,2;
```

**51 rows across 21 distinct tables.** That is the revoke set, verbatim, and it is what the forward file contains.

## 3. ⚠ Three numbers in the issue body no longer hold — the disk wins, and it is stated rather than reconciled

| Issue body / thread says | Measured live 2026-09-08 | Direction |
|---|---|---|
| "44 RLS tables" | **45** | one table added since 2026-08-25 |
| "41 grant `anon` more than SELECT" | **42** tables grant `anon` at least one of INSERT/UPDATE/DELETE | +1, consistent with the above |
| "26 of 44 RLS tables grant `anon` INSERT/UPDATE/DELETE with no anon/public policy of that command" (comment `5526298002`) | **21** | see below |

The 26 → 21 gap is **not** drift; it is a difference in how a `{public}`-role policy is counted, and the
difference is worth being explicit about because it is the same trap that produced the `contractor_can_bid`
reclassification on the function half:

* counting only policies whose `roles` literally contains `anon` → **36 tables** unbacked
* counting policies whose `roles` contains `anon` **or** `public` → **21 tables** unbacked

A policy written without a `TO` clause has `roles = {public}` and **is evaluated for `anon`.** So the 21 is the
correct and conservative number and the 36 is the one that would over-revoke. This file uses 21.

## 4. Why a revoke here cannot break a live path — structural, not a grep

With RLS enabled on the table and **no permissive policy of that command naming `anon` or `public`**, PostgreSQL
denies every `anon` write of that command **regardless of the table grant**. The grant is already inert. This is
the table-half analogue of the function half's `prorettype = trigger` argument: a property of the engine, not of
grep coverage — and the refuter on #1634 preferred exactly that class of argument over the empirical one.

Column-level ACLs could defeat a table-level revoke. There are none:

```sql
select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid
  join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and a.attacl is not null;   ->  0
```

## 5. The proof, run against production inside a forced rollback

One `DO $proof$ … $proof$` block: capture counters → **negative control** → **positive control** → forward SQL →
counters → positive control again → negative control again → rollback SQL → counters → `RAISE EXCEPTION`.
Production's own reply, verbatim:

```
ERROR:  P0001: GH1529-TABLEHALF-PROOF (deliberate abort => full ROLLBACK):
pairs before=51 after-FORWARD=0 after-ROLLBACK=51 |
anon SELECT on the 21 before=21 after=21 |
authenticated same-pairs before=51 after=51 |
anon INSERT feature_requests (no policy) pre=42501 post=42501 |
anon INSERT leads (policy exists, NOT revoked) pre=SUCCESS post=SUCCESS
```

Four controls in one string:

1. **Exactness both ways** — forward removes exactly 51, rollback restores exactly 51.
2. **No collateral** — `anon`'s SELECT (21/21) and `authenticated`'s same-51 pairs are unchanged in both directions.
   A revoke that also stripped `authenticated` passes a bare "anon is now false" check and breaks signed-in users.
3. **Negative control** — `anon` INSERT on `feature_requests` (a revoked table) was **already refused `42501`
   before the revoke** and is still `42501` after. That is the safety argument measured rather than asserted.
4. **Positive control** — `anon` INSERT on `leads`, a genuine pre-authentication path whose INSERT is policy-backed
   and therefore **NOT** in the revoke set, **SUCCEEDS both before and after.** A file that over-reached would show
   an SQLSTATE here instead of `SUCCESS`. Two refusals alone prove a wall; the refusal beside the success proves a
   revoke that discriminates.

## 6. Production re-read outside the transaction — unchanged

```
target_pairs_still_granted = 51
target_tables              = 21
proof rows persisted in feature_requests = 0
proof rows persisted in leads            = 0
read_at 2026-09-08 11:16:23.867751+00
```

## 7. Post-apply acceptance test that can FAIL

After a real apply, in one read:

* the enumeration in §2 returns **0 rows** (the issue's second `closes-on` conjunct);
* `anon`'s SELECT count over those 21 tables is still **21**, and `authenticated`'s 51 pairs are still **51**;
* an **unauthenticated `leads` INSERT still succeeds** — the pre-auth path that must survive.

It fails if the revoke over-reached (the `leads` insert refuses, or `authenticated` moved) or under-reached (the
enumeration still returns rows).

## 8. Out of scope, stated

The 36 `authenticated_security_definer_function_executable` advisor rows; `extension_in_public` (pg_net); the
`storage.objects` policy cross-filed from #1412. None are touched here.
