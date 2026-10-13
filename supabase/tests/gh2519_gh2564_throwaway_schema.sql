-- gh-2519 / gh-2564: THROWAWAY schema for supabase/tests/gh2519_gh2564_fee_lock_proof.sql.
-- GENERATED, never applied anywhere but a scratch Postgres. Source: production project yeszghaspzwwstvsrioa,
-- read-only (information_schema.columns, pg_constraint, pg_policies, pg_class.relacl, pg_get_functiondef,
-- pg_get_triggerdef), read 2026-10-08 by the cto62-fee worker. Production is PostgreSQL 17.6; this file was
-- run on PostgreSQL 16 (the MAINTAIN privilege, new in 17, is therefore not granted here).
-- LOADED: tables quotes, claims, contractors, platform_fee_config, referrals, referral_agents,
--   payout_approvals with every column, default, NOT NULL, PRIMARY KEY, UNIQUE and CHECK constraint, the
--   foreign keys between these seven tables, row level security, every policy and every table grant;
--   the functions and triggers listed at the bottom, byte for byte from pg_get_functiondef.
-- NOT LOADED (stated so nobody reads this as production): foreign keys to tables outside the seven
--   (auth.users, adjusters, carrier_profiles, contractor_payment_methods, warranty_options); the quotes
--   triggers quotes_enforce_bid_can_submit (D-199 template gate, needs contractor_templates),
--   trg_log_bid_accepted, trg_log_bid_submitted, trg_notify_partner_status_on_bid_submitted and
--   trg_set_bid_window_on_first_bid (AFTER triggers: activity log, pg_net, bid window); the claims triggers
--   other than the four created below; pg_net and Supabase Vault (vault.decrypted_secrets is an empty stub,
--   so apply_referral_commission() logs "secret not found" and sends nothing, as its own code allows).
-- auth.uid(), auth.role(), auth.jwt(), auth.email() are production's definitions (they read
-- request.jwt.claims, which is how PostgREST passes the caller).
\set ON_ERROR_STOP on
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
CREATE SCHEMA auth; CREATE SCHEMA vault;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE VIEW vault.decrypted_secrets AS SELECT NULL::text AS name, NULL::text AS decrypted_secret WHERE false;

CREATE OR REPLACE FUNCTION auth.email()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$function$;

CREATE OR REPLACE FUNCTION auth.jwt()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select 
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$function$;

CREATE OR REPLACE FUNCTION auth.role()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$function$;

CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE public.referral_agents (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "agent_type" text NOT NULL,
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "email" text NOT NULL,
  "phone" text,
  "company" text,
  "photo_url" text,
  "bio" text,
  "website" text,
  "service_area" text,
  "unique_code" text NOT NULL,
  "status" text DEFAULT 'active'::text NOT NULL,
  "onboarded_at" timestamp with time zone,
  "total_referrals" integer DEFAULT 0,
  "total_commission_earned" numeric(10,2) DEFAULT 0,
  "total_commission_paid" numeric(10,2) DEFAULT 0,
  "user_id" uuid,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "recruit_code" text,
  "recruited_by_id" uuid,
  "recruited_at" timestamp with time zone,
  "recruit_earnings" numeric(10,2) DEFAULT 0,
  "referred_by_note" text,
  "w9_file_url" text,
  "w9_submitted_at" timestamp with time zone,
  "w9_verified_at" timestamp with time zone,
  "payments_blocked" boolean DEFAULT true NOT NULL,
  "w9_notification_sent_at" timestamp with time zone,
  "public_directory_optin" boolean DEFAULT false NOT NULL,
  "is_test" boolean DEFAULT false NOT NULL,
  "utm_source" text,
  "utm_medium" text,
  "utm_campaign" text,
  "utm_content" text,
  "partner_agreement_version" text,
  "partner_agreement_accepted_at" timestamp with time zone,
  "partner_agreement_attestation" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "needs_partner_reacceptance" boolean DEFAULT false NOT NULL,
  "fbclid" text,
  "li_fat_id" text,
  "funnel_id" text,
  "app_first_signed_in_launch_at" timestamp with time zone,
  "onboarding_opted_out_at" timestamp with time zone,
  "meta_lead_id" text
);

CREATE TABLE public.contractors (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "company_name" text NOT NULL,
  "contact_name" text NOT NULL,
  "email" text NOT NULL,
  "phone" text,
  "license_number" text,
  "specialties" text[],
  "rating" numeric(2,1),
  "review_count" integer DEFAULT 0,
  "verified" boolean DEFAULT false,
  "has_payment_method" boolean DEFAULT false,
  "stripe_customer_id" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "no_license_required" boolean DEFAULT false,
  "about_us" text,
  "why_choose_us" text,
  "owner_photo_url" text,
  "preferred_brands" text[],
  "trades" text[],
  "service_counties" text[],
  "service_area_description" text,
  "google_reviews_url" text,
  "bbb_url" text,
  "angi_url" text,
  "yelp_url" text,
  "color_selection_enabled" boolean DEFAULT true,
  "notification_emails" text[],
  "notification_phones" text[],
  "notification_preferences" jsonb DEFAULT '{"bid_accepted": true, "reminder_48h": true, "color_complete": true, "contract_signed": true, "new_opportunity": true, "deductible_collected": true}'::jsonb,
  "status" text DEFAULT 'pending_approval'::text,
  "contract_pdf_url" text,
  "auto_bid_enabled" boolean DEFAULT false,
  "auto_bid_settings" jsonb DEFAULT '{"scope": "full_replacement", "trade": "roofing", "pricing": "rcv", "funding_type": "insurance"}'::jsonb,
  "contract_templates" jsonb DEFAULT '[]'::jsonb,
  "address_line1" text,
  "address_city" text,
  "address_state" text DEFAULT 'IN'::text,
  "address_zip" text,
  "website_url" text,
  "num_employees" text,
  "years_in_business" integer,
  "repairs_accepted" boolean DEFAULT false NOT NULL,
  "guarantee_accepted" boolean DEFAULT false NOT NULL,
  "has_workers_comp" boolean DEFAULT false,
  "has_general_liability" boolean DEFAULT false,
  "auto_bid_value_adds" jsonb,
  "stripe_payment_method_id" text,
  "stripe_payment_method_last4" text,
  "stripe_payment_method_brand" text,
  "color_confirmation_template" jsonb,
  "agreement_accepted_at" timestamp with time zone,
  "agreement_version" text,
  "timezone" text DEFAULT 'America/New_York'::text,
  "gl_carrier" text,
  "gl_policy_number" text,
  "gl_coverage_amount" text,
  "gl_expiration_date" date,
  "wc_carrier" text,
  "wc_policy_number" text,
  "wc_coverage_amount" text,
  "wc_expiration_date" date,
  "gallery_photo_urls" text[] DEFAULT '{}'::text[],
  "admin_notes" text,
  "license_verified" boolean DEFAULT false,
  "license_verified_at" timestamp with time zone,
  "insurance_verified" boolean DEFAULT false,
  "insurance_verified_at" timestamp with time zone,
  "insurance_verification_sent_at" timestamp with time zone,
  "insurance_verification_email" text,
  "approved_at" timestamp with time zone,
  "rejected_at" timestamp with time zone,
  "rejection_reason" text,
  "pc_template_migration_pending" boolean DEFAULT false,
  "coi_file_url" text,
  "coi_expires_at" date,
  "coi_insurer" text,
  "coi_policy_number" text,
  "coi_uploaded_at" timestamp with time zone,
  "coi_reminder_30_sent_at" timestamp with time zone,
  "coi_reminder_14_sent_at" timestamp with time zone,
  "coi_reminder_7_sent_at" timestamp with time zone,
  "coi_expired_notified_at" timestamp with time zone,
  "ic_24511_attestation" jsonb DEFAULT '{}'::jsonb,
  "attestation_accepted_at" timestamp with time zone,
  "attestation_signer_name" text,
  "attestation_signer_title" text,
  "attestation_text_version" text,
  "sms_consent_ts" timestamp with time zone,
  "default_auto_renew" boolean DEFAULT false,
  "cpa_version" text DEFAULT 'v1-2026-04'::text NOT NULL,
  "cpa_accepted_at" timestamp with time zone,
  "onboarding_step" integer DEFAULT 1 NOT NULL,
  "partial_completion_email_sent_at" timestamp with time zone,
  "template_review_role" text,
  "cert_status" jsonb,
  "intro_video_path" text,
  "wc_cert_file_ref" text,
  "wc_cert_expiry" date,
  "wc_cert_uploaded_at" timestamp with time zone,
  "license_path" text,
  "license_document_url" text,
  "license_attestation_signed_at" timestamp with time zone,
  "legacy_pre_approval" boolean DEFAULT false NOT NULL,
  "wc_cert_reminder_30_sent_at" timestamp with time zone,
  "needs_cpa_reattestation" boolean DEFAULT false NOT NULL,
  "public_directory_optin" boolean DEFAULT false NOT NULL,
  "is_test" boolean DEFAULT false NOT NULL,
  "service_states" text[],
  "sms_opt_in" boolean,
  "sms_opt_in_at" timestamp with time zone,
  "sms_opt_in_source" text,
  "sms_consent_text_version" text,
  "notifications_suppressed" boolean
);

