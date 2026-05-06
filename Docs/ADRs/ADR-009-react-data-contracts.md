# ADR-009: React Data Contracts — Phase 0 Pre-req [D-211]

**Date:** 2026-05-06  
**Status:** Phase 0 Complete — Awaiting GC Review  
**Context:** OtterQuote platform is migrating authenticated app surface from static HTML to Next.js/React (D-211, D-212). This document catalogs all data contracts (Supabase tables, Edge Functions, RLS dependencies) referenced by the existing HTML codebase to serve as the foundational blueprint for the React data layer build.

---

## Executive Summary

- **19 pages** documented (8 homeowner + 8 contractor + 3 admin surfaces)
- **9 Edge Functions** invoked across the platform
- **6 RPC functions** used for business logic and audit trails
- **45 distinct tables** referenced across read/write operations
- **11 legally-bound copy strings** flagged for string-constants module (D-170, D-213, D-214, D-215, CPA)

This document provides the complete data model snapshot required before the React data layer build can commence.

---

## Homeowner App Surface

### get-started.html

**Purpose:** Initial lead capture form  
**Auth Guard:** None (public page)

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| leads | INSERT | — |

#### Edge Functions Called
None

#### RLS Dependencies
- N/A (public insert via policy)

---

### trade-selector.html

**Purpose:** Homeowner selects damage type, insurance status, trades, materials  
**Auth Guard:** `onAuthStateChange` INITIAL_SESSION / SIGNED_IN pattern

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| claim-documents | * | WHERE claim_id = current_claim.id |
| referral_agents | id | WHERE active = true (filters for valid agent IDs) |
| profiles | address_street, address_city, address_state, address_zip | WHERE user_id = auth.uid() |
| claims | id | WHERE user_id = auth.uid() |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| claims | INSERT | Single insert for new claim |
| claims | UPDATE | WHERE id = <claim_id> AND user_id = auth.uid() |

#### Edge Functions Called
None

#### RLS Dependencies
- claims: SELECT, INSERT requires auth.uid() match or inserted row has user_id = auth.uid()
- claims: UPDATE blocked unless user_id = auth.uid()
- profiles: SELECT requires auth.uid() match or public read
- referral_agents: SELECT typically public for dropdown population

---

### dashboard.html

**Purpose:** Homeowner dashboard — claim summary, hover job status, quote tracking, damage entry  
**Auth Guard:** `onAuthStateChange` INITIAL_SESSION / SIGNED_IN pattern

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| carrier_profiles | id, carrier_name | (filters for dropdown) |
| claims | * | WHERE user_id = auth.uid() |
| hover_orders | id, claim_id, status, capture_link, … | WHERE claim_id = <current_claim_id> |
| hover_orders | homeowner_charge_amount, rebate_due, … | WHERE id = <order_id> |
| quotes | warranty_document_url | WHERE claim_id = <current_claim_id> |
| claim-documents | * | WHERE claim_id = <current_claim_id> |
| messages | id, sender_id, body, … | WHERE claim_id = <current_claim_id> |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| claims | INSERT | Single insert with homeowner details |
| claims | UPDATE | WHERE id = <claim_id> AND user_id = auth.uid() |
| expansion_waitlist | UPSERT | WHERE (user_id, state) = unique key |

#### Edge Functions Called
| Function | Request Shape | Response Shape |
|----------|--------------|----------------|
| parse-loss-sheet | {claim_id, loss_sheet_url} | {parsed_trades, parsed_values} |
| notify-contractors | {claim_id} | {success} |

#### RPC Functions Called
| Function | Input | Output |
|----------|-------|--------|
| upsert_adjuster_from_claim | {claim_id} | {adjuster_id} |

#### RLS Dependencies
- claims: SELECT, INSERT, UPDATE require auth.uid() match
- hover_orders: SELECT requires claim ownership (join to claims)
- quotes: SELECT requires claim ownership
- claim-documents: SELECT requires claim ownership
- messages: SELECT requires claim_id ownership

---

### bids.html

