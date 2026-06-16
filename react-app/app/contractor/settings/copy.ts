/**
 * Contractor Settings — UI copy + catalogs (D-211 Phase 5, port of contractor-settings.html).
 *
 * ⚠️ Tier-3 verbatim legal copy lives here and is ported BYTE-FOR-BYTE from the static page:
 *   - SETTINGS_COPY.attestation (IC 24-5-11 attestation + joint-and-several indemnity, D-170)
 *   - SETTINGS_COPY.coi        (CGL certificate requirements + status banners, D-170)
 *   - SETTINGS_COPY.repair     (show-up guarantee: $100 homeowner / $250 charge)
 *   - SETTINGS_COPY.pricing    (platform-fee disclosure)
 * Any wording change to these is Tier-3 → STOP and gate to Dustin (D-220; mirrors D-244/D-230).
 * The remaining strings are non-legal UX copy (Tier-A/B), ported as-is.
 */

export const SETTINGS_COPY = {
  pageTitle: 'Settings & Preferences',
  pageSubtitle:
    'Manage your notification preferences, repair work settings, payment methods, and review how Otter Quotes pricing works.',

  notifications: {
    title: 'Notification Preferences',
    emailHeading: 'Email Addresses',
    phoneHeading: 'Phone Numbers (SMS)',
    typesHeading: 'Notification Types',
    emailPlaceholder: 'Email address',
    phonePlaceholder: 'Phone number',
    addEmail: '+ Add Email Address',
    addPhone: '+ Add Phone Number',
    remove: 'Remove',
    comingSoon: 'Coming Soon',
    save: 'Save Notification Settings',
  },

  autoRenew: {
    title: 'Bid Auto-Renew',
    subtitle:
      'Each bid you submit is valid for 14 days. When auto-renew is on, your bids automatically stay active for up to 3 additional 14-day windows (42 days total) without any manual effort.',
    toggleLabel: 'Auto-renew my bids (up to 3 renewals / 42 days total)',
    note: 'You can also set this per-bid when submitting. This setting is your default.',
    save: 'Save Bid Settings',
  },

  directory: {
    title: 'Public Contractor Directory',
    subtitle:
      'Opt in to be listed on the public Otter Quotes contractor directory. Homeowners researching contractors can discover your business through search engines and our directory pages.',
    toggleLabel: 'List me in the Otter Quotes public contractor directory',
    note: 'Off by default. When on, your company name, service area, and trade are visible on the public directory.',
    save: 'Save Directory Settings',
  },

  payment: {
    title: 'Payment Methods',
    subtitle:
      'Add one or more payment methods so we can charge the platform fee when you win a project. Bank accounts (ACH) have no processing fee. Card payments include a small processing fee.',
    noPaymentTitle: '⚠️ Payment Method Required',
    noPaymentBody:
      'A payment method is required before you can receive projects. Add a bank account (no processing fee) or credit/debit card to get started.',
    encourageTitle: 'Protect Your Reputation — Add a Backup Payment Method',
    encourageBody: [
      "When a homeowner signs a contract with you through Otter Quotes, your platform fee is charged automatically. If the charge fails, we're required to notify the homeowner — and that conversation can raise questions about your business that no contractor wants to answer.",
      'Adding a second payment method ensures your projects are delivered seamlessly, even if your primary method has a temporary issue. Most contractors keep a bank account on file as their backup — bank transfers have no processing fee and are the most reliable payment method.',
      "This isn't about us collecting fees faster. It's about making sure that when a homeowner chooses you, the experience is seamless from start to finish.",
    ],
    encourageBtn: 'Add Backup Payment Method',
    successText: '✓ You have backup payment methods on file. Nice work.',
    addBank: '🏦 Add Bank Account',
    addBankSub: 'Free — No Processing Fee',
    addCard: '💳 Add Credit/Debit Card',
    addCardSub: 'Processing fee applies',
    feeNote:
      'Credit and debit card payments include a small processing fee (2.9% + $0.30). Bank account transfers are always free.',
    cardFormTitle: 'Enter Your Card Details',
    saveCard: 'Save Card',
    achFormTitle: '🏦 Connect Your Bank Account',
    achFormBody:
      "You'll be guided through Stripe's secure bank verification process. ACH payments have no processing fee — you only pay the exact platform fee.",
    connectBank: 'Connect Bank Account',
    cancel: 'Cancel',
    feeBadgeCard: 'Processing fee',
    feeBadgeBank: 'Free',
    defaultBadge: 'DEFAULT',
    setDefault: 'Set as Default',
    remove: 'Remove',
    addedPrefix: 'Added ',
    microdepositNotice:
      "Your bank requires verification via micro-deposits (2-3 business days). You'll receive two small deposits in your account. Once received, return here to verify.",
    // Graceful-degradation notice when NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set on the
    // Netlify build (the static page logs an error + dead buttons; this is the clearer React state).
    unavailable:
      'Adding a new payment method is temporarily unavailable. Your saved methods are shown above. Please try again shortly.',
    saveErrorDefault: 'Error setting default payment method. Please try again.',
    saveErrorRemove: 'Error removing payment method. Please try again.',
  },

  pricing: {
    title: 'How Our Pricing Works',
    subtitle:
      'You only pay for what Otter Quotes delivers. Our fee is a percentage of the job value, based on which services we successfully complete for your project.',
    tierLabel: 'Signed Contract',
    tierDescription:
      'Once a homeowner selects you, Otter Quotes handles the contract signing — you sign first, then the homeowner. Both signatures happen on our platform. You receive a fully signed contract, not just a referral.',
    tierFee: '5%',
    summaryLabel: 'Your platform fee per project:',
    summaryAmount: '5% of job value',
    summaryNote: 'Charged when a homeowner signs a contract with you through Otter Quotes',
  },

  repair: {
    title: 'Repair Work',
    intro:
      'Repair jobs are FREE REPAIR OPPORTUNITIES that we provide to contractors who promise to: 1) send a technician capable of diagnosing and quoting a repair (not the canvasser you hired last month); and 2) show up on time.',
    toggleLabel: 'Repair Work',
    toggleSub: 'Appear in repair results and receive notifications for repair jobs in your service area',
    statusOn: 'ON',
    statusOff: 'OFF',
    guaranteeTitle: 'Show-Up Guarantee Agreement',
    guaranteeBody:
      'By accepting repair work, you agree to the Otter Quotes show-up guarantee: if you schedule a repair diagnostic visit and fail to appear without 24 hours notice, Otter Quotes will pay the homeowner $100 and charge your account $250.',
    guaranteeCheckLabel:
      'I agree to the show-up guarantee terms. If I no-show a scheduled repair visit, I authorize Otter Quotes to charge $250 to my payment method and disburse $100 to the homeowner.',
    save: 'Save Repair Settings',
  },

  // ── Tier-3 VERBATIM (IC 24-5-11 attestation, D-170) ──
  attestation: {
    title: '⚠️ Contractor Attestation Required',
    subtitle:
      'Otter Quotes has updated its terms. Before you can submit new bids, please confirm the following IC 24-5-11 attestation and joint-and-several indemnity.',
    introP1:
      'Otter Quotes is a contractor matching and payments platform. We do not perform your work or warrant your materials. Every contractor represents themselves — directly — as licensed, insured, and compliant with applicable law.',
    introP2: 'By accepting below, you personally and on behalf of the business attest that:',
    bullets: [
      'You hold all licenses, registrations, and permits required in every jurisdiction where you bid.',
      'You carry and maintain CGL insurance of at least $1M per occurrence / $2M aggregate, with products-completed operations and contractual liability coverage, naming Stellar Edge Services, LLC as additional insured on a primary and non-contributory basis.',
      'You comply with Indiana Code 24-5-11 (Home Improvement Contracts Act) on every platform project.',
      "You indemnify, defend, and hold harmless Stellar Edge Services, LLC, Otter Quotes, and their officers, employees, and agents from any claims, damages, losses, liabilities, fines, penalties, and reasonable attorneys' fees arising out of or relating to your work, crews, subcontractors, failure to maintain insurance or licensing, or any violation of IC 24-5-11 or other applicable law. This indemnity is joint and several with any co-contractor, subcontractor, or affiliate on the project, and survives termination.",
    ],
    esignLine:
      'Electronic acceptance below — together with the name, title, timestamp, and IP captured — constitutes your signature under the federal E-SIGN Act and the Indiana UETA.',
    signerNameLabel: 'Signer Name',
    signerNamePlaceholder: 'First and last name',
    signerTitleLabel: 'Signer Title',
    signerTitlePlaceholder: 'Owner / President / Authorized Officer',
    acceptCheckLabel:
      'I am authorized to bind the business named above. I attest to the licensing, insurance, IC 24-5-11 compliance, and joint-and-several indemnity obligations stated above, and I intend this electronic acceptance to be my signature.',
    save: 'Accept & Continue',
    savedMsg: 'Attestation recorded.',
  },

  // ── CGL Certificate of Insurance (D-170) — verbatim legal/compliance copy ──
  coi: {
    title: 'Commercial General Liability Certificate',
    subtitle:
      "Otter Quotes requires a current CGL certificate of insurance on file at all times. Required minimums: $1,000,000 per occurrence / $2,000,000 aggregate, products-completed operations, contractual liability, with Stellar Edge Services, LLC named as additional insured on a primary and non-contributory basis. We'll remind you 30, 14, and 7 days before expiration. An expired or missing COI automatically suspends bidding.",
    requirementsHeading: 'What Your COI Must Show',
    requirements: [
      'Coverage limits: $1,000,000 per occurrence / $2,000,000 aggregate',
      'Coverage types: Products-Completed Operations + Contractual Liability',
      'Additional insured: Stellar Edge Services, LLC — primary and non-contributory',
    ],
    requirementsNote:
      "Share these requirements with your insurance agent — they'll know exactly what to add to your certificate.",
    insurerLabel: 'Insurer',
    insurerPlaceholder: 'e.g., Nationwide',
    policyLabel: 'Policy Number',
    policyPlaceholder: 'Policy #',
    expiresLabel: 'Expiration Date',
    fileLabel: 'Certificate PDF',
    policyShort: 'Policy #',
    expiresShort: 'Expires',
    certificate: 'Certificate',
    viewPdf: 'View PDF',
    save: 'Upload / Update Certificate',
    savedMsg: 'Saved.',
    needFileMsg: 'Please attach the updated certificate PDF.',
    pastDateConfirm: 'That expiration date is in the past. Continue anyway?',
    // status banners (loadCoiStatus) — verbatim
    bannerNone: 'No CGL certificate on file. You cannot submit bids until a current certificate is uploaded.',
    bannerExpired: 'Your CGL certificate is expired. Bidding is suspended until you upload a current certificate.',
    bannerExpiringPrefix: 'Your CGL certificate expires in ',
    bannerExpiringSuffix: ' days. Upload a renewed certificate to avoid a bidding suspension.',
    bannerCurrentPrefix: 'CGL certificate current — expires ',
  },

  crm: {
    title: 'CRM Integration',
    heading: 'Connect your CRM to receive projects directly.',
    providers: ['AccuLynx', 'JobNimbus', 'Roofr'],
    connect: 'Connect',
    comingSoon: 'Coming Soon',
  },

  feature: {
    title: 'Request a Feature',
    subtitle: 'Have an idea for a new feature or improvement? Let us know — we read every request.',
    placeholder: "Describe the feature or improvement you'd like to see...",
    send: 'Send Feature Request',
    sending: 'Sending...',
    sent: 'Sent!',
    thankYou: '✅ Thank you! Your request has been submitted.',
    error: 'Error submitting your request. Please try again.',
  },

  actionBar: {
    save: 'Save Settings',
    note: 'Changes are saved to your account when you click Save Settings.',
    saving: 'Saving...',
    saved: 'Saved!',
    saveError: 'Error — Try Again',
    notConnected: 'Error — Not Connected',
  },
} as const;
