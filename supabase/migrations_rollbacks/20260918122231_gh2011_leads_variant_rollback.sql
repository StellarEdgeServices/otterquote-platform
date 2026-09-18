-- Rollback for 20260918122231_gh2011_leads_variant.sql (gh-2011 / gh-2014).
-- Tier 3B when executed (drops a column: any `variant` values captured
-- since the forward migration are LOST). Export them first if needed:
--   COPY (SELECT id, variant FROM public.leads WHERE variant IS NOT NULL) TO STDOUT;
--
-- No CHECK constraint was ever added by the forward migration (see that
-- file's SCOPE NOTE -- Ben/CEO ruled it out on issue #2014, comment
-- 5729306151), so there is nothing to DROP CONSTRAINT here. Only the
-- column comes back out.
--
-- NOTE: the forward migration IS applied to production as of
-- 2026-09-18T12:22:31Z, so this rollback is live-relevant, not hypothetical.
-- Running it while start.html carries the `variant:` line in
-- insertFreshLead() would reintroduce the PGRST204 lead-destruction path the
-- apply ordering exists to prevent: revert the code first, then the column.

BEGIN;

ALTER TABLE public.leads
  DROP COLUMN IF EXISTS variant;

COMMIT;