CREATE TABLE public.referrals (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "referral_agent_id" uuid NOT NULL,
  "claim_id" uuid,
  "homeowner_name" text,
  "homeowner_email" text,
  "homeowner_phone" text,
  "status" text DEFAULT 'clicked'::text NOT NULL,
  "job_value" numeric(12,2),
  "commission_amount" numeric(10,2),
  "commission_paid_at" timestamp with time zone,
  "landing_page" text,
  "utm_source" text,
  "utm_medium" text,
  "utm_campaign" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "recruit_commission_amount" numeric(10,2) DEFAULT 0,
  "recruit_paid_at" timestamp with time zone,
  "is_test" boolean DEFAULT false NOT NULL
);

CREATE TABLE public.claims (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "claim_number" text,
  "status" text DEFAULT 'documents_needed'::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "carrier_id" uuid,
  "adjuster_id" uuid,
  "adjuster_name" text,
  "adjuster_email" text,
  "adjuster_phone" text,
  "ingest_email" text,
  "material_category" text,
  "shingle_type" text,
  "impact_class" text,
  "designer_product" text,
  "designer_manufacturer" text,
  "metal_type" text,
  "metal_material" text,
  "color_brand" text,
  "color_name" text,
  "color_selected_at" timestamp with time zone,
  "color_addendum_signed" boolean DEFAULT false,
  "hover_order_id" text,
  "hover_status" text,
  "hover_paid" boolean DEFAULT false,
  "hover_rebated" boolean DEFAULT false,
  "has_estimate" boolean DEFAULT false,
  "has_measurements" boolean DEFAULT false,
  "has_material_selection" boolean DEFAULT false,
  "ready_for_bids" boolean DEFAULT false,
  "bids_submitted_at" timestamp with time zone,
  "selected_contractor_id" uuid,
  "contract_signed_at" timestamp with time zone,
  "docusign_envelope_id" text,
  "deductible_amount" numeric(10,2),
  "deductible_collected" boolean DEFAULT false,
  "deductible_stripe_id" text,
  "platform_fee_charged" boolean DEFAULT false,
  "platform_fee_amount" numeric(10,2),
  "platform_fee_stripe_id" text,
  "estimate_filename" text,
  "measurements_filename" text,
  "date_of_loss" date,
  "damage_type" text DEFAULT 'roof'::text,
  "job_type" text,
  "rcv_amount" numeric(10,2),
  "acv_amount" numeric(10,2),
  "roof_squares" numeric(6,1),
  "repair_squares" numeric(6,1),
  "existing_shingle_brand" text,
  "existing_shingle_product" text,
  "existing_shingle_color" text,
  "urgency" text DEFAULT 'flexible'::text,
  "urgency_deadline" date,
  "urgency_reason" text,
  "homeowner_notes" text,
  "referral_code" text,
  "referral_id" uuid,
  "policy_type" text,
  "funding_type" text,
  "trades" text[] DEFAULT '{}'::text[],
  "repair_type" text,
  "repair_description" text,
  "repair_shingle_count" integer,
  "roof_age_years" integer,
  "material_id_method" text,
  "material_id_status" text DEFAULT 'pending'::text,
  "itel_order_id" text,
  "itel_status" text,
  "ai_id_confidence" numeric(5,2),
  "trade_intents" jsonb DEFAULT '[]'::jsonb,
  "color_confirmation_envelope_id" text,
  "contract_sent_at" timestamp with time zone,
  "contract_signed_by" text,
  "selected_bid_amount" numeric,
  "deductible_collected_at" timestamp with time zone,
  "homeowner_name" text,
  "contract_declined_at" timestamp with time zone,
  "contract_voided_at" timestamp with time zone,
  "color_confirmed_at" timestamp with time zone,
  "property_address" text,
  "ingest_email_address" text,
  "parsed_line_items" jsonb,
  "contractor_scope_summary" text,
  "loss_sheet_parsed_at" timestamp with time zone,
  "project_confirmation" jsonb,
  "project_confirmation_envelope_id" text,
  "referral_source" text,
  "referral_agent_id" uuid,
  "contractor_switched_at" timestamp with time zone,
  "contractor_switch_count" integer DEFAULT 0 NOT NULL,
  "siding_bid_released_at" timestamp with time zone,
  "roofing_bid_released_at" timestamp with time zone,
  "gutters_bid_released_at" timestamp with time zone,
  "windows_bid_released_at" timestamp with time zone,
  "bid_window_expires_at" timestamp with time zone,
  "bid_window_notified_at" timestamp with time zone,
  "property_state" text,
  "switch_reason_survey" jsonb,
  "completion_date" timestamp with time zone,
  "video_url" text,
  "profile_prompt_sent_at" timestamp with time zone,
  "is_test" boolean DEFAULT false NOT NULL,
  "carrier_name" text,
  "hover_measurements" jsonb,
  "project_confirmation_signed_at" timestamp with time zone,
  "referrer_updates_opt_out" boolean,
  "measurement_shape" text,
  "live_charge_authorized_at" timestamp with time zone,
  "live_charge_authorized_by" text,
  "loss_sheet_reviewed_at" timestamp with time zone,
  "utm_source" text,
  "utm_medium" text,
  "utm_campaign" text,
  "utm_content" text,
  "utm_term" text,
  "fbclid" text,
  "gclid" text,
  "first_touch_landing_path" text,
  "first_touch_referrer" text,
  "first_touch_at" timestamp with time zone,
  "property_city" text,
  "property_zip" text,
  "signed_contract_price" numeric(12,2),
  "signed_price_raw" text,
  "signed_price_verdict" text,
  "signed_price_reason" text,
  "signed_price_checked_at" timestamp with time zone,
  "out_of_state_alerted_at" timestamp with time zone
);

