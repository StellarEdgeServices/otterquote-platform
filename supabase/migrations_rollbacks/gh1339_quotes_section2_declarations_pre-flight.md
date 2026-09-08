# Pre-flight — gh-1339 `quotes.section2_declarations`

Drafted by CTO subagent under CEO claim `ceo-2026-09-07T20:08:08Z`, stamp
`2026-09-07T20:27:55Z` (`stamp.py`, pasted). **Not applied.**

## What it does

Adds one nullable JSONB column to `public.quotes`, an IMMUTABLE shape
validator function, a CHECK using it, and a partial GIN index over rows where
the column is not null.

## Tier

**3A** — additive, nullable, no default, no backfill, no existing column
altered, no data rewritten. Every existing row keeps `NULL`.

## Why it is needed

#1339 scope item 1 (required INCLUDED / EXTRA declarations) and item 2 (the
homeowner two-list view) are blocked on it. Item 2 is *generated from* item 1's
declarations, so neither moves until the column exists. Measured against the
live schema 2026-09-07:

```sql
select column_name, data_type from information_schema.columns
 where table_schema='public' and table_name='quotes'
   and (column_name ilike '%declar%' or column_name ilike '%section%'
        or column_name ilike '%included%' or column_name ilike '%extra%'
        or column_name ilike '%scope%');
-- exactly one row:  scope_summary | text
```

No declarations column of any spelling exists.

## Blast radius, measured

```sql
select count(*) as quotes_total,
       count(*) filter (where is_test)     as test_rows,
       count(*) filter (where not is_test) as real_rows,
       pg_size_pretty(pg_total_relation_size('public.quotes')) as tbl_size
  from public.quotes;
-- quotes_total 7 | test_rows 6 | real_rows 1 | 520 kB
```

Seven rows, one of them real. `ADD COLUMN` with no default is a catalogue-only
operation in Postgres 11+ (no table rewrite); at 7 rows and 520 kB the lock is
momentary regardless. The GIN index is built over the zero rows that currently
satisfy its `WHERE`.

## The eight danger patterns

| # | pattern | present? |
|---|---|---|
| 1 | table rewrite / long ACCESS EXCLUSIVE | no — `ADD COLUMN` without default, 7 rows |
| 2 | data destruction (DROP / TRUNCATE / type narrowing) | no — purely additive |
| 3 | backfill of existing rows | no — every row stays `NULL` deliberately |
| 4 | constraint applied to existing data that could fail | no — `NULL` is explicitly valid; validator returns true for `NULL` |
| 5 | index build blocking writes | index is partial over 0 qualifying rows; use `CONCURRENTLY` if that ever changes |
| 6 | RLS / grant change | none — column inherits the table's existing policies |
| 7 | function/trigger with side effects | validator is `IMMUTABLE`, pure, no I/O; no trigger added |
| 8 | irreversible | no — rollback script drops index, constraint, column, function in dependency order |

## Proof the CHECK predicate behaves

Run **read-only** against production as an inlined `SELECT` (no DDL, no write,
no transaction left open) — 12 cases, 7 of them negative controls:

```
NULL (pre-requirement bid)        expected true   actual true    PASS
all included                      expected true   actual true    PASS
extra with rate                   expected true   actual true    PASS
not_offered                       expected true   actual true    PASS
mixed valid                       expected true   actual true    PASS
NEG: extra with NO rate           expected false  actual false   PASS
NEG: extra rate not numeric       expected false  actual false   PASS
NEG: extra rate negative          expected false  actual false   PASS
NEG: unknown status               expected false  actual false   PASS
NEG: missing status               expected false  actual false   PASS
NEG: value not an object          expected false  actual false   PASS
NEG: top level is an array        expected false  actual false   PASS
```

The negative cases matter more than the positive ones here: `extra` without a
rate is exactly Dustin's *"I don't want extra costs hiding in a list"*, and the
constraint rejects it at the database rather than only in the bid form. A
required field enforced only in the browser stops being required the moment
someone posts to PostgREST directly.

## `NULL` vs `{}` — a deliberate choice

`NULL` means *this bid predates the declarations requirement*. `{}` would mean
*this bid asserts it has no rows to declare*. The 7 quotes already on file made
no such assertion, so they get `NULL` and the application must treat the two as
distinct. Backfilling `{}` would fabricate an assertion on a legal document.

## Apply / verify / roll back

```sql
-- apply
\i supabase/migrations_drafts/gh1339_quotes_section2_declarations.sql

-- verify
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema='public' and table_name='quotes'
   and column_name='section2_declarations';
select conname from pg_constraint where conname='quotes_section2_declarations_shape';
select count(*) from public.quotes where section2_declarations is not null;  -- expect 0

-- roll back
\i supabase/migrations_rollbacks/gh1339_quotes_section2_declarations_rollback.sql
```

## After it is applied

Rename the forward file into `supabase/migrations/` with a real 14-digit UTC
timestamp prefix, per that directory's contract (it holds only SQL already
applied in production). Leave this pre-flight and the rollback where they are —
`migrations_rollbacks/` is never CLI-parseable by design.
