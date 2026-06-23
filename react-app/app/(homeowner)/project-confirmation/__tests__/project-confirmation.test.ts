/**
 * Parity + unit tests for the homeowner project-confirmation scaffolding
 * (D-211 Phase 26 — PR 1/2, ADDITIVE).
 *
 *  1. TIER-3 verbatim copy: the disclosure / legal blocks are asserted BYTE-FOR-BYTE
 *     against project-confirmation.html (the live homeowner reference). Any reword of
 *     ./copy.ts trips this — the intended Tier-3 tripwire. The "[Contractor]" token and the
 *     inaccurate "All four" wording are asserted AS-IS (both ticketed separately).
 *  2. Pure helpers (./utils): trade detection, insurance gating, the dynamic required-ack
 *     set (incl. the preserved case-sensitivity quirk), the submit gate's hidden/absent-ack
 *     behavior, and the project_confirmation payload shape + conditional blocks.
 */

import { describe, it, expect } from 'vitest';
import { CONFIRM_COPY } from '../copy';
import {
  normalizeSelectedTrades,
  detectTrades,
  isInsuranceClaim,
  buildAckIds,
  allAcksChecked,
  buildPayload,
  type AckCheckboxState,
  type BuildPayloadInput,
  type ConfirmationFormValues,
} from '../utils';

// ── Verbatim source strings — project-confirmation.html (see copy.ts line refs) ──
// Entities decoded to rendered glyphs: &mdash;→—  &#x270F;&#xFE0F;→✏️  &amp;→&  &rarr;→→
const STATIC = {
  headerTitle: 'Project Confirmation — Roofing',
  headerSubtitle:
    'Your contract is signed. Review the details below, answer a few questions, and initial the disclosures. Your contractor receives a signed confirmation document as soon as you submit.',
  badDeckingDisclosure:
    "BAD DECKING DISCLOSURE: I understand that decking cannot be inspected until the shingles are removed from the roof. On the day of install, my contractor is required by law to replace all bad decking discovered during removal. If any decking needs to be replaced, my contractor will submit an estimate of the costs to me and to my insurance company, but they cannot guarantee that my insurance company will pay for bad decking. I agree to sign the estimate and pay for re-decking at the contractor's stated per-sheet rate if my insurance company will not cover it.",
  badDeckingAckLabel: 'I have read and understand the Bad Decking Disclosure above. (Initial)',
  deckingRateSublabelLabel: 'Decking rate per sheet:',
  rottenSheathingHeading: 'Rotten Sheathing',
  rottenSheathingDisclosure:
    'Rotten or damaged wall sheathing cannot be fully inspected until the existing siding is removed. On the day of install, [Contractor] is required to replace all rotten sheathing found. Sheathing replacement costs will be communicated to me before work begins and submitted to my insurance company. If my insurance company will not pay for sheathing replacement, I will be responsible for the cost.',
  rottenSheathingAckLabel:
    'I have read and understand the Rotten Sheathing Disclosure above. (Initial)',
  disclosuresSectionTitle: '✏️ Disclosures & Acknowledgments',
  disclosuresIntro: 'Please initial each item below. All four are required before you can submit.',
  // Reconstituted from the split around #depreciationAmtDisplay ($___ default).
  depreciationDisclosureFull:
    'NON-RECOVERABLE DEPRECIATION: My insurance claim shows non-recoverable depreciation in the amount of $___. I understand that this is money my insurance company will not be paying to me, but I will still be responsible for paying my contractor the full Replacement Cost Value (RCV) of my project.',
  depreciationAckLabel:
    'I have read and understand the Non-Recoverable Depreciation disclosure above. (Initial)',
  depreciationAckSublabel:
    'If your policy does not have non-recoverable depreciation, this acknowledgment confirms you have reviewed the financial details.',
  paymentTermsDisclosure:
    'PAYMENT DUE 30 DAYS AFTER TRADE COMPLETED: I understand that full payment for completed work is due 30 days after that trade is completed. My contractor will contact my insurance company to confirm that a trade is completed, but it is my responsibility to ensure the balance due to my contractor is paid on time.',
  paymentTermsAckLabel: 'I have read and understand the Payment Terms disclosure above. (Initial)',
  projectChangesDisclosure:
    'PROJECT CHANGES: Should I make any changes to the project after signing this document, I understand that I will need to sign a revised document and the changes could delay my install date.',
  projectChangesAckLabel:
    'I have read and understand the Project Changes disclosure above. (Initial)',
  infoCorrectLabel:
    'THE ABOVE INFORMATION IS CORRECT. I have reviewed all selections and scope items in this Project Confirmation and confirm they are accurate to the best of my knowledge. (Initial)',
  infoCorrectSublabel:
    'This does not modify your signed contract — it confirms the project details discussed.',
  submitCta: 'Submit Project Confirmation →',
};