CREATE TABLE public.quotes (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "claim_id" uuid NOT NULL,
  "contractor_id" uuid NOT NULL,
  "total_price" numeric(12,2) NOT NULL,
  "estimated_days" integer,
  "timeline_note" text,
  "scope_summary" text,
  "notes" text,
  "fee_percentage" numeric(5,2) NOT NULL,
  "fee_amount" numeric(12,2) NOT NULL,
  "fee_agreed" boolean DEFAULT false,
  "fee_agreed_at" timestamp with time zone,
  "status" text DEFAULT 'submitted'::text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "decking_price_per_sheet" numeric(8,2),
  "full_redeck_price" numeric(10,2),
  "supplement_acknowledged" boolean DEFAULT false,
  "trade_type" text,
  "is_bundled_bid" boolean DEFAULT false,
  "bundled_trades" text[] DEFAULT '{}'::text[],
  "per_trade_breakdown" jsonb,
  "value_adds" jsonb,
  "payment_intent_id" text,
  "payment_status" text,
  "docusign_envelope_id" text,
  "contractor_signed_at" timestamp with time zone,
  "homeowner_signed_at" timestamp with time zone,
  "is_auto_bid" boolean DEFAULT false,
  "payment_method_id" uuid,
  "payment_method_type" text,
  "card_fee_cents" integer,
  "cancelled_at" timestamp with time zone,
  "cancellation_reason" text,
  "expires_at" timestamp with time zone,
  "auto_renew" boolean DEFAULT false,
  "renewed_from_quote_id" uuid,
  "expired_at" timestamp with time zone,
  "bid_status" text DEFAULT 'active'::text NOT NULL,
  "warranty_option_id" uuid,
  "warranty_snapshot" text,
  "material_selection" jsonb,
  "workmanship_warranty_years" integer,
  "warranty_document_url" text,
  "warranty_uploaded_at" timestamp with time zone,
  "platform_fee_pct" numeric(5,2),
  "platform_fee_basis" text,
  "fee_accepted_at" timestamp with time zone,
  "is_test" boolean DEFAULT false NOT NULL
);

CREATE TABLE public.platform_fee_config (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "state" text,
  "trade" text,
  "fee_pct" numeric(5,2) NOT NULL,
  "fee_basis" text NOT NULL,
  "effective_date" date DEFAULT CURRENT_DATE NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.payout_approvals (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "referral_id" uuid,
  "payout_type" text NOT NULL,
  "partner_id" uuid,
  "partner_name" text,
  "amount" numeric(10,2) NOT NULL,
  "trigger_event" text,
  "status" text DEFAULT 'pending_approval'::text NOT NULL,
  "rejection_reason" text,
  "auto_approve_at" timestamp with time zone,
  "approved_at" timestamp with time zone,
  "rejected_at" timestamp with time zone,
  "approved_by" text,
  "reminder_sent_at" timestamp with time zone,
  "notification_sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now(),
  "is_test" boolean DEFAULT false NOT NULL,
  "paid_at" timestamp with time zone
);

ALTER TABLE public.claims ADD CONSTRAINT "claims_awarded_requires_selected_contractor" CHECK (((status <> ALL (ARRAY['awarded'::text, 'selected'::text])) OR (selected_contractor_id IS NOT NULL)));

ALTER TABLE public.claims ADD CONSTRAINT "claims_funding_type_check" CHECK ((funding_type = ANY (ARRAY['insurance'::text, 'cash'::text])));

ALTER TABLE public.claims ADD CONSTRAINT "claims_ingest_email_address_key" UNIQUE (ingest_email_address);

ALTER TABLE public.claims ADD CONSTRAINT "claims_ingest_email_key" UNIQUE (ingest_email);

ALTER TABLE public.claims ADD CONSTRAINT "claims_itel_status_check" CHECK ((itel_status = ANY (ARRAY['pending'::text, 'completed'::text])));

ALTER TABLE public.claims ADD CONSTRAINT "claims_job_type_check" CHECK ((job_type = ANY (ARRAY['insurance_rcv'::text, 'insurance_acv'::text, 'retail'::text, 'repair'::text])));

ALTER TABLE public.claims ADD CONSTRAINT "claims_material_id_method_check" CHECK ((material_id_method = ANY (ARRAY['paperwork'::text, 'leftover'::text, 'ai_photo'::text, 'itel'::text, 'inspection'::text])));

ALTER TABLE public.claims ADD CONSTRAINT "claims_material_id_status_check" CHECK ((material_id_status = ANY (ARRAY['pending'::text, 'identified'::text, 'submitted'::text, 'completed'::text])));

ALTER TABLE public.claims ADD CONSTRAINT "claims_measurement_shape_check" CHECK ((measurement_shape = ANY (ARRAY['basic'::text, 'full'::text])));

ALTER TABLE public.claims ADD CONSTRAINT "claims_pkey" PRIMARY KEY (id);

ALTER TABLE public.claims ADD CONSTRAINT "claims_policy_type_check" CHECK ((policy_type = ANY (ARRAY['rcv'::text, 'acv'::text, 'idk'::text])));

ALTER TABLE public.claims ADD CONSTRAINT "claims_repair_type_check" CHECK ((repair_type = ANY (ARRAY['leak'::text, 'blown_off'::text, 'other'::text])));

ALTER TABLE public.claims ADD CONSTRAINT "claims_signed_price_reason_check" CHECK (((signed_price_reason IS NULL) OR (signed_price_reason = ANY (ARRAY['no_expected'::text, 'field_absent'::text, 'unparseable'::text, 'properties_unreadable'::text, 'reconciliation_error'::text]))));

ALTER TABLE public.claims ADD CONSTRAINT "claims_signed_price_verdict_check" CHECK (((signed_price_verdict IS NULL) OR (signed_price_verdict = ANY (ARRAY['reconciled'::text, 'mismatch'::text, 'unverified'::text]))));

ALTER TABLE public.claims ADD CONSTRAINT "claims_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'active'::text, 'waitlisted'::text, 'bidding'::text, 'contract_signed'::text, 'awarded'::text, 'documents_needed'::text])));

ALTER TABLE public.claims ADD CONSTRAINT "claims_urgency_check" CHECK ((urgency = ANY (ARRAY['flexible'::text, '30_days'::text, '2_weeks'::text, 'asap'::text])));

ALTER TABLE public.contractors ADD CONSTRAINT "chk_contractors_license_path" CHECK (((license_path IS NULL) OR (license_path = 'not_provided'::text)));

ALTER TABLE public.contractors ADD CONSTRAINT "contractors_has_payment_method_requires_verified_method" CHECK (((has_payment_method IS NOT TRUE) OR ((stripe_payment_method_id IS NOT NULL) AND (stripe_payment_method_id <> ''::text) AND (stripe_payment_method_last4 ~ '^[0-9]{4}$'::text))));

ALTER TABLE public.contractors ADD CONSTRAINT "contractors_pkey" PRIMARY KEY (id);

ALTER TABLE public.contractors ADD CONSTRAINT "contractors_status_check" CHECK ((status = ANY (ARRAY['pending_approval'::text, 'active'::text, 'suspended'::text, 'inactive'::text])));

ALTER TABLE public.contractors ADD CONSTRAINT "contractors_template_review_role_check" CHECK (((template_review_role IS NULL) OR (template_review_role = 'admin'::text)));

ALTER TABLE public.payout_approvals ADD CONSTRAINT "payout_approvals_payout_type_check" CHECK ((payout_type = ANY (ARRAY['commission_referral'::text, 'commission_recruit'::text])));

ALTER TABLE public.payout_approvals ADD CONSTRAINT "payout_approvals_pkey" PRIMARY KEY (id);

ALTER TABLE public.payout_approvals ADD CONSTRAINT "payout_approvals_status_check" CHECK ((status = ANY (ARRAY['pending_approval'::text, 'approved'::text, 'rejected'::text, 'auto_approved'::text, 'pre_approved'::text, 'paid'::text])));

ALTER TABLE public.platform_fee_config ADD CONSTRAINT "platform_fee_config_pkey" PRIMARY KEY (id);

ALTER TABLE public.quotes ADD CONSTRAINT "quotes_bid_status_check" CHECK ((bid_status = ANY (ARRAY['active'::text, 'expired'::text, 'superseded'::text, 'cancelled'::text])));

ALTER TABLE public.quotes ADD CONSTRAINT "quotes_payment_status_check" CHECK ((payment_status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'pending'::text, 'dunning'::text, 'refunded'::text, 'no_method'::text])));

