# ADR-009: React Data Contracts for OtterQuote Platform

**Status:** DRAFT (awaiting GC review)  
**Date:** 2026-05-05  
**Decision Drivers:** D-211 (React Scaffold), D-181 (Stripe Verification), D-205 (Hover Deliverable Type), F-007 (Auth Pattern)  
**Author:** Claude (AI Assistant)  
**Reviewer:** dustinstohler (GC - Legal + Architecture)

---

## 1. Overview

This document specifies the complete data contracts between the OtterQuote React application and the Supabase backend. It covers:

- **48 PostgreSQL tables** with column schemas, RLS policies, and access patterns
- **48 deployed Edge Functions** with request/response shapes and rate limiting
- **Auth-based Row-Level Security (RLS)** policies enforcing user/contractor/admin scopes
- **Legally-bound strings** (IC attestations, fee disclosures, TOS language) requiring hard reference
- **Open questions** for legal/compliance review before React data layer implementation

**Scope:** Public schema tables only. Auth/email auth table schemas are handled by Supabase Auth and not duplicated here.

---

## 2. Core Tables & RLS Policies

### 2.1 Claims Table (Primary Entity)

**Purpose:** Damage claim lifecycle from submission through contractor selection, bid management, contract signing, and completion.

**Key Columns (98 total):**

| Column | Type | RLS Access | Purpose |
|--------|------|-----------|---------|
| `id` | uuid | Public read for bidding contractors | Claim identifier |
| `user_id` | uuid | User-scoped (auth.uid() = user_id) | Homeowner owner |
| `claim_number` | text | User-scoped read | Formatted claim ID for UX |
| `status` | text | User-scoped; contractor visibility when ready_for_bids=true | enum: pending_measurement, bids_requested, contractor_selected, contract_signed, completed, archived |
| `created_at`, `updated_at` | timestamp | User-scoped | Audit timestamps |
| **Hover Integration** | | | |
| `hover_order_id` | text | User-scoped | Hover capture_request_id from /capture endpoint |
| `hover_status` | text | User-scoped | Hover job state: pending, in_progress, completed, failed |
| `hover_paid` | boolean | User-scoped | Payment processed for measurement ($79 via create-payment-intent) |
| `hover_rebated` | boolean | User-scoped | Rebate released to homeowner if applicable |
| **Material Selection** | | | |
| `designer_product` | text | User-scoped | Selected roofing product name |
| `designer_manufacturer` | text | User-scoped | Manufacturer (e.g., "CertainTeed") |
| `metal_type` | text | User-scoped | Metal type (e.g., "Aluminum") for metal roofing |
| `color_brand`, `color_name` | text | User-scoped | Color selection from manufacturer catalog |
| **Bid Management** | | | |
| `ready_for_bids` | boolean | Public read (contractor visibility) | Gates contractor visibility in bid list |
| `bids_submitted_at` | timestamp | User-scoped | When bidding opened for contractors |
| `selected_contractor_id` | uuid | User-scoped | FK to contractors(id) after homeowner selection |
| **Financial** | | | |
| `deductible_amount` | numeric(10,2) | User-scoped | Homeowner insurance deductible |
| `platform_fee_charged` | boolean | User-scoped | Whether platform fee will be applied |
| `platform_fee_amount` | numeric(10,2) | User-scoped | Calculated platform fee amount |
| **Contract & Signing** | | | |
| `contract_signed_at` | timestamp | User-scoped | Contractor + homeowner signed at |
| `docusign_envelope_id` | text | User-scoped | DocuSign envelope ID for main contract |
| `color_confirmation_envelope_id` | text | User-scoped | DocuSign envelope for color confirmation |
| `project_confirmation_envelope_id` | text | User-scoped | DocuSign envelope for project scope confirmation |
| **Line Items & Scope** | | | |
| `parsed_line_items` | jsonb | User-scoped | Array of {material, quantity, unit_price, tax} from loss sheet |
| `contractor_scope_summary` | text | User-scoped | Contractor-written scope description |
| `loss_sheet_parsed_at` | timestamp | User-scoped | When loss sheet parsing completed |
| **Referral Tracking** | | | |
| `referral_code`, `referral_id`, `referral_source`, `referral_agent_id` | text/uuid | User-scoped | Partner/agent attribution |
| **Contractor Lifecycle** | | | |
| `contractor_switched_at` | timestamp | User-scoped | When homeowner switched contractors |
| `contractor_switch_count` | integer | User-scoped | Number of switches (audit) |
| **Bid Windows (by trade)** | | | |
| `roofing_bid_released_at`, `siding_bid_released_at`, `gutters_bid_released_at`, `windows_bid_released_at` | timestamp | User-scoped; contractor visibility when claim ready_for_bids=true | Per-trade bid window open times |
| `bid_window_expires_at` | timestamp | User-scoped | Global bid expiration |
| **Completion** | | | |
| `completion_date` | date | User-scoped | Project completion date |

**RLS Policies:**

```sql
-- Users can read/write their own claims
CREATE POLICY "users_own_claims" ON claims
  FOR ALL USING (auth.uid() = user_id);

-- Contractors can read claims where ready_for_bids = true AND status = 'bids_requested'
CREATE POLICY "contractors_read_bidding_claims" ON claims
  FOR SELECT USING (
    ready_for_bids = true AND
    EXISTS (
      SELECT 1 FROM contractors
      WHERE contractors.user_id = auth.uid()
        AND (contractors.id = ANY(claims.id::text[]) OR true) -- flexible bidding scope
    )
  );

-- Service role (Edge Functions) full access
CREATE POLICY "service_role_all" ON claims
  FOR ALL USING (auth.role() = 'service_role'::text);
```

