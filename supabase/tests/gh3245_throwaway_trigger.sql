-- gh-3245: production's trigger on claims (pg_get_triggerdef 2026-10-30). Loaded after apply_referral_commission() exists.
\set ON_ERROR_STOP on
CREATE TRIGGER after_claim_completed AFTER UPDATE OF completion_date ON public.claims FOR EACH ROW
  WHEN (((new.completion_date IS NOT NULL) AND (old.completion_date IS NULL))) EXECUTE FUNCTION apply_referral_commission();