ALTER TABLE public.quotes ADD CONSTRAINT "quotes_pkey" PRIMARY KEY (id);

ALTER TABLE public.quotes ADD CONSTRAINT "quotes_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'selected'::text, 'declined'::text, 'expired'::text])));

ALTER TABLE public.quotes ADD CONSTRAINT "quotes_trade_type_check" CHECK ((trade_type = ANY (ARRAY['roofing'::text, 'siding'::text, 'gutters'::text, 'windows'::text])));

ALTER TABLE public.referral_agents ADD CONSTRAINT "referral_agents_agent_type_check" CHECK ((agent_type = ANY (ARRAY['re_agent'::text, 'insurance_agent'::text, 'home_inspector'::text, 'customer'::text, 'adjuster'::text, 'other'::text])));

ALTER TABLE public.referral_agents ADD CONSTRAINT "referral_agents_email_key" UNIQUE (email);

ALTER TABLE public.referral_agents ADD CONSTRAINT "referral_agents_meta_lead_id_key" UNIQUE (meta_lead_id);

ALTER TABLE public.referral_agents ADD CONSTRAINT "referral_agents_pkey" PRIMARY KEY (id);

ALTER TABLE public.referral_agents ADD CONSTRAINT "referral_agents_recruit_code_key" UNIQUE (recruit_code);

ALTER TABLE public.referral_agents ADD CONSTRAINT "referral_agents_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text])));

ALTER TABLE public.referral_agents ADD CONSTRAINT "referral_agents_unique_code_key" UNIQUE (unique_code);

ALTER TABLE public.referrals ADD CONSTRAINT "referrals_pkey" PRIMARY KEY (id);

ALTER TABLE public.referrals ADD CONSTRAINT "referrals_status_check" CHECK ((status = ANY (ARRAY['clicked'::text, 'registered'::text, 'claim_submitted'::text, 'bid_received'::text, 'contract_signed'::text, 'job_completed'::text, 'commission_paid'::text])));

ALTER TABLE public.claims ADD CONSTRAINT "claims_referral_agent_id_fkey" FOREIGN KEY (referral_agent_id) REFERENCES referral_agents(id) ON DELETE SET NULL;

ALTER TABLE public.claims ADD CONSTRAINT "claims_referral_id_fkey" FOREIGN KEY (referral_id) REFERENCES referrals(id) ON DELETE SET NULL;

ALTER TABLE public.claims ADD CONSTRAINT "claims_selected_contractor_id_fkey" FOREIGN KEY (selected_contractor_id) REFERENCES contractors(id);

ALTER TABLE public.payout_approvals ADD CONSTRAINT "payout_approvals_partner_id_fkey" FOREIGN KEY (partner_id) REFERENCES referral_agents(id) ON DELETE SET NULL;

ALTER TABLE public.payout_approvals ADD CONSTRAINT "payout_approvals_referral_id_fkey" FOREIGN KEY (referral_id) REFERENCES referrals(id) ON DELETE SET NULL;

ALTER TABLE public.quotes ADD CONSTRAINT "quotes_claim_id_fkey" FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE;

ALTER TABLE public.quotes ADD CONSTRAINT "quotes_contractor_id_fkey" FOREIGN KEY (contractor_id) REFERENCES contractors(id) ON DELETE CASCADE;

ALTER TABLE public.quotes ADD CONSTRAINT "quotes_renewed_from_quote_id_fkey" FOREIGN KEY (renewed_from_quote_id) REFERENCES quotes(id) ON DELETE SET NULL;

ALTER TABLE public.referral_agents ADD CONSTRAINT "referral_agents_recruited_by_id_fkey" FOREIGN KEY (recruited_by_id) REFERENCES referral_agents(id) ON DELETE SET NULL;

ALTER TABLE public.referrals ADD CONSTRAINT "referrals_claim_id_fkey" FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE SET NULL;

ALTER TABLE public.referrals ADD CONSTRAINT "referrals_referral_agent_id_fkey" FOREIGN KEY (referral_agent_id) REFERENCES referral_agents(id) ON DELETE CASCADE;

SET check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.is_admin_email()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (auth.jwt() ->> 'email') IN (
    'dustinstohler1@gmail.com',
    'dustin@otterquote.com'
  );
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.referral_attribution_window()
 RETURNS interval
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT interval '30 days' $function$;

CREATE OR REPLACE FUNCTION public.contractor_can_bid(p_contractor_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM contractors c
    WHERE c.id = p_contractor_id
      AND c.status = 'active'
      AND c.coi_file_url IS NOT NULL
      AND c.coi_expires_at IS NOT NULL
      AND c.coi_expires_at > CURRENT_DATE
      AND c.attestation_accepted_at IS NOT NULL
  );
$function$;

