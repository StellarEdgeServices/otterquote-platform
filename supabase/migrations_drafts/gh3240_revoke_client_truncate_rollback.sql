-- STATUS (gh-1438, as of 2026-10-30T16:00:00Z): NOT APPLIED
-- FILE ROLE: rollback file of set gh3240_revoke_client_truncate
-- EVIDENCE: drafted 2026-10-30 under #3240. Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa, PostgreSQL 17.6): 74 relations in schema public; anon holds TRUNCATE on 48 and authenticated on 50 (43 tables, 7 views), all granted by postgres, all owned by postgres; public.referrals relacl = {postgres=arwdDxtm/postgres,anon=wdDxtm/postgres,authenticated=wdDxtm/postgres,service_role=arwdDxtm/postgres}. No function in a non-system schema except storage.list_objects_with_delimiter (no TRUNCATE statement, a column name) mentions TRUNCATE; no cron.job command does (18 jobs). pg_default_acl for postgres and supabase_admin in public still grants arwdDxtm to anon and authenticated on new tables (out of scope, see the pre-flight). No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Rollback of gh3240_revoke_client_truncate. Restores exactly the TRUNCATE grants read live 2026-10-30: anon on 48 relations,
-- authenticated on 50 (anon never held it on activity_log or admin_contractor_last_logins, so they are not in the anon list).
-- Each grantee already has an ACL entry on every listed relation, so GRANT adds the D back into that entry and relacl returns to
-- the exact pre-forward text (the proof runner diffs the catalog). WARNING: re-opens TRUNCATE for client roles. Run as postgres.
BEGIN;
GRANT TRUNCATE ON TABLE
  public.adjuster_email_requests, public.adjusters, public.admin_dispute_queue, public.carrier_profiles,
  public.cert_verification_quality, public.cert_verification_quality_by_manufacturer, public.claims,
  public.coming_soon_waitlist, public.contractor_cert_verifications, public.contractor_certifications,
  public.contractor_licenses, public.contractor_payment_methods, public.contractor_templates, public.contractors,
  public.contribution_summary, public.cpa_versions, public.cron_health, public.disputes, public.expansion_waitlist,
  public.feature_requests, public.fee_acceptances, public.funnel_abandonment_facts, public.home_profiles,
  public.hover_orders, public.hover_tokens, public.imported_hover_jobs, public.leads, public.material_catalog,
  public.members, public.messages, public.notifications, public.org_summary, public.partner_onboarding_sends,
  public.payout_approvals, public.platform_fee_config, public.platform_settings, public.profiles, public.quotes,
  public.rate_limit_config, public.rate_limits, public.referral_network, public.referrals, public.scope_records,
  public.state_summary, public.stripe_webhook_events, public.support_tickets, public.warranty_manifest_drift,
  public.warranty_options
  TO anon;
GRANT TRUNCATE ON TABLE
  public.activity_log, public.adjuster_email_requests, public.adjusters, public.admin_contractor_last_logins,
  public.admin_dispute_queue, public.carrier_profiles, public.cert_verification_quality,
  public.cert_verification_quality_by_manufacturer, public.claims, public.coming_soon_waitlist,
  public.contractor_cert_verifications, public.contractor_certifications, public.contractor_licenses,
  public.contractor_payment_methods, public.contractor_templates, public.contractors, public.contribution_summary,
  public.cpa_versions, public.cron_health, public.disputes, public.expansion_waitlist, public.feature_requests,
  public.fee_acceptances, public.funnel_abandonment_facts, public.home_profiles, public.hover_orders,
  public.hover_tokens, public.imported_hover_jobs, public.leads, public.material_catalog, public.members,
  public.messages, public.notifications, public.org_summary, public.partner_onboarding_sends, public.payout_approvals,
  public.platform_fee_config, public.platform_settings, public.profiles, public.quotes, public.rate_limit_config,
  public.rate_limits, public.referral_network, public.referrals, public.scope_records, public.state_summary,
  public.stripe_webhook_events, public.support_tickets, public.warranty_manifest_drift, public.warranty_options
  TO authenticated;
COMMIT;
