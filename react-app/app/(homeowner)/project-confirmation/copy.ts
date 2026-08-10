/**
 * Homeowner project-confirmation copy — D-211 Phase 26, PR 1/2 (ADDITIVE).
 *
 * Source file:  project-confirmation.html (repo root)
 * Branched from: main (feature/d211-project-confirmation-pr1)
 *
 * TIER-3 VERBATIM-LOCKED. The legal / disclosure blocks below are ported
 * BYTE-FOR-BYTE (rendered text content) from project-confirmation.html and asserted by
 * ./__tests__/project-confirmation.test.ts — any reword trips the lock. Do NOT edit a
 * locked string without Dustin's approval.
 *
 * Faithful-port notes (same idiom as the H3 contract-signing copy.ts):
 *   • HTML entities are decoded to their rendered glyph because React renders text
 *     nodes, not HTML:  &mdash;→—  ·  &#x270F;&#xFE0F;→✏️  ·  &amp;→&  ·  &rarr;→→.
 *   • Inline <strong>/<em> markup is presentation-only and flattened to plain text
 *     (the words are what is locked). The trailing "(Initial)" comes from <em>(Initial)</em>
 *     and is preserved including its leading space inside the ack labels.
 *   • The depreciation disclosure is stored SPLIT around the #depreciationAmtDisplay
 *     injection point (lead + "$___" default + tail), mirroring how H3 split the
 *     #ackContractorName span. lead + amount-default + tail reconstitutes the verbatim
 *     sentence (asserted by the parity test). The runtime replaces "$___" with the
 *     formatted depreciation amount (PR 2/2).
 *   • The bad-decking ack carries a "Decking rate per sheet:" sublabel whose value is
 *     injected at #deckingRateDisplay (static default "—"); the label text is locked here,
 *     the injected value is wired in PR 2/2.
 *   • The Rotten Sheathing disclosure ports the literal "[Contractor]" token AS-IS — it is
 *     NOT resolved here (per brief).
 *   • gh-418 (2026-08-10): disclosuresIntro's "All four are required" was inaccurate (the
 *     required-ack set is dynamic, 3-6 depending on trades/insurance) and has been
 *     corrected to drop the count. Not a TIER-3 LEGAL string, no sign-off gate applies.
 *   • Indiana / current-source copy is preserved exactly. D-247 multi-state abstraction is
 *     a SEPARATE gated change and is NOT applied here.
 *
 * Locked-block source line ranges (project-confirmation.html):
 *   Page header H1 + subtitle ........................ 859-860
 *   Bad Decking Disclosure + ack + sublabel .......... 1086, 1091-1092
 *   Rotten Sheathing Disclosure + ack ................ 1277-1278, 1283
 *   Disclosures section header + intro ............... 1393, 1395
 *   Non-Recoverable Depreciation disclosure + ack .... 1403, 1405-1406
 *   Payment Terms disclosure + ack ................... 1415, 1417
 *   Project Changes disclosure + ack ................. 1426, 1428
 *   "The Above Information Is Correct" + sublabel .... 1436-1437
 *   Submit button ................................... 1447
 */