describe('TIER-3 verbatim homeowner disclosure copy (byte-for-byte)', () => {
  it('page header + section header + intro match project-confirmation.html exactly', () => {
    expect(CONFIRM_COPY.headerTitle).toBe(STATIC.headerTitle);
    expect(CONFIRM_COPY.headerSubtitle).toBe(STATIC.headerSubtitle);
    expect(CONFIRM_COPY.disclosuresSectionTitle).toBe(STATIC.disclosuresSectionTitle);
    // "All four" is inaccurate but locked verbatim (ticketed separately).
    expect(CONFIRM_COPY.disclosuresIntro).toBe(STATIC.disclosuresIntro);
    expect(CONFIRM_COPY.disclosuresIntro).toContain('All four');
  });

  it('Bad Decking disclosure + ack + sublabel match exactly', () => {
    expect(CONFIRM_COPY.badDeckingDisclosure).toBe(STATIC.badDeckingDisclosure);
    expect(CONFIRM_COPY.badDeckingAckLabel).toBe(STATIC.badDeckingAckLabel);
    expect(CONFIRM_COPY.deckingRateSublabelLabel).toBe(STATIC.deckingRateSublabelLabel);
    expect(CONFIRM_COPY.deckingRateDisplayDefault).toBe('—');
  });

  it('Rotten Sheathing disclosure ports the literal [Contractor] token AS-IS', () => {
    expect(CONFIRM_COPY.rottenSheathingHeading).toBe(STATIC.rottenSheathingHeading);
    expect(CONFIRM_COPY.rottenSheathingDisclosure).toBe(STATIC.rottenSheathingDisclosure);
    expect(CONFIRM_COPY.rottenSheathingDisclosure).toContain('[Contractor]');
    expect(CONFIRM_COPY.rottenSheathingAckLabel).toBe(STATIC.rottenSheathingAckLabel);
  });

  it('Non-Recoverable Depreciation (split lead + $___ default + tail) reconstitutes exactly', () => {
    expect(
      CONFIRM_COPY.depreciationDisclosureLead +
        CONFIRM_COPY.depreciationAmountDefault +
        CONFIRM_COPY.depreciationDisclosureTail,
    ).toBe(STATIC.depreciationDisclosureFull);
    expect(CONFIRM_COPY.depreciationAmountDefault).toBe('$___');
    expect(CONFIRM_COPY.depreciationAckLabel).toBe(STATIC.depreciationAckLabel);
    expect(CONFIRM_COPY.depreciationAckSublabel).toBe(STATIC.depreciationAckSublabel);
  });

  it('Payment Terms + Project Changes + Info-Correct blocks match exactly', () => {
    expect(CONFIRM_COPY.paymentTermsDisclosure).toBe(STATIC.paymentTermsDisclosure);
    expect(CONFIRM_COPY.paymentTermsAckLabel).toBe(STATIC.paymentTermsAckLabel);
    expect(CONFIRM_COPY.projectChangesDisclosure).toBe(STATIC.projectChangesDisclosure);
    expect(CONFIRM_COPY.projectChangesAckLabel).toBe(STATIC.projectChangesAckLabel);
    expect(CONFIRM_COPY.infoCorrectLabel).toBe(STATIC.infoCorrectLabel);
    expect(CONFIRM_COPY.infoCorrectSublabel).toBe(STATIC.infoCorrectSublabel);
  });

  it('submit CTA matches exactly', () => {
    expect(CONFIRM_COPY.submitCta).toBe(STATIC.submitCta);
  });
});

describe('normalizeSelectedTrades', () => {
  it('passes arrays through and coerces non-arrays to []', () => {
    expect(normalizeSelectedTrades(['roofing'])).toEqual(['roofing']);
    expect(normalizeSelectedTrades(null)).toEqual([]);
    expect(normalizeSelectedTrades(undefined)).toEqual([]);
    expect(normalizeSelectedTrades('roofing')).toEqual([]);
  });
});

describe('detectTrades (case-insensitive, section show/hide)', () => {
  it('treats empty/absent trades as roofing (fallback)', () => {
    expect(detectTrades([])).toEqual({
      hasRoofing: true,
      hasSiding: false,
      hasGutters: false,
      hasWindows: false,
    });
    expect(detectTrades(null).hasRoofing).toBe(true);
  });

  it('detects each trade case-insensitively', () => {
    expect(detectTrades(['Roofing']).hasRoofing).toBe(true);
    expect(detectTrades(['SIDING']).hasSiding).toBe(true);
    expect(detectTrades(['Windows']).hasWindows).toBe(true);
  });

  it('counts gutters, downspouts, and the singular "gutter" toward gutters', () => {
    expect(detectTrades(['gutters']).hasGutters).toBe(true);
    expect(detectTrades(['downspouts']).hasGutters).toBe(true);
    expect(detectTrades(['Gutter']).hasGutters).toBe(true);
  });

  it('a non-empty non-roofing trade set turns roofing off', () => {
    expect(detectTrades(['siding']).hasRoofing).toBe(false);
  });
});