CREATE OR REPLACE FUNCTION public.get_contractor_quote_claim_ids(p_user_id uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT q.claim_id
  FROM quotes q
  JOIN contractors c ON c.id = q.contractor_id
  WHERE c.user_id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.get_own_referral_agent_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM public.referral_agents WHERE user_id = auth.uid() LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.normalize_quotes_fee_amount()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.platform_fee_pct IS NOT NULL AND NEW.total_price IS NOT NULL THEN
    NEW.fee_amount := round((NEW.platform_fee_pct / 100.0) * NEW.total_price, 2);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.quotes_guard_homeowner_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false) THEN

    IF TG_OP = 'INSERT' THEN
      -- gh-2479 born state: a client-created quote is the caller's own new bid and nothing later
      IF NOT COALESCE(EXISTS (
               SELECT 1 FROM public.contractors k
                WHERE k.id = NEW.contractor_id AND k.user_id = auth.uid()), false) THEN
        RAISE EXCEPTION 'quotes: a bid can only be created by the contractor it names (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
      IF COALESCE(NEW.status <> 'submitted', true)
         OR COALESCE(NEW.bid_status <> 'active', true)
         OR NEW.is_auto_bid IS TRUE
         OR NEW.renewed_from_quote_id IS NOT NULL
         OR NEW.homeowner_signed_at IS NOT NULL
         OR NEW.contractor_signed_at IS NOT NULL
         OR NEW.payment_status IS NOT NULL THEN
        RAISE EXCEPTION 'quotes: a new bid must start as a submitted, active bid; selection, renewal, signing and payment state are set later by the platform (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;

    IF COALESCE(
         (NEW.claim_id IS DISTINCT FROM OLD.claim_id)
         OR (NEW.contractor_id IS DISTINCT FROM OLD.contractor_id),
         true) THEN
      RAISE EXCEPTION 'quotes: claim_id and contractor_id can only be changed by service_role or an admin (gh-2479)'
        USING ERRCODE = '42501';
    END IF;

    IF COALESCE(NEW.total_price IS DISTINCT FROM OLD.total_price, true)
       AND NOT COALESCE(EXISTS (
             SELECT 1 FROM public.contractors k
              WHERE k.id = OLD.contractor_id AND k.user_id = auth.uid()), false) THEN
      RAISE EXCEPTION 'quotes: total_price can only be changed by the bidding contractor, service_role or an admin (gh-2519)'
        USING ERRCODE = '42501';
    END IF;

    IF COALESCE(NEW.status IS DISTINCT FROM OLD.status, true)
       AND NOT COALESCE(
             NEW.status IN ('selected', 'declined')
             AND EXISTS (
               SELECT 1 FROM public.claims c
                WHERE c.id = OLD.claim_id AND c.user_id = auth.uid()), false) THEN
      RAISE EXCEPTION 'quotes: status can only be set to selected or declined by the claim owner; other changes need service_role or an admin (gh-2479)'
        USING ERRCODE = '42501';
    END IF;

    -- gh-2519: the fee columns. Only the bid's own contractor may change them (the bid forms send all four on
    -- a change-bid save). The claim owner, who holds UPDATE on every column through the policy "Homeowners can
    -- update quotes for their claims", never writes them: no client page does. fee_amount is derived from
    -- platform_fee_pct by quotes_normalize_fee_amount(), which fires after this guard and sees what this
    -- guard let through.
    IF COALESCE(
         (NEW.fee_amount IS DISTINCT FROM OLD.fee_amount)
         OR (NEW.fee_percentage IS DISTINCT FROM OLD.fee_percentage)
         OR (NEW.platform_fee_pct IS DISTINCT FROM OLD.platform_fee_pct)
         OR (NEW.platform_fee_basis IS DISTINCT FROM OLD.platform_fee_basis),
         true)
       AND NOT COALESCE(EXISTS (
             SELECT 1 FROM public.contractors k
              WHERE k.id = OLD.contractor_id AND k.user_id = auth.uid()), false) THEN
      RAISE EXCEPTION 'quotes: fee_amount, fee_percentage, platform_fee_pct and platform_fee_basis can only be changed by the bidding contractor, service_role or an admin (gh-2519)'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_bid_window_expiry()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_window_expires_at TIMESTAMPTZ;