export const CONFIRM_COPY = {
  // ── Page header (project-confirmation.html:859-860) — non-legal chrome, but locked for parity ──
  headerTitle: 'Project Confirmation — Roofing',
  headerSubtitle:
    'Your contract is signed. Review the details below, answer a few questions, and initial the disclosures. Your contractor receives a signed confirmation document as soon as you submit.',

  // ── TIER-3 LEGAL — Bad Decking Disclosure (project-confirmation.html:1086) ──
  badDeckingDisclosure:
    "BAD DECKING DISCLOSURE: I understand that decking cannot be inspected until the shingles are removed from the roof. On the day of install, my contractor is required by law to replace all bad decking discovered during removal. If any decking needs to be replaced, my contractor will submit an estimate of the costs to me and to my insurance company, but they cannot guarantee that my insurance company will pay for bad decking. I agree to sign the estimate and pay for re-decking at the contractor's stated per-sheet rate if my insurance company will not cover it.",
  // ack label + sublabel (project-confirmation.html:1091-1092)
  badDeckingAckLabel: 'I have read and understand the Bad Decking Disclosure above. (Initial)',
  deckingRateSublabelLabel: 'Decking rate per sheet:',
  // #deckingRateDisplay default glyph (&mdash;). PR 2/2 injects the formatted rate.
  deckingRateDisplayDefault: '—',

  // ── TIER-3 LEGAL — Rotten Sheathing Disclosure (project-confirmation.html:1277-1278) ──
  // "[Contractor]" is ported AS-IS (NOT resolved).
  rottenSheathingHeading: 'Rotten Sheathing',
  rottenSheathingDisclosure:
    'Rotten or damaged wall sheathing cannot be fully inspected until the existing siding is removed. On the day of install, [Contractor] is required to replace all rotten sheathing found. Sheathing replacement costs will be communicated to me before work begins and submitted to my insurance company. If my insurance company will not pay for sheathing replacement, I will be responsible for the cost.',
  rottenSheathingAckLabel:
    'I have read and understand the Rotten Sheathing Disclosure above. (Initial)',

  // ── Disclosures section header + intro (project-confirmation.html:1393, 1395) ──
  disclosuresSectionTitle: '✏️ Disclosures & Acknowledgments',
  // gh-418 fix: dropped the inaccurate "All four" count (the required-ack set is dynamic,
  // 3-6 depending on trades/insurance — see buildAckIds()). Not a TIER-3 LEGAL disclosure
  // string, just UI instruction copy, so no Dustin sign-off gate applies to this one.
  disclosuresIntro: 'Please initial each item below before you can submit.',

  // ── TIER-3 LEGAL — Non-Recoverable Depreciation (project-confirmation.html:1403) ──
  // Stored SPLIT around the #depreciationAmtDisplay injection point ("$___" default).
  // lead + amount-default + tail == the verbatim sentence (asserted by the parity test).
  depreciationDisclosureLead:
    'NON-RECOVERABLE DEPRECIATION: My insurance claim shows non-recoverable depreciation in the amount of ',
  depreciationAmountDefault: '$___',
  depreciationDisclosureTail:
    '. I understand that this is money my insurance company will not be paying to me, but I will still be responsible for paying my contractor the full Replacement Cost Value (RCV) of my project.',
  // ack label + sublabel (project-confirmation.html:1405-1406)
  depreciationAckLabel:
    'I have read and understand the Non-Recoverable Depreciation disclosure above. (Initial)',
  depreciationAckSublabel:
    'If your policy does not have non-recoverable depreciation, this acknowledgment confirms you have reviewed the financial details.',

  // ── TIER-3 LEGAL — Payment Terms (project-confirmation.html:1415) ──
  paymentTermsDisclosure:
    'PAYMENT DUE 30 DAYS AFTER TRADE COMPLETED: I understand that full payment for completed work is due 30 days after that trade is completed. My contractor will contact my insurance company to confirm that a trade is completed, but it is my responsibility to ensure the balance due to my contractor is paid on time.',
  paymentTermsAckLabel: 'I have read and understand the Payment Terms disclosure above. (Initial)',

  // ── TIER-3 LEGAL — Project Changes (project-confirmation.html:1426) ──
  projectChangesDisclosure:
    'PROJECT CHANGES: Should I make any changes to the project after signing this document, I understand that I will need to sign a revised document and the changes could delay my install date.',
  projectChangesAckLabel:
    'I have read and understand the Project Changes disclosure above. (Initial)',

  // ── TIER-3 LEGAL — The Above Information Is Correct (project-confirmation.html:1436-1437) ──
  infoCorrectLabel:
    'THE ABOVE INFORMATION IS CORRECT. I have reviewed all selections and scope items in this Project Confirmation and confirm they are accurate to the best of my knowledge. (Initial)',
  infoCorrectSublabel:
    'This does not modify your signed contract — it confirms the project details discussed.',

  // ── Submit button (project-confirmation.html:1447) ──
  submitCta: 'Submit Project Confirmation →',
} as const;