**React Read Patterns:**
- Homeowner dashboard: fetch claims by user_id, filter by status
- Bid list: contractors fetch claims where ready_for_bids=true
- Claim detail: user_id-scoped single-claim fetch with related quotes, activity_log, messages

**React Write Patterns:**
- Create claim: insert with user_id (RLS enforced)
- Update status: user-scoped, or service_role via Edge Function
- Select contractor: update selected_contractor_id (user-scoped)
- Switch contractor: update contractor_switched_at (user-scoped, or via switch-contractor Edge Function)

---

### 2.2 Quotes Table (Contractor Bids)

**Purpose:** Individual contractor bids (quotes) for a claim. Multiple quotes per claim, one quote per contractor.

**Key Columns (48 total):**

| Column | Type | RLS Access | Purpose |
|--------|------|-----------|---------|
| `id` | uuid | Claim-scoped (via FK claim_id) | Quote identifier |
| `claim_id` | uuid | Claim-scoped | FK to claims(id) |
| `contractor_id` | uuid | Contractor-scoped + claim-scoped | FK to contractors(id) |
| `total_price` | numeric(10,2) | Claim-scoped | Total bid amount |
| `status` | text | Claim-scoped | enum: pending, submitted, accepted, rejected, expired, auto_renewed |
| `created_at`, `updated_at` | timestamp | Claim-scoped | Audit |
| **Pricing & Fees** | | | |
| `fee_percentage`, `fee_amount`, `fee_agreed`, `fee_agreed_at` | numeric/boolean/timestamp | Claim-scoped | Platform fee negotiation |
| `platform_fee_pct`, `platform_fee_basis` | numeric/text | Claim-scoped | Fee calculation (percentage or flat; basis: quote_total, insurance_approved, etc.) |
| **Scope** | | | |
| `scope_summary` | text | Claim-scoped | Contractor description of work |
| `notes` | text | Claim-scoped | Additional notes |
| `trade_type` | text | Claim-scoped | enum: roofing, siding, gutters, windows, etc. |
| `is_bundled_bid`, `bundled_trades` | boolean/text[] | Claim-scoped | Multi-trade bundled bid |
| `per_trade_breakdown` | jsonb | Claim-scoped | Array of {trade, price, description} |
| `value_adds` | jsonb | Claim-scoped | Array of {name, description, price, included} |
| **Material Selection** | | | |
| `material_selection` | jsonb | Claim-scoped | {product, manufacturer, color, grade, warranty_years} |
| `warranty_option_id` | uuid | Claim-scoped | FK to warranty_options(id) |
| `warranty_snapshot` | jsonb | Claim-scoped | Snapshot of warranty terms at quote time |
| **Warranty** | | | |
| `workmanship_warranty_years` | integer | Claim-scoped | Contractor workmanship guarantee period |
| `warranty_document_url` | text | Claim-scoped | URL to contractor warranty doc |
| `warranty_uploaded_at` | timestamp | Claim-scoped | When warranty document uploaded |
| **Signing** | | | |
| `docusign_envelope_id` | text | Claim-scoped | DocuSign contract envelope ID |
| `contractor_signed_at`, `homeowner_signed_at` | timestamp | Claim-scoped | Signature timestamps |
| **Payment** | | | |
| `payment_intent_id` | text | Claim-scoped | FK to Stripe PaymentIntent |
| `payment_status` | text | Claim-scoped | enum: requires_action, succeeded, processing |
| `payment_method_id` | text | Claim-scoped | FK to Stripe PaymentMethod |
| `payment_method_type` | text | Claim-scoped | enum: card, us_bank_account, ach_credit_transfer |
| `card_fee_cents` | integer | Claim-scoped | Surcharge applied to card payments (2.9% + $0.30) |
| **Lifecycle** | | | |
| `bid_status` | text | Claim-scoped | enum: auto_generated, manually_submitted |
| `is_auto_bid` | boolean | Claim-scoped | True if generated by contractor auto_bid_enabled settings |
| `cancelled_at`, `cancellation_reason` | timestamp/text | Claim-scoped | When/why quote was cancelled |
| `expires_at`, `auto_renew` | timestamp/boolean | Claim-scoped | Quote expiration + auto-renew flag |
| `renewed_from_quote_id` | uuid | Claim-scoped | FK to previous quote if auto-renewed |
| `expired_at` | timestamp | Claim-scoped | When quote actually expired |
| **Decking (Roofing-specific)** | | | |
| `decking_price_per_sheet`, `full_redeck_price`, `supplement_acknowledged` | numeric/boolean | Claim-scoped | Roofing decking supplement pricing |

**RLS Policies:**

```sql
-- Users can read quotes for their claims
CREATE POLICY "users_read_claim_quotes" ON quotes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM claims
      WHERE claims.id = quotes.claim_id
        AND claims.user_id = auth.uid()
    )
  );

-- Contractors can read/write quotes they created
CREATE POLICY "contractors_own_quotes" ON quotes
  FOR ALL USING (
    contractor_id IN (
      SELECT contractors.id FROM contractors
      WHERE contractors.user_id = auth.uid()
    )
  );

-- Service role full access
CREATE POLICY "service_role_all" ON quotes
  FOR ALL USING (auth.role() = 'service_role'::text);
```

