/**
 * Homeowner help-measurements copy — D-211 Phase 28, PR 1/2 (ADDITIVE).
 *
 * Source file:  help-measurements.html (repo root)
 * Branched from: main (feat/h6-help-measurements-pr1)
 *
 * VERBATIM-LOCKED. Every user-facing string below is ported BYTE-FOR-BYTE (rendered text
 * content) from help-measurements.html and asserted by ./__tests__/copy.test.ts — any reword
 * trips the lock. These include the D-291 financial terms ($15 price line + rebate callout,
 * repricing D-205's now-superseded $150) and the Stripe security line, which must be exact.
 *
 * Faithful-port notes (same idiom as the H5 color-selection copy.ts):
 *   • HTML entities are decoded to their rendered glyph because React renders text nodes,
 *     not HTML. Em-dashes in the static are literal U+2014 (—); all apostrophes are straight
 *     ASCII ('); the "Sending…" label uses a literal U+2026 ellipsis (…).
 *   • Inline <strong> markup is presentation-only and flattened to plain text (the words are
 *     what is locked). e.g. "<strong>How the $15 works:</strong> You pay…" →
 *     "How the $15 works: You pay…".
 *   • Icon glyphs (📐 📬 ✓ ← 💳 🔒) are kept as the literal emoji/symbol the static renders.
 *   • There are NO interpolated copy strings to lock: the only runtime-text element is the
 *     #emailPreview div, whose updater (updateEmailPreview) is CALLED-BUT-NEVER-DEFINED in the
 *     static (help-measurements.html:822) and has no template text anywhere in the file. We
 *     therefore lock only its real default placeholder ("Loading...") and do NOT fabricate an
 *     email-preview body. See the PR body / utils.ts for the full discrepancy note.
 *
 * Source line ranges (help-measurements.html):
 *   Page header ...................................... 553-556
 *   Path intro ....................................... 565-566
 *   Path A card (Hover) .............................. 572-583
 *   Path B card (Ask Adjuster) ....................... 588-599
 *   Shared card button ............................... 583/599
 *   Hover flow section ............................... 607-658
 *   Hover success state .............................. 666-675
 *   Adjuster flow section ............................ 685-723
 *   Email success state .............................. 733-742
 *   Operational status / button labels .............. 801-1088
 */