BEGIN
  SELECT bid_window_expires_at
  INTO v_window_expires_at
  FROM claims
  WHERE id = NEW.claim_id;

  IF v_window_expires_at IS NOT NULL
    AND v_window_expires_at < NOW()
    AND NEW.renewed_from_quote_id IS NULL
  THEN
    RAISE EXCEPTION
      'Bid window for claim % expired at %. Only renewal bids (renewed_from_quote_id set) are accepted after window expiry.',
      NEW.claim_id, v_window_expires_at
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.accept_bid(p_claim_id uuid, p_quote_id uuid)
 RETURNS TABLE(out_claim_id uuid, out_quote_id uuid, out_contractor_id uuid, out_amount numeric, out_declined_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_contractor uuid; v_amount numeric; v_declined integer; v_has_pm boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'accept_bid: no authenticated user' USING ERRCODE='28000';
  END IF;

  -- Ownership check + row lock: only the claim's own homeowner may accept a bid on it,
  -- and FOR UPDATE OF q takes the lock in the same statement that authorizes the caller,
  -- so two simultaneous accepts on one claim serialize instead of racing.
  SELECT q.contractor_id, q.total_price INTO v_contractor, v_amount
    FROM quotes q JOIN claims c ON c.id = q.claim_id
   WHERE q.id = p_quote_id AND q.claim_id = p_claim_id AND c.user_id = v_uid
   FOR UPDATE OF q;

  IF v_contractor IS NULL THEN
    RAISE EXCEPTION 'accept_bid: quote % is not a bid on claim % owned by the caller',
      p_quote_id, p_claim_id USING ERRCODE='42501';
  END IF;

  -- gh-1532: guard the money path -- a bid cannot be accepted for a contractor
  -- with no payment method on file. The BEFORE UPDATE trigger above is the
  -- enforcement point of record (it also covers the React direct-update path
  -- this RPC's HTML callers do not use); this check exists so bids.html and
  -- contractor-about.html get the same readable, ERRCODE-matchable refusal
  -- before the UPDATE below rather than depending on how the trigger's
  -- exception text surfaces back through this SECURITY DEFINER call.
  SELECT has_payment_method INTO v_has_pm FROM contractors WHERE id = v_contractor;
  IF v_has_pm IS NOT TRUE THEN
    RAISE EXCEPTION 'contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE claims SET selected_contractor_id = v_contractor,
                    selected_bid_amount    = v_amount,
                    status                 = 'awarded',
                    updated_at             = now()
   WHERE id = p_claim_id AND user_id = v_uid;

  UPDATE quotes SET status = 'selected', updated_at = now() WHERE id = p_quote_id;

  WITH d AS (UPDATE quotes q2 SET status = 'declined', updated_at = now()
              WHERE q2.claim_id = p_claim_id AND q2.id <> p_quote_id
                AND q2.status IN ('submitted','draft') RETURNING 1)
  SELECT count(*)::int INTO v_declined FROM d;

  RETURN QUERY SELECT p_claim_id, p_quote_id, v_contractor, v_amount, v_declined;
END $function$;

CREATE OR REPLACE FUNCTION public.apply_referral_commission()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_referral            public.referrals%ROWTYPE;
  v_referrer            public.referral_agents%ROWTYPE;
  v_recruiter           public.referral_agents%ROWTYPE;
  v_referral_approval   UUID;
  v_recruit_approval    UUID;
  v_service_role_key    TEXT;
  v_quote_id            UUID;
  v_total_price         NUMERIC;
BEGIN
  IF NEW.referral_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_referral
    FROM public.referrals
    WHERE id = NEW.referral_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF COALESCE(v_referral.commission_amount, 0) > 0 THEN
    RETURN NEW;
  END IF;

  SELECT id, total_price INTO v_quote_id, v_total_price
    FROM public.quotes
    WHERE claim_id = NEW.id
      AND status IN ('selected', 'awarded')
    ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
    LIMIT 1;

  IF v_quote_id IS NULL OR COALESCE(v_total_price, 0) < 10000 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_referrer
    FROM public.referral_agents
    WHERE id = v_referral.referral_agent_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- ── gh-2479 (ruling #2403 comment 5972625589): three precondition checks,
  -- all before any write. Each one only removes capability: it can turn an
  -- accrual into a no-op, never the reverse.
  -- (a) is_test must agree on claim, referral and referrer. A test claim must
  --     not accrue against a live referral, nor a live claim against a test one.
  IF COALESCE(NEW.is_test, false) IS DISTINCT FROM COALESCE(v_referral.is_test, false)
     OR COALESCE(NEW.is_test, false) IS DISTINCT FROM COALESCE(v_referrer.is_test, false) THEN
    RAISE LOG 'apply_referral_commission: gh-2479 is_test mismatch (claim=% referral=% referrer=%), no accrual for claim_id=% referral_id=%',
      NEW.is_test, v_referral.is_test, v_referrer.is_test, NEW.id, v_referral.id;
    RETURN NEW;
  END IF;

  -- (b) status: only a referral that has been attributed to a claim
  --     (claims_advance_referral moves clicked/registered -> claim_submitted,
  --     and only inside the 30-day window) may accrue. A bare clicked or
  --     registered referral never advanced, so it is expired or unattributed.
  IF v_referral.status IS NULL
     OR v_referral.status NOT IN ('claim_submitted', 'bid_received', 'contract_signed') THEN
    RAISE LOG 'apply_referral_commission: gh-2479 referral status % is not an attributed status, no accrual for claim_id=% referral_id=%',
      v_referral.status, NEW.id, v_referral.id;
    RETURN NEW;
  END IF;

  -- (c) attribution window, measured when the id was stamped on the claim
  --     (claims.created_at, frozen for client callers by the guard), never now() - 30 days at completion: a job that
  --     takes longer than 30 days keeps its commission. A NULL date accrues
  --     nothing (#2403 closes-on item 3).
  IF v_referral.created_at IS NULL
     OR NEW.created_at IS NULL
     OR v_referral.created_at < NEW.created_at - public.referral_attribution_window() THEN
    RAISE LOG 'apply_referral_commission: gh-2479 referral outside attribution window (referral.created_at=% claim.created_at=%), no accrual for claim_id=% referral_id=%',
      v_referral.created_at, NEW.created_at, NEW.id, v_referral.id;
    RETURN NEW;
  END IF;

  -- ── D-333 guard 1: no referral fee to a home_inspector referrer. ──
  IF v_referrer.agent_type IS DISTINCT FROM 'home_inspector' THEN

    UPDATE public.referrals
       SET commission_amount = 200,
           job_value         = v_total_price,
           status            = CASE
                                 WHEN status = 'commission_paid'
                                   THEN status
                                 ELSE 'job_completed'
                               END
     WHERE id = v_referral.id;

    INSERT INTO public.payout_approvals (
      referral_id, payout_type, partner_id, partner_name,
      amount, trigger_event, status, auto_approve_at, is_test
    )
    VALUES (
      v_referral.id,
      'commission_referral',
      v_referrer.id,
      TRIM(COALESCE(v_referrer.first_name, '') || ' ' || COALESCE(v_referrer.last_name, '')),
      200,
      'Job completed — referral ' || v_referral.id::TEXT || ' (claim ' || NEW.id::TEXT || ')',
      'pending_approval',
      NOW() + INTERVAL '7 days',
      COALESCE(NEW.is_test, false)
    )
    RETURNING id INTO v_referral_approval;

  ELSE
    -- D-333: home_inspector referrer — mark the job completed with no
    -- commission so the referral ledger still reflects reality, but accrue
    -- and pay nothing.
    UPDATE public.referrals
       SET job_value = v_total_price,
           status     = CASE
                          WHEN status = 'commission_paid'
                            THEN status
                          ELSE 'job_completed'
                        END
     WHERE id = v_referral.id;

    RAISE LOG 'apply_referral_commission: D-333 no-fee — referrer % is agent_type=home_inspector, no referral fee accrued for referral_id=%',
      v_referrer.id, v_referral.id;
  END IF;

  -- Recruit bonus: gated on the RECRUITER's own agent_type (D-333), not the
  -- referrer's. A non-inspector who recruited a home_inspector still earns
  -- the $50 bonus on that inspector's completed referral — unchanged.
  --
  -- FIXUP (review 5817579721): the inspector-referrer branch above never
  -- sets commission_amount, so the function's only other idempotency check
  -- never trips for it. `recruit_commission_amount = 0` is an independent
  -- idempotency check on the recruit bonus itself, so a second completion
  -- on the same referral cannot pay the $50 bonus twice, no matter what
  -- commission_amount is doing.
  IF v_referrer.recruited_by_id IS NOT NULL
     AND v_referrer.recruited_at IS NOT NULL
     AND v_referral.created_at   >= v_referrer.recruited_at
     AND COALESCE(v_referral.recruit_commission_amount, 0) = 0 THEN

    SELECT * INTO v_recruiter
      FROM public.referral_agents
      WHERE id = v_referrer.recruited_by_id;

    -- ── D-333 guard 2: no recruit bonus to a home_inspector recruiter. ──
    IF FOUND AND v_recruiter.agent_type IS DISTINCT FROM 'home_inspector' THEN

      UPDATE public.referrals
         SET recruit_commission_amount = 50
       WHERE id = v_referral.id;

      UPDATE public.referral_agents
         SET recruit_earnings = COALESCE(recruit_earnings, 0) + 50
       WHERE id = v_referrer.recruited_by_id;

      INSERT INTO public.payout_approvals (
        referral_id, payout_type, partner_id, partner_name,
        amount, trigger_event, status, auto_approve_at, is_test
      )
      VALUES (
        v_referral.id,
        'commission_recruit',
        v_referrer.recruited_by_id,
        TRIM(COALESCE(v_recruiter.first_name, '') || ' ' || COALESCE(v_recruiter.last_name, '')),
        50,
        'Recruit bonus — referral ' || v_referral.id::TEXT || ' (referrer: ' || TRIM(COALESCE(v_referrer.first_name, '') || ' ' || COALESCE(v_referrer.last_name, '')) || ')',
        'pending_approval',
        NOW() + INTERVAL '7 days',
        COALESCE(NEW.is_test, false)
      )
      RETURNING id INTO v_recruit_approval;

    ELSIF FOUND THEN
      RAISE LOG 'apply_referral_commission: D-333 no-fee — recruiter % is agent_type=home_inspector, no recruit bonus accrued for referral_id=%',
        v_recruiter.id, v_referral.id;
    END IF;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO v_service_role_key
      FROM vault.decrypted_secrets
     WHERE name = 'cron_service_role_key';

    IF v_service_role_key IS NULL THEN
      RAISE LOG 'apply_referral_commission: vault secret cron_service_role_key not found — skipping notify-payout-pending for approval_id=%', v_referral_approval;
    ELSIF v_referral_approval IS NOT NULL THEN
      PERFORM net.http_post(
        url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/notify-payout-pending',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || v_service_role_key
        ),
        body    := jsonb_build_object(
          'payout_approval_id', v_referral_approval
        )
      );
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE LOG 'apply_referral_commission: pg_net call to notify-payout-pending failed (non-fatal). approval_id=% sqlstate=% sqlerrm=%',
        v_referral_approval, SQLSTATE, SQLERRM;
  END;

  -- FIXUP (review 5817579721 item 2, D-333): a home_inspector referrer must
  -- not trigger send-partner-status-email, which tells the partner "your
  -- referral fee/payment is on its way" — an inspector accrues no fee and
  -- gets no such message. A non-inspector referral is unaffected (control).
  IF v_referrer.agent_type IS DISTINCT FROM 'home_inspector' THEN
    BEGIN
      IF v_service_role_key IS NULL THEN
        SELECT decrypted_secret INTO v_service_role_key
          FROM vault.decrypted_secrets
         WHERE name = 'cron_service_role_key';
      END IF;

      IF v_service_role_key IS NULL THEN
        RAISE LOG 'apply_referral_commission: vault secret cron_service_role_key not found — skipping send-partner-status-email for referral_id=%', v_referral.id;
      ELSE
        PERFORM net.http_post(
          url     := 'https://yeszghaspzwwstvsrioa.supabase.co/functions/v1/send-partner-status-email',
          headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'Authorization', 'Bearer ' || v_service_role_key
          ),
          body    := jsonb_build_object('referral_id', v_referral.id)
        );
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE LOG 'apply_referral_commission: pg_net call to send-partner-status-email failed (non-fatal) for referral_id=% sqlstate=% sqlerrm=%',
          v_referral.id, SQLSTATE, SQLERRM;
    END;
  ELSE
    RAISE LOG 'apply_referral_commission: D-333 no-fee — referrer % is agent_type=home_inspector, skipping send-partner-status-email for referral_id=%',
      v_referrer.id, v_referral.id;
  END IF;

  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'apply_referral_commission failed for claim_id=% referral_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.referral_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_referral_commission()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_referral      public.referrals%ROWTYPE;
  v_referrer      public.referral_agents%ROWTYPE;
  v_recruit_amt   DECIMAL(10,2);
  v_voided_count  integer;
BEGIN
  SELECT * INTO v_referral
    FROM public.referrals
    WHERE claim_id = NEW.claim_id
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF COALESCE(v_referral.commission_amount, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF v_referral.commission_paid_at IS NOT NULL THEN
    RAISE LOG 'reverse_referral_commission: SKIPPING reversal — commission already paid. quote_id=% claim_id=% referral_id=% commission_amount=% commission_paid_at=% — FLAGGED FOR MANUAL REVIEW',
      NEW.id, NEW.claim_id, v_referral.id,
      v_referral.commission_amount, v_referral.commission_paid_at;
    RETURN NEW;
  END IF;

  v_recruit_amt := COALESCE(v_referral.recruit_commission_amount, 0);

  IF v_recruit_amt > 0 THEN
    SELECT * INTO v_referrer
      FROM public.referral_agents
      WHERE id = v_referral.referral_agent_id;

    IF FOUND AND v_referrer.recruited_by_id IS NOT NULL THEN
      UPDATE public.referral_agents
         SET recruit_earnings = GREATEST(COALESCE(recruit_earnings, 0) - v_recruit_amt, 0)
       WHERE id = v_referrer.recruited_by_id;
    END IF;
  END IF;

  UPDATE public.referrals
     SET commission_amount         = 0,
         recruit_commission_amount = 0,
         job_value                 = NULL,
         status                    = CASE
                                        WHEN status = 'job_completed'
                                          THEN 'contract_signed'
                                        ELSE status
                                      END
   WHERE id = v_referral.id;

  UPDATE public.payout_approvals
     SET status            = 'rejected',
         rejected_at       = now(),
         rejection_reason  = 'Auto-voided by reverse_referral_commission: underlying referral commission was reversed/refunded on ' || to_char(now(), 'YYYY-MM-DD') || '.'
   WHERE referral_id = v_referral.id
     AND status = 'pending_approval';
  GET DIAGNOSTICS v_voided_count = ROW_COUNT;

  IF v_voided_count > 0 THEN
    RAISE LOG 'reverse_referral_commission: voided % pending payout_approvals row(s) for referral_id=%',
      v_voided_count, v_referral.id;
  END IF;

  RETURN NEW;

EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'reverse_referral_commission failed for quote_id=% claim_id=% sqlstate=% sqlerrm=%',
      NEW.id, NEW.claim_id, SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claims_enforce_payment_method_on_award()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_has_pm boolean;
BEGIN
  IF NEW.status = 'awarded' AND OLD.status IS DISTINCT FROM 'awarded' THEN
    IF NEW.selected_contractor_id IS NULL THEN
      RAISE EXCEPTION 'contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet'
        USING ERRCODE = 'P0001';
    END IF;

    SELECT has_payment_method INTO v_has_pm
      FROM public.contractors
     WHERE id = NEW.selected_contractor_id;

    IF v_has_pm IS NOT TRUE THEN
      RAISE EXCEPTION 'contractor_no_payment_method: the selected contractor has not added a payment method, so this bid cannot be accepted yet'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claims_guard_referral_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT COALESCE(public.is_admin_email(), false) THEN
    IF TG_OP = 'INSERT' THEN
      -- the window anchor is server time, never a browser-supplied value
      NEW.created_at := now();
      -- gh-2479 born state: a client-created claim starts at the beginning of the flow
      IF COALESCE(NEW.status NOT IN ('documents_needed', 'draft'), true)
         OR NEW.selected_contractor_id IS NOT NULL
         OR NEW.selected_bid_amount IS NOT NULL
         OR NEW.completion_date IS NOT NULL
         OR NEW.contract_signed_at IS NOT NULL THEN
        RAISE EXCEPTION 'claims: a new claim must start in its initial state; status, selected contractor, bid amount, signing and completion are set later by the platform (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      IF COALESCE(
           (NEW.referral_id IS DISTINCT FROM OLD.referral_id)
           OR (NEW.completion_date IS DISTINCT FROM OLD.completion_date)
           OR (NEW.created_at IS DISTINCT FROM OLD.created_at),
           true) THEN
        RAISE EXCEPTION 'claims: referral_id, completion_date and created_at can only be changed by service_role or an admin (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
      -- gh-2479 born state: without this an initial-state INSERT plus one UPDATE reaches the same row
      IF COALESCE(NEW.status IS DISTINCT FROM OLD.status, true)
         AND NOT COALESCE(NEW.status IN ('active', 'waitlisted', 'submitted', 'awarded'), false) THEN
        RAISE EXCEPTION 'claims: status can only be changed to active, waitlisted, submitted or awarded by the claim owner; other changes need service_role or an admin (gh-2479)'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

CREATE TRIGGER quotes_guard_homeowner_columns BEFORE INSERT OR UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION quotes_guard_homeowner_columns();

CREATE TRIGGER quotes_normalize_fee_amount BEFORE INSERT OR UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION normalize_quotes_fee_amount();

CREATE TRIGGER set_updated_at_quotes BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_enforce_bid_window_expiry BEFORE INSERT ON public.quotes FOR EACH ROW EXECUTE FUNCTION enforce_bid_window_expiry();

CREATE TRIGGER after_quote_refunded AFTER UPDATE OF payment_status ON public.quotes FOR EACH ROW WHEN (((new.payment_status = 'refunded'::text) AND (old.payment_status IS DISTINCT FROM 'refunded'::text))) EXECUTE FUNCTION reverse_referral_commission();

CREATE TRIGGER after_claim_completed AFTER UPDATE OF completion_date ON public.claims FOR EACH ROW WHEN (((new.completion_date IS NOT NULL) AND (old.completion_date IS NULL))) EXECUTE FUNCTION apply_referral_commission();

CREATE TRIGGER claims_guard_referral_columns BEFORE INSERT OR UPDATE ON public.claims FOR EACH ROW EXECUTE FUNCTION claims_guard_referral_columns();

CREATE TRIGGER claims_payment_method_guard BEFORE UPDATE ON public.claims FOR EACH ROW EXECUTE FUNCTION claims_enforce_payment_method_on_award();

CREATE TRIGGER claims_updated_at BEFORE UPDATE ON public.claims FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.contractors ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.payout_approvals ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.platform_fee_config ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.quotes ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.referral_agents ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Contractors can view biddable claims" ON public.claims AS PERMISSIVE FOR SELECT TO public USING (((ready_for_bids = true) AND (status = ANY (ARRAY['active'::text, 'bidding'::text, 'pending'::text])) AND (( SELECT auth.uid() AS uid) IN ( SELECT contractors.user_id
   FROM contractors
  WHERE (contractors.status = 'active'::text))) AND ((is_test = false) OR ((is_test = true) AND (( SELECT auth.uid() AS uid) IN ( SELECT contractors.user_id
   FROM contractors
  WHERE ((contractors.status = 'active'::text) AND (contractors.is_test = true))))))));