describe('isInsuranceClaim', () => {
  it('true for funding_type insurance or job_type containing "insurance"', () => {
    expect(isInsuranceClaim({ funding_type: 'insurance' })).toBe(true);
    expect(isInsuranceClaim({ job_type: 'roof_insurance' })).toBe(true);
  });
  it('false for retail / missing signals', () => {
    expect(isInsuranceClaim({ funding_type: 'retail', job_type: 'retail_roof' })).toBe(false);
    expect(isInsuranceClaim({})).toBe(false);
    expect(isInsuranceClaim(null)).toBe(false);
    expect(isInsuranceClaim(undefined)).toBe(false);
  });
});

describe('buildAckIds (dynamic required-ack set)', () => {
  const UNIVERSAL = ['ackPaymentTerms', 'ackProjectChanges', 'ackInfoCorrect'];

  it('roofing fallback (empty trades) + retail ⇒ bad-decking + universal', () => {
    expect(buildAckIds([], false)).toEqual(['ackBadDecking', ...UNIVERSAL]);
  });

  it('roofing + insurance ⇒ bad-decking + depreciation + universal', () => {
    expect(buildAckIds(['roofing'], true)).toEqual([
      'ackBadDecking',
      'ackDepreciation',
      ...UNIVERSAL,
    ]);
  });

  it('siding-only + retail ⇒ rotten-sheathing + universal (no bad-decking)', () => {
    expect(buildAckIds(['siding'], false)).toEqual(['ackRottenSheathing', ...UNIVERSAL]);
  });

  it('roofing + siding + insurance ⇒ all three trade/claim acks + universal', () => {
    expect(buildAckIds(['roofing', 'siding'], true)).toEqual([
      'ackBadDecking',
      'ackRottenSheathing',
      'ackDepreciation',
      ...UNIVERSAL,
    ]);
  });

  it('gutters/downspouts add no ack of their own', () => {
    expect(buildAckIds(['gutters'], false)).toEqual(UNIVERSAL);
    expect(buildAckIds(['downspouts'], false)).toEqual(UNIVERSAL);
  });

  it('PRESERVED QUIRK: case-sensitive — mixed-case "Roofing" does NOT require bad-decking', () => {
    // detectTrades() would SHOW the ack (case-insensitive); buildAckIds does NOT require it
    // (case-sensitive on raw trades). This divergence is intentional — see utils.ts note.
    expect(buildAckIds(['Roofing'], false)).toEqual(UNIVERSAL);
    expect(detectTrades(['Roofing']).hasRoofing).toBe(true);
  });
});

describe('allAcksChecked (hidden/absent acks satisfied)', () => {
  const present = (checked: boolean, hidden = false): AckCheckboxState => ({
    present: true,
    hidden,
    checked,
  });
  const IDS = ['ackBadDecking', 'ackPaymentTerms', 'ackProjectChanges', 'ackInfoCorrect'];

  it('true when every required ack is present and checked', () => {
    const states = Object.fromEntries(IDS.map((id) => [id, present(true)]));
    expect(allAcksChecked(IDS, states)).toBe(true);
  });

  it('false when a present required ack is unchecked', () => {
    const states = Object.fromEntries(IDS.map((id) => [id, present(true)]));
    states.ackPaymentTerms = present(false);
    expect(allAcksChecked(IDS, states)).toBe(false);
  });

  it('a hidden ack is treated as satisfied even if unchecked', () => {
    const states = Object.fromEntries(IDS.map((id) => [id, present(true)]));
    states.ackBadDecking = present(false, /* hidden */ true);
    expect(allAcksChecked(IDS, states)).toBe(true);
  });

  it('an absent ack (no DOM element / no entry) is treated as satisfied', () => {
    const states: Record<string, AckCheckboxState | undefined> = {
      ackPaymentTerms: present(true),
      ackProjectChanges: present(true),
      ackInfoCorrect: present(true),
      // ackBadDecking absent entirely
    };
    expect(allAcksChecked(IDS, states)).toBe(true);
    states.ackBadDecking = { present: false, hidden: false, checked: false };
    expect(allAcksChecked(IDS, states)).toBe(true);
  });
});