**React Read Patterns:**
- Bid list for homeowner: fetch quotes for claim_id, order by created_at DESC
- Contractor bid detail: contractor reads their own quotes for a claim
- Payment status check: read payment_intent_id + payment_status

**React Write Patterns:**
- Submit bid: insert quote with contractor_id, claim_id, pricing (contractor-scoped RLS)
- Accept bid: user updates claim.selected_contractor_id (claim-scoped RLS)
- Update pricing: contractor updates total_price, fee_amount (contractor-scoped)
- Sign contract: update docusign_envelope_id, contractor_signed_at (contractor-scoped after DocuSign webhook)

---

### 2.3 Contractors Table (Service Providers)

**Purpose:** Contractor profiles, insurance, payment methods, contract templates, and onboarding status.

**Key Columns (98 total):**

| Column | Type | RLS Access | Purpose |
|--------|------|-----------|---------|
| `id` | uuid | Contractor-scoped + claim-scoped | Contractor identifier |
| `user_id` | uuid | Contractor-scoped | FK to auth.users(id) |
| `company_name` | text | Public read (bid visibility) | Company legal name |
| `contact_name`, `email`, `phone` | text | Contractor-scoped; public read for bids | Contact info |
| `license_number` | text | Contractor-scoped | State contractor license |
| **Profile** | | | |
| `about_us`, `why_choose_us` | text | Public read | Marketing copy |
| `owner_photo_url` | text | Public read | Profile image URL |
| `website_url` | text | Public read | Contractor website |
| `address_line1`, `address_city`, `address_state`, `address_zip` | text | Contractor-scoped | Business address |
| **Operations** | | | |
| `specialties`, `trades` | text[] | Public read | Service offerings (e.g., ["roofing", "siding"]) |
| `service_counties` | text[] | Public read | Counties served |
| `service_area_description` | text | Public read | Formatted service area |
| `preferred_brands` | text[] | Contractor-scoped | Preferred material brands |
| `notification_emails`, `notification_phones` | text[] | Contractor-scoped | Notification recipients |
| **Insurance & Verification** | | | |
| `has_workers_comp`, `has_general_liability` | boolean | Contractor-scoped | Insurance flags |
| `gl_carrier`, `gl_policy_number`, `gl_coverage_amount`, `gl_expiration_date` | text/numeric/date | Contractor-scoped | GL insurance details |
| `wc_carrier`, `wc_policy_number`, `wc_coverage_amount`, `wc_expiration_date` | text/numeric/date | Contractor-scoped | Workers comp details |
| **Certificates** | | | |
| `coi_file_url` | text | Contractor-scoped | Certificate of Insurance URL |
| `coi_expires_at`, `coi_uploaded_at` | timestamp | Contractor-scoped | COI expiration + upload time |
| `coi_insurer`, `coi_policy_number` | text | Contractor-scoped | COI metadata |
| `coi_reminder_60_sent_at`, `coi_reminder_30_sent_at`, `coi_reminder_7_sent_at` | timestamp | Service-role (for reminder job) | Reminder tracking |
| `ic_24511_attestation` | jsonb | Contractor-scoped | Independent Contractor (IC) 24/5/11 attestation (see 3.2 Legal Strings) |
| `attestation_accepted_at` | timestamp | Contractor-scoped | When contractor accepted IC attestation |
| **Onboarding** | | | |
| `onboarding_step` | text | Contractor-scoped | enum: profile, insurance, agreement, payment, complete |
| `status` | text | Contractor-scoped | enum: pending, active, suspended, rejected, archived |
| `approved_at`, `rejected_at`, `rejection_reason` | timestamp/text | Service-role (admin) | Approval audit |
| `agreement_accepted_at`, `agreement_version` | timestamp/text | Contractor-scoped | Terms of Service acceptance |
| `attestation_signer_name`, `attestation_signer_title` | text | Contractor-scoped | Attestation signer identity |
| **Payment** | | | |
| `stripe_customer_id` | text | Service-role | FK to Stripe Customer |
| `stripe_payment_method_id` | text | Service-role | Default PaymentMethod ID |
| `stripe_payment_method_last4`, `stripe_payment_method_brand` | text | Contractor-scoped | Card/ACH display info (e.g., "4242", "Visa") |
| `has_payment_method` | boolean | Contractor-scoped | Whether payment method on file |
| **Templates** | | | |
| `contract_pdf_url` | text | Contractor-scoped | Custom contract template |
| `auto_bid_enabled` | boolean | Contractor-scoped | Enable auto-bidding |
| `auto_bid_settings` | jsonb | Contractor-scoped | {max_claims_per_month, allowed_trades, allowed_counties, price_adjustment_pct} |
| `contract_templates` | jsonb | Contractor-scoped | Array of {name, url, active} |
| `color_confirmation_template` | jsonb | Contractor-scoped | Color confirmation email template |
| `template_review_role` | text | Service-role (admin) | Role that reviewed templates (enum: admin, legal) |
| **Metadata** | | | |
| `rating`, `review_count`, `verified` | numeric/integer/boolean | Public read | Reputation metrics |
| `years_in_business`, `num_employees` | integer | Public read | Business size |
| `repairs_accepted`, `guarantee_accepted` | boolean | Contractor-scoped | Repair + guarantee policy flags |
| `color_selection_enabled` | boolean | Public read | Whether contractor handles color selection |
| `default_auto_renew` | boolean | Contractor-scoped | Auto-renew quotes by default |
| `cpa_version`, `cpa_accepted_at` | text/timestamp | Contractor-scoped | Contractor Performance Agreement version + acceptance |
| `created_at`, `updated_at` | timestamp | Service-role (audit) | Audit timestamps |

