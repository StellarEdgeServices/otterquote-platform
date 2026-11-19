<!--
STATUS (gh-1438, as of 2026-11-18T22:23:11Z): DRAFT, NOT APPLIED (name gh3726_reserved_slugs_add)
FILE ROLE: pre-flight file of set gh3726_reserved_slugs_add (the STATUS is the set's; it describes the forward migration)
EVIDENCE: drafted 2026-11-18 under #3726 / PR #3807. No database was written to produce this file.
REPO COPY: none. When applied, move to supabase/migrations_rollbacks/.
DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
-->
# Pre-flight: gh3726_reserved_slugs_add

Data only: one row appended to `public.reserved_slugs` (`sms-terms`). Tier 3A (additive). Apply before or with the PR #3807 Netlify publish,
so no partner can claim `otterquote.com/sms-terms` before the page is served.

## Before apply (read-only)
```sql
SELECT count(*) FROM public.reserved_slugs;
SELECT to_regprocedure('public.p18_slug_is_reserved(text)');
-- nobody already holds the name as a vanity slug (expect 0)
SELECT count(*) FROM public.referral_agents WHERE lower(vanity_slug) = 'sms-terms';
-- current state (expect false before apply)
SELECT public.p18_slug_is_reserved('sms-terms');
SELECT count(*) FROM public.reserved_slugs WHERE slug = 'sms-terms';  -- expect 0 before apply, 1 after
```

## Apply
`gh3726_reserved_slugs_add.sql` (one transaction; ON CONFLICT DO NOTHING, so a re-run is a no-op).

## After apply
`SELECT public.p18_slug_is_reserved('sms-terms');` must return true.

## Rollback
`gh3726_reserved_slugs_add_rollback.sql` deletes exactly that one row.

## CI note
`scripts/vanity-reserved.test.py` reads `supabase/migrations_drafts/*reserved_slugs_add*.sql`, so the draft file alone turns the P18 check green;
the production row is a separate apply owed before the page is served.
