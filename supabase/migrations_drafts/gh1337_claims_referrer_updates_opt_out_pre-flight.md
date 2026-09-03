# Pre-flight — gh-1337 `claims.referrer_updates_opt_out`

**Tier:** 3A (additive, autonomous per D-261).
**Status:** **DRAFTED, NOT APPLIED.** Nothing in this PR has touched production
(`yeszghaspzwwstvsrioa`) or any Supabase branch. Requires Dustin's read (R-120)
alongside the rest of the PR, because it is the storage for a consent record.

## Exact object

| | |
|---|---|
| Table | `public.claims` |
| Column | `referrer_updates_opt_out` |
| Type | `BOOLEAN` |
| Nullable | yes |
| Default | none |
| Index | none |
| Constraint | none |

## Danger-pattern check

| Pattern | Present? |
|---|---|
| Data loss / destructive DDL | No — forward is purely additive. The **rollback** is destructive; that is called out in its header with an export query. |
| Table rewrite | No — nullable `ADD COLUMN` with no default is catalog-only on PG 11+. |
| Long lock | No — brief `ACCESS EXCLUSIVE` on `public.claims` only. |
| Backfill | None, deliberately. Existing rows stay `NULL` = "never asked" = do not send. Backfilling `FALSE` would manufacture consent nobody gave. |
| RLS / grant change | None needed. `public.claims` grants are table-level and uniform across all 107 existing columns for `anon`, `authenticated`, `service_role`, `postgres` (verified live 2026-08-28), so the new column inherits them. |
| Constraint added to existing data | No. |
| Trigger / function body change | No. |
| Irreversible | No — rollback drops the column; see its data-loss warning. |

## Why a column and not `referrals.metadata`

`send-partner-status-email/index.ts` read-modify-writes the whole
`referrals.metadata` object in JS. Its own header documents the consequence: a
concurrent write to an unrelated metadata key from another process "could be
lost." A consent record must not sit in a column with a documented lossy merge.
`claims` is also the homeowner's own row and is already loaded by the function.

The approved copy doc's §5.2 suggested `referrals.metadata`; its author
explicitly flagged that as "an engineering decision, not a copy one," and issue
#1337 authorises either ("additive nullable column or existing JSONB"). The gate
reads `referrals.metadata.referrer_updates_opt_out` as a **fallback** regardless,
so this choice does not foreclose the JSONB path if Dustin prefers it.

## Ordering

The Edge Function gate is safe in **either** order — it tolerates the column not
existing and fails closed. Suggested order anyway:

1. Apply forward.sql.
2. Land the intake checkbox (blocked here — see PR body) so `FALSE` starts being written.
3. Deploy the Edge Function gate.

Applying (1) alone changes no behaviour. Deploying (3) alone stops all
third-party claim-progress email until (1) and (2) land — which, at today's
blast radius, means stopping a stream with **zero real third-party recipients**.

## Verification after apply

```sql
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema='public' AND table_name='claims'
   AND column_name='referrer_updates_opt_out';
-- expect: boolean | YES | (null)

SELECT count(*) FILTER (WHERE referrer_updates_opt_out IS NULL)  AS never_asked,
       count(*) FILTER (WHERE referrer_updates_opt_out IS FALSE) AS consented,
       count(*) FILTER (WHERE referrer_updates_opt_out IS TRUE)  AS opted_out
  FROM public.claims;
-- expect immediately after apply: all rows in never_asked
```