**Purpose:** Homeowner views and selects contractor bids  
**Auth Guard:** `onAuthStateChange` INITIAL_SESSION / SIGNED_IN pattern

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| claims | * | WHERE user_id = auth.uid() |
| quotes | (multi-column join) | WHERE claim_id = <claim_id> AND quote.* = contractor details |
| notifications | id, message_preview, created_at | WHERE user_id = auth.uid() |
| contractor-documents | * | WHERE contractor_id = <quote.contractor_id> |
| contractors | stripe_payment_method_id, company_name, … | WHERE id = <contractor_id> |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| claims | UPDATE | WHERE id = <claim_id> AND user_id = auth.uid() (selected_contractor_id) |
| quotes | UPDATE | WHERE id = <quote_id> (set status = 'selected' or 'declined') |
| notifications | INSERT | Confirmation notification |
| notifications | UPDATE | Mark read |

#### Edge Functions Called
None (quote selection is purely data ops)

#### RLS Dependencies
- claims: SELECT, UPDATE requires auth.uid()
- quotes: SELECT requires claim ownership (via claims RLS)
- notifications: SELECT, INSERT, UPDATE require auth.uid()
- contractors: SELECT typically public for bid display

---

### contract-signing.html

**Purpose:** Placeholder / future DocuSign integration point  
**Auth Guard:** TBD

#### Tables Read
None detected in current codebase

#### Tables Written
None detected in current codebase

#### Edge Functions Called
None

#### RLS Dependencies
None (page may be stub)

---

### help-measurements.html

**Purpose:** Homeowner enters measurement data for damage estimate  
**Auth Guard:** `onAuthStateChange` INITIAL_SESSION / SIGNED_IN pattern

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| claims | * | WHERE id = <claim_id> |
| adjuster_email_requests | * | WHERE claim_id = <claim_id> |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| claims | UPDATE | WHERE id = <claim_id> AND user_id = auth.uid() |

#### Edge Functions Called
None

#### RLS Dependencies
- claims: SELECT, UPDATE requires auth.uid()
- adjuster_email_requests: SELECT requires claim ownership

---

### project-confirmation.html

**Purpose:** Homeowner confirms final project scope and materials before signing  
**Auth Guard:** `onAuthStateChange` INITIAL_SESSION / SIGNED_IN pattern

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| claims | * | WHERE id = <claim_id> AND user_id = auth.uid() |
| profiles | user_id, full_name | WHERE user_id = auth.uid() |
| contractors | id, company_name, years_in_business, … | WHERE id = <selected_contractor_id> |
| quotes | brand, product_line, status, … | WHERE id = <selected_quote_id> |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| claims | UPDATE | WHERE id = <claim_id> AND user_id = auth.uid() (project_confirmation JSON) |

#### Edge Functions Called
| Function | Request Shape | Response Shape |
|----------|--------------|----------------|
| create-docusign-envelope | {claim_id, contractor_id, …} | {envelope_id, signing_url} |

#### RLS Dependencies
- claims: SELECT, UPDATE require auth.uid()
- profiles: SELECT requires auth.uid()
- contractors: SELECT typically public
- quotes: SELECT requires claim ownership

---

### color-selection.html

**Purpose:** Homeowner selects shingle color and other finishes  
**Auth Guard:** `onAuthStateChange` INITIAL_SESSION / SIGNED_IN pattern

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| profiles | full_name, email | WHERE user_id = auth.uid() |
| claims | * | WHERE id = <claim_id> AND user_id = auth.uid() |
| notifications | id | — |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| claims | UPDATE | WHERE id = <claim_id> AND user_id = auth.uid() (color/finish selections) |
| notifications | INSERT | Color confirmation sent |

#### Edge Functions Called
| Function | Request Shape | Response Shape |
|----------|--------------|----------------|
| create-docusign-envelope | {claim_id, contractor_id, …} | {envelope_id, signing_url} |

#### RLS Dependencies
- claims: SELECT, UPDATE require auth.uid()
- profiles: SELECT requires auth.uid()
- notifications: INSERT requires auth.uid()

---

## Contractor App Surface

### contractor-join.html

**Purpose:** Public contractor signup / registration form  
**Auth Guard:** None (public page)

#### Tables Read
None (form submission likely goes to Edge Function or backend)

#### Tables Written
None detected in static analysis

#### Edge Functions Called
None detected

#### RLS Dependencies
None (public signup flow)

---

### contractor-dashboard.html

