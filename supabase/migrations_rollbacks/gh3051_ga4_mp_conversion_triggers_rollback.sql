-- Rollback of supabase/migrations_drafts/gh3051_ga4_mp_conversion_triggers.sql. Dropping the three triggers stops all new sends at once;
-- the table is dropped last (it holds only ids + timestamps). Client-side GA4 events are untouched either way.
BEGIN;
DROP TRIGGER IF EXISTS trg_ga4_mp_lead   ON public.leads;
DROP TRIGGER IF EXISTS trg_ga4_mp_signup ON public.profiles;
DROP TRIGGER IF EXISTS trg_ga4_mp_claim  ON public.claims;
DROP FUNCTION IF EXISTS public.notify_ga4_mp_conversion();
DROP TABLE IF EXISTS public.ga4_mp_sent;
COMMIT;
