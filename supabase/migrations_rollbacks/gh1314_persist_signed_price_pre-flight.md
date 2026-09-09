# Pre-flight — gh-1314 step 4: persist the signed-price verdict on `claims`

Forward: `supabase/migrations_drafts/gh1314_persist_signed_price.sql`
Rollback: `supabase/migrations_rollbacks/gh1314_persist_signed_price_rollback.sql`
Writer half: `supabase/functions/docusign-webhook/index.ts` → `persistSignedPriceVerdict()`

## Tier

**3A.** Additive, nullable, no backfill, no default, no index, no RLS change, no
policy change, no trigger. `ADD COLUMN` without a `DEFAULT` is catalogue-only in
PostgreSQL 11+, so there is no table rewrite and no lock held for the length of
a scan. Requires the `migration-author` gate and Dustin's approval before it is
applied; **this branch applies nothing.**

## Blast radius

`public.claims` — 16 rows at the last count on this thread (2026-09-04), 2 of
them with `contract_signed_at` set, both `is_test = true`. Every existing row
stays NULL on all five columns, which reads as *the reconciliation never
recorded a verdict for this claim* — as distinct from a recorded
`unverified/field_absent`, which is a measurement. The migration deliberately
does not backfill, because a backfill would fabricate verdicts that were never
computed.

## The eight danger patterns

| pattern | present? |
|---|---|
| destructive DDL (DROP/TRUNCATE) | no (forward); the rollback drops the five columns it added, and nothing else |
| column type change on populated data | no |
| NOT NULL added to an existing column | no |
| DEFAULT that forces a rewrite | no |
| unique/primary-key addition | no |
| index build without CONCURRENTLY | no — no index at all |
| RLS / policy / grant change | no |
| trigger or function replacement | no |

## Ordering

1. Apply the forward migration.
2. Deploy `docusign-webhook` (Tier 3B — a separate R-097 window; **not** carried
   by this PR).

Reversed, nothing breaks: `persistSignedPriceVerdict()` logs a PostgREST
"column does not exist" error per completion and returns. The price gate itself
still halts, the fee is still not charged. The degradation is loud and inert.

## Verification after apply

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='claims'
  and column_name like 'signed_price%' or column_name = 'signed_contract_price';

-- the query this whole change exists to make writable:
select signed_price_verdict, signed_price_reason, count(*)
from public.claims where contract_signed_at is not null
group by 1,2 order by 1,2;
```

Negative control for the CHECK, read-only, no DDL:

```sql
select 'reconciliation_error' in ('no_expected','field_absent','unparseable',
                                  'properties_unreadable','reconciliation_error') as accepted,
       'flag' in ('no_expected','field_absent','unparseable',
                  'properties_unreadable','reconciliation_error') as rejected_control;
-- expect: accepted = true, rejected_control = false
```