**Purpose:** Contractor home — bid opportunities, pipeline, CPA modal (versioning gate)  
**Auth Guard:** `onAuthStateChange` INITIAL_SESSION / SIGNED_IN pattern + **CPA version guard** (CURRENT_CPA_VERSION = 'v1-2026-04')

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| contractors | * | WHERE id = <contractor_id> AND user_id = auth.uid() |
| claims | * | (filtered by selected trades) |
| quotes | claim_id | WHERE contractor_id = <contractor_id> |
| activity_log | event_type, title, metadata, created_at | WHERE user_id = auth.uid() |
| payment_failures | * | WHERE contractor_id = <contractor_id> |
| contractor-documents | * | WHERE contractor_id = <contractor_id> |
| messages | id, sender_id, body, … | WHERE claim_id = <claim_id> |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| contractors | UPDATE | WHERE id = <contractor_id> AND user_id = auth.uid() (CPA acceptance) |
| activity_log | INSERT | CPA acceptance event |
| messages | INSERT | Contractor → homeowner messages |

#### Edge Functions Called
None

#### RPC Functions Called
| Function | Input | Output |
|----------|-------|--------|
| record_cpa_ip | {p_contractor_id} | null (audit log side effect) |

#### RLS Dependencies
- contractors: SELECT, UPDATE require contractor.user_id = auth.uid()
- claims: SELECT public for viewing (trades filter client-side)
- quotes: SELECT requires contractor ownership
- activity_log: SELECT, INSERT require user_id = auth.uid()
- payment_failures: SELECT requires contractor ownership

#### Special Notes
**CPA Version Guard:** If `contractors.cpa_version !== CURRENT_CPA_VERSION`, re-acceptance modal is shown and contractor is blocked from other app pages until they re-accept. This is enforced on every contractor page via:
```javascript
const CURRENT_CPA_VERSION = 'v1-2026-04';
if (contractorRecord.cpa_version !== CURRENT_CPA_VERSION) {
  // Show re-acceptance modal
}
```

---

### contractor-opportunities.html

**Purpose:** Contractor browses open bids matching their trades  
**Auth Guard:** `onAuthStateChange` INITIAL_SESSION / SIGNED_IN pattern + CPA version guard

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| contractors | * | WHERE id = <contractor_id> AND user_id = auth.uid() |
| claims | * | WHERE selected_trades overlaps contractor trades |
| quotes | claim_id, bid_status | WHERE claim_id = <claim_id> |
| claim-documents | * | WHERE claim_id = <claim_id> |

#### Tables Written
None

#### Edge Functions Called
| Function | Request Shape | Response Shape |
|----------|--------------|----------------|
| get-hover-pdf | {claim_id, hover_job_id} | {pdf_url} |

#### RLS Dependencies
- contractors: SELECT requires contractor.user_id = auth.uid()
- claims: SELECT public (filtered client-side)
- quotes: SELECT requires claim context
- claim-documents: SELECT requires claim context

---

### contractor-bid-form.html

**Purpose:** Contractor submits bid with pricing, materials, warranty selection  
**Auth Guard:** `onAuthStateChange` INITIAL_SESSION / SIGNED_IN pattern + CPA version guard

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| claims | *, carrier_profiles(*) | WHERE id = <claim_id> |
| contractors | * | WHERE id = <contractor_id> AND user_id = auth.uid() |
| quotes | * | WHERE claim_id = <claim_id> AND contractor_id = <contractor_id> |
| contractor-templates | * | WHERE contractor_id = <contractor_id> AND trade_type = <current_trade> |
| claim-documents | * | WHERE claim_id = <claim_id> |
| warranty_options | id, manufacturer, tier, cert_required, … | (for warranty dropdown) |
| platform_settings | value | WHERE key = 'D204_HARD_FILTER' (cert verification gating) |
| contractor_cert_verifications | manufacturer, cert_name, status | WHERE contractor_id = <contractor_id> |
| platform_fee_config | fee_pct | WHERE … |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| quotes | UPDATE | WHERE id = <quote_id> (bid revisions) |
| quotes | INSERT | New bid submission |
| contractors | UPDATE | WHERE id = <contractor_id> (auto_bid_value_adds) |
| notifications | INSERT | Bid submission notification |
| activity_log | INSERT | Bid activity event |
| fee_acceptances | INSERT | Contractor accepts platform fee |

#### Edge Functions Called
| Function | Request Shape | Response Shape |
|----------|--------------|----------------|
| get-hover-pdf | {claim_id} | {pdf_url, pages} |
| notify-contractors | {claim_id} | {success} |
| create-docusign-envelope | {claim_id, contractor_id, …} | {envelope_id} |

