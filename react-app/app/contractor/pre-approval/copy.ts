/**
 * Contractor Pre-Approval — UI copy + catalogs (D-211 Phase 6, port of contractor-pre-approval.html).
 *
 * ⚠️ Tier-3 VERBATIM legal copy lives here and is ported BYTE-FOR-BYTE from the static page:
 *   - PRE_APPROVAL_COPY.partnerAgreement   (Contractor Partner Agreement + platform-fee disclosure)
 *   - PRE_APPROVAL_COPY.cancellation        (Homeowner Cancellation Policy + sole-remedy clause)
 *   - PRE_APPROVAL_COPY.attestation         (IC 24-5-11 attestation + joint-and-several indemnity, D-170)
 *   - PRE_APPROVAL_COPY.tcpa                 (TCPA SMS consent)
 *   - PRE_APPROVAL_COPY.submitted            (D-225 verbatim post-apply copy)
 * Any wording change to these is Tier-3 -> STOP and gate to Dustin (D-220; mirrors D-244/D-230).
 *
 * ⚠️ D-247 OPEN QUESTION (flagged, NOT acted on): the brief notes D-247 multi-state-v1-2026-06
 * MAY have superseded ic-24511-v1-2026-04. The LIVE static page (main) still uses the 2026-04
 * version + copy, so this port matches production byte-for-byte. Bumping the version/copy is a
 * Tier-3 change applied to BOTH stacks — gate to Dustin, do NOT change it in this PR.
 *
 * The remaining strings are non-legal UX copy (Tier-A/B), ported as-is.
 *
 * Cross-stack links use absolute https://otterquote.com/*.html (static pages not yet migrated);
 * the dashboard link targets the migrated React /contractor/dashboard route (coexistence).
 */

// Cross-stack / in-app destinations.
export const CONTRACTOR_DASHBOARD_ROUTE = '/contractor/dashboard'; // migrated React route
export const CONTRACTOR_JOIN_URL = 'https://otterquote.com/contractor-join.html';
export const CONTRACTOR_FAQ_URL = 'https://otterquote.com/contractor-faq.html';
export const CONTRACTOR_AGREEMENT_URL = 'https://otterquote.com/contractor-agreement.html';
export const SUPPORT_EMAIL = 'support@otterquote.com';

// Trades the profile card offers (value -> label). Port of the 4 profile-trade checkboxes.
export const PROFILE_TRADES: { value: string; label: string }[] = [
  { value: 'roofing', label: 'Roofing' },
  { value: 'siding', label: 'Siding' },
  { value: 'gutters', label: 'Gutters' },
  { value: 'windows', label: 'Windows' },
];

// Jurisdiction levels for the multi-license form (D-218). Port of the <select> options.
export const JURISDICTION_LEVELS: { value: string; label: string }[] = [
  { value: 'state', label: 'State' },
  { value: 'county', label: 'County' },
  { value: 'city', label: 'City' },
  { value: 'other', label: 'Other' },
];

// Step-4 contract-template selectors. Port of the trade + funding-type <select> options.
export const TEMPLATE_TRADES = ['Roofing', 'Siding', 'Gutters', 'Windows'] as const;
export const TEMPLATE_FUNDING_TYPES = ['Insurance (full replacement)', 'Retail'] as const;

