-- Rollback of supabase/migrations_drafts/gh3051_ga4_mp_conversion_triggers.sql. Dropping the triggers stops all new sends at once;
-- the table is dropped last (it holds only ids + timestamps). Client-side GA4 events are untouched either way.
BEGIN;
DROP TRIGGER IF EXISTS trg_ga4_mp_lead   ON public.leads;
DROP TRIGGER IF EXISTS trg_ga4_mp_claim  ON public.claims;
DROP FUNCTION IF EXISTS public.notify_ga4_mp_conversion();
DROP TABLE IF EXISTS public.ga4_mp_sent;
-- D-336 opt-out recording (added with the opt-out gate). Dropping the columns is safe for the Edge Function: a failed read of
-- ad_sharing_opt_out is "unknown", which sends nothing. The pages only send a header, so inserts are unaffected.
DROP TRIGGER IF EXISTS trg_ad_sharing_opt_out_lead  ON public.leads;
DROP TRIGGER IF EXISTS trg_ad_sharing_opt_out_claim ON public.claims;
DROP FUNCTION IF EXISTS public.record_ad_sharing_opt_out_at_insert();
ALTER TABLE public.leads  DROP COLUMN IF EXISTS ad_sharing_opt_out;
ALTER TABLE public.claims DROP COLUMN IF EXISTS ad_sharing_opt_out;
COMMIT;
