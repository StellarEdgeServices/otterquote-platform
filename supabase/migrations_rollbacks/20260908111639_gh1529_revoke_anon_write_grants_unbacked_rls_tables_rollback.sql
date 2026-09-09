-- ROLLBACK for 20260908111639_gh1529_revoke_anon_write_grants_unbacked_rls_tables.sql
--
-- Restores exactly the 69 (table, command) privilege pairs the forward half
-- revokes, and nothing else.
--
-- ⚠ CORRECTED 2026-09-09 (was 51 pairs / 21 tables). The forward half's §2
-- enumeration was missing `p.permissive='PERMISSIVE'`, so 6 tables backed
-- only by a RESTRICTIVE deny-all policy (`admin_dispute_queue`, `disputes`,
-- `hover_tokens`, `imported_hover_jobs`, `stripe_webhook_events`,
-- `support_tickets`) were wrongly excluded. This file's 21 original GRANT
-- lines are CAPTURED LIVE FROM `has_table_privilege('anon', ...)` on
-- production before the original forward half was rehearsed; the 6 added
-- lines (18 pairs, all DELETE/INSERT/UPDATE) restore the same live-captured
-- grant shape for the corrected 6 tables -- `anon` held DELETE/INSERT/UPDATE
-- on all six before this migration and holds it again if this file is run.
--
-- Verified in the aborted transaction run against the ORIGINAL 51/21 set (see
-- the forward file's proof section for the caveat that this transcript
-- predates the correction):
--   pairs before=51 after-FORWARD=0 after-ROLLBACK=51
-- i.e. this file returns the database to precisely the state the forward half
-- found, with `anon` SELECT (21/21) and `authenticated` (51/51) never having
-- been touched in either direction. The forced-rollback proof for the
-- corrected 69-pair / 27-table set must be re-run by a claim-holder before
-- `apply_migration` is called on the forward file.
--
-- There are no column-level ACLs anywhere in `public` (pg_attribute.attacl
-- non-null count = 0, live), so these table-level GRANTs are exact.

GRANT DELETE, INSERT, UPDATE ON TABLE public.adjuster_email_requests TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.adjusters TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.admin_dispute_queue TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.carrier_profiles TO anon;
GRANT DELETE, UPDATE ON TABLE public.coming_soon_waitlist TO anon;
GRANT DELETE, UPDATE ON TABLE public.contractor_cert_verifications TO anon;
GRANT DELETE ON TABLE public.contractors TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.cpa_versions TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.cron_health TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.disputes TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.feature_requests TO anon;
GRANT DELETE ON TABLE public.fee_acceptances TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.funnel_abandonment_facts TO anon;
GRANT DELETE ON TABLE public.home_profiles TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.hover_tokens TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.imported_hover_jobs TO anon;
GRANT DELETE, UPDATE ON TABLE public.leads TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.material_catalog TO anon;
GRANT DELETE, UPDATE ON TABLE public.members TO anon;
GRANT DELETE, INSERT ON TABLE public.payment_failures TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.platform_settings TO anon;
GRANT DELETE, UPDATE ON TABLE public.quotes TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.scope_records TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.stripe_webhook_events TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.support_tickets TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.warranty_manifest_drift TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.warranty_options TO anon;
