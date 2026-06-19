/**
 * Contractor contract-signing copy — D-211 Phase 17 Unit B.
 *
 * TIER-3 verbatim-locked copy. Two blocks are ported BYTE-FOR-BYTE from the live
 * reference flows and asserted by the parity test (./__tests__/sign.test.ts) — any
 * reword trips it. Do NOT edit the locked strings without Dustin's approval.
 *
 *   1. The IC 24-5-11 "contractor signs first" legal disclaimer is ported verbatim
 *      from contractor-bid-form.html #contractSigningStep (the dead/unreachable
 *      contractor_sign block, lines ~2348-2355).
 *   2. The signed-confirmation copy + the in-iframe "Returning" bridge text are
 *      ported verbatim from contract-signing.html (the live homeowner embedded-
 *      signing reference: #docusignSigned + the iframe-detection block).
 *
 * The deprecated success sentence in the static block ("Your bid is now live. If the
 * homeowner selects you, the contract will be sent...") describes the OLD bid-time
 * flow and is factually wrong post-selection, so it is intentionally NOT ported;
 * the accurate homeowner-reference success copy is used instead (also verbatim).
 */

export const SIGN_COPY = {
  // ── TIER-3 LEGAL — verbatim: contractor-bid-form.html #contractSigningStep ──
  legalHeading: '⚖️ Sign Your Contract — Required by Indiana Law',
  // Para 1 is split around the bold "before"; legalPara1Lead + legalPara1Emphasis +
  // legalPara1Tail reconstitutes the verbatim sentence (asserted by the parity test).
  legalPara1Lead: 'Indiana law (IC 24-5-11) requires that you, as the contractor, sign the contract ',
  legalPara1Emphasis: 'before',
  legalPara1Tail:
    ' the homeowner. Your contract template has been pre-filled with the project details. Please review and sign below.',
  legalPara2:
    'An IC 24-5-11 compliance addendum (Statement of Right to Cancel + Notice of Cancellation) has been automatically attached.',

  // ── TIER-3 success state — verbatim: contract-signing.html #docusignSigned ──
  signedTitle: 'Contract Signed Successfully',
  signedBody: 'Your signed contract has been recorded.',

  // ── In-iframe return bridge — verbatim: contract-signing.html iframe block ──
  returningText: 'Contract signed! Returning...',

  // ── DocuSign prep states — verbatim: contractor-bid-form.html ──
  loadingTitle: 'Preparing your contract for signing...',
  loadingHint: 'This may take a few seconds.',
  errorTitle: 'Unable to prepare contract',
  errorDetail: 'Please try again or contact support.',

  // ── Page chrome (non-legal) ──
  pageTitle: 'Sign Your Contract',
  proceedCta: 'Proceed to Sign →',
  retryCta: 'Retry',
  redirectingText: 'Returning you to your dashboard…',
  noContractTitle: 'No contract awaiting your signature',
  noContractBody:
    "There's no contract awaiting your signature for this project. A contract appears here once a homeowner selects your bid.",
  alreadySignedTitle: 'You have already signed this contract',
  alreadySignedBody:
    'Your signature is on file. The homeowner will be prompted to sign next. Nothing more is needed from you.',
  noProjectError: 'No project specified. Open a contract to sign from your dashboard.',
  loadFailedError: 'This contract could not be loaded. It may no longer be available.',
  backToDashboard: '← Back to Dashboard',
} as const;