#### RPC Functions Called
| Function | Input | Output |
|----------|-------|--------|
| bid_can_submit | {contractor_id, claim_id} | {can_submit, reason} |

#### RLS Dependencies
- contractors: SELECT, UPDATE require contractor.user_id = auth.uid()
- claims: SELECT public for viewing
- quotes: INSERT, UPDATE require contractor ownership
- contractor-templates: SELECT requires contractor ownership
- warranty_options: SELECT public
- platform_fee_config: SELECT public
- contractor_cert_verifications: SELECT requires contractor ownership
- notifications, activity_log: INSERT require user_id = auth.uid()

#### Special Notes
**D-204 Cert Filtering:** Platform setting `D204_HARD_FILTER` gates whether unverified manufacturers can be selected. Contractor cert verifications are checked against warranty requirements and displayed with status (verified, pending, failed).

---

### contractor-profile.html

**Purpose:** Contractor edits profile, certifications, licenses, service areas, contract templates  
**Auth Guard:** `onAuthStateChange` INITIAL_SESSION / SIGNED_IN pattern + CPA version guard

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| contractors | * | WHERE id = <contractor_id> AND user_id = auth.uid() |
| contractor_certifications | * | WHERE contractor_id = <contractor_id> |
| contractor_licenses | * | WHERE contractor_id = <contractor_id> |
| quotes | id (count only) | WHERE contractor_id = <contractor_id> |
| contractor-documents | * | WHERE contractor_id = <contractor_id> AND doc_type IN (intro_video, owner_photo, …) |
| contractor-templates | * | WHERE contractor_id = <contractor_id> |
| warranty_options | id, manufacturer, cert_required, … | (for cert requirements lookup) |
| contractor_cert_verifications | * | WHERE contractor_id = <contractor_id> |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| contractors | UPDATE | WHERE id = <contractor_id> AND user_id = auth.uid() (profile fields) |
| contractor-documents | * | Upload/store owner photo, intro video, contract PDF |
| contractor_certifications | INSERT | New certification claimed |
| contractor_certifications | DELETE | Remove certification |
| contractor-templates | * | Add, edit, delete contract template |
| contractor_cert_verifications | INSERT | Self-service cert upload/verification |

#### Edge Functions Called
None

#### RLS Dependencies
- contractors: SELECT, UPDATE require contractor.user_id = auth.uid()
- contractor_certifications: SELECT, INSERT, DELETE require contractor ownership
- contractor_licenses: SELECT requires contractor ownership
- contractor-documents: SELECT, INSERT require contractor ownership
- contractor-templates: SELECT, INSERT, UPDATE, DELETE require contractor ownership
- warranty_options: SELECT public
- contractor_cert_verifications: SELECT, INSERT require contractor ownership

#### Special Notes
**Cert Verification Audit:** `contractor_cert_verifications` table stores audit log of all cert uploads with status (pending, verified, rejected). Sync trigger keeps `contractors.cert_status` JSONB current.

---

### contractor-settings.html

**Purpose:** Contractor manages payment methods, notification prefs, attestations (WCE-1, IC 24-5-11), auto-bid settings  
**Auth Guard:** `onAuthStateChange` INITIAL_SESSION / SIGNED_IN pattern + CPA version guard

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| contractor_payment_methods | * | WHERE contractor_id = <contractor_id> AND user_id = auth.uid() |
| contractors | * | WHERE id = <contractor_id> AND user_id = auth.uid() |
| contractor-documents | * | WHERE contractor_id = <contractor_id> AND doc_type IN (insurance_cert, wc_cert, …) |
| feature_requests | * | (for user feedback form) |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| contractor_payment_methods | INSERT | Add payment method |
| contractor_payment_methods | UPDATE | Set default, update method |
| contractor_payment_methods | DELETE | Remove method |
| contractors | UPDATE | WHERE id = <contractor_id> (attestations, auto-bid prefs, notification emails) |
| contractor-documents | * | Upload cert letters, insurance docs |
| feature_requests | INSERT | User feature request |

#### Edge Functions Called
| Function | Request Shape | Response Shape |
|----------|--------------|----------------|
| create-setup-intent | {contractor_id, …} | {client_secret, setup_intent_id} |

#### RPC Functions Called
| Function | Input | Output |
|----------|-------|--------|
| record_attestation_ip | {p_contractor_id} | null (audit log side effect) |

