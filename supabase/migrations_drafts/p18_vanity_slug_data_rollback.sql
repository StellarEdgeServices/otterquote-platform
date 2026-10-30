-- STATUS (gh-1438, as of 2026-10-30T14:00:00Z): NOT APPLIED
-- EVIDENCE: rollback half of p18_vanity_slug_data.sql (#3218). Before that migration, read-only production reads on 2026-10-30 show none of the objects below exist and referral_agents has 46 columns (no vanity_slug), 12 indexes, 7 policies, 6 triggers (referral_agents_generate_code, _generate_recruit_code, _guard_agent_type, _guard_payout_columns, _set_is_test_internal, trg_notify_admin_new_partner); this file removes exactly what the forward file adds and touches nothing else.
-- REPO COPY: none (draft). GATED: dropping the column and tables DELETES every chosen slug and all slug history, so this file RAISES (nothing is dropped) if any vanity_slug or history row exists, unless the session first confirms an export was taken:
--   SET oq.p18_rollback_confirm_export = 'export-taken';
-- (export referral_agents(id, vanity_slug) and referral_agent_slug_history first). With no slugs and no history it runs without the setting.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md

BEGIN;

DO $g$
DECLARE n_slugs bigint := 0; n_hist bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'referral_agents' AND column_name = 'vanity_slug') THEN
    EXECUTE 'SELECT count(*) FROM public.referral_agents WHERE vanity_slug IS NOT NULL' INTO n_slugs;
  END IF;
  IF to_regclass('public.referral_agent_slug_history') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.referral_agent_slug_history' INTO n_hist;
  END IF;
  IF (n_slugs > 0 OR n_hist > 0)
     AND COALESCE(current_setting('oq.p18_rollback_confirm_export', true), '') <> 'export-taken' THEN
    RAISE EXCEPTION 'P18 rollback refused: % partner slug(s) and % history row(s) would be deleted. Export them, then SET oq.p18_rollback_confirm_export = ''export-taken'' and run again.', n_slugs, n_hist
      USING ERRCODE = 'P0001';
  END IF;
END $g$;

DROP TRIGGER IF EXISTS referral_agents_guard_vanity_slug ON public.referral_agents;
DROP FUNCTION IF EXISTS public.set_partner_slug(text);
DROP FUNCTION IF EXISTS public.referral_agents_guard_vanity_slug();
DROP TABLE IF EXISTS public.referral_agent_slug_history;
DROP FUNCTION IF EXISTS public.p18_slug_is_reserved(text);
DROP TABLE IF EXISTS public.reserved_slugs;
DROP INDEX IF EXISTS public.referral_agents_vanity_slug_lower_key;
ALTER TABLE public.referral_agents DROP CONSTRAINT IF EXISTS referral_agents_vanity_slug_format;
ALTER TABLE public.referral_agents DROP COLUMN IF EXISTS vanity_slug;

COMMIT;
