-- ============================================================================
-- Migration v89 — contractors public-safe view + owner SELECT policy
-- Created: 2026-06-13
-- ============================================================================
-- Problem:
--   "Authenticated users can read contractors" policy has USING(true) for
--   role authenticated. Any authenticated user (homeowners, partners, anyone
--   with an account) can SELECT all columns including:
--     stripe_customer_id, stripe_payment_method_id, stripe_payment_method_last4,
--     gl_carrier, gl_policy_number, wc_carrier, wc_policy_number,
--     coi_file_url, coi_policy_number, admin_notes, contract_templates,
--     contract_pdf_url, notification_emails, notification_phones,
--     ic_24511_attestation, cpa_version, email, phone.
--
-- Read-site classification (full repo grep across JS/TS/HTML/PY):
--
--  ── HOMEOWNER-FACING (authenticated homeowner or anon) — repoint to view ──
--   contractor-about.html:501     SELECT multi-column profile (no PII) by id — HOMEOWNER viewing contractor
--   contractor-about.html:532     SELECT intro_video_path by id — HOMEOWNER
--   repair-intake.html:1317       SELECT id,name,years_in_business,rating,service_counties,phone,email
--                                 WHERE repairs_accepted=true — HOMEOWNER ANON (bug: reads phone+email;
--                                 pre-existing col mismatch: uses 'active'=true which doesn't exist)
--   project-confirmation.html:2196 SELECT id,company_name,years_in_business,logo_url by id — HOMEOWNER
--                                  (logo_url col doesn't exist — pre-existing bug, query silently misses it)
--
--  ── HOMEOWNER-FACING but CANNOT REPOINT — needs EF migration first ──
--   bids.html:1911                SELECT stripe_payment_method_id,stripe_customer_id,company_name,user_id
--                                 — homeowner checks if contractor has PM before awarding project
--                                 → BLOCKED: reads Stripe columns, can't go in view; move to service-role EF
--   contract-signing.html:1218    SELECT * by id — homeowner reads contract_templates, contract_pdf_url,
--                                 user_id for DocuSign flow
--                                 → BLOCKED: needs contract_templates (not in view); move to service-role EF
--
--  ── CONTRACTOR OWN SESSION — covered by new owner SELECT policy ──
--   js/auth.js:338,439,541,564    select id / insert own record — own session
--   js/auth.js:894                select template_review_role — own session (admin check)
--   react-app/app/auth-callback/page.tsx:89  select id — own session
--   react-app/app/providers/auth-provider.tsx:54,80  select id, template_review_role — own session
--   contractor-about.html (contractor viewing own) — own session
--   contractor-auto-bids.html:635,814   select own record
--   contractor-bid-form.html:3555,4901  select own record
--   contractor-dashboard.html:1081,1135,1210,1984,2094,2180,2265  select own
--   contractor-onboarding.html:393  select/insert own
--   contractor-opportunities.html:474  select own record
--   contractor-pre-approval.html:906,1009,1094,1146,1168  select/update own
--   contractor-profile.html:multiple  select/update own record
--   contractor-settings.html:multiple  select/update own record
--
--  ── ADMIN SESSION — covered by existing admin_select_contractors policy ──
--   admin-cert-verifications.html:204
--   admin-contractors.html:880
--   admin-cpa.html:369,378,478
--   admin-incomplete-profiles.html:667
--   admin-template-review.html:231
--   admin-warranty-drift.html:273
--
--  ── EDGE FUNCTIONS (service_role — bypass RLS) ──
--   supabase/functions/admin-contractor-action, approve-warranty-drift,
--   create-docusign-envelope, create-invoice, create-payment-intent,
--   create-setup-intent, docusign-webhook, get-hover-pdf, mark-job-complete,
--   notify-admin-new-contractor, notify-contractors, process-auto-bids,
--   process-coi-reminders, process-dunning, record-attestation,
--   record-warranty-upload, reject-warranty-drift, rescind-bid,
--   send-bid-confirmation, send-incomplete-onboarding-reminders,
--   validate-contract-template
--
--  ── TOOLS (service_role key — bypass RLS) ──
--   tools/generate_contractor_pages.py  — uses service key directly against REST API
--                                          with public_directory_optin=eq.true filter
--
-- Decision:
--   1. Create contractors_public view — safe columns only, status IN ('active','approved').
--      View runs as postgres (owner), bypasses base-table RLS.
--   2. Add "Contractors can read own record" SELECT policy so contractors continue
--      to read their own full row after USING(true) is eventually dropped.
--   3. DO NOT drop "Authenticated users can read contractors" USING(true) yet.
--      bids.html and contract-signing.html still need it.
--      Coordinator: drop ONLY after those two pages are migrated to service-role EFs.
--
-- Deferred DROP (coordinator runs this after EF migration + frontend deploy):
--   DROP POLICY "Authenticated users can read contractors" ON public.contractors;
--
-- Columns EXCLUDED from view (never expose):
--   email, phone, stripe_customer_id, stripe_payment_method_id,
--   stripe_payment_method_last4, stripe_payment_method_brand,
--   has_payment_method, contract_pdf_url, contract_templates,
--   auto_bid_enabled, auto_bid_settings, auto_bid_value_adds,
--   color_confirmation_template, admin_notes, template_review_role,
--   notification_emails, notification_phones, notification_preferences,
--   coi_file_url, coi_policy_number, coi_insurer, coi_expires_at,
--   coi_uploaded_at, coi_reminder_*, coi_expired_notified_at,
--   gl_carrier, gl_policy_number, gl_coverage_amount, gl_expiration_date,
--   wc_carrier, wc_policy_number, wc_coverage_amount, wc_expiration_date,
--   wc_cert_file_ref, wc_cert_expiry, wc_cert_uploaded_at,
--   wc_cert_reminder_30_sent_at, license_path, license_document_url,
--   license_attestation_signed_at, license_verified, license_verified_at,
--   insurance_verified, insurance_verified_at, insurance_verification_sent_at,
--   insurance_verification_email, ic_24511_attestation, attestation_*,
--   agreement_accepted_at, agreement_version, cpa_version, cpa_accepted_at,
--   needs_cpa_reattestation, approved_at, rejected_at, rejection_reason,
--   onboarding_step, partial_completion_email_sent_at, pc_template_migration_pending,
--   sms_consent_ts, timezone, address_line1, address_zip,
--   legacy_pre_approval, cert_status
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Public-safe view
-- ============================================================================
CREATE OR REPLACE VIEW public.contractors_public AS
SELECT
  id,
  company_name,
  contact_name,
  -- Address: city + state only (no line1, no zip)
  address_city,
  address_state,
  -- Service / profile
  trades,
  specialties,
  rating,
  review_count,
  years_in_business,
  num_employees,
  about_us,
  why_choose_us,
  -- Media
  owner_photo_url,
  gallery_photo_urls,
  intro_video_path,
  -- Service area
  service_area_description,
  service_counties,
  -- Public verification badges (boolean only — no policy numbers, no carrier names)
  verified,
  has_workers_comp,
  has_general_liability,
  -- License number shown on contractor-about.html (semi-public: required for verification)
  license_number,
  -- Review / social links
  google_reviews_url,
  bbb_url,
  angi_url,
  yelp_url,
  website_url,
  -- Filtering / directory
  status,
  repairs_accepted,
  -- public_directory_optin added by v83 (live in prod). Included here for
  -- generate_contractor_pages.py clients that may read through this view.
  public_directory_optin
FROM public.contractors
-- Only expose contractors that are live in the marketplace.
-- The status enum has both 'active' and 'approved' in circulation (inconsistency
-- noted: generate_contractor_pages.py uses 'approved'; frontend uses 'active').
-- Cover both until the enum is normalized.
WHERE status IN ('active', 'approved');

COMMENT ON VIEW public.contractors_public IS
'Public-safe projection of the contractors table for homeowner-facing pages. '
'Never exposes email, phone, Stripe fields, insurance policy numbers, COI, '
'contract templates, admin notes, or internal flags. '
'Filtered to status IN (''active'', ''approved''). Runs as postgres (owner) — '
'bypasses base-table RLS; the WHERE clause is the sole row gate. '
'Added by v89 migration (2026-06-13). See D-249 for column whitelist.';

GRANT SELECT ON public.contractors_public TO anon;
GRANT SELECT ON public.contractors_public TO authenticated;


-- ============================================================================
-- 2. Owner SELECT policy
--    Existing policy "Authenticated users can read contractors" (USING true)
--    is intentionally left in place. This new policy pre-positions the
--    contractor's own-row access so it survives when USING(true) is dropped.
--    While USING(true) exists both policies are permissive/OR'd — no change
--    in behavior for any caller.
-- ============================================================================
CREATE POLICY "Contractors can read own record"
  ON public.contractors
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================================================
-- DO NOT run the following DROP until:
--   (a) contract-signing.html Stripe / contract_templates reads are moved to
--       a service-role Edge Function (they need contractor.contract_pdf_url,
--       contractor.contract_templates, and contractor.user_id)
--   (b) bids.html stripe_payment_method_id check is moved to a service-role EF
--   (c) All homeowner-facing reads are confirmed to use contractors_public view
--
-- DROP POLICY "Authenticated users can read contractors" ON public.contractors;
-- ============================================================================

COMMIT;