**RLS Policies:**

```sql
-- Contractors can read/write their own profile
CREATE POLICY "contractors_own_profile" ON contractors
  FOR ALL USING (auth.uid() = user_id);

-- Public can read active contractor profiles (for bidding visibility)
CREATE POLICY "public_read_active_contractors" ON contractors
  FOR SELECT USING (status = 'active');

-- Service role full access
CREATE POLICY "service_role_all" ON contractors
  FOR ALL USING (auth.role() = 'service_role'::text);
```

**React Read Patterns:**
- Homeowner bid list: fetch active contractors with trades matching claim.trade_type
- Contractor profile: public read of company info, photo, specialties, rating
- Contractor dashboard: fetch own contractor record (contractor-scoped)

**React Write Patterns:**
- Profile update: contractor updates company_name, specialties, service_area (contractor-scoped)
- Payment method: contractor updates stripe_payment_method_* (service-role only via Edge Function)
- Template upload: contractor updates contract_pdf_url, color_confirmation_template (contractor-scoped)
- Onboarding: contractor updates onboarding_step, agreement_accepted_at (contractor-scoped)

---

### 2.4 Profiles Table (Homeowners)

**Purpose:** Homeowner identity and referral tracking.

**Key Columns (16 total):**

| Column | Type | RLS Access | Purpose |
|--------|------|-----------|---------|
| `id` | uuid | User-scoped (auth.uid() = id) | Homeowner identifier (= auth.users.id) |
| `full_name`, `email`, `phone` | text | User-scoped | Identity |
| `role` | text | User-scoped | enum: homeowner, contractor, admin |
| **Address** | | | |
| `address_street`, `address_city`, `address_state`, `address_zip` | text | User-scoped | Primary address |
| **Referral** | | | |
| `referral_source` | text | User-scoped | enum: organic, partner, agent, ad |
| `referring_agent_name`, `referring_agent_email` | text | User-scoped | Agent attribution |
| **Consent** | | | |
| `sms_consent_ts` | timestamp | User-scoped | SMS opt-in timestamp |
| **Metadata** | | | |
| `is_test` | boolean | Service-role (admin/test flagging) | Test account flag |
| `created_at`, `updated_at` | timestamp | User-scoped | Audit |

**RLS Policies:**

```sql
-- Users can read/write their own profile
CREATE POLICY "users_own_profile" ON profiles
  FOR ALL USING (auth.uid() = id);

-- Service role full access
CREATE POLICY "service_role_all" ON profiles
  FOR ALL USING (auth.role() = 'service_role'::text);
```

**React Read/Write Patterns:**
- Profile dashboard: fetch + update own profile (user-scoped)
- Referral tracking: read referral_source + agent info for analytics

---

### 2.5 Fee Acceptances Table (Compliance)

**Purpose:** Track contractor fee acceptance for platform fees. **Legally critical for proof of informed consent.**

**Key Columns (14 total):**

| Column | Type | RLS Access | Purpose |
|--------|------|-----------|---------|
| `id` | uuid | Claim-scoped | Record identifier |
| `contractor_id` | uuid | Contractor-scoped + claim-scoped | FK to contractors(id) |
| `claim_id` | uuid | Claim-scoped | FK to claims(id) |
| `bid_id` | uuid | Claim-scoped | FK to quotes(id) |
| `fee_pct` | numeric(4,2) | Claim-scoped | Fee percentage at acceptance time |
| `fee_basis` | text | Claim-scoped | Basis (e.g., "quote_total", "insurance_approved_amount") |
| `fee_amount` | numeric(10,2) | Claim-scoped | Calculated fee amount |
| `fee_text_displayed` | text | Claim-scoped | **LEGALLY CRITICAL:** Exact fee disclosure text shown to contractor |
| `accepted_at` | timestamp | Claim-scoped | Acceptance timestamp |
| `ip_address` | inet | Claim-scoped | Contractor's IP address (audit trail) |
| `user_agent` | text | Claim-scoped | Browser user agent (audit trail) |
| `invoice_url` | text | Claim-scoped | URL to invoice/receipt |
| `rescinded_at`, `rescission_reason` | timestamp/text | Service-role (admin only) | Rescission (cancellation) of acceptance |
| `created_at` | timestamp | Service-role (audit) | Record creation time |

**RLS Policies:**

```sql
-- Contractors can read their own fee acceptances
CREATE POLICY "contractors_read_own_acceptances" ON fee_acceptances
  FOR SELECT USING (
    contractor_id IN (
      SELECT contractors.id FROM contractors
      WHERE contractors.user_id = auth.uid()
    )
  );

-- Users can read fee acceptances for their claims
CREATE POLICY "users_read_claim_acceptances" ON fee_acceptances
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM claims
      WHERE claims.id = fee_acceptances.claim_id
        AND claims.user_id = auth.uid()
    )
  );

-- Service role full access (for Edge Functions recording acceptances)
CREATE POLICY "service_role_all" ON fee_acceptances
  FOR ALL USING (auth.role() = 'service_role'::text);
```

**React Read Patterns:**
- Contractor fee history: fetch acceptances by contractor_id (contractor-scoped)
- Claim fee audit: user views fee_acceptances for claim (claim-scoped, read-only)

**React Write Patterns:**
- Record acceptance: insert via service-role Edge Function only (never client-side)
- Audit compliance: fee_text_displayed must match legally-reviewed string (see 3.2)

---

