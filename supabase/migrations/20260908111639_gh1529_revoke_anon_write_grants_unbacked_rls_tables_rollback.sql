-- ROLLBACK for 20260908111639_gh1529_revoke_anon_write_grants_unbacked_rls_tables.sql
--
-- Restores exactly the 51 (table, command) privilege pairs the forward half
-- revokes, and nothing else. These are the grants as CAPTURED LIVE FROM
-- `has_table_privilege('anon', ...)` on production BEFORE the forward half was
-- rehearsed -- not reconstructed afterwards from memory. A rollback
-- reconstructed after the fact is not a rollback.
--
-- Verified in the same aborted transaction as the forward half:
--   pairs before=51 after-FORWARD=0 after-ROLLBACK=51
-- i.e. this file returns the database to precisely the state the forward half
-- found, with `anon` SELECT (21/21) and `authenticated` (51/51) never having
-- been touched in either direction.
--
-- There are no column-level ACLs anywhere in `public` (pg_attribute.attacl
-- non-null count = 0, live), so these table-level GRANTs are exact.

GRANT DELETE, INSERT, UPDATE ON TABLE public.adjuster_email_requests TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.adjusters TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.carrier_profiles TO anon;
GRANT DELETE, UPDATE ON TABLE public.coming_soon_waitlist TO anon;
GRANT DELETE, UPDATE ON TABLE public.contractor_cert_verifications TO anon;
GRANT DELETE ON TABLE public.contractors TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.cpa_versions TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.cron_health TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.feature_requests TO anon;
GRANT DELETE ON TABLE public.fee_acceptances TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.funnel_abandonment_facts TO anon;
GRANT DELETE ON TABLE public.home_profiles TO anon;
GRANT DELETE, UPDATE ON TABLE public.leads TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.material_catalog TO anon;
GRANT DELETE, UPDATE ON TABLE public.members TO anon;
GRANT DELETE, INSERT ON TABLE public.payment_failures TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.platform_settings TO anon;
GRANT DELETE, UPDATE ON TABLE public.quotes TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.scope_records TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.warranty_manifest_drift TO anon;
GRANT DELETE, INSERT, UPDATE ON TABLE public.warranty_options TO anon;