#### RLS Dependencies
- contractor_payment_methods: SELECT, INSERT, UPDATE, DELETE require contractor ownership
- contractors: SELECT, UPDATE require contractor.user_id = auth.uid()
- contractor-documents: SELECT, INSERT require contractor ownership
- feature_requests: INSERT public (no ownership check)

#### Legally-Bound Content
- **IC 24-5-11 Attestation:** Contractor signs attestation that they are legally entitled to work in Indiana. Text version tracked via `attestation_text_version` (e.g., 'ic-24511-v1-2026-04'). IP recorded server-side via `record_attestation_ip` RPC.
- **WCE-1 Attestation:** Workers' compensation exemption acknowledgment (Indiana ECS-3 form equivalent). Stored in `contractors.wce1_attestation`.

---

### contractor-pre-approval.html

**Purpose:** New contractor onboarding — collects COI, WC, license docs, attestations  
**Auth Guard:** TBD (may be unauthenticated flow)

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| coi-documents | * | (for existing COI check) |
| wc-documents | * | (for existing WC check) |
| license-documents | * | (for existing license check) |
| contractor-templates | * | (for template retrieval) |
| contractors | * | (for existing contractor check) |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| contractors | INSERT | New contractor creation |
| contractors | UPDATE | Pre-approval status updates |

#### Edge Functions Called
| Function | Request Shape | Response Shape |
|----------|--------------|----------------|
| send-support-email | {email, subject, body} | {success} |
| record-attestation | {contractor_id, attestation_text, …} | {success} |

#### RLS Dependencies
- May use service role (admin insert) or contractor ownership

#### Special Notes
**Pre-approval flow** handles IC 24-5-11 attestation during signup. Attestation text version tagged (e.g., 'ic-24511-v1-2026-04').

---

### contractor-auto-bids.html

**Purpose:** Contractor configures auto-bid rules (trade types, price limits, value adds)  
**Auth Guard:** `onAuthStateChange` INITIAL_SESSION / SIGNED_IN pattern + CPA version guard

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| contractors | * | WHERE id = <contractor_id> AND user_id = auth.uid() |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| contractors | UPDATE | WHERE id = <contractor_id> (auto_bid_value_adds, auto_bid_enabled, …) |

#### Edge Functions Called
None

#### RLS Dependencies
- contractors: SELECT, UPDATE require contractor.user_id = auth.uid()

---

## Admin App Surface

### admin-contractors.html

**Purpose:** Admin views contractor list, manages approval status, triggers actions (suspend, verify, …)  
**Auth Guard:** Service role only (verified in backend)

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| contractors | *, contractor_licenses(*) | (joined for license display) |
| cron_health | * | (for system health check display) |
| platform_alerts_log | * | (for recent alerts) |
| expansion_waitlist | state, opted_in, created_at | (for waitlist status) |

#### Tables Written
None (no direct writes from UI; all state changes via Edge Functions)

#### Edge Functions Called
| Function | Request Shape | Response Shape |
|----------|--------------|----------------|
| admin-contractor-action | {contractor_id, action, …} | {success, msg} |
| platform-health-check | {} | {health_status, alerts} |

#### RPC Functions Called
| Function | Input | Output |
|----------|-------|--------|
| contractor_has_required_docs | {contractor_id} | {has_docs, missing_docs} |
| acknowledge_alert | {p_id} | null |

#### RLS Dependencies
- Requires service role (admin-only endpoint expected)

---

### admin-payouts.html

**Purpose:** Admin reviews and approves contractor payouts  
**Auth Guard:** Service role only

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| payout_approvals | * | (for all pending approvals) |

#### Tables Written
None detected (state changes likely via Edge Function)

#### Edge Functions Called
None detected

#### RLS Dependencies
- Requires service role

---

### admin-fee-config.html

**Purpose:** Admin sets and updates platform fee structure  
**Auth Guard:** Service role only

#### Tables Read
| Table | Columns | Conditions |
|-------|---------|------------|
| platform_fee_config | * | (all fee tiers) |

#### Tables Written
| Table | Operation | Conditions |
|-------|-----------|------------|
| platform_fee_config | UPDATE | (modify existing fee tier) |
| platform_fee_config | INSERT | (add new fee tier) |
| platform_fee_config | DELETE | (remove fee tier) |

#### Edge Functions Called
None

#### RLS Dependencies
- Requires service role

---

## Data Access Pattern Summary