### 2.6 Activity Log Table (Audit Trail)

**Purpose:** Event audit trail for claims, quotes, and contractor actions.

**Key Columns (6 total):**

| Column | Type | RLS Access | Purpose |
|--------|------|-----------|---------|
| `id` | uuid | Associated entity scoped | Record identifier |
| `user_id` | uuid | User-scoped + service-role | FK to auth.users(id) or NULL for system events |
| `event_type` | text | Associated entity scoped | enum: claim_created, quote_submitted, contract_signed, coi_uploaded, fee_accepted, etc. |
| `title` | text | Associated entity scoped | Human-readable event summary |
| `metadata` | jsonb | Associated entity scoped | {claim_id?, quote_id?, old_value?, new_value?, reason?} for context |
| `created_at` | timestamp | Associated entity scoped | Event timestamp |

**RLS Policies:**

```sql
-- Users can read activity for their claims
CREATE POLICY "users_read_activity" ON activity_log
  FOR SELECT USING (
    COALESCE(metadata->>'claim_id', '')::uuid = ANY(
      SELECT id FROM claims WHERE user_id = auth.uid()
    ) OR auth.uid() = user_id
  );

-- Service role full access
CREATE POLICY "service_role_all" ON activity_log
  FOR ALL USING (auth.role() = 'service_role'::text);
```

**React Read Patterns:**
- Claim timeline: fetch activity_log for claim_id, order by created_at DESC
- Audit trail: service-role-only admin view of all events

**React Write Patterns:**
- Log events: insert via service-role Edge Functions only (never client-side)

---

### 2.7 Platform Fee Config Table (Rate Management)

**Purpose:** State + trade matrix for platform fee percentages. Dynamically loaded by create-payment-intent Edge Function.

**Key Columns (9 total):**

| Column | Type | RLS Access | Purpose |
|--------|------|-----------|---------|
| `id` | uuid | Public read (for Edge Function) | Config identifier |
| `state` | text | Public read | US state abbreviation (e.g., "TX", "CA", or NULL for national default) |
| `trade` | text | Public read | Trade type (e.g., "roofing", "siding", or NULL for all trades) |
| `fee_pct` | numeric(4,2) | Public read | Fee percentage (e.g., 10.00 for 10%) |
| `fee_basis` | text | Public read | Basis: "quote_total", "insurance_approved_amount", or "flat" |
| `effective_date` | date | Public read | Date this config becomes effective |
| `notes` | text | Service-role (admin) | Internal notes (e.g., "Pilot rate for TX roofing Q2 2026") |
| `created_at`, `updated_at` | timestamp | Service-role (audit) | Audit timestamps |

**RLS Policies:**

```sql
-- Public read (needed for Edge Functions and transparent pricing)
CREATE POLICY "public_read" ON platform_fee_config
  FOR SELECT USING (true);

-- Service role full access (admin-only updates)
CREATE POLICY "service_role_all" ON platform_fee_config
  FOR ALL USING (auth.role() = 'service_role'::text);
```

**React Read Patterns:**
- Pricing transparency: fetch applicable fee config at claim submission time
- Display fee estimate: read fee_pct + fee_basis before contractor selection

**React Write Patterns:**
- None (admin-only, via Edge Function or Supabase CLI)

---

## 3. Edge Functions & Data Contracts

### 3.1 Payment & Financial Edge Functions

#### create-payment-intent (v50)

**Purpose:** Create Stripe PaymentIntent for Hover measurements ($79), deductible escrow, or contractor platform fees.

**Request (JSON):**
```json
{
  "amount": 7900,
  "currency": "usd",
  "description": "Hover measurement for claim CLM-123456",
  "metadata": {
    "type": "hover_measurement",
    "claim_id": "550e8400-e29b-41d4-a716-446655440000"
  },
  "contractor_id": "550e8400-e29b-41d4-a716-446655440001",
  "off_session": false
}
```

**Response (JSON):**
```json
{
  "client_secret": "pi_1234567890_secret_abcdef123456",
  "payment_intent_id": "pi_1234567890",
  "status": "requires_payment_method",
  "succeeded": false,
  "amount": 7900,
  "currency": "usd",
  "rate_limit_counts": {
    "remaining": 58,
    "reset_seconds": 300
  }
}
```

**Rate Limiting:** 60 requests per 5 minutes (hard limit; see check-rate-limits).

**Key Decisions (D-181):**
- Server-side pricing enforced: hover_measurement type fetches from platform_settings.hover_measurement_price
- Multi-payment-method support: tries default method first, then ACH, then cards
- Card charges include 2.9% + $0.30 passthrough surcharge

**RLS Context:** Service-role only (no user-initiated payment creation in v1 React).

**React Integration Points:**
- Call after homeowner confirms measurement payment
- Store payment_intent_id in claims table via Edge Function return
- Poll payment_intent_id status for completion

---

#### create-hover-order (v41)

**Purpose:** Creates Hover capture request (measurement order) via Hover v2 API after Stripe PaymentIntent succeeds.

**Request (JSON):**
```json
{
  "order_id": "CLM-123456-ORD-1",
  "claim_id": "550e8400-e29b-41d4-a716-446655440000",
  "address_line_1": "1234 Oak Street",
  "address_city": "Austin",
  "address_state": "TX",
  "address_zip": "78701",
  "homeowner_name": "John Doe",
  "homeowner_email": "john@example.com",
  "homeowner_phone": "+15125551234",
  "deliverable_type_id": 3,
  "payment_intent_id": "pi_1234567890"
}
```

