# Pre-flight — gh-1253 `service_states` backfill

**Version:** `20260830170958`
**Issue:** [#1253](https://github.com/StellarEdgeServices/otterquote-platform/issues/1253)
**Tier:** 3A (additive data repair on a nullable column, fully reversible)
**Authority:** CTO ruling `cto-2026-08-30T14:10:10Z` on #1253 — SQL prescribed verbatim there.
**Author:** run-work code lane, thread `rw-f22-20260830T170846-a9da`

---

## ⚠️ Read this before merging

Unlike the gh-945 / gh-1028 / gh-1302 migrations in this directory, **this one has NOT
been applied yet.** Those were applied via `apply_migration` first and committed
afterwards as a historical trace, so merging them was a no-op. **This file is a pending
change: merging the PR applies it** through the D-221 Path A auto-run.

The authoring session ran in a remote Linux container whose write classifier blocked the
direct `apply_migration` call. Rather than work around that denial, the change was routed
through the reviewed deploy chain, which is the stricter path — a human merges it.

## What it does

```sql
UPDATE contractors
   SET service_states = string_to_array(replace(service_area_description, ' ', ''), ','),
       updated_at     = now()
 WHERE service_states IS NULL
   AND service_counties IS NULL
   AND service_area_description ~ '^[A-Z]{2}(,\s*[A-Z]{2})*$';
```

## Blast radius — enumerated live 2026-08-30T17:09Z

Production `yeszghaspzwwstvsrioa`, `select … from contractors order by created_at`:

| measure | value |
|---|---|
| contractor rows total | 13 |
| `is_test = true` | 13 (**all**) |
| `auto_bid_enabled = true` | 0 |
| rows matching this predicate | **1** |

The single matching row:

| id | company | before | after |
|---|---|---|---|
| `986ce2b6-39fd-4a2c-aba4-a806c618c8c0` | PFW Roofing 1787836001 | `service_states = NULL`, `service_counties = NULL`, `service_area_description = 'IN'` | `service_states = {IN}` |

No real (non-test) contractor rows exist, and no row has auto-bid enabled, so the live
behavioral change at merge time is nil. The value of the migration is that it removes a
row that would have matched every state the moment auto-bid was switched on.

## Danger-pattern check (8/8)

| # | Pattern | Result |
|---|---|---|
| 1 | `DROP` / destructive DDL | none — `UPDATE` only |
| 2 | `ALTER` on an existing column/type | none |
| 3 | RLS policy change | none |
| 4 | Unbounded `UPDATE`/`DELETE` (no `WHERE`) | ✅ three-clause `WHERE`, verified to match 1 row |
| 5 | Non-idempotent / unsafe on replay | ✅ idempotent — predicate self-excludes once populated |
| 6 | Locking risk on a large table | ✅ 13-row table, single-row update |
| 7 | Irreversible data loss | ✅ reversible — rollback half provided and predicate-scoped |
| 8 | External side effects (Stripe / email / SMS / webhook) | none |

## Rollback

`20260830170958_gh1253_backfill_service_states_from_description_rollback.sql` — reverts
`service_states` to `NULL` only for rows whose current value is byte-identical to the
value derived from that row's own `service_area_description`, so a service area set by a
human or by the UI after the forward run is never clobbered.

## Not covered — surfaced, not decided here

Two further rows reach the same `inServiceArea → true` (match-every-state) branch and
**this predicate cannot repair either**, because neither has a recoverable service area:

- `ee452a12-c16e-4d30-9d2c-df8128fbce52` — `service_states NULL`, `service_counties = '{}'`, description `NULL`
- `f3350ae0-2fa1-4ae6-9751-79a0790f07f3` — all three `NULL`, blank company name (abandoned stub)

Note `ee452a12` is not even reached by the CTO's `service_counties IS NULL` clause: an
**empty array is not NULL** in SQL, but it *is* falsy to the Edge Function's
`.length > 0` check, so it lands in the include-everything branch regardless. The CTO
ruling's "3 rows are in that condition today" is correct about the EF behavior; the
prescribed predicate repairs 1 of those 3.

The durable fix for the remaining shape is the `inServiceArea` fallback itself
(`process-auto-bids/index.ts:156-163`), where both-null currently **includes** rather
than excludes. That is a matching-semantics change on a money-path function, so it is
reported to the CTO on the issue thread rather than taken by this lane.