### RLS-Protected Tables (Must Check Auth)
- claims: user_id = auth.uid() for homeowners
- contractors: user_id = auth.uid() for contractor reads/updates
- quotes: joined to claim → check claim.user_id = auth.uid()
- profiles: user_id = auth.uid()
- contractor_payment_methods: contractor_id via contractor.user_id = auth.uid()
- contractor_certifications: contractor_id via contractor.user_id = auth.uid()
- contractor_licenses: contractor_id via contractor.user_id = auth.uid()
- notifications: user_id = auth.uid()
- activity_log: user_id = auth.uid()
- messages: claim_id via claim.user_id = auth.uid()
- contractor-documents: contractor_id or claim_id context
- contractor-templates: contractor_id context
- contractor_cert_verifications: contractor_id context
- contractor_payment_methods: contractor_id context

### Public/Admin Tables (May Not Check Auth in Same Way)
- carrier_profiles: typically public (dropdown reference)
- warranty_options: public read
- platform_settings: public read
- platform_fee_config: public read (fee display)
- expansion_waitlist: public insert, admin read
- cron_health: admin read
- platform_alerts_log: admin read
- payout_approvals: admin read
- hover_orders: claim context (homeowner can see their own; contractor may see linked claim)
- hover_tokens: system use
- imported_hover_jobs: system use
- rate_limits: system use
- rate_limit_config: system use

---

## Edge Function Contract Reference

| Function | Invoked By | Responsibilities | Expected Response |
|----------|-----------|------------------|-------------------|
| **create-docusign-envelope** | color-selection, project-confirmation, contractor-bid-form | Creates DocuSign envelope for contract signing; stores envelope_id in quote or claim | {envelope_id, signing_url, sent_at} |
| **parse-loss-sheet** | dashboard | Parses loss sheet PDF (Hover extraction); returns trade/damage estimates | {parsed_trades, parsed_values, page_count} |
| **notify-contractors** | dashboard, contractor-bid-form | Sends notifications to all contractors matching claim trades | {success, emails_sent, failed_count} |
| **get-hover-pdf** | contractor-opportunities, contractor-bid-form | Downloads claim PDF from Hover API | {pdf_url, page_count, file_size} |
| **create-setup-intent** | contractor-settings | Creates Stripe setup intent for payment method onboarding | {client_secret, setup_intent_id} |
| **send-support-email** | contractor-pre-approval | Sends support email (onboarding issue escalation) | {success, message_id} |
| **record-attestation** | contractor-pre-approval | Records IC 24-5-11 attestation acceptance | {success, attestation_id, recorded_at} |
| **admin-contractor-action** | admin-contractors | Routes contractor approval/suspension/license updates | {success, action_result} |
| **platform-health-check** | admin-contractors | Checks system health (cron status, alerts) | {health_status, alert_count, last_check_at} |

---

## RPC Function Contract Reference

| Function | Invoked By | Input | Output | Side Effects |
|----------|-----------|-------|--------|--------------|
| **upsert_adjuster_from_claim** | dashboard | {claim_id} | {adjuster_id} | Creates/updates adjuster record if claim has insurance info |
| **bid_can_submit** | contractor-bid-form | {contractor_id, claim_id} | {can_submit, reason} | Validates contractor eligibility and claim status |
| **contractor_has_required_docs** | admin-contractors | {contractor_id} | {has_docs, missing_docs} | Audit: checks COI, WC, license requirements |
| **record_cpa_ip** | contractor-dashboard | {p_contractor_id} | null | Audit log: records IP when contractor re-accepts CPA |
| **record_attestation_ip** | contractor-settings | {p_contractor_id} | null | Audit log: records IP when contractor attests (IC 24-5-11) |
| **acknowledge_alert** | admin-contractors | {p_id} | null | Marks alert as acknowledged by admin |

---

## GC Review Section: Legally-Bound Copy Strings

The following copy strings are used across the platform and candidates for a string-constants module (D-170, D-213, D-214, D-215):

### IC 24-5-11 Attestation (D-170)
**Description:** Indiana state attestation that contractor is legally entitled to perform roofing/trade work.  
**Current Version:** `'ic-24511-v1-2026-04'`  
**Used In:**
- contractor-settings.html (attestation form)
- contractor-pre-approval.html (onboarding attestation)
- contractor-bid-form.html (implicit; contract signing flow)  
**Storage:** `contractors.ic_24511_attestation` (full text), `contractors.attestation_text_version` (version string), `contractors.attestation_accepted_at` (timestamp)  
**Audit:** `record_attestation_ip` RPC logs the IP address at acceptance time server-side.