CREATE POLICY "Contractors can view claims for their quotes" ON public.claims AS PERMISSIVE FOR SELECT TO authenticated USING ((id IN ( SELECT get_contractor_quote_claim_ids(( SELECT auth.uid() AS uid)) AS get_contractor_quote_claim_ids)));

CREATE POLICY "Users can delete own claims" ON public.claims AS PERMISSIVE FOR DELETE TO public USING ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "Users can insert own claims" ON public.claims AS PERMISSIVE FOR INSERT TO public WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "Users can update own claims" ON public.claims AS PERMISSIVE FOR UPDATE TO public USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "Users can view own claims" ON public.claims AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "claims_admin_select" ON public.claims AS PERMISSIVE FOR SELECT TO public USING (is_admin_email());

CREATE POLICY "claims_admin_update" ON public.claims AS PERMISSIVE FOR UPDATE TO public USING (is_admin_email()) WITH CHECK (is_admin_email());

CREATE POLICY "Admin can read all contractors" ON public.contractors AS PERMISSIVE FOR SELECT TO authenticated USING (((auth.jwt() ->> 'email'::text) = 'dustinstohler1@gmail.com'::text));

CREATE POLICY "Contractors can insert own profile" ON public.contractors AS PERMISSIVE FOR INSERT TO public WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "Contractors can read own record" ON public.contractors AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = auth.uid()));

