/**
 * OtterQuote Legal Constants — GC Hard Rule (D-211)
 *
 * All legally-bound copy strings live here. Never hard-code legal text
 * inline in components. When attorneys approve updated language, update
 * here only — all pages consuming these strings update automatically.
 *
 * GC Review Required: No page may go live with these strings without
 * Dustin (GC) reviewing and approving this module.
 *
 * Sources: otterquote-ref-legal.md domain reference file, otterquote-deploy/ HTML files
 * Last reviewed: [Pending GC review - May 5, 2026]
 * Version: v1.0
 */

/**
 * IC 24-5-11 Contractor Attestation & Indemnification
 * Source: contractor-pre-approval.html (Step 3: Platform Agreements)
 * References: D-147 (master agreement pre-commitment), D-170 (attestation + indemnity), D-209 (OQ non-party positioning)
 * 
 * This is the exact text shown on page 2 of the contractor onboarding wizard.
 * Checkbox label requiring explicit acknowledgment of the 4-part attestation.
 */
export const IC_24_5_11_ATTESTATION_LABEL = `I am authorized to bind the business. I attest to the licensing, insurance, IC 24-5-11 compliance, and joint-and-several indemnity obligations above. I intend this electronic acceptance to be my signature.`;

/**
 * IC 24-5-11 Attestation Content — Pre-checkbox messaging
 * Source: contractor-pre-approval.html (Step 3 info box)
 * 
 * Full attestation content shown to contractor before the checkbox:
 * - Licensing requirement
 * - Insurance requirement (CGL $1M/$2M with SES as additional insured)
 * - IC 24-5-11 compliance commitment
 * - Joint and several indemnification language
 */
export const IC_24_5_11_ATTESTATION_CONTENT = `Otter Quotes is a contractor matching and payments platform. By accepting below, you personally and on behalf of the business attest that:
- You hold all licenses required in every jurisdiction where you work.
- You carry CGL insurance of at least $1M/$2M with Stellar Edge Services, LLC as additional insured.
- You will comply with Indiana Code 24-5-11 on every Indiana project and all equivalent laws in other states.
- You will indemnify and hold harmless Stellar Edge Services, LLC from claims arising from your work, licensing failures, or law violations. This indemnity is joint and several and survives termination.

Electronic acceptance constitutes your signature under the E-SIGN Act and UETA.`;

/**
 * Homeowner Cancellation Policy Disclosure
 * Source: contractor-pre-approval.html (Step 3: Homeowner Cancellation Policy)
 * References: D-137 (cancellation guarantee), D-025 (switch-contractor mechanism)
 */
export const HOMEOWNER_CANCELLATION_POLICY = `Homeowners may switch to a different contractor in our network up to 3 days before their scheduled installation date, no questions asked. If this occurs: Otter Quotes handles the switch entirely, your platform fee is refunded in full, and the homeowner selects another contractor.

A platform fee refund is your sole remedy if a homeowner exercises this right.`;

/**
 * Contractor Partner Agreement — Platform Fee Structure (Section 6.1)
 * Source: contractor-agreement.html (Section 6: Platform Fee Structure)
 * References: D-214 (flexible per-job fee framework), D-215 (fee acceptance evidence system)
 *
 * NOTE: D-214 supersedes the fixed 5% language. This reflects the CURRENT state of contractor-agreement.html
 * which still contains "5% of the contract price" language. See D-214 acceptance record for fee_text_displayed capture.
 */
export const PLATFORM_FEE_SECTION_6_1 = `Otter Quotes charges a Platform Fee based on the services delivered per project. The fee is calculated as a percentage of the total contract price agreed upon between Contractor and Homeowner. The current Platform Fee rate is 5% of the contract price. Otter Quotes reserves the right to modify fee rates with 30 days written notice to Contractor. Bids submitted before a rate change takes effect will honor the rate displayed at the time of bid submission.`;

/**
 * Platform Fee Disclosure at Bid Submission (Section 5.5)
 * Source: contractor-agreement.html (Section 5: Bid Submission Process, 5.5 Fee Disclosure)
 * References: D-214 (displayed fee), D-215 (confirmation email + invoice)
 *
 * This is the binding language: "The Platform Fee applicable to each Bid is displayed
 * to the Contractor at the time of bid submission."
 */
export const PLATFORM_FEE_DISCLOSURE_AT_BID = `The Platform Fee applicable to each Bid is displayed to the Contractor at the time of bid submission. The Platform Fee is a separate charge to the Contractor and is not deducted from the contract price paid by the Homeowner to the Contractor.`;