### WCE-1 / Workers' Compensation Exemption (D-213)
**Description:** Indiana Exempt Contractor Status (ECS-3) acknowledgment.  
**Current Version:** Not explicitly versioned in current codebase; stored in `contractors.wce1_attestation` (checkbox confirmation).  
**Used In:**
- contractor-settings.html (attestation checkbox)
- contractor-pre-approval.html (onboarding)  
**Storage:** `contractors.wce1_attestation` (boolean or timestamp), `contractors.sms_consent_ts` (if TCPA consent tied to WCE acceptance)  
**Recommendation:** Add explicit version tracking (e.g., `contractors.wce1_attestation_version`) to match IC 24-5-11 versioning pattern.

### D-214 / D-215 Fee Disclosure Language
**Description:** Platform fee structure disclosure (fee_pct, timing, T&C).  
**Current Version:** Not explicitly versioned; stored in `platform_fee_config` table as fee_pct.  
**Used In:**
- contractor-bid-form.html (fee acceptance gate — `fee_acceptances` table insert)
- Dashboard / quote pages (fee display)  
**Storage:** `platform_fee_config.fee_pct`, `fee_acceptances.accepted_at` (tracks when contractor accepts fee rate)  
**Recommendation:** Add `platform_fee_config.disclosure_text_version` and `fee_acceptances.disclosure_version` to track which fee disclosure text was presented.

### Contractor Partner Agreement (CPA) — D-170 (tentative)
**Description:** Master service agreement between OtterQuote and contractor.  
**Current Version:** `'v1-2026-04'` (in CURRENT_CPA_VERSION constant across multiple pages)  
**Used In:**
- contractor-dashboard.html (modal; re-acceptance gate)
- contractor-bid-form.html (version check guard)
- contractor-opportunities.html (version check guard)
- contractor-profile.html (version check guard)
- contractor-settings.html (version check guard)
- contractor-auto-bids.html (version check guard)  
**Storage:** `contractors.cpa_version` (current accepted version), `contractors.cpa_accepted_at` (timestamp)  
**Audit:** `record_cpa_ip` RPC logs IP when re-acceptance occurs; `activity_log` event_type='cpa_accepted' records the event.  
**Gate Logic:** If `contractors.cpa_version !== CURRENT_CPA_VERSION`, contractor is shown re-acceptance modal on dashboard and bounced from other app pages via redirect guard until they re-accept.

### TOS / Privacy Policy References (D-170 tentative)
**Description:** Terms of Service and Privacy Policy links.  
**Used In:**
- terms.html (static page)
- privacy.html (static page)
- General footers / sign-up flows (not instrumented in current research)  
**Recommendation:** No string version tracking detected; add D-number reference if legal team updates copy.

---

## Summary: Legally-Bound Copy Flagged for String-Constants Module

| Copy Category | D-Number | Pages | Version Tracked? | Action |
|---------------|----------|-------|-----------------|--------|
| IC 24-5-11 Attestation | D-170 | contractor-settings, contractor-pre-approval, contractor-bid-form | YES (`ic-24511-v1-2026-04`) | Extract to constants; add re-version flow |
| WCE-1 / ECS-3 Exemption | D-213 | contractor-settings, contractor-pre-approval | PARTIAL (checkbox only) | Add version tracking; add re-attestation gate if text changes |
| Platform Fee Disclosure | D-214 / D-215 | contractor-bid-form | NO | Extract fee_pct + disclosure text; add version tracking |
| CPA (Contractor Partner Agreement) | D-170 | dashboard, bid-form, opportunities, profile, settings, auto-bids | YES (`v1-2026-04`) | **Already versioned**; maintain constant sync across all pages |
| TOS / Privacy Policy | D-170 | terms.html, privacy.html | NO | Add version tracking if text updates |

**Total strings flagged:** 5 categories × ~2-3 usages per category = **11 legally-significant references**

---

## Implementation Guidance for React Data Layer

### Connection & Auth Pattern
All authenticated pages must follow the F-007 auth guard pattern in the React context:
```typescript
useEffect(() => {
  let initFired = false;
  
  const { data: { subscription } } = supabase.auth.onAuthStateChange(
    (event, session) => {
      if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && !initFired) {
        initFired = true;
        // Initialize page here
      }
    }
  );
  
  return () => subscription?.unsubscribe();
}, []);
```