export const MEASUREMENTS_COPY = {
  // ── Page header (help-measurements.html:553-556) ──
  pageTitle: 'Measurements',
  pageSubtitle: 'Help Me: Get property measurements for your project',
  backLink: '← Back to Dashboard',

  // ── Path intro (help-measurements.html:565-566) ──
  pathIntroTitle: 'How would you like to get measurements?',
  pathIntroText:
    'Accurate measurements help contractors provide more precise bids. Choose the option that works best for you.',

  // ── Path A card — Hover, PAID (help-measurements.html:572-583) ──
  hoverBadge: 'Recommended for Most',
  hoverIcon: '📐',
  hoverCardTitle: 'Complete Property Report',
  // D-291 price line (repriced from D-205's $150) — LOCKED, exact.
  hoverCardPrice: '$15 (rebated if you use an Otter Quotes contractor)',
  hoverCardDescription:
    "Get a complete 3D model of your home — roof, walls, openings, and full measurements — by taking photos with your phone. Our measurement technology builds the model from your photos. This is your best option for any full-replacement project.",
  hoverCardFeatures: [
    'Precise, professional-grade measurements',
    '3D model of your property',
    'Ready in 24-48 hours',
    'Cost rebated when using an Otter Quotes contractor',
  ],

  // ── Path B card — Ask Adjuster, FREE (help-measurements.html:588-599) ──
  adjusterBadge: 'Recommended for Insurance',
  adjusterIcon: '📬',
  adjusterCardTitle: 'Ask Your Adjuster',
  adjusterCardPrice: 'Free',
  adjusterCardDescription:
    'Request measurements from your insurance adjuster. Many adjusters take measurements during their inspection and can share them at no cost.',
  adjusterCardFeatures: [
    'No cost to you',
    'We send a professional email on your behalf',
    'Auto-captured when adjuster replies',
    'May not always be available',
  ],

  // Shared select button on both path cards (help-measurements.html:583/599).
  cardSelectButton: 'Choose This Option',

  // ── Hover flow section (help-measurements.html:607-647) ──
  hoverSectionTitle: 'Complete Property Report',
  hoverSectionIntro:
    'Our advanced technology builds a complete 3D model of your home from photos you take with your phone — roof, walls, openings, and every measurement contractors need to bid accurately.',

  // Rebate callout (help-measurements.html:611) — D-291 financial terms (repriced from D-205's $150), LOCKED.
  // "<strong>How the $15 works:</strong> …" flattened.
  rebateCallout:
    "How the $15 works: You pay $15 now for a complete 3D property data file — every measurement, every wall, every opening, all in one place. When your project closes with an Otter Quotes contractor, the full $15 is rebated to your original payment method. Either way, the file stays with you. We're building a suite of products around your home, and your data file is the foundation of every one of them.",

  // Hover steps (help-measurements.html:614-636).
  hoverStep1Title: 'Purchase Your Report',
  hoverStep1Text:
    'Pay the $15 fee securely through Stripe. This covers your Complete Property Report.',
  hoverStep2Title: 'Take Photos of Your Home',
  hoverStep2Text:
    "We'll send you a link to start your guided photo capture. The photo-capture app walks you through taking 8-10 photos from around your home — it checks photo quality as you go.",
  hoverStep3Title: 'Receive Your Report',
  hoverStep3Text:
    "Our measurement service processes your photos (usually 24-48 hours) and creates a detailed measurement report. We'll save it in your account — you'll get a notification when it's ready.",

  // Info callout (help-measurements.html:639) — "<strong>What you'll need:</strong> …" flattened.
  hoverWhatYouNeed:
    "What you'll need: A smartphone with a decent camera and the ability to walk around the outside of your home. Our guided process handles the rest.",

  // Hover purchase button (help-measurements.html:644).
  hoverPurchaseButton: 'Purchase Property Data File — $15',
  // Shared "go back" button (help-measurements.html:646/724).
  chooseDifferentButton: '← Choose Different Option',

  // ── Stripe card form (help-measurements.html:649-659) ──
  hoverCardFormLead: '💳 Enter your card details to complete the $15 purchase:',
  hoverPayButton: 'Pay $15 Securely',
  hoverCancelButton: 'Cancel',
  // Stripe security line (help-measurements.html:658) — LOCKED, exact.
  stripeSecurityLine:
    '🔒 Payment secured by Stripe. Your card info is never stored on our servers.',

  // ── Hover payment success (help-measurements.html:663-676) ──
  hoverSuccessIcon: '📐',
  hoverSuccessTitle: 'Measurement Report Ordered',
  hoverSuccessText:
    'Your Complete Property Report has been ordered. Check your email and text messages for a link to take photos of your home.',
  // "<strong>Next steps:</strong> …" flattened (help-measurements.html:671).
  hoverSuccessNextSteps:
    'Next steps: Open the link on your phone, walk around the outside of your home, and follow the guided photo capture. The report is usually ready in 24-48 hours.',
  // Shared return-to-dashboard button (help-measurements.html:675/742).
  returnToDashboardButton: 'Return to Dashboard',

  // ── Adjuster flow section (help-measurements.html:683-725) ──
  adjusterSectionTitle: 'Request Measurements from Your Adjuster',
  adjusterIntro:
    "If you're working with an insurance claim, we can request property measurements from your adjuster. Many adjusters take measurements during their inspection and can share them at no cost. (If you're paying out of pocket, the Complete Property Report is your best option.)",
  // "<strong>Good news:</strong> …" flattened (help-measurements.html:691).
  alreadySentEstimateNote:
    "Good news: We already sent an email to your adjuster requesting your insurance estimate. Since that email also requested measurements, you don't need to send another one. We'll capture any measurements they include in their response.",
  adjusterInfoTitle: 'Adjuster Information',
  adjusterInfoText:
    "Enter your adjuster's details. If you already provided this on the estimate page, it's pre-filled.",

  // Adjuster form labels + placeholders (help-measurements.html:699-711).
  adjusterNameLabel: 'Adjuster Name',
  adjusterNamePlaceholder: 'e.g., John Smith',
  adjusterEmailLabel: 'Adjuster Email',
  adjusterEmailPlaceholder: 'e.g., john.smith@insurance.com',
  adjusterPhoneLabel: 'Adjuster Phone',
  adjusterPhonePlaceholder: 'e.g., (317) 555-1234',
  requiredStar: '*',

  // Email preview (help-measurements.html:715-716).
  emailPreviewHeading: 'Email Preview',
  // The #emailPreview default text. Its updater (updateEmailPreview) is called-but-never-defined
  // in the static, and no preview body template exists in the file — so this placeholder is the
  // ONLY email-preview copy that actually ships. See header note + PR body.
  emailPreviewLoading: 'Loading...',

  // Followup note in the adjuster form (help-measurements.html:719) — "<strong>What happens
  // next:</strong> …" flattened.
  adjusterFollowupNote:
    "What happens next: If your adjuster doesn't respond within 48 hours, we'll text you with a recommended call script so you can follow up directly.",
  // Send button (help-measurements.html:723).
  sendMeasurementEmailButton: 'Send Request to Adjuster',

  // ── Email success state (help-measurements.html:730-742) ──
  emailSuccessIcon: '✓',
  emailSuccessTitle: 'Measurement Request Sent',
  emailSuccessText:
    "We've emailed your adjuster requesting property measurements. When they reply, we'll automatically capture the documents and attach them to your claim.",
  // "<strong>48-Hour Follow-Up:</strong> …" flattened (help-measurements.html:738).
  emailSuccess48HourNote:
    "48-Hour Follow-Up: If we don't hear back within 48 hours, we'll text you with a call script to follow up directly with your adjuster.",

  // ── Operational status / transient button labels (help-measurements.html:801-1088) ──
  // User-facing toast + button-state strings the PR-2 page will render.
  statusInitError: 'Failed to load page. Please refresh.',
  statusPaymentInitError: 'Could not initialize payment. Please try again.',
  statusEmailValidation: "Please enter the adjuster's email address.",
  statusEmailSent:
    "Email sent to your adjuster. We'll follow up if they don't respond within 48 hours.",
  statusEmailError: 'Failed to send email. Please try again or contact support.',
  loadingButton: 'Loading...',
  payProcessingButton: 'Processing...',
  payOrderingButton: 'Ordering your report...',
  sendingButton: 'Sending…',
  emailSentButton: '✓ Email Sent!',
} as const;