export const PRE_APPROVAL_COPY = {
  // Progress header (Step 1 "Contact Info" is done before this page; steps 2-4 here).
  progress: {
    title: 'Complete Your Application',
    steps: [
      { n: 1, label: 'Contact Info' },
      { n: 2, label: 'License & Insurance' },
      { n: 3, label: 'Agreements' },
      { n: 4, label: 'Contract Template' },
    ],
  },

  loading: 'Loading your application…',

  // Error panel (session not found) — :132-137
  error: {
    title: 'Session Not Found',
    body: "We couldn't verify your session. Please use the link in your email or start a new application.",
    cta: '← Start Application',
  },

  // Step 2 — Profile & Documentation
  step2: {
    title: 'Profile & Documentation',
    subtitle:
      'Provide a few profile details and upload your required documents. All sections must be complete before you can continue.',
    profile: {
      title: 'Your Profile',
      subtitle:
        'Tells us where to send opportunities and how to reach you. You can refine your service area and add more counties later from your profile.',
      phoneLabel: 'Phone Number',
      phonePlaceholder: '317-555-1234',
      tradesLabel: 'Trades You Serve',
      countiesLabel: 'Counties You Serve',
      countiesPlaceholder: 'Marion-IN, Hamilton-IN, Boone-IN',
      countiesHelp:
        'Format: CountyName-StateCode, separated by commas. You can edit this later in your profile to pick from a full county list.',
    },
    coi: {
      title: 'CGL Certificate of Insurance',
      subtitle:
        'Commercial General Liability certificate (PDF, PNG, JPG). Max 10MB. Must name Stellar Edge Services, LLC as additional insured.',
      chooseFile: 'Choose File',
      expiryLabel: 'Expiry Date',
    },
    wc: {
      title: "Workers' Compensation Insurance",
      subtitle: "Workers' Comp certificate or proof of coverage. Max 10MB.",
      uploadChoice: 'Upload certificate',
      chooseFile: 'Choose File',
      expiryLabel: 'Expiry Date',
      exemptionChoice: 'I qualify for WCE-1 exemption (sole proprietor, no employees)',
      exemptionHelp:
        "Upload your Indiana WCE-1 Workers' Compensation Clearance Certificate (state-issued, valid 1 year). Max 10MB.",
      exemptionExpiryLabel: 'Certificate Expiry Date',
    },
    license: {
      title: 'Contractor License',
      subtitle: 'Add each contractor license you hold. You may add licenses from multiple jurisdictions.',
      empty: 'No licenses added yet.',
      levelLabel: 'Jurisdiction Level',
      levelPlaceholder: 'Select level…',
      jurisdictionLabel: 'Jurisdiction',
      jurisdictionPlaceholder: 'e.g. Indiana, Hamilton County',
      numberLabel: 'License Number',
      numberPlaceholder: 'License number',
      expiryLabel: 'Expiration Date',
      expiryOptional: '(optional)',
      docLabel: 'License Document',
      docOptional: '(optional, max 10MB)',
      chooseFile: 'Choose File',
      verificationLabel: 'Verification URL',
      verificationOptional: '(optional)',
      verificationHelp:
        'Give homeowners a link to the local municipality website where they can verify your license.',
      verificationPlaceholder: 'https://...',
      saveBtn: 'Save License',
      cancelBtn: 'Cancel',
      addBtn: '+ Add a License',
      editBtn: 'Edit',
      deleteBtn: 'Delete',
      noLicenseLabel: "I don't have a license for this work",
    },
    advance: 'Continue to Agreements →',
    statusRequired: 'Required',
    statusComplete: '✓ Complete',
  },

  // Step 3 — Platform Agreements (VERBATIM legal copy)
  step3: {
    title: 'Platform Agreements',
    subtitle: 'Please review each section and check the box to confirm your acceptance.',

    // Contractor Partner Agreement — :359-366
    partnerAgreement: {
      heading: 'Contractor Partner Agreement',
      // Rendered as: bodyPre + <a href={CONTRACTOR_AGREEMENT_URL}>{linkText}</a> + bodyPost
      bodyPre: 'By joining Otter Quotes, you agree to the terms of the ',
      linkText: 'Otter Quotes Contractor Partner Agreement',
      bodyPost:
        '. You will also be asked to sign it via DocuSign when your first project is matched. The platform fee is 5% of the insurance estimate (RCV) for insurance jobs and 5% of your bid for retail/cash jobs.',
      checkLabel:
        'I have reviewed the Contractor Partner Agreement and agree to its terms, including the platform fee structure.',
    },

    // Homeowner Cancellation Policy — :369-377
    cancellation: {
      heading: 'Homeowner Cancellation Policy',
      body:
        'Homeowners may switch to a different contractor in our network up to 3 days before their scheduled installation date, no questions asked. If this occurs: Otter Quotes handles the switch entirely, your platform fee is refunded in full, and the homeowner selects another contractor.',
      bodyStrong: 'A platform fee refund is your sole remedy if a homeowner exercises this right.',
      checkLabel:
        'I understand homeowners may switch contractors up to 3 days before installation. I will receive a full platform fee refund. I agree to this as a condition of the platform.',
    },

    // IC 24-5-11 Attestation & Indemnity — :379-394 (D-170, joint-and-several)
    attestation: {
      heading: 'Contractor Attestation & Indemnity',
      intro:
        'Otter Quotes is a contractor matching and payments platform. By accepting below, you personally and on behalf of the business attest that:',
      bullets: [
        'You hold all licenses required in every jurisdiction where you work.',
        'You carry CGL insurance of at least $1M/$2M with Stellar Edge Services, LLC as additional insured.',
        'You will comply with Indiana Code 24-5-11 on every Indiana project and all equivalent laws in other states.',
        'You will indemnify and hold harmless Stellar Edge Services, LLC from claims arising from your work, licensing failures, or law violations. This indemnity is joint and several and survives termination.',
      ],
      esignLine: 'Electronic acceptance constitutes your signature under the E-SIGN Act and UETA.',
      checkLabel:
        'I am authorized to bind the business. I attest to the licensing, insurance, IC 24-5-11 compliance, and joint-and-several indemnity obligations above. I intend this electronic acceptance to be my signature.',
    },

    // TCPA SMS — :396-404 (optional)
    tcpa: {
      heading: 'SMS Notifications',
      body:
        'Otter Quotes uses SMS to notify you of new project opportunities, bid updates, and important platform communications.',
      checkLabel:
        'I agree to receive transactional SMS from Otter Quotes. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe. (Optional — you can still use the platform without SMS notifications.)',
    },

    advance: 'Continue to Contract Template →',
    incompleteAlert: 'Please review and accept all agreements before continuing.',
    saveError: 'Failed to save agreements. Please try again.',
  },

  // Step 4 — Contract Template (D-209: required)
  step4: {
    title: 'Upload Your Contract Template',
    subtitle:
      'Upload the contract you use with homeowners. This is the agreement they will sign on Otter Quotes — your contract, your terms. Upload is required to complete your application. You can add additional templates for other trade and funding-type combinations later in your profile.',
    infoTitle: 'What to Upload',
    infoBody:
      "Your standard contract PDF for your primary trade and funding type. Otter Quotes auto-fills the homeowner's name, address, project details, and your bid fields via DocuSign — but the contract terms are yours, drafted or reviewed by your attorney. We do not draft or provide homeowner-contractor contracts.",
    tradeLabel: 'Trade',
    tradePlaceholder: 'Select trade…',
    fundingLabel: 'Funding Type',
    fundingPlaceholder: 'Select type…',
    uploadHeading: 'Click to upload your contract PDF',
    uploadHint: 'PDF only · max 10MB',
    submit: 'Upload & Submit Application →',
    uploading: 'Uploading…',
    uploadingStatus: 'Uploading contract template…',
    uploadError: 'Upload failed. Please try again.',
    submitError: 'Failed to submit application. Please try again or contact support@otterquote.com.',
  },

  // Submitted panel — D-225 verbatim (:139-153)
  submitted: {
    title: 'Application Submitted!',
    confirmationPrefix: 'Confirmation sent to ',
    body:
      "We're finishing up the platform and are bringing on contractors before we open to homeowners. You don't pay anything until you get a customer. We'll text you as soon as opportunities are available.",
    whileYouWait: 'While You Wait',
    reviewFaqPre: 'Review the ',
    reviewFaqLink: 'Contractor FAQ',
    questionsPre: 'Questions? Email ',
    dashboardLink: 'Go to your contractor dashboard →',
  },

  uploadFailedTitle: 'Upload Failed',
} as const;