**Response (JSON):**
```json
{
  "capture_request_id": "CR-abc123def456",
  "identifier": "https://hover.com/claim/CR-abc123def456",
  "capture_link": "https://hover.to/CR-abc123def456",
  "pending_job_id": "JOB-12345",
  "state": "pending",
  "rate_limit_counts": {
    "remaining": 9,
    "reset_seconds": 86400
  }
}
```

**Rate Limiting:** Hard cap 2/day, 10/month (per contractor or global).

**Key Decisions:**
- **D-181:** Verifies Stripe PaymentIntent succeeded before contacting Hover
- **D-205:** deliverable_type_id REQUIRED (2=Roof Only, 3=Complete; always 3 for full-replacement)
- Manual JWT verification (handler-level, due to ES256/HS256 gateway mismatch)
- Idempotency check by payment_intent_id (no duplicate orders for same payment)
- Duplicate prevention by address (no two orders for same address in 24 hours)

**RLS Context:** Service-role only (called by backend after homeowner clicks "Send to Hover").

**React Integration Points:**
- Display Hover capture_link to homeowner for measurement
- Update claims.hover_order_id, claims.hover_status after webhook completion (via hover-webhook Edge Function)
- Poll claims.hover_status for measurement completion state

---

#### create-setup-intent (v26)

**Purpose:** Create Stripe SetupIntent for saving contractor payment methods (off-session payments).

**Request (JSON):**
```json
{
  "contractor_id": "550e8400-e29b-41d4-a716-446655440001",
  "usage": "off_session"
}
```

**Response (JSON):**
```json
{
  "client_secret": "seti_1234567890_secret_abcdef",
  "setup_intent_id": "seti_1234567890",
  "status": "requires_payment_method",
  "rate_limit_counts": {
    "remaining": 59,
    "reset_seconds": 300
  }
}
```

**RLS Context:** Service-role only (contractor payment setup).

---

### 3.2 Hover Integration Edge Functions

#### get-hover-pdf (v27) [LARGE FUNCTION]

**Purpose:** Fetch measurement PDF from Hover API and store in Storage.

**Request (JSON):**
```json
{
  "claim_id": "550e8400-e29b-41d4-a716-446655440000",
  "hover_order_id": "CR-abc123def456",
  "measurement_type": "roof"
}
```

**Response (JSON):**
```json
{
  "pdf_url": "https://storage.otterquote.com/hover-pdfs/CLM-123456-roof-measurement.pdf",
  "file_name": "CLM-123456-roof-measurement.pdf",
  "downloaded_at": "2026-05-05T14:22:00Z"
}
```

**RLS Context:** Service-role only (called by backend after Hover webhook).

---

#### hover-webhook (v38)

**Purpose:** Handle Hover capture request state changes (pending → completed → failed).

**Payload (from Hover):**
```json
{
  "event": "capture_complete",
  "capture_request_id": "CR-abc123def456",
  "state": "completed",
  "measurements": {
    "roof_area_sqft": 2500,
    "ridge_length_ft": 150
  }
}
```

**RLS Context:** Service-role only (webhook handler).

**React Integration:** Polls claims.hover_status after submission.

---

### 3.3 Authentication & Authorization Edge Functions

#### hover-oauth-init (v33)

**Purpose:** Initiate Hover OAuth 2.0 login flow.

**Request (JSON):**
```json
{
  "redirect_uri": "https://otterquote.com/auth/hover-callback"
}
```

**Response (JSON):**
```json
{
  "authorization_url": "https://api.hover.com/oauth/authorize?client_id=...",
  "state": "state_12345"
}
```

---

#### hover-oauth-callback (v32)

**Purpose:** Complete Hover OAuth 2.0 token exchange.

**Request (JSON):**
```json
{
  "code": "auth_code_12345",
  "state": "state_12345"
}
```

**Response (JSON):**
```json
{
  "access_token": "hov_...",
  "refresh_token": "ref_...",
  "expires_in": 3600,
  "contractor_id": "550e8400-e29b-41d4-a716-446655440001"
}
```

---

#### get-signing-url (v4)

**Purpose:** Generate DocuSign signing URL for contract.

**Request (JSON):**
```json
{
  "envelope_id": "abc123def456",
  "recipient_email": "contractor@example.com",
  "recipient_name": "Jane Contractor",
  "return_url": "https://otterquote.com/quotes/550e8400-e29b-41d4-a716-446655440001/signed"
}
```

**Response (JSON):**
```json
{
  "signing_url": "https://na4.docusign.net/Member/PowerFormSigning.aspx?...",
  "expires_at": "2026-05-06T14:22:00Z"
}
```

---

#### validate-contract-template (v3)

**Purpose:** Validate contractor's uploaded contract template for legal compliance.

**Request (JSON):**
```json
{
  "contractor_id": "550e8400-e29b-41d4-a716-446655440001",
  "template_url": "https://storage.otterquote.com/templates/contractor-contract.pdf"
}
```

**Response (JSON):**
```json
{
  "valid": true,
  "warnings": [],
  "requires_legal_review": false
}
```

---

### 3.4 DocuSign Integration Edge Functions

#### create-docusign-envelope (v19) [LARGE FUNCTION — 102K+ characters]

**Purpose:** Create DocuSign envelope for contract signing (main contract, color confirmation, project scope).