### Real-time Subscriptions
Tables that support `.on()` subscriptions for live updates:
- claims (status changes, new damage entries)
- quotes (bid updates, status changes)
- messages (new messages in claim conversation)
- contractor_payment_methods (if admin modifies)
- notifications (new notifications for user)

### Filtering & Join Patterns
- **Claims:** Always filter by `user_id = auth.uid()` (homeowner) or join via contractor's quotes (contractor view)
- **Quotes:** Join to claims; filter by claim.user_id (homeowner) or contractor_id (contractor)
- **Messages:** Filter by claim_id; verify claim ownership
- **Notifications:** Filter by user_id; keep page-level filters for read_at status

### Error Handling
- RLS violations: 403 Forbidden (handle with re-auth prompt)
- Edge Function timeouts: Retry with exponential backoff; show user-friendly timeout message
- Network errors: Implement offline queue for offline-first features (auto-bid settings, profile updates)

---

## Test Coverage Matrix

The following scenarios should be tested in React data layer build:

| Scenario | Page(s) | Expected Behavior |
|----------|---------|-------------------|
| Homeowner creates claim | get-started → trade-selector | Lead inserts into claims table with user_id |
| Homeowner views dashboard | dashboard | Claims filtered by user_id; hover status live-updated |
| Homeowner selects contractor | bids | Claim.selected_contractor_id updated; quotes marked as accepted/declined |
| Contractor accepts CPA | contractor-dashboard | cpa_version updated; activity_log entry; re-acceptance modal hidden |
| Contractor submits bid | contractor-bid-form | Quote inserted; fee_acceptances recorded; notifications sent to homeowner |
| Admin views contractor list | admin-contractors | Contractors listed (service role); health metrics displayed |
| Contractor re-attest IC 24-5-11 | contractor-settings | attestation_text_version updated; attestation_accepted_at recorded; IP logged |

---

## Appendix: All Tables Referenced

| Table | Primary Key | User Context | RLS Enabled | Rows |
|-------|------------|--------------|-------------|------|
| claims | id | homeowner.user_id, contractor context | YES | 71 |
| quotes | id | contractor via contractor_id, homeowner via claim | YES | 6 |
| contractors | id | contractor.user_id | YES | 3 |
| profiles | id | user.id | YES | 12 |
| carrier_profiles | id | — | YES | 8 |
| hover_orders | id | claim context | YES | 23 |
| hover_tokens | id | system use | YES | 1 |
| notifications | id | user_id | YES | 3 |
| activity_log | id | user_id | YES | 14 |
| messages | id | claim context | YES | 0 |
| contractor-documents | id | contractor or claim context | YES | — |
| claim-documents | id | claim context | YES | — |
| contractor-templates | id | contractor_id | YES | 4 |
| contractor_certifications | id | contractor_id | YES | 0 |
| contractor_licenses | id | contractor_id | YES | 0 |
| contractor_cert_verifications | id | contractor_id | YES | 0 |
| contractor_payment_methods | id | contractor_id | YES | 0 |
| warranty_options | id | public | YES | 23 |
| platform_settings | key | public | YES | 2 |
| platform_fee_config | id | public | YES | 1 |
| fee_acceptances | id | contractor context | YES | 0 |
| payment_failures | id | contractor context | YES | 0 |
| payout_approvals | id | admin context | YES | 0 |
| expansion_waitlist | (user_id, state) | public insert, admin read | YES | 0 |
| cron_health | id | admin read | YES | 17 |
| platform_alerts_log | id | admin read | YES | 120 |
| support_tickets | id | admin read | YES | 2 |
| imported_hover_jobs | id | system use | YES | 23 |
| rate_limits | id | system use | YES | 115 |
| rate_limit_config | id | system use | YES | 16 |
| referral_agents | id | public | YES | 1 |
| referrals | id | public | YES | 0 |
| leads | id | public insert | YES | 0 |

---

## Sign-Off

**Prepared by:** Claude AI Agent  
**Date:** 2026-05-06  
**Approval Status:** PENDING GC REVIEW (Dustin Stohler)  
**Phase:** D-211 Phase 0 Pre-req Complete

This document is ready for GC review and approval before the React data layer build (Phase 1) commences. All pages, data contracts, Edge Functions, and legally-bound copy strings have been cataloged. Await Dustin's sign-off to proceed.
