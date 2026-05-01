-- v58 rollback: Remove FK indexes added in v58, restore dropped notification duplicates
-- Apply this ONLY to roll back v58_perf_fk_indexes migration

DROP INDEX IF EXISTS public.idx_aer_adjuster_id;
DROP INDEX IF EXISTS public.idx_claims_adjuster_id;
DROP INDEX IF EXISTS public.idx_claims_carrier_id;
DROP INDEX IF EXISTS public.idx_claims_referral_id;
DROP INDEX IF EXISTS public.idx_claims_selected_contractor_id;
DROP INDEX IF EXISTS public.idx_documents_claim_id;
DROP INDEX IF EXISTS public.idx_expansion_waitlist_claim_id;
DROP INDEX IF EXISTS public.idx_feature_requests_contractor_id;
DROP INDEX IF EXISTS public.idx_job_assignments_quote_id;
DROP INDEX IF EXISTS public.idx_payment_failures_claim_id;
DROP INDEX IF EXISTS public.idx_payment_failures_quote_id;
DROP INDEX IF EXISTS public.idx_quotes_payment_method_id;

-- Restore dropped duplicate notification indexes
CREATE INDEX IF NOT EXISTS idx_notif_claim ON public.notifications USING btree (claim_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON public.notifications USING btree (user_id);