CREATE POLICY "Contractors can update own profile" ON public.contractors AS PERMISSIVE FOR UPDATE TO public USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "admin_update_contractors" ON public.contractors AS PERMISSIVE FOR UPDATE TO public USING (((auth.jwt() ->> 'email'::text) = 'dustinstohler1@gmail.com'::text));

CREATE POLICY "Admin full access payout_approvals" ON public.payout_approvals AS PERMISSIVE FOR ALL TO public USING (is_admin_email());

CREATE POLICY "Partners read own payout_approvals" ON public.payout_approvals AS PERMISSIVE FOR SELECT TO public USING ((partner_id IN ( SELECT referral_agents.id
   FROM referral_agents
  WHERE (referral_agents.user_id = ( SELECT auth.uid() AS uid)))));

CREATE POLICY "Admin can manage fee config" ON public.platform_fee_config AS PERMISSIVE FOR ALL TO public USING (is_admin_email()) WITH CHECK (is_admin_email());

CREATE POLICY "Contractors can insert quotes" ON public.quotes AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((contractor_id IN ( SELECT contractors.id
   FROM contractors
  WHERE (contractors.user_id = ( SELECT auth.uid() AS uid)))) AND contractor_can_bid(contractor_id)));

CREATE POLICY "Contractors can read own quotes" ON public.quotes AS PERMISSIVE FOR SELECT TO authenticated USING ((contractor_id IN ( SELECT contractors.id
   FROM contractors
  WHERE (contractors.user_id = ( SELECT auth.uid() AS uid)))));

CREATE POLICY "Contractors can update own quotes" ON public.quotes AS PERMISSIVE FOR UPDATE TO authenticated USING ((contractor_id IN ( SELECT contractors.id
   FROM contractors
  WHERE (contractors.user_id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((contractor_id IN ( SELECT contractors.id
   FROM contractors
  WHERE (contractors.user_id = ( SELECT auth.uid() AS uid)))));

CREATE POLICY "Homeowners can read quotes for their claims" ON public.quotes AS PERMISSIVE FOR SELECT TO authenticated USING ((claim_id IN ( SELECT claims.id
   FROM claims
  WHERE (claims.user_id = ( SELECT auth.uid() AS uid)))));

CREATE POLICY "Homeowners can update quotes for their claims" ON public.quotes AS PERMISSIVE FOR UPDATE TO authenticated USING ((claim_id IN ( SELECT claims.id
   FROM claims
  WHERE (claims.user_id = ( SELECT auth.uid() AS uid))))) WITH CHECK ((claim_id IN ( SELECT claims.id
   FROM claims
  WHERE (claims.user_id = ( SELECT auth.uid() AS uid)))));

CREATE POLICY "Admin can read all referral agents" ON public.referral_agents AS PERMISSIVE FOR SELECT TO authenticated USING (is_admin_email());

CREATE POLICY "Admin can update referral agents" ON public.referral_agents AS PERMISSIVE FOR UPDATE TO authenticated USING (is_admin_email()) WITH CHECK (is_admin_email());

CREATE POLICY "Agents can update own profile" ON public.referral_agents AS PERMISSIVE FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));

CREATE POLICY "Agents can view own profile" ON public.referral_agents AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = auth.uid()));

CREATE POLICY "Authenticated can claim unclaimed partner record" ON public.referral_agents AS PERMISSIVE FOR UPDATE TO public USING (((user_id IS NULL) AND (email = (auth.jwt() ->> 'email'::text)))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

CREATE POLICY "Partners can read their recruits" ON public.referral_agents AS PERMISSIVE FOR SELECT TO authenticated USING ((recruited_by_id = get_own_referral_agent_id()));

CREATE POLICY "Service role full access" ON public.referral_agents AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));

CREATE POLICY "Agents can read own referrals" ON public.referrals AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1
   FROM referral_agents
  WHERE ((referral_agents.id = referrals.referral_agent_id) AND (referral_agents.user_id = ( SELECT auth.uid() AS uid))))));

CREATE POLICY "Service role full access" ON public.referrals AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.claims TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.claims TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.claims TO service_role;

GRANT INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.contractors TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.contractors TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.contractors TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payout_approvals TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payout_approvals TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.payout_approvals TO service_role;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.platform_fee_config TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.platform_fee_config TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.platform_fee_config TO service_role;

GRANT REFERENCES, SELECT, TRIGGER, TRUNCATE ON public.quotes TO anon;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.quotes TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.quotes TO service_role;

GRANT SELECT ON public.referral_agents TO anon;

GRANT SELECT, UPDATE ON public.referral_agents TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.referral_agents TO service_role;

GRANT DELETE, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.referrals TO anon;

GRANT DELETE, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.referrals TO authenticated;

GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.referrals TO service_role;