**Request (JSON):**
```json
{
  "claim_id": "550e8400-e29b-41d4-a716-446655440000",
  "quote_id": "550e8400-e29b-41d4-a716-446655440001",
  "contractor_id": "550e8400-e29b-41d4-a716-446655440002",
  "document_type": "main_contract",
  "contractor_email": "contractor@example.com",
  "homeowner_email": "homeowner@example.com",
  "contract_body": "<html>...</html>"
}
```

**Response (JSON):**
```json
{
  "envelope_id": "abc123def456",
  "status": "sent",
  "created_at": "2026-05-05T14:22:00Z",
  "signing_urls": {
    "contractor": "https://na4.docusign.net/...",
    "homeowner": "https://na4.docusign.net/..."
  }
}
```

**RLS Context:** Service-role only.

**Note:** Full function source exceeds token limit. Restore with: `supabase functions download create-docusign-envelope --project-ref yeszghaspzwwstvsrioa`

---

#### docusign-webhook (v31)

**Purpose:** Handle DocuSign envelope state changes (sent → signed → completed).

**Payload (from DocuSign):**
```json
{
  "event": "envelope-completed",
  "envelope_id": "abc123def456",
  "status": "completed",
  "signers": [
    {
      "email": "contractor@example.com",
      "status": "completed",
      "signed_at": "2026-05-05T14:22:00Z"
    }
  ]
}
```

**RLS Context:** Service-role only (webhook handler).

**React Integration:** Polls quotes.docusign_envelope_id + contractor_signed_at for signing completion.

---

### 3.5 Notification Edge Functions (Summary)

| Function | Trigger | Purpose | RLS Context |
|----------|---------|---------|-------------|
| send-adjuster-email (v38) | Claim event | Email to adjuster | Service-role |
| send-sms (v39) | User opt-in | SMS notification | Service-role |
| send-support-email (v28) | Support request | Admin notification | Service-role |
| notify-contractors (v46) | Claim ready | Broadcast to matching contractors | Service-role |
| notify-feature-request (v22) | User feature request | Admin notification | Service-role |
| notify-partner-w9 (v12) | Partner signup | W9 request | Service-role |
| notify-payout-pending (v12) | Payout approved | Contractor notification | Service-role |
| send-incomplete-onboarding-reminders (v3) | Cron job | Onboarding reminder | Service-role |
| send-message-notification (v2) | Message created | In-app notification | Service-role |

---

### 3.6 Payout & Finance Edge Functions (Summary)

| Function | Trigger | Purpose | RLS Context |
|----------|---------|---------|-------------|
| approve-payout (v12) | Admin action | Mark payout approved | Service-role |
| reject-payout (v12) | Admin action | Reject payout request | Service-role |
| process-dunning (v25) | Failed payment | Dunning campaign | Service-role |
| process-payout-reminders (v14) | Cron job | Contractor payout reminders | Service-role |
| process-hover-rebate (v6) | Hover completion | Release rebate to homeowner | Service-role |

---

### 3.7 Rate Limiting Edge Function

#### check-rate-limits (v15)

**Purpose:** Query rate limit state for create-payment-intent, create-hover-order, etc.

**Request (JSON):**
```json
{
  "endpoint": "create-hover-order",
  "scope": "contractor",
  "scope_id": "550e8400-e29b-41d4-a716-446655440001"
}
```

**Response (JSON):**
```json
{
  "remaining": 9,
  "limit": 10,
  "window_seconds": 86400,
  "reset_at": "2026-05-06T14:22:00Z"
}
```

---

## 4. Legally-Bound Strings (F-008)

**These strings appear in fee disclosures, IC attestations, and Terms of Service. They must be hard-referenced in React code and cannot be generated dynamically.**

### 4.1 Fee Disclosure Text

**String ID:** `FEE_DISCLOSURE_HOVER_MEASUREMENT`

**Display Location:** Homeowner Hover measurement payment confirmation screen.

**Text (CRITICAL — do NOT modify without legal review):**
```
Platform Fee: {fee_pct}% of {fee_basis}
= ${fee_amount}

By accepting this quote, you authorize [Company Legal Name] to:
1. Charge your payment method
2. Retain the platform fee as specified above
3. Process your claim through our network

This fee covers measurement coordination, quote management, and contractor matching services.
```

**Bound Variables:**
- `{fee_pct}`: from platform_fee_config.fee_pct
- `{fee_basis}`: from platform_fee_config.fee_basis (display name: "quote total" or "insurance approved amount")
- `{fee_amount}`: calculated and stored in fee_acceptances.fee_amount
- `[Company Legal Name]`: from environment variable or CMS

**Storage:** fee_acceptances.fee_text_displayed (must match exactly for audit compliance).

---

### 4.2 Independent Contractor (IC) Attestation

**String ID:** `IC_24_5_11_ATTESTATION`

**Display Location:** Contractor onboarding step 2 (insurance).

**Legal Context:** IC-24/5/11 is a legal classification under [relevant state law — verify with Dustin]. Contractor must affirm they meet all criteria.

**Text (CRITICAL — do NOT modify without legal review):**
```
INDEPENDENT CONTRACTOR ATTESTATION (IC-24/5/11)

I certify that I meet all criteria for independent contractor classification:

1. Control: I control the means and methods of my work
2. Financial Risk: I bear financial risk and can make profit/loss on jobs
3. Scope: I provide roofing/siding/other contractor services to multiple customers
4. Equipment: I provide or control my own tools and equipment
5. Hours: I set my own work schedule
6. Integration: My work is not integral to any single business

I understand that misrepresenting my status is illegal and may result in fines or liability.

Signed: ________________   Date: __________
```