/**
 * Certificate of Insurance (COI) Requirements — from contractor-pre-approval.html Step 2
 * Source: contractor-pre-approval.html (Step 2: License & Insurance, info box)
 * References: D-170 (COI attestation gate), D-210 (document gate on page 2), D-213 (WC path amendment)
 *
 * Displays COI requirements to contractor during onboarding.
 */
export const COI_REQUIREMENTS = `You'll upload your COI in your contractor profile after approval. Your COI must name Stellar Edge Services, LLC as additional insured with minimum $1M per occurrence / $2M aggregate General Liability coverage.`;

/**
 * Insurance Commitment Checkbox Label
 * Source: contractor-pre-approval.html (Step 2, checkbox label)
 * References: D-170, D-210
 */
export const INSURANCE_COMMITMENT_LABEL = `I carry (or will obtain) Commercial General Liability insurance meeting the platform requirements and will upload my COI before bidding on any projects.`;

/**
 * Contractor Licensing Requirements — from contractor-agreement.html Section 2.2
 * Source: contractor-agreement.html (Section 2: Profile Approval, 2.2 Licensing and Insurance Requirements)
 * References: D-027, D-088, D-210 (no-license attestation path)
 *
 * List of required credentials for approval.
 */
export const CONTRACTOR_LICENSING_REQUIREMENTS = [
  `Current, valid professional license(s) required in the jurisdiction(s) where work will be performed`,
  `Active general liability insurance with minimum coverage of $1,000,000`,
  `Workers' compensation insurance as required by applicable state law`,
  `Current proof of bonding or similar financial protection mechanism as required by state law`,
  `Compliance with all local, state, and federal licensing and regulatory requirements`,
  `No suspension, revocation, or disciplinary action pending against any professional license`
];

/**
 * Indemnification Language — from contractor-agreement.html Section 15
 * Source: contractor-agreement.html (Section 15: Indemnification)
 * References: D-170 (dual-capacity indemnity), D-209 (OQ non-party positioning)
 */
export const INDEMNIFICATION_CLAUSE = `Contractor shall defend, indemnify, and hold harmless Otter Quotes, Stellar Edge Services, LLC, its members, officers, employees, and agents from any and all claims, damages, liabilities, and expenses (including reasonable attorney's fees) arising from or related to:`;

/**
 * Additional Insured Requirement — from contractor-agreement.html Section 15
 * Source: contractor-agreement.html (Section 15: Indemnification)
 * References: D-170 (CGL additional-insured requirement)
 */
export const ADDITIONAL_INSURED_REQUIREMENT = `Contractor shall ensure that all insurance policies include Otter Quotes as an additional insured and shall provide certificates of insurance as requested.`;

/**
 * Contractor Authority Attestation — from contractor-pre-approval.html Step 3
 * Source: contractor-pre-approval.html (IC 24-5-11 Attestation checkbox)
 * 
 * Part of the binding attestation: contractor warrants they have authority to bind the business
 * and accept personal liability for the indemnification obligations.
 */
export const CONTRACTOR_AUTHORITY_ATTESTATION = `I am authorized to bind the business.`;

/**
 * Electronic Signature Disclosure
 * Source: contractor-pre-approval.html (Step 3: IC 24-5-11 Attestation)
 * References: E-SIGN Act, UETA (Uniform Electronic Transactions Act — Indiana Code § 26-2-8)
 */
export const ELECTRONIC_SIGNATURE_DISCLOSURE = `Electronic acceptance constitutes your signature under the E-SIGN Act and UETA.`;

/**
 * TODO: Workers' Compensation Sole Proprietor Exemption Attestation
 * References: D-210, D-213 (WCE-1 certificate gate replaces this)
 * Status: D-213 supersedes D-210's in-platform affidavit path with WCE-1 state-issued certificate
 * 
 * Action: Locate the exact WCE-1 form text or state-issued certificate language shown to contractors
 * on page 2 of the contractor-pre-approval.html Step 2 / Step 3 wizard when they claim sole-proprietor status.
 * D-213 notes this is no longer an attestation text but a document upload gate.
 */
export const TODO_WC_SOLE_PROP_EXEMPTION = `[GC: D-213 specifies WCE-1 state-issued certificate replaces in-platform affidavit. Locate document upload prompt text for contractors claiming sole-proprietor exemption.]`;

/**
 * TODO: No-License Attestation
 * References: D-210, D-027, D-088
 * Status: GC-drafted attestation text (v1-2026-05)
 * 
 * Action: Locate the exact no-license attestation text on contractor-pre-approval.html Step 2
 * when contractor checks "No contractor license is required in my primary service area."
 * This is one of three required artifacts on page 2 per D-210.
 */
