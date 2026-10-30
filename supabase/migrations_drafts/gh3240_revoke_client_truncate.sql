-- STATUS (gh-1438, as of 2026-10-30T16:00:00Z): NOT APPLIED
-- FILE ROLE: forward file of set gh3240_revoke_client_truncate (pre-flight is gh3240_revoke_client_truncate_pre-flight.md)
-- EVIDENCE: drafted 2026-10-30 under #3240. Production read-only 2026-10-30 (project yeszghaspzwwstvsrioa, PostgreSQL 17.6): 74 relations in schema public; anon holds TRUNCATE on 48 and authenticated on 50 (43 tables, 7 views), all granted by postgres, all owned by postgres; public.referrals relacl = {postgres=arwdDxtm/postgres,anon=wdDxtm/postgres,authenticated=wdDxtm/postgres,service_role=arwdDxtm/postgres}. No function in a non-system schema except storage.list_objects_with_delimiter (no TRUNCATE statement, a column name) mentions TRUNCATE; no cron.job command does (18 jobs). pg_default_acl for postgres and supabase_admin in public still grants arwdDxtm to anon and authenticated on new tables (out of scope, see the pre-flight). No database was written to produce this file.
-- REPO COPY: none. When applied, file this forward under its real ledger version in supabase/migrations/ and move the rollback and pre-flight to supabase/migrations_rollbacks/.
-- DO NOT RUN FROM THIS DIRECTORY -- see supabase/migrations_drafts/README.md
--
-- Migration: gh3240_revoke_client_truncate
-- GitHub: #3240 (follow-up (a) of Ben's R-177 SIGNED on #3225, 6524259012). Project P18. Tier 3B (grant change). R-134 protective-only.
-- Rollback: gh3240_revoke_client_truncate_rollback.sql (restores the exact 98 grants read live)
-- Proof: bash supabase/tests/gh3240_revoke_client_truncate_proof_run.sh --mutations (throwaway Postgres only)
--
-- WHAT IT DOES
--   Revokes TRUNCATE from anon and authenticated on every public relation that holds it today: public.referrals (the issue) and
--   the 49 others the issue asked to check. RLS does not govern TRUNCATE, so a client role holding it could empty a table outright
--   if any path ever ran SQL as that role. PostgREST has no TRUNCATE verb, so nothing reachable today uses it, and no function or
--   cron job in production issues a TRUNCATE. Only the TRUNCATE privilege changes: SELECT/INSERT/UPDATE/DELETE/REFERENCES/TRIGGER/
--   MAINTAIN, column grants, policies, postgres and service_role are untouched. The 7 views are included because the grant exists
--   on them (a view cannot be truncated, so for those the revoke is hygiene only).
--   Idempotent: revoking a privilege that is not held is a no-op, so a re-run changes nothing.
--
-- GUARD: the closing DO block refuses (and so rolls back the whole migration) if any public relation still grants TRUNCATE to anon
--   or authenticated afterwards, e.g. a table created between this draft and the apply. Re-run the pre-flight query, add the
--   table to both lists here and in the rollback, and apply again.

REVOKE TRUNCATE ON TABLE
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
  FROM anon, authenticated;

DO $guard$
DECLARE left_over text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO left_over
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND (has_table_privilege('anon', c.oid, 'TRUNCATE') OR has_table_privilege('authenticated', c.oid, 'TRUNCATE'));
  IF left_over IS NOT NULL THEN
    RAISE EXCEPTION 'gh3240: anon/authenticated still hold TRUNCATE on: % (re-run the pre-flight and extend the lists)', left_over
      USING ERRCODE = 'P0001';
  END IF;
END
$guard$;
