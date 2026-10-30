-- STATUS (gh-1438, as of 2026-10-30T12:30:00Z): NOT APPLIED
-- EVIDENCE: rollback half of p18_vanity_slug_data.sql (#3218). Before that migration, read-only production reads on 2026-10-30 show none of the objects below exist and referral_agents has 46 columns (no vanity_slug), 12 indexes, 6 policies, 6 triggers (referral_agents_generate_code, _generate_recruit_code, _guard_agent_type, _guard_payout_columns, _set_is_test_internal, trg_notify_admin_new_partner); this file removes exactly what the forward file adds and touches nothing else.
-- REPO COPY: none (draft). WARNING: dropping the column and tables DELETES every chosen slug and all slug history; /<slug> links would stop crediting. Run only if no partner has a slug, or after exporting referral_agents(id, vanity_slug) and referral_agent_slug_history.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md

BEGIN;

DROP TRIGGER IF EXISTS referral_agents_guard_vanity_slug ON public.referral_agents;
DROP FUNCTION IF EXISTS public.set_partner_slug(text);
DROP FUNCTION IF EXISTS public.referral_agents_guard_vanity_slug();
DROP TABLE IF EXISTS public.referral_agent_slug_history;
DROP TABLE IF EXISTS public.reserved_slugs;
DROP INDEX IF EXISTS public.referral_agents_vanity_slug_lower_key;
ALTER TABLE public.referral_agents DROP CONSTRAINT IF EXISTS referral_agents_vanity_slug_format;
ALTER TABLE public.referral_agents DROP COLUMN IF EXISTS vanity_slug;

COMMIT;