export const TODO_NO_LICENSE_ATTESTATION = `[GC: Locate no-license attestation text (nolicense-v1-2026-05) shown to contractors on page 2 of onboarding.]`;

/**
 * TODO: SMS/TCPA Consent Language
 * Source: contractor-pre-approval.html (Step 3: SMS Notifications checkbox)
 * References: TCPA (Telephone Consumer Protection Act)
 * 
 * Action: Extract exact checkbox label from Step 3.
 */
export const TODO_SMS_CONSENT = `[GC: Extract SMS notification consent language from contractor-pre-approval.html Step 3.]`;

/**
 * SMS Notification Disclosure (partial match found)
 * Source: contractor-pre-approval.html (Step 3)
 * Exact text to be confirmed
 */
export const SMS_NOTIFICATION_INTRO = `Otter Quotes uses SMS to notify you of new project opportunities, bid updates, and important platform communications.`;

/**
 * No-License Checkbox Label
 * Source: contractor-pre-approval.html (Step 2)
 */
export const NO_LICENSE_REQUIRED_LABEL = `No contractor license is required in my primary service area`;

/**
 * TODO: Fee Basis for Insurance vs. Retail (from onboarding messaging)
 * References: D-214, D-215
 * Source: contractor-pre-approval.html (Step 3: Platform Agreements info box)
 * Status: Found in onboarding copy
 * 
 * "The platform fee is 5% of the insurance estimate (RCV) for insurance jobs and 5% of your bid for retail/cash jobs."
 * This is mentioned in the Partner Agreement acceptance section but actual fee rates are
 * now flexible per D-214 and displayed at bid-submission time per D-215.
 */
export const FEE_BASIS_DISCLOSURE_ONBOARDING = `The platform fee is 5% of the insurance estimate (RCV) for insurance jobs and 5% of your bid for retail/cash jobs.`;

/**
 * Contract Attestation Notice
 * Source: contractor-agreement.html (Section 1: Definitions, important notice section)
 * References: E-SIGN Act, electronic signature enforceability
 */
export const CONTRACTOR_AGREEMENT_ATTESTATION = `We strongly recommend that you review this agreement with a qualified attorney before accepting these terms. By executing this Agreement via DocuSign (or other electronic signature method designated by Otter Quotes), you agree to be bound by all provisions of this Agreement. Your electronic signature has the same legal force and effect as a handwritten signature.`;

/**
 * Contractor Definition — OQ Non-Party Positioning
 * Source: contractor-agreement.html (Section 1: Definitions, Contract definition)
 * References: D-136, D-151 (OQ is not a party to homeowner-contractor contracts)
 */
export const CONTRACT_DEFINITION = `The agreement between the Contractor and Homeowner for the performance of work, which is the Contractor's own contract template auto-populated by the Platform and executed via electronic signature. Otter Quotes is not a party to the Contract.`;

/**
 * Measurement Disclaimer for Retail Exhibit A (Scope of Work)
 * Source: otterquote-ref-legal.md (D-186, D-200)
 * Status: Referenced in memory but not yet extracted from HTML (Exhibit A is generated PDF)
 * 
 * This is the EXACT verbatim text per D-203 amendment. Appears on every retail Exhibit A.
 */
export const MEASUREMENT_DISCLAIMER_EXHIBIT_A = `The measurements contained in this Statement of Work were provided to Contractor on behalf of Customer. Both parties have relied upon the accuracy of this information in negotiating the terms of this Agreement. Prior to starting the work set forth in this agreement, either party shall have the right to perform his or her own measurements of the items listed in this statement of work. If any measurement in this statement of work is off by more than 10%, either party shall have the right to: (1) negotiate a change order to be signed by both parties prior to starting the work; (2) cancel the Agreement; or (3) proceed under the terms set forth in the Agreement.`;

/**
 * TODO: Contractor-Agreement.html Section 9 — IC 24-5-11 Compliance
 * References: D-147, D-185, D-201
 * Source: contractor-agreement.html needs to be read for full Section 9 text
 * 
 * Action: Extract Section 9 compliance language about addendum appending,
 * 3-day cancellation notice, and detachable cancellation form.
 */
export const TODO_IC_24_5_11_COMPLIANCE_SECTION = `[GC: Extract full Section 9 (IC 24-5-11 Compliance) from contractor-agreement.html — covers compliance addendum, 3-day cancellation notice, and detachable form.]`;