describe('buildPayload (project_confirmation JSONB)', () => {
  const baseInput = (over: Partial<BuildPayloadInput> = {}): BuildPayloadInput => ({
    trades: [],
    submittedAt: '2026-06-23T00:00:00.000Z',
    form: {},
    structures: [],
    skylights: [],
    autoFill: {},
    ...over,
  });

  it('retail roofing (empty trades): activeTrades=[roofing], defaults applied, no siding/gutters blocks', () => {
    const p = buildPayload(baseInput());
    expect(p.activeTrades).toEqual(['roofing']);
    expect(p.submittedAt).toBe('2026-06-23T00:00:00.000Z');
    expect(p.gutterGuards).toBe('None');
    expect(p.satelliteDish).toBe('None');
    expect(p.badDecking).toBe('Unexpected');
    expect(p.shingleManufacturer).toBe('');
    // Conditional blocks absent
    expect(p).not.toHaveProperty('rottenSheathing');
    expect(p).not.toHaveProperty('ackRottenSheathing');
    expect(p).not.toHaveProperty('gutterSize');
    // The 5 universal disclosure booleans always present
    expect(p.ackBadDecking).toBe(false);
    expect(p.ackDepreciation).toBe(false);
    expect(p.ackPaymentTerms).toBe(false);
    expect(p.ackProjectChanges).toBe(false);
    expect(p.ackInfoCorrect).toBe(false);
  });

  it('parseInt coercions: numStructures "0"⇒1, ventBox "0"⇒0, blank sheets⇒0', () => {
    const p = buildPayload(
      baseInput({ form: { numStructures: '0', ventBox: '0', ventRidge: '3', badDeckingSheets: '' } }),
    );
    expect(p.numStructures).toBe(1); // 0 || 1
    expect(p.ventBox).toBe(0); // 0 || 0
    expect(p.ventRidge).toBe(3);
    expect(p.badDeckingSheets).toBe(0); // NaN || 0
  });

  it('passes pre-collected structures + skylights through untouched', () => {
    const structures = [
      {
        name: 'Main',
        roofAsphalt: 'Full',
        roofMetal: 'None',
        siding: 'None',
        gutters: 'Yes',
        downspouts: 'Yes',
        skylightsReplace: '0',
        skylightsReflash: '0',
      },
    ];
    const skylights = [{ scope: 'N/A' }];
    const p = buildPayload(baseInput({ structures, skylights }));
    expect(p.structures).toBe(structures);
    expect(p.skylights).toBe(skylights);
  });

  it('siding active: emits the siding block (incl. ackRottenSheathing), case-sensitive', () => {
    const p = buildPayload(
      baseInput({
        trades: ['siding'],
        form: { rottenSheathing: 'Expected', rottenSheathingSqFt: '12', ackRottenSheathing: true },
      }),
    );
    expect(p.rottenSheathing).toBe('Expected');
    expect(p.rottenSheathingSqFt).toBe(12);
    expect(p.ackRottenSheathing).toBe(true);
    expect(p.soffitFascia).toBe('');
    expect(p.activeTrades).toEqual(['siding']);
  });

  it('gutters active (gutters OR downspouts): emits the gutters block', () => {
    expect(buildPayload(baseInput({ trades: ['gutters'] }))).toHaveProperty('gutterSize', '');
    expect(buildPayload(baseInput({ trades: ['downspouts'] }))).toHaveProperty('splashBlocks', '');
  });

  it('PRESERVED QUIRK: case-sensitive — "Siding"/"Gutters" do NOT emit their conditional blocks', () => {
    const p = buildPayload(baseInput({ trades: ['Siding', 'Gutters'] }));
    expect(p).not.toHaveProperty('rottenSheathing');
    expect(p).not.toHaveProperty('gutterSize');
    // ...yet activeTrades echoes the raw trades verbatim.
    expect(p.activeTrades).toEqual(['Siding', 'Gutters']);
  });

  it('_autoFill: string sources default to "", depreciation/decking pass through (null when absent)', () => {
    const p = buildPayload(
      baseInput({
        autoFill: {
          homeownerName: 'Jane Doe',
          propertyAddress: '1 Main St',
          shingleMftrFromBid: 'GAF',
          depreciation: 1234.5,
        },
      }),
    );
    expect(p._autoFill).toEqual({
      homeownerName: 'Jane Doe',
      propertyAddress: '1 Main St',
      shingleMftrFromBid: 'GAF',
      shingleTypeFromBid: '',
      depreciation: 1234.5,
      deckingRatePerSheet: null,
      contractorName: '',
    });
  });

  it('disclosure checkboxes coerce truthy/undefined to strict booleans', () => {
    const form: ConfirmationFormValues = {
      ackBadDecking: true,
      ackPaymentTerms: true,
      ackProjectChanges: false,
      ackInfoCorrect: true,
    };
    const p = buildPayload(baseInput({ form }));
    expect(p.ackBadDecking).toBe(true);
    expect(p.ackDepreciation).toBe(false); // undefined ⇒ false
    expect(p.ackProjectChanges).toBe(false);
    expect(p.ackInfoCorrect).toBe(true);
  });
});
