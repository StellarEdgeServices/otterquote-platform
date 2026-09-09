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

## 2. Enumeration, live (project `yeszghaspzwwstvsrioa`)

⚠ **CORRECTED 2026-09-09.** The query below is the corrected form — `and p.permissive='PERMISSIVE'` added to the
`pg_policies` join. The original file (2026-09-08) omitted that filter; see §3 for why that under-counted.

```sql
with rls as (select c.oid,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
             where n.nspname='public' and c.relkind='r' and c.relrowsecurity),
cmds(cmd) as (values ('INSERT'),('UPDATE'),('DELETE')),
g as (select r.relname,cmds.cmd from rls r cross join cmds
      where has_table_privilege('anon',r.oid,cmds.cmd))
select g.relname, g.cmd from g
where not exists (select 1 from pg_policies p
                  where p.schemaname='public' and p.tablename=g.relname
                    and p.permissive='PERMISSIVE'
                    and (p.roles && array['anon','public']::name[])
                    and (p.cmd=g.cmd or p.cmd='ALL'))
order by 1,2;
```

**69 rows across 27 distinct tables**, re-derived live 2026-09-09. That is the revoke set, verbatim, and it is
what the forward file now contains. None of the 27 tables carries any PERMISSIVE `anon`/`public` policy for the
revoked command — the join above proves it by construction, and was re-checked by re-running it against
production immediately before this correction. The three pre-auth INSERT paths that must and do survive —
`leads`, `coming_soon_waitlist`, `members` — appear in the 69 rows only for DELETE/UPDATE, never INSERT.

## 3. ⚠ Correction 2026-09-09 — the PERMISSIVE filter, and why omitting it under-counted

The original §2 query (2026-09-08) joined `pg_policies` without `p.permissive='PERMISSIVE'`. `pg_policies.cmd`
and `.roles` describe a policy regardless of whether it is PERMISSIVE or RESTRICTIVE, and a RESTRICTIVE policy's
`roles` can legitimately include `anon` (it is still evaluated for `anon`, just as an AND-ed narrowing condition,
never as a grant of access on its own). The unfiltered join therefore counted six RESTRICTIVE deny-all policies as
if they *backed* the grant they in fact only ever narrow:

| Table | Policy | `polpermissive` | `USING` |
|---|---|---|---|
| `admin_dispute_queue` | `service_role_only_admin_dispute_queue` | false | `false` |
| `disputes` | `service_role_only_disputes` | false | `false` |
| `hover_tokens` | `hover_tokens_deny_all` | false | `false` |
| `imported_hover_jobs` | `imported_hover_jobs_deny_all` | false | `false` |
| `stripe_webhook_events` | `stripe_webhook_events_deny_all` | false | `false` |
| `support_tickets` | `support_tickets_deny_all` | false | `false` |

All six carry `roles={authenticated,anon}` and `USING false` — a RESTRICTIVE policy that can never grant, only
subtract. With no PERMISSIVE policy on any of these six for INSERT/UPDATE/DELETE naming `anon` or `public`, all 18
of their pairs (3 commands × 6 tables) belong in the revoke set and were missing from the original 51/21 file.

```
original (unfiltered) query   -> 51 pairs / 21 tables
corrected (+PERMISSIVE) query -> 69 pairs / 27 tables   (delta: +18 pairs / +6 tables, exactly these 6)
```

