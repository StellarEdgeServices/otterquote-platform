/**
 * Verbatim copy-lock tests for the homeowner help-measurements scaffolding
 * (D-211 Phase 28 — PR 1/2, ADDITIVE).
 *
 * Every user-facing string in ../copy.ts is asserted BYTE-FOR-BYTE against an independently
 * re-typed snapshot of help-measurements.html (the live homeowner reference). Any reword of
 * copy.ts trips this lock. The D-291 financial terms ($15 price line + rebate callout,
 * repricing D-205's now-superseded $150) and the Stripe security line are the highest-value
 * locks.
 *
 * Convention mirrors H5 color-selection.test.ts: the STATIC object below is typed by hand from
 * the static page (entities decoded, <strong> flattened) and is the source of truth for the
 * assertions — it is NOT imported from copy.ts.
 */

import { describe, it, expect } from 'vitest';
import { MEASUREMENTS_COPY } from '../copy';

// ── Verbatim source strings — help-measurements.html (entities decoded; em-dash = U+2014) ──
const STATIC = {
  // header (553-556)
  pageTitle: 'Measurements',
  pageSubtitle: 'Help Me: Get property measurements for your project',
  backLink: '← Back to Dashboard',
  // path intro (565-566)
  pathIntroTitle: 'How would you like to get measurements?',
  pathIntroText:
    'Accurate measurements help contractors provide more precise bids. Choose the option that works best for you.',
  // Hover card (572-583)
  hoverBadge: 'Recommended for Most',
  hoverIcon: '📐',
  hoverCardTitle: 'Hover Complete Property Data File',
  hoverCardPrice: '$15 (rebated if you use an Otter Quotes contractor)',
  hoverCardDescription:
    "Get a complete 3D model of your home — roof, walls, openings, and full measurements — by taking photos with your phone. Hover's technology builds the model from your photos. This is your best option for any full-replacement project.",
  hoverCardFeatures: [
    'Precise, professional-grade measurements',
    '3D model of your property',
    'Ready in 24-48 hours',
    'Cost rebated when using an Otter Quotes contractor',
  ],
  // Adjuster card (588-599)
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
  cardSelectButton: 'Choose This Option',
  // Hover flow (607-647)
  hoverSectionTitle: 'Hover Complete Property Data File',
  hoverSectionIntro:
    'Hover uses advanced technology to build a complete 3D model of your home from photos you take with your phone — roof, walls, openings, and every measurement contractors need to bid accurately.',
  rebateCallout:
    "How the $15 works: You pay $15 now for a complete 3D property data file — every measurement, every wall, every opening, all in one place. When your project closes with an Otter Quotes contractor, the full $15 is rebated to your original payment method. Either way, the file stays with you. We're building a suite of products around your home, and your data file is the foundation of every one of them.",
  hoverStep1Title: 'Purchase Your Report',
  hoverStep1Text:
    'Pay the $15 fee securely through Stripe. This covers your RoofScope Complete property data file.',
  hoverStep2Title: 'Take Photos of Your Home',
  hoverStep2Text:
    "We'll send you a link to Hover's guided photo capture. Their app walks you through taking 8-10 photos from around your home — it checks photo quality as you go.",
  hoverStep3Title: 'Receive Your Report',
  hoverStep3Text:
    "Hover processes your photos (usually 24-48 hours) and creates a detailed measurement report. We'll save it in your account — you'll get a notification when it's ready.",
  hoverWhatYouNeed:
    "What you'll need: A smartphone with a decent camera and the ability to walk around the outside of your home. Hover's guided process handles the rest.",
  hoverPurchaseButton: 'Purchase Property Data File — $15',
  chooseDifferentButton: '← Choose Different Option',
  // Stripe form (649-659)
  hoverCardFormLead: '💳 Enter your card details to complete the $15 purchase:',
  hoverPayButton: 'Pay $15 Securely',
  hoverCancelButton: 'Cancel',
  stripeSecurityLine:
    '🔒 Payment secured by Stripe. Your card info is never stored on our servers.',
  // Hover success (663-676)
  hoverSuccessIcon: '📐',
  hoverSuccessTitle: 'Hover Report Ordered',
  hoverSuccessText:
    'Your Hover Complete property data file has been ordered. Check your email and text messages for a link to take photos of your home.',
  hoverSuccessNextSteps:
    'Next steps: Open the Hover link on your phone, walk around the outside of your home, and follow the guided photo capture. The report is usually ready in 24-48 hours.',
  returnToDashboardButton: 'Return to Dashboard',
  // Adjuster flow (683-725)
  adjusterSectionTitle: 'Request Measurements from Your Adjuster',
  adjusterIntro:
    "If you're working with an insurance claim, we can request property measurements from your adjuster. Many adjusters take measurements during their inspection and can share them at no cost. (If you're paying out of pocket, Hover is your best option.)",
  alreadySentEstimateNote:
    "Good news: We already sent an email to your adjuster requesting your insurance estimate. Since that email also requested measurements, you don't need to send another one. We'll capture any measurements they include in their response.",
  adjusterInfoTitle: 'Adjuster Information',
  adjusterInfoText:
    "Enter your adjuster's details. If you already provided this on the estimate page, it's pre-filled.",
  adjusterNameLabel: 'Adjuster Name',
  adjusterNamePlaceholder: 'e.g., John Smith',
  adjusterEmailLabel: 'Adjuster Email',
  adjusterEmailPlaceholder: 'e.g., john.smith@insurance.com',
  adjusterPhoneLabel: 'Adjuster Phone',
  adjusterPhonePlaceholder: 'e.g., (317) 555-1234',
  requiredStar: '*',
  emailPreviewHeading: 'Email Preview',
  emailPreviewLoading: 'Loading...',
  adjusterFollowupNote:
    "What happens next: If your adjuster doesn't respond within 48 hours, we'll text you with a recommended call script so you can follow up directly.",
  sendMeasurementEmailButton: 'Send Request to Adjuster',
  // Email success (730-742)
  emailSuccessIcon: '✓',
  emailSuccessTitle: 'Measurement Request Sent',
  emailSuccessText:
    "We've emailed your adjuster requesting property measurements. When they reply, we'll automatically capture the documents and attach them to your claim.",
  emailSuccess48HourNote:
    "48-Hour Follow-Up: If we don't hear back within 48 hours, we'll text you with a call script to follow up directly with your adjuster.",
  // Operational (801-1088)
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

describe('MEASUREMENTS_COPY — header & path intro', () => {
  it('locks the page header copy', () => {
    expect(MEASUREMENTS_COPY.pageTitle).toBe(STATIC.pageTitle);
    expect(MEASUREMENTS_COPY.pageSubtitle).toBe(STATIC.pageSubtitle);
    expect(MEASUREMENTS_COPY.backLink).toBe(STATIC.backLink);
  });

  it('locks the path-selection intro', () => {
    expect(MEASUREMENTS_COPY.pathIntroTitle).toBe(STATIC.pathIntroTitle);
    expect(MEASUREMENTS_COPY.pathIntroText).toBe(STATIC.pathIntroText);
  });
});

describe('MEASUREMENTS_COPY — D-291 financial terms (highest-value locks)', () => {
  it('locks the $15 price line exactly', () => {
    expect(MEASUREMENTS_COPY.hoverCardPrice).toBe(STATIC.hoverCardPrice);
    expect(MEASUREMENTS_COPY.hoverCardPrice).toBe(
      '$15 (rebated if you use an Otter Quotes contractor)',
    );
  });

  it('locks the full rebate callout (every clause, exact)', () => {
    expect(MEASUREMENTS_COPY.rebateCallout).toBe(STATIC.rebateCallout);
    // spot-check the load-bearing clauses survive verbatim
    expect(MEASUREMENTS_COPY.rebateCallout).toContain('You pay $15 now');
    expect(MEASUREMENTS_COPY.rebateCallout).toContain(
      'the full $15 is rebated to your original payment method',
    );
    expect(MEASUREMENTS_COPY.rebateCallout).toContain('the file stays with you');
  });

  it('locks the Stripe security line exactly', () => {
    expect(MEASUREMENTS_COPY.stripeSecurityLine).toBe(STATIC.stripeSecurityLine);
    expect(MEASUREMENTS_COPY.stripeSecurityLine).toBe(
      '🔒 Payment secured by Stripe. Your card info is never stored on our servers.',
    );
  });

  it('uses a real em-dash (U+2014), not a hyphen, in the rebate callout & price button', () => {
    expect(MEASUREMENTS_COPY.rebateCallout).toContain('—');
    expect(MEASUREMENTS_COPY.hoverPurchaseButton).toContain('—');
  });
});

describe('MEASUREMENTS_COPY — Path A (Hover) card', () => {
  it('locks the Hover card title/badge/icon/price', () => {
    expect(MEASUREMENTS_COPY.hoverBadge).toBe(STATIC.hoverBadge);
    expect(MEASUREMENTS_COPY.hoverIcon).toBe(STATIC.hoverIcon);
    expect(MEASUREMENTS_COPY.hoverCardTitle).toBe(STATIC.hoverCardTitle);
    expect(MEASUREMENTS_COPY.hoverCardPrice).toBe(STATIC.hoverCardPrice);
  });

  it('locks the Hover card description', () => {
    expect(MEASUREMENTS_COPY.hoverCardDescription).toBe(STATIC.hoverCardDescription);
  });

  it('locks all four Hover feature bullets in order', () => {
    expect(MEASUREMENTS_COPY.hoverCardFeatures).toEqual(STATIC.hoverCardFeatures);
  });
});

describe('MEASUREMENTS_COPY — Path B (Ask Adjuster) card', () => {
  it('locks the Adjuster card title/badge/icon/price', () => {
    expect(MEASUREMENTS_COPY.adjusterBadge).toBe(STATIC.adjusterBadge);
    expect(MEASUREMENTS_COPY.adjusterIcon).toBe(STATIC.adjusterIcon);
    expect(MEASUREMENTS_COPY.adjusterCardTitle).toBe(STATIC.adjusterCardTitle);
    expect(MEASUREMENTS_COPY.adjusterCardPrice).toBe(STATIC.adjusterCardPrice);
  });

  it('locks the Adjuster card description', () => {
    expect(MEASUREMENTS_COPY.adjusterCardDescription).toBe(STATIC.adjusterCardDescription);
  });

  it('locks all four Adjuster feature bullets in order', () => {
    expect(MEASUREMENTS_COPY.adjusterCardFeatures).toEqual(STATIC.adjusterCardFeatures);
  });

  it('locks the shared "Choose This Option" select button', () => {
    expect(MEASUREMENTS_COPY.cardSelectButton).toBe(STATIC.cardSelectButton);
  });
});

describe('MEASUREMENTS_COPY — Hover flow section', () => {
  it('locks the section title + intro', () => {
    expect(MEASUREMENTS_COPY.hoverSectionTitle).toBe(STATIC.hoverSectionTitle);
    expect(MEASUREMENTS_COPY.hoverSectionIntro).toBe(STATIC.hoverSectionIntro);
  });

  it('locks all three hover steps (titles + body)', () => {
    expect(MEASUREMENTS_COPY.hoverStep1Title).toBe(STATIC.hoverStep1Title);
    expect(MEASUREMENTS_COPY.hoverStep1Text).toBe(STATIC.hoverStep1Text);
    expect(MEASUREMENTS_COPY.hoverStep2Title).toBe(STATIC.hoverStep2Title);
    expect(MEASUREMENTS_COPY.hoverStep2Text).toBe(STATIC.hoverStep2Text);
    expect(MEASUREMENTS_COPY.hoverStep3Title).toBe(STATIC.hoverStep3Title);
    expect(MEASUREMENTS_COPY.hoverStep3Text).toBe(STATIC.hoverStep3Text);
  });

  it('locks the "what you\'ll need" info callout', () => {
    expect(MEASUREMENTS_COPY.hoverWhatYouNeed).toBe(STATIC.hoverWhatYouNeed);
  });

  it('locks the purchase + go-back buttons', () => {
    expect(MEASUREMENTS_COPY.hoverPurchaseButton).toBe(STATIC.hoverPurchaseButton);
    expect(MEASUREMENTS_COPY.chooseDifferentButton).toBe(STATIC.chooseDifferentButton);
  });

  it('locks the Stripe card-form lead + pay/cancel buttons', () => {
    expect(MEASUREMENTS_COPY.hoverCardFormLead).toBe(STATIC.hoverCardFormLead);
    expect(MEASUREMENTS_COPY.hoverPayButton).toBe(STATIC.hoverPayButton);
    expect(MEASUREMENTS_COPY.hoverCancelButton).toBe(STATIC.hoverCancelButton);
  });
});

describe('MEASUREMENTS_COPY — Hover success state', () => {
  it('locks the hover-success block', () => {
    expect(MEASUREMENTS_COPY.hoverSuccessIcon).toBe(STATIC.hoverSuccessIcon);
    expect(MEASUREMENTS_COPY.hoverSuccessTitle).toBe(STATIC.hoverSuccessTitle);
    expect(MEASUREMENTS_COPY.hoverSuccessText).toBe(STATIC.hoverSuccessText);
    expect(MEASUREMENTS_COPY.hoverSuccessNextSteps).toBe(STATIC.hoverSuccessNextSteps);
    expect(MEASUREMENTS_COPY.returnToDashboardButton).toBe(STATIC.returnToDashboardButton);
  });
});

describe('MEASUREMENTS_COPY — Adjuster flow section', () => {
  it('locks the section title + intro', () => {
    expect(MEASUREMENTS_COPY.adjusterSectionTitle).toBe(STATIC.adjusterSectionTitle);
    expect(MEASUREMENTS_COPY.adjusterIntro).toBe(STATIC.adjusterIntro);
  });

  it('locks the already-sent-estimate info callout', () => {
    expect(MEASUREMENTS_COPY.alreadySentEstimateNote).toBe(STATIC.alreadySentEstimateNote);
  });

  it('locks the adjuster-info title + helper text', () => {
    expect(MEASUREMENTS_COPY.adjusterInfoTitle).toBe(STATIC.adjusterInfoTitle);
    expect(MEASUREMENTS_COPY.adjusterInfoText).toBe(STATIC.adjusterInfoText);
  });

  it('locks all form labels + placeholders + required star', () => {
    expect(MEASUREMENTS_COPY.adjusterNameLabel).toBe(STATIC.adjusterNameLabel);
    expect(MEASUREMENTS_COPY.adjusterNamePlaceholder).toBe(STATIC.adjusterNamePlaceholder);
    expect(MEASUREMENTS_COPY.adjusterEmailLabel).toBe(STATIC.adjusterEmailLabel);
    expect(MEASUREMENTS_COPY.adjusterEmailPlaceholder).toBe(STATIC.adjusterEmailPlaceholder);
    expect(MEASUREMENTS_COPY.adjusterPhoneLabel).toBe(STATIC.adjusterPhoneLabel);
    expect(MEASUREMENTS_COPY.adjusterPhonePlaceholder).toBe(STATIC.adjusterPhonePlaceholder);
    expect(MEASUREMENTS_COPY.requiredStar).toBe(STATIC.requiredStar);
  });

  it('locks the email-preview heading + its real "Loading..." default', () => {
    expect(MEASUREMENTS_COPY.emailPreviewHeading).toBe(STATIC.emailPreviewHeading);
    expect(MEASUREMENTS_COPY.emailPreviewLoading).toBe(STATIC.emailPreviewLoading);
  });

  it('locks the 48-hour followup note + send button', () => {
    expect(MEASUREMENTS_COPY.adjusterFollowupNote).toBe(STATIC.adjusterFollowupNote);
    expect(MEASUREMENTS_COPY.sendMeasurementEmailButton).toBe(STATIC.sendMeasurementEmailButton);
  });
});

describe('MEASUREMENTS_COPY — email success state', () => {
  it('locks the email-success block', () => {
    expect(MEASUREMENTS_COPY.emailSuccessIcon).toBe(STATIC.emailSuccessIcon);
    expect(MEASUREMENTS_COPY.emailSuccessTitle).toBe(STATIC.emailSuccessTitle);
    expect(MEASUREMENTS_COPY.emailSuccessText).toBe(STATIC.emailSuccessText);
    expect(MEASUREMENTS_COPY.emailSuccess48HourNote).toBe(STATIC.emailSuccess48HourNote);
  });
});

describe('MEASUREMENTS_COPY — operational status & button labels', () => {
  it('locks the status/toast messages', () => {
    expect(MEASUREMENTS_COPY.statusInitError).toBe(STATIC.statusInitError);
    expect(MEASUREMENTS_COPY.statusPaymentInitError).toBe(STATIC.statusPaymentInitError);
    expect(MEASUREMENTS_COPY.statusEmailValidation).toBe(STATIC.statusEmailValidation);
    expect(MEASUREMENTS_COPY.statusEmailSent).toBe(STATIC.statusEmailSent);
    expect(MEASUREMENTS_COPY.statusEmailError).toBe(STATIC.statusEmailError);
  });

  it('locks the transient button labels (incl. the U+2026 ellipsis on "Sending…")', () => {
    expect(MEASUREMENTS_COPY.loadingButton).toBe(STATIC.loadingButton);
    expect(MEASUREMENTS_COPY.payProcessingButton).toBe(STATIC.payProcessingButton);
    expect(MEASUREMENTS_COPY.payOrderingButton).toBe(STATIC.payOrderingButton);
    expect(MEASUREMENTS_COPY.sendingButton).toBe(STATIC.sendingButton);
    expect(MEASUREMENTS_COPY.sendingButton).toContain('…');
    expect(MEASUREMENTS_COPY.emailSentButton).toBe(STATIC.emailSentButton);
  });
});
