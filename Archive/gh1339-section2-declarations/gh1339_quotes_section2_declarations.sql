-- gh-1339: quotes.section2_declarations — the per-row INCLUDED / EXTRA
-- declarations a contractor must make on a `basic`-shape claim.
--
-- ⛔ DRAFT. Not applied. Lives in migrations_drafts/ per this directory's
-- contract: supabase/migrations/ holds only SQL already approved AND applied
-- in production, because the CLI replays that directory forward onto every
-- fresh branch. Promote this file (renamed to a 14-digit UTC timestamp
-- prefix) only after it is actually applied.
--
-- WHY. #1339 scope item 1, Dustin's ruling verbatim (2026-08-28):
--   "Contractors should be required to identify whether things are included
--    or excluded. Bids don't go out without it. That's how we end up in
--    court."
-- and item 2:
--   "I'd like the homeowner to see things broken out into two sections -
--    included and extra expenses. I don't want extra costs hiding in a list."
--
-- Item 2 is GENERATED FROM item 1's declarations, so item 2 cannot be built
-- until this column exists. Measured 2026-09-07 against the live schema:
--
--   select column_name, data_type from information_schema.columns
--    where table_schema='public' and table_name='quotes'
--      and (column_name ilike '%declar%' or column_name ilike '%section%'
--           or column_name ilike '%included%' or column_name ilike '%extra%'
--           or column_name ilike '%scope%');
--   -> exactly one row: scope_summary | text
--
-- There is no declarations column of any spelling. This is the critical path
-- for #1339 items 1 and 2, and nothing in either moves until it lands.
--
-- TIER 3A — additive, nullable, no default backfill, no existing column
-- touched, no data rewritten. Every current row keeps NULL, which the shape
-- constraint below explicitly permits and which reads as "this bid predates
-- the declarations requirement" rather than "this bid declared nothing".
-- That distinction is deliberate: an empty object would be a bid asserting it
-- has no rows to declare, and we must not fabricate that assertion for the
-- 12 quotes already on file.
--
-- SHAPE. A JSONB object keyed by catalog row key, each value an object:
--
--   {
--     "ridge_cap":      { "status": "included" },
--     "drip_edge":      { "status": "extra", "rate_cents": 42500,
--                         "trigger": "per linear foot if replacement needed" },
--     "chimney_flash":  { "status": "not_offered" }
--   }
--
-- The three statuses are D-272's existing three-state model, unchanged:
--   included     -- covered by the Section 1 price the homeowner sees
--   extra        -- billable if triggered; REQUIRES a rate (#1339: "EXTRA rows
--                   require a rate (Section 3 unit price)")
--   not_offered  -- struck from the homeowner view entirely
--
-- The rate-required rule for `extra` is enforced HERE as well as in the bid
-- form, on purpose. A required field enforced only in the browser is a
-- required field until someone posts to PostgREST directly, and this is the
-- data a legal argument would later be built on.

begin;

-- The validator is a function because Postgres forbids subqueries inside a
-- CHECK constraint, and validating "every value in this object" needs one.
-- IMMUTABLE is honest here: the result depends only on the argument.
create or replace function public.quotes_section2_declarations_valid(d jsonb)
returns boolean
language sql
immutable
as $$
  select
    d is null
    or (
      jsonb_typeof(d) = 'object'
      and not exists (
        select 1
        from jsonb_each(d) as e(key, value)
        where
          -- every entry must be an object carrying a known status
          jsonb_typeof(e.value) <> 'object'
          or not (e.value ? 'status')
          or (e.value ->> 'status') not in ('included', 'extra', 'not_offered')
          -- an EXTRA row without a rate is the hiding-in-a-list case
          or (
            (e.value ->> 'status') = 'extra'
            and (
              not (e.value ? 'rate_cents')
              or jsonb_typeof(e.value -> 'rate_cents') <> 'number'
              or (e.value ->> 'rate_cents')::numeric < 0
            )
          )
      )
    );
$$;

comment on function public.quotes_section2_declarations_valid(jsonb) is
  'gh-1339: shape validator for quotes.section2_declarations. Object keyed by '
  'catalog row key; each value {status: included|extra|not_offered} and, for '
  'status=extra, a non-negative numeric rate_cents. NULL is valid and means '
  'the bid predates the declarations requirement.';

alter table public.quotes
  add column if not exists section2_declarations jsonb;

comment on column public.quotes.section2_declarations is
  'gh-1339 item 1 (D-272 three-state model): per-catalog-row INCLUDED / EXTRA '
  '/ NOT OFFERED declarations required on a basic-shape claim. Source of the '
  'homeowner two-list view (item 2), which is generated from this and is never '
  'contractor-editable. NULL = bid predates the requirement.';

alter table public.quotes
  drop constraint if exists quotes_section2_declarations_shape;

alter table public.quotes
  add constraint quotes_section2_declarations_shape
  check (public.quotes_section2_declarations_valid(section2_declarations));

-- Partial index: only bids that actually carry declarations. The homeowner
-- view and the admin review both filter on presence, and 12 of 12 existing
-- rows are NULL, so a full index would be almost entirely dead entries.
create index if not exists quotes_section2_declarations_gin
  on public.quotes using gin (section2_declarations)
  where section2_declarations is not null;

commit;
