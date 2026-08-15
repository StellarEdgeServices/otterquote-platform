/**
 * Homeowner contract-signing copy — D-211 Phase 25 (H3), PR 1/2.
 *
 * Source file:  contract-signing.html (repo root)
 * Branched from: main @ 92eb09c8fda0d366e8e8581418c992cd852f27cd
 *
 * TIER-3 VERBATIM-LOCKED. The legal / disclosure blocks below are ported
 * BYTE-FOR-BYTE (rendered text content) from contract-signing.html and asserted by
 * ./__tests__/contract-signing.test.tsx — any reword trips the lock. Do NOT edit a
 * locked string without Dustin's approval.
 *
 * Faithful-port notes (same idiom as the Phase-17 contractor copy.ts):
 *   • HTML entities are decoded to their rendered glyph because React renders text
 *     nodes, not HTML:  &mdash;→—  ·  &#x2696;&#xFE0F;→⚖️  ·  &#x1F504;→🔄  ·
 *     &#x1F4CB;→📋  (the 💳/⚖️/✅ icons in the Step-1 callouts live in separate
 *     icon <div>s, NOT in the locked title/body text, so they are not included there).
 *   • Inline <strong>/<a> markup is presentation-only and flattened to plain text
 *     (the words are what is locked); the <a> link text resolves to its address
 *     (support@otterquote.com).
 *   • The D-123 acknowledgment's contractor-name <span> is a runtime placeholder, so
 *     that sentence is stored split (lead + name fallback + tail).
 *   • "Indiana" / "IC 24-5-11" wording is ported AS-IS — D-247 multi-state
 *     abstraction is a SEPARATE gated change.
 *
 * Locked-block source line ranges (contract-signing.html @ 92eb09c):
 *   (b) Step-1 "Right to Cancel" callout ............ 937-938
 *   (c) Step-1 "No Cost to You" (D-206) ............. 946-947
 *   (a) D-123 acknowledgment checkbox + hint ........ 955-956
 *   (d) Step-3 "Your Rights Under Indiana Law" ...... 1046-1047
 *   (e) Step-3 "Otter Quotes Contractor Switch Policy" 1052-1055
 *   (f) Step-3 signed-contract delivery note ........ 1039-1041
 *   signed-confirmation (Step-2) ................... 1002-1003
 *   in-iframe "Returning" bridge text .............. 1122
 */

export const SIGN_COPY = {
  // ── (b) TIER-3 LEGAL — Step 1 "Right to Cancel" callout (contract-signing.html:937-938) ──
  rightToCancelTitle: 'Your Right to Cancel (Indiana Law IC 24-5-11)',
  rightToCancelBody:
    'You may cancel this contract at any time before midnight on the third business day after signing. A Notice of Cancellation form is included in the contract documents. Both you and the contractor will sign this agreement.',

  // ── (c) TIER-3 LEGAL — Step 1 "No Cost to You" (D-206) (contract-signing.html:946-947) ──
  noCostTitle: 'No Cost to You',
  noCostBody:
    'Otter Quotes is 100% free for Homeowners. The price shown in this contract is the price you pay your contractor — there are no separate fees from Otter Quotes.',

  // ── (a) TIER-3 LEGAL — D-123 acknowledgment checkbox (contract-signing.html:955-956) ──
  // Split around the #ackContractorName placeholder span (default text "the contractor");
  // ackLabelLead + ackContractorNameFallback + ackLabelTail reconstitutes the verbatim
  // sentence (asserted by the parity test).
  ackLabelLead: 'I understand I am signing a contract directly with ',
  ackContractorNameFallback: 'the contractor',
  ackLabelTail: '. Otter Quotes is not a party to this agreement.',
  ackHint: 'Required before signing.',

  // ── (d) TIER-3 LEGAL — Step 3 "Your Rights Under Indiana Law" (contract-signing.html:1046-1047) ──
  indianaRightsTitle: '⚖️ Your Rights Under Indiana Law (IC 24-5-11)',
  indianaRightsBody:
    'You have the right to cancel this contract at any time before midnight on the third business day after the date you signed. To cancel, complete and deliver the Notice of Cancellation form included in your contract documents to your contractor. No penalty applies.',

  // ── (e) TIER-3 LEGAL — Step 3 "Otter Quotes Contractor Switch Policy" (contract-signing.html:1052-1055) ──
  switchPolicyTitle: '🔄 Otter Quotes Contractor Switch Policy',
  switchPolicyP1:
    'Changed your mind about your contractor? Up to 3 days before your scheduled installation date, you can switch to a different contractor in the Otter Quotes network — at no cost to you.',
  switchPolicyP2:
    'Otter Quotes handles the entire transition. Your project goes back out to the contractor network and a replacement is selected. You do not need to contact your current contractor directly.',
  switchPolicyNote:
    'Note: If you choose to leave the Otter Quotes platform entirely rather than switch within the network, you remain bound by the contract you signed with your contractor. To initiate a contractor switch, go to your dashboard and use the "Switch Contractor" option, or contact us at support@otterquote.com.',

  // ── (f) TIER-3 LEGAL — Step 3 signed-contract delivery note (contract-signing.html:1039-1041) ──
  signedContractTitle: '📋 Your Signed Contract',
  signedContractBody:
    'DocuSign has emailed a copy of your fully signed contract to the address on your account. Keep it for your records.',
  signedContractSpam:
    "If you don't see it within a few minutes, check your spam folder or contact us at support@otterquote.com.",

  // ── TIER-3 — Step 2 success state (contract-signing.html:1002-1003) ──
  signedTitle: 'Contract Signed Successfully',
  signedBody: 'Your signed contract has been recorded.',

  // ── In-iframe return bridge text (contract-signing.html:1122) ──
  returningText: 'Contract signed! Returning...',

  // ── Page chrome (non-legal) — mirrors the contractor copy.ts split. Not lock-tested. ──
  headerTitle: 'Contract Review & Signature',
  headerSubtitle: "Review your contractor's agreement and sign electronically.",
  step2Title: 'Electronic Signature',
  step2Intro:
    "Your contractor's contract has been pre-filled with your project details. Review and sign the document below.",
  loadingTitle: 'Preparing your contract...',
  loadingHint: 'This may take a few seconds.',
  errorTitle: 'Unable to load contract',
  errorDetail: 'Please try again or contact support.',
  proceedCta: 'Proceed to Sign →',
  retryCta: 'Retry',
  continueCta: 'Continue →',
  backToBids: '← Back to Bids',
  backToReview: '← Back to Review',
  allSetTitle: "You're All Set!",
  goToDashboard: 'Go to My Dashboard →',
  redirectingText: 'Returning you to your dashboard…',
  noContractTitle: 'No contract awaiting your signature',
  noContractBody:
    "There's no contract awaiting your signature for this project. A contract appears here once your selected contractor has signed.",
  alreadySignedTitle: 'You have already signed this contract',
  alreadySignedBody:
    "Your signature is on file. We've emailed you a copy. Nothing more is needed from you.",
  noProjectError: 'No project specified. Open a contract to sign from your bids page.',
} as const;
