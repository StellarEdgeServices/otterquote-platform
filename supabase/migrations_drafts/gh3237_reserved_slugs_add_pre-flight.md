<!--
STATUS (gh-1438, as of 2026-10-30T17:30:00Z): NOT APPLIED
FILE ROLE: pre-flight file of set gh3237_reserved_slugs_add (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-10-30 under #3239 / #3237; production read-only queries the same day (project yeszghaspzwwstvsrioa). No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3237_reserved_slugs_add

Data only: two rows appended to `public.reserved_slugs` (`partner-agreement-v3`, `ref-bind`). Tier 3A (additive). Apply before or with
the #3242 Netlify publish, so no partner can claim `otterquote.com/partner-agreement-v3` before the archived page is served.

## Before apply (read-only)
```sql
-- p18_vanity_slug_data is applied (expect 169 or more rows, and the function)
SELECT count(*) FROM public.reserved_slugs;
SELECT to_regprocedure('public.p18_slug_is_reserved(text)');
-- nobody already holds either name as a vanity slug (expect 0; the guard would have refused it, this is belt and braces)
SELECT count(*) FROM public.referral_agents WHERE lower(vanity_slug) IN ('partner-agreement-v3', 'ref-bind');
-- current state of the two names (expect both false before apply)
SELECT public.p18_slug_is_reserved('partner-agreement-v3'), public.p18_slug_is_reserved('ref-bind');
```

## Apply
`gh3237_reserved_slugs_add.sql` (one transaction; ON CONFLICT DO NOTHING, so a re-run is a no-op).

## After apply
Run `supabase/tests/gh3237_reserved_slugs_add_check.sql` (read-only): every row must say PASS, and it ends `FAILING=0`.

## Rollback
`gh3237_reserved_slugs_add_rollback.sql` deletes exactly those two rows.

## Proof
`supabase/tests/gh3237_reserved_slugs_add_check.sql` on a throwaway Postgres 16 built from `p18_vanity_slug_data.sql`: before apply both
names are not reserved (the negative control), after apply both are, a re-run changes nothing, and the rollback restores the before state.