**Storage:** contractors.ic_24511_attestation (jsonb: {accepted: bool, signed_by: text, signed_at: timestamp})

**Compliance Note:** This string and acceptance must be reviewed by dustinstohler (legal) before React app goes live.

---

### 4.3 Terms of Service (TOS)

**String ID:** `TOS_HOMEOWNER_V1`, `TOS_CONTRACTOR_V1`

**Display Location:** Signup/onboarding, clickwrap with acceptance checkbox.

**Storage:** profiles.agreement_accepted_at, contractors.agreement_accepted_at (+ agreement_version field).

**Compliance Note:** TOS must be separately maintained and version-tracked. React app should fetch current TOS from CMS or static file at startup.

---

## 5. Open Questions for GC Review

Before the React data layer is built, Dustin (GC) must review and approve answers to:

### 5.1 Legal & Compliance

1. **IC Attestation Legality:** Is the IC-24/5/11 attestation string legally sufficient for the jurisdictions where OtterQuote operates? Does it need state-specific versions?

2. **Fee Disclosure Transparency:** Does the fee disclosure text meet all regulatory requirements (FTC, state insurance laws, etc.)? Should the fee be called something else (e.g., "service fee", "transaction fee")?

3. **COI Expiration Enforcement:** When contractor.coi_expires_at passes, should the system automatically suspend contractor.status = 'suspended', or require admin approval first?

4. **Rescission Rights:** For fee_acceptances, how long does a contractor have to rescind their fee acceptance? (30 days? 14 days?) Should the React app show a rescission window?

5. **Data Retention:** What is the retention policy for fee_acceptances, activity_log, and signed DocuSign envelopes? (Compliance often requires 3–7 years.)

---

### 5.2 Product & Architecture

6. **User Role Hierarchy:** Should profiles.role be extended to support sub-roles (e.g., "admin_legal", "admin_finance")? Current schema supports only "homeowner", "contractor", "admin".

7. **Claim Visibility to Contractors:** Should contractors see claims where ready_for_bids = false? Currently, RLS gates visibility until ready_for_bids = true. Is this correct?

8. **Multi-Claim Contractor Limits:** Should a contractor have a daily/monthly limit on how many claims they can bid on? (Currently enforced only for Hover orders, not bidding.)

9. **Quote Expiration Enforcement:** Should the system auto-mark quotes as expired when quotes.expires_at passes, or should this be a background job in process-bid-expirations? How should the React app handle expired quotes?

10. **Payment Method Storage:** Should contractor stripe_payment_method_id be stored in the database, or always retrieved from Stripe API? Current design stores it; is this acceptable for security?

---

### 5.3 Data Privacy & Security

11. **PII in Activity Log:** Should activity_log.metadata contain sensitive data (e.g., email, phone)? Currently, yes. Should we mask or hash these?

12. **IP Address & User Agent Storage:** fee_acceptances.ip_address and user_agent are stored for audit purposes. Should these be hashed? Retention period?

13. **Insurance Policy Numbers:** Storing gl_policy_number, wc_policy_number in contractors table. Should these be encrypted at rest, or is standard RLS sufficient?

---

### 5.4 Integration & External Services

14. **Stripe Customer ID:** Should we store contractors.stripe_customer_id in the OtterQuote DB, or always fetch from Stripe? Current design stores it for convenience.

15. **Hover Token Management:** Where should Hover access/refresh tokens be stored? Currently assumed in external vault or short-lived session. React app shouldn't handle tokens directly.

16. **DocuSign Integration Audit:** Are all DocuSign envelope IDs being stored and logged correctly for compliance audits?

---

## 6. Implementation Checklist for React Data Layer

- [ ] Implement auth pattern (F-007) on all authenticated pages: onAuthStateChange + INITIAL_SESSION/SIGNED_IN + _initFired boolean
- [ ] Build claims list fetcher with RLS filter (user_id-scoped)
- [ ] Build quotes fetcher per claim with contractor-scoped OR claim-scoped filter
- [ ] Build contractor profile page with public read (status = 'active')
- [ ] Build payment form integration with create-payment-intent Edge Function
- [ ] Build Hover redirect link with create-hover-order Edge Function
- [ ] Build DocuSign signing iframe with get-signing-url Edge Function
- [ ] Hard-code fee disclosure string (FEE_DISCLOSURE_HOVER_MEASUREMENT) — no dynamic generation
- [ ] Hard-code IC attestation string (IC_24_5_11_ATTESTATION) — no dynamic generation
- [ ] Implement activity log timeline (activity_log read-only)
- [ ] Implement rate limit polling (check-rate-limits) before Hover/payment buttons
- [ ] Validate all RLS policies with test users (homeowner, contractor, admin)
- [ ] Audit trail verification: ensure all sensitive updates are logged to activity_log via Edge Functions

---

## 7. References

- **Supabase Project:** yeszghaspzwwstvsrioa
- **GitHub Repo:** feature/d211-react-scaffold branch
- **Related ADRs:** ADR-001 (Auth Pattern), ADR-003 (Stripe Integration), ADR-005 (Hover Integration), ADR-007 (DocuSign)
- **Related Decisions:** D-181 (Stripe Verification), D-205 (Hover Deliverable Type), F-007 (Auth Pattern), F-008 (Legally-Bound Strings)

---

## 8. Document History

| Date | Author | Status | Notes |
|------|--------|--------|-------|
| 2026-05-05 | Claude (AI) | DRAFT | Initial comprehensive data contracts specification. Awaiting Dustin (GC) review for legal questions + final approval before React data layer build begins. |

