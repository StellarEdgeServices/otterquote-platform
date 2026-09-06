-- ROLLBACK for 20260904140000_gh1529_revoke_anon_execute_orphaned_security_definer_fns.sql
--
-- Restores EXECUTE to PUBLIC and/or anon exactly as captured live from
-- pg_proc.proacl before the forward migration, for each of the 23
-- functions it touches. authenticated is never revoked or granted here --
-- it was never touched by the forward file.
--
-- Live proacl snapshot used to build this file (via
-- pg_get_userbyid(proowner)/p.proacl, project yeszghaspzwwstvsrioa,
-- 2026-09-04, before any DDL from this PR ran):
--   apply_referral_commission, enforce_bid_can_submit,
--   enforce_bid_window_expiry, handle_new_user, log_bid_submitted,
--   notify_admin_new_contractor, notify_feature_request_webhook,
--   notify_hover_rebate, notify_partner_status_on_bid_submitted,
--   referral_agents_guard_payout_columns, reverse_referral_commission,
--   rls_auto_enable, set_bid_window_on_first_bid,
--   sync_contractor_cert_status, sync_contractor_profile_role,
--   bid_can_submit, contractor_has_required_docs,
--   get_own_referral_agent_id, get_platform_fee_percentage,
--   record_attestation_ip, record_cpa_ip,
--   record_partner_agreement_reacceptance
--     -- all carried {=X/postgres,postgres=X/postgres,anon=X/postgres,
--        authenticated=X/postgres,service_role=X/postgres} -- PUBLIC + anon
--        restored for each.
--   get_contractor_last_logins
--     -- carried {postgres=X/postgres,anon=X/postgres,
--        authenticated=X/postgres,service_role=X/postgres} -- no PUBLIC
--        entry -- anon restored only.

BEGIN;

GRANT EXECUTE ON FUNCTION public.apply_referral_commission() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_referral_commission() TO anon;

GRANT EXECUTE ON FUNCTION public.enforce_bid_can_submit() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_bid_can_submit() TO anon;

GRANT EXECUTE ON FUNCTION public.enforce_bid_window_expiry() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_bid_window_expiry() TO anon;

GRANT EXECUTE ON FUNCTION public.handle_new_user() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO anon;

GRANT EXECUTE ON FUNCTION public.log_bid_submitted() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_bid_submitted() TO anon;

GRANT EXECUTE ON FUNCTION public.notify_admin_new_contractor() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_admin_new_contractor() TO anon;

GRANT EXECUTE ON FUNCTION public.notify_feature_request_webhook() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_feature_request_webhook() TO anon;

GRANT EXECUTE ON FUNCTION public.notify_hover_rebate() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_hover_rebate() TO anon;

GRANT EXECUTE ON FUNCTION public.notify_partner_status_on_bid_submitted() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_partner_status_on_bid_submitted() TO anon;

GRANT EXECUTE ON FUNCTION public.referral_agents_guard_payout_columns() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.referral_agents_guard_payout_columns() TO anon;

GRANT EXECUTE ON FUNCTION public.reverse_referral_commission() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_referral_commission() TO anon;

GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO anon;

GRANT EXECUTE ON FUNCTION public.set_bid_window_on_first_bid() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_bid_window_on_first_bid() TO anon;

GRANT EXECUTE ON FUNCTION public.sync_contractor_cert_status() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_contractor_cert_status() TO anon;

GRANT EXECUTE ON FUNCTION public.sync_contractor_profile_role() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_contractor_profile_role() TO anon;

GRANT EXECUTE ON FUNCTION public.bid_can_submit(p_contractor_id uuid, p_trade text, p_funding_type text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.bid_can_submit(p_contractor_id uuid, p_trade text, p_funding_type text) TO anon;

GRANT EXECUTE ON FUNCTION public.contractor_has_required_docs(p_contractor_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.contractor_has_required_docs(p_contractor_id uuid) TO anon;

GRANT EXECUTE ON FUNCTION public.get_contractor_last_logins() TO anon;

GRANT EXECUTE ON FUNCTION public.get_own_referral_agent_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_own_referral_agent_id() TO anon;

GRANT EXECUTE ON FUNCTION public.get_platform_fee_percentage() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_platform_fee_percentage() TO anon;

GRANT EXECUTE ON FUNCTION public.record_attestation_ip(p_contractor_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_attestation_ip(p_contractor_id uuid) TO anon;

GRANT EXECUTE ON FUNCTION public.record_cpa_ip(p_contractor_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_cpa_ip(p_contractor_id uuid) TO anon;

GRANT EXECUTE ON FUNCTION public.record_partner_agreement_reacceptance(p_referral_agent_id uuid, p_agreement_version text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_partner_agreement_reacceptance(p_referral_agent_id uuid, p_agreement_version text) TO anon;

COMMIT;