Found by a fresh-context reviewer (PR #1864 comment `5595019811`, subagent of `ceo-2026-09-09T00:51:11Z`);
corrected same-day.

## 4. ⚠ Three numbers in the issue body no longer hold as of 2026-09-08 — the disk wins, and it is stated rather than reconciled

| Issue body / thread says | Measured live 2026-09-08 | Direction |
|---|---|---|
| "44 RLS tables" | **45** | one table added since 2026-08-25 |
| "41 grant `anon` more than SELECT" | **42** tables grant `anon` at least one of INSERT/UPDATE/DELETE | +1, consistent with the above |
| "26 of 44 RLS tables grant `anon` INSERT/UPDATE/DELETE with no anon/public policy of that command" (comment `5526298002`) | **27** (was measured as 21 before the §3 PERMISSIVE-filter correction) | see §3 |

The 26 → 21 → 27 history is **not** drift; it is two independent counting questions, both worth being explicit
about because the second is the same trap that produced the `contractor_can_bid` reclassification on the function
half, and the first is this correction:

* counting only policies whose `roles` literally contains `anon` → **36 tables** unbacked (over-revokes: misses
  `{public}`-role PERMISSIVE policies that do back a grant)
* counting policies whose `roles` contains `anon` **or** `public`, **without** filtering to PERMISSIVE → **21
  tables** unbacked (under-revokes: counts RESTRICTIVE deny-all policies as backing — §3)
* counting policies whose `roles` contains `anon` **or** `public`, filtered to PERMISSIVE only → **27 tables**
  unbacked — **this is the number this file uses.**

## 5. Why a revoke here cannot break a live path — structural, not a grep

With RLS enabled on the table and **no PERMISSIVE policy of that command naming `anon` or `public`**, PostgreSQL
denies every `anon` write of that command **regardless of the table grant**. The grant is already inert. This is
the table-half analogue of the function half's `prorettype = trigger` argument: a property of the engine, not of
grep coverage — and the refuter on #1634 preferred exactly that class of argument over the empirical one. A
RESTRICTIVE policy only ever narrows what a PERMISSIVE policy already allows — it cannot itself authorize a write,
so it can never be the thing that "backs" a grant, which is exactly what §3's correction encodes.

Column-level ACLs could defeat a table-level revoke. There are none:

```sql
select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid
  join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and a.attacl is not null;   ->  0
```

## 6. The proof, run against production inside a forced rollback (original 51/21 set)

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

⚠ **This transcript covers only the original 51/21 set and predates the §3 correction.** It is retained as
evidence for those 51 pairs. It is **not** evidence for the 18 pairs added across the 6 RESTRICTIVE-deny-all
tables — Supabase MCP access for the 2026-09-09 fix was read-only, so the forced-rollback proof for the full
69-pair / 27-table set has **not yet been re-run**. It must be re-run by a claim-holder before `apply_migration`
is called on the forward file. §7's negative control (below) is the interim, read-only check that the corrected
set is right on paper.

## 7. Production re-read outside the transaction — unchanged (original 51/21 set)

```
target_pairs_still_granted = 51
target_tables              = 21
proof rows persisted in feature_requests = 0
proof rows persisted in leads            = 0
read_at 2026-09-08 11:16:23.867751+00
```

## 8. Post-apply acceptance test that can FAIL

After a real apply, in one read:

* the §2 enumeration returns **0 rows** (the issue's second `closes-on` conjunct) — **run with the PERMISSIVE
  filter.** Re-running §2's *original*, unfiltered form is not a valid acceptance test: it would read 0 rows both
  before this correction and after, which is exactly how the original 18-pair under-revoke passed review the
  first time. The filtered query is the only form of this check that can fail.
* `anon`'s SELECT count over those 27 tables is still **27**, and `authenticated`'s 69 pairs are still **69**
  (both counts, not the original 21/51 — using the pre-correction numbers here would silently accept the
  under-revoked state as "no drift").
* an **unauthenticated `leads` INSERT still succeeds** — the pre-auth path that must survive. Same check on
  `coming_soon_waitlist` INSERT and `members` INSERT (both PERMISSIVE-backed, both excluded from the revoke set).
* **RESTRICTIVE-policy negative control (added 2026-09-09 — this is what would have caught the 18-pair
  under-revoke):** for each of `admin_dispute_queue`, `disputes`, `hover_tokens`, `imported_hover_jobs`,
  `stripe_webhook_events`, `support_tickets`, assert `has_table_privilege('anon', <table>, 'INSERT')` (and
  `UPDATE`, `DELETE`) is **false** post-apply. A fixture or CI assertion that checks the *unfiltered* §2 query
  returns 0 rows will pass even when these six tables still hold live `anon` grants, because the unfiltered query
  never lists them as violations in the first place — it must check `has_table_privilege` on these six named
  tables directly, not re-run the same join that missed them.

It fails if the revoke over-reached (`leads`/`coming_soon_waitlist`/`members` INSERT refuses, or `authenticated`
moved) or under-reached (the filtered enumeration still returns rows, or any of the six named RESTRICTIVE-backed
tables still shows `anon` holding INSERT/UPDATE/DELETE).

## 9. Out of scope, stated

The 36 `authenticated_security_definer_function_executable` advisor rows; `extension_in_public` (pg_net); the
`storage.objects` policy cross-filed from #1412. None are touched here.
