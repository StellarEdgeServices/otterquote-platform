/**
 * Parity + unit tests for the homeowner color-selection scaffolding
 * (D-211 Phase 27 — PR 1/2, ADDITIVE).
 *
 *  1. Verbatim copy: every user-facing string is asserted BYTE-FOR-BYTE against
 *     color-selection.html (the live homeowner reference). Any reword of ./copy.ts trips
 *     this. Interpolated copy is asserted through its builder for a fixed sample input.
 *  2. Pure helpers (./utils): brand normalization (incl. the 'OC'/'Owens Corning' aliases
 *     and the untrimmed-passthrough quirk), ZIP extraction + fallback, capability checks,
 *     the visualizer-description fallback, the link-out resolver, primary-phone resolution,
 *     the addendum guard + payload (asserted to carry NO `signer`), the return-url builder,
 *     and the job-number slice.
 */

import { describe, it, expect } from 'vitest';
import {
  COLOR_COPY,
  subtitleBrandKnown,
  subtitleBrandUnconfirmed,
  colorBoardVisitRequested,
  colorBoardPhoneSuffix,
  addendumFallbackWithPhone,
  addendumFallbackNoPhone,
  colorBoardMailtoBody,
} from '../copy';
import {
  COLOR_CONFIRMATION_DOC_TYPE,
  KNOWN_BRANDS,
  LINK_OUT_BRANDS,
  normalizeBrand,
  extractZip,
  hasVisualizer,
  isLinkOutBrand,
  getVisualizerDescription,
  resolveLinkOut,
  resolvePrimaryPhone,
  canCreateAddendum,
  buildColorReturnUrl,
  buildColorAddendumPayload,
  jobNumberFromClaimId,
} from '../utils';

// ── Verbatim source strings — color-selection.html (entities decoded: &mdash;→—) ──
const STATIC = {
  headerTitle: 'Choose Your Color',
  subtitleStaticPlaceholder:
    "Your contractor uses [Brand]. Let's pick the perfect color for your home.",
  noRushText:
    "Take your time — your contract is already signed and your contractor has been notified. There's no rush to pick a color.",
  optionVisualizeTitle: 'See It On Your House',
  optionBrowseTitle: 'Browse Colors',
  optionBrowseDescription: 'See our color catalog and make your selection.',
  optionInPersonTitle: "I'd Rather See Colors In Person",
  optionInPersonDescription: 'Request physical color boards for a closer look at your options.',
  optionVisualizeButton: 'Start Visualizing',
  optionBrowseButton: 'View Colors',
  optionInPersonButton: 'Request Visit',
  opensInNewTabLabel: 'Opens in new tab',
  inPersonTitle: 'Prefer to See Colors In Person?',
  inPersonDescription:
    'Request physical color boards. Your contractor will bring shingle samples to your home so you can see the real colors in your own lighting and against your exterior.',
  inPersonButton: 'Request In-Person Color Samples',
  confirmationTitle: 'What Color Did You Choose?',
  confirmationSubtitle: 'Tell us the color you selected from the tool above or physical boards.',
  brandLabel: 'Brand',
  colorNameLabel: 'Color Name',
  colorNamePlaceholder: 'e.g., Estate Gray, Charcoal, Weathered Wood',
  confirmationNote:
    'Note: Your color selection will be added to your contract as a separate addendum for signature.',
  successText:
    "✓ Color confirmed! We've saved your selection. You'll see the addendum on your next contract review.",
  addendumHeading: 'Sign Color Addendum',
  addendumBody:
    'Almost done! Please sign the color addendum below to add your selected color to your contract.',
  addendumIframeTitle: 'Color Addendum — E-Sign',
  addendumFallbackBase:
    'Color saved. Your contractor will include the color selection in your final contract documents.',
  colorBoardAlreadyRequested:
    '✓ Already requested. Your contractor will reach out soon with physical color samples.',
  colorBoardAlreadyRequestedAlert:
    "You've already requested a color board visit. Your contractor will reach out soon.",
  colorBoardMailtoSubject: 'Color Board Visit Request',
  brandUnknownTitle: 'Brand Not Yet Confirmed',
  brandUnknownText:
    "Your contractor hasn't specified a shingle brand yet. Once confirmed, the right color visualization tool will appear here. In the meantime, you can request in-person color samples below.",
  ocLeadParagraph:
    'Upload a photo of your home and try on different Owens Corning shingle colors in real time.',
  ocLauncherButton: '🎨 Click to Preview Colors',
  ocLauncherSubNote:
    'Opens an interactive visualizer — upload a photo of your home to see real shingle colors.',
  ocAfterVisualizingDesktop:
    "After visualizing: Once you've found a color you like, enter it in the form below to lock it in.",
  ocAfterVisualizingMobile:
    'After visualizing: Come back here and enter the color you selected in the form below.',
  ocMobileButton: 'Open OC Design EyeQ',
  // Per-brand visualizer (option-card) descriptions
  vizOwensCorning:
    'Upload a photo of your home and try on different Owens Corning colors in real time.',
  vizGAF: "Use GAF's online design tool to visualize your roof with different color options.",
  vizCertainTeed: 'Explore CertainTeed colors with their interactive visualizer.',
  vizTAMKO: 'See TAMKO shingle colors on your home with their visualization tool.',
  vizAtlas: 'Try Atlas shingle colors and see how they look on your roof.',
  vizIKO: "Use IKO's roofing visualizer to preview different colors and styles.",
  vizDefault: 'Upload a photo and try different colors to see what works best for your home.',
  // Link-out paragraphs
  gafParagraph:
    "Use GAF's comprehensive design tool to visualize your roof with different color and style options.",
  certainTeedParagraph:
    'Explore CertainTeed color options with their interactive ColorView visualizer.',
  tamkoParagraph: 'Try TAMKO shingle colors on your home with their RenoWorks visualizer.',
  atlasParagraph: 'Visualize Atlas shingle colors and see how they look on your roof.',
  ikoParagraph: "Use IKO's RoofViewer to preview different colors and styles on your home.",
};

// ── Verbatim URLs (brief-locked + static) ──
const URLS = {
  GAF: 'https://www.gaf.com/en-us/plan-design/design-your-roof',
  CertainTeed: 'https://www.certainteed.com/colorview',
  TAMKO: 'https://tamko.renoworks.com/',
  Atlas: 'https://www.atlasroofing.com/visualizer',
  IKO: 'https://www.iko.com/na/roofviewer/',
  ocMobile: 'https://designeyeq.owenscorning.com/',
  ocWidgetScript: 'https://apis.owenscorning.com/client/widget.js',
};

describe('verbatim homeowner copy (byte-for-byte)', () => {
  it('header + no-rush banner match color-selection.html exactly', () => {
    expect(COLOR_COPY.headerTitle).toBe(STATIC.headerTitle);
    expect(COLOR_COPY.subtitleStaticPlaceholder).toBe(STATIC.subtitleStaticPlaceholder);
    expect(COLOR_COPY.subtitleStaticPlaceholder).toContain('[Brand]');
    expect(COLOR_COPY.noRushIcon).toBe('⏳');
    expect(COLOR_COPY.noRushText).toBe(STATIC.noRushText);
  });

  it('the three option cards (titles/descriptions/buttons/note) match exactly', () => {
    expect(COLOR_COPY.optionVisualizeTitle).toBe(STATIC.optionVisualizeTitle);
    expect(COLOR_COPY.optionVisualizeIcon).toBe('🏡');
    expect(COLOR_COPY.optionVisualizeButton).toBe(STATIC.optionVisualizeButton);
    expect(COLOR_COPY.optionBrowseTitle).toBe(STATIC.optionBrowseTitle);
    expect(COLOR_COPY.optionBrowseIcon).toBe('🎨');
    expect(COLOR_COPY.optionBrowseDescription).toBe(STATIC.optionBrowseDescription);
    expect(COLOR_COPY.optionBrowseButton).toBe(STATIC.optionBrowseButton);
    expect(COLOR_COPY.optionInPersonTitle).toBe(STATIC.optionInPersonTitle);
    expect(COLOR_COPY.optionInPersonIcon).toBe('👁️');
    expect(COLOR_COPY.optionInPersonDescription).toBe(STATIC.optionInPersonDescription);
    expect(COLOR_COPY.optionInPersonButton).toBe(STATIC.optionInPersonButton);
    expect(COLOR_COPY.externalLinkIcon).toBe('↗');
    expect(COLOR_COPY.opensInNewTabLabel).toBe(STATIC.opensInNewTabLabel);
  });

  it('per-brand visualizer (option-card) descriptions match exactly', () => {
    const d = COLOR_COPY.visualizerDescriptions;
    expect(d['Owens Corning']).toBe(STATIC.vizOwensCorning);
    expect(d.GAF).toBe(STATIC.vizGAF);
    expect(d.CertainTeed).toBe(STATIC.vizCertainTeed);
    expect(d.TAMKO).toBe(STATIC.vizTAMKO);
    expect(d.Atlas).toBe(STATIC.vizAtlas);
    expect(d.IKO).toBe(STATIC.vizIKO);
    expect(d.default).toBe(STATIC.vizDefault);
    // The OC card description and the OC widget lead are DISTINCT ("shingle" word).
    expect(d['Owens Corning']).not.toBe(COLOR_COPY.ocLeadParagraph);
  });

  it('in-person + confirmation section copy match exactly', () => {
    expect(COLOR_COPY.visualizerSectionTitle).toBe(STATIC.optionVisualizeTitle);
    expect(COLOR_COPY.inPersonIcon).toBe('🏠');
    expect(COLOR_COPY.inPersonTitle).toBe(STATIC.inPersonTitle);
    expect(COLOR_COPY.inPersonDescription).toBe(STATIC.inPersonDescription);
    expect(COLOR_COPY.inPersonButton).toBe(STATIC.inPersonButton);
    expect(COLOR_COPY.confirmationTitle).toBe(STATIC.confirmationTitle);
    expect(COLOR_COPY.confirmationSubtitle).toBe(STATIC.confirmationSubtitle);
    expect(COLOR_COPY.brandLabel).toBe(STATIC.brandLabel);
    expect(COLOR_COPY.colorNameLabel).toBe(STATIC.colorNameLabel);
    expect(COLOR_COPY.colorNamePlaceholder).toBe(STATIC.colorNamePlaceholder);
    expect(COLOR_COPY.brandDisplayDefault).toBe('—');
    expect(COLOR_COPY.brandDisplayUnconfirmed).toBe('To be confirmed');
    expect(COLOR_COPY.contractorNameFallback).toBe('Your Contractor');
    expect(COLOR_COPY.signerNameFallback).toBe('Homeowner');
    expect(COLOR_COPY.confirmationNote).toBe(STATIC.confirmationNote);
    expect(COLOR_COPY.confirmButton).toBe('Confirm My Color');
    expect(COLOR_COPY.confirmButtonSaving).toBe('Saving...');
    expect(COLOR_COPY.confirmButtonConfirmed).toBe('Color Confirmed ✓');
    expect(COLOR_COPY.backToDashboardButton).toBe('Back to Dashboard');
  });

  it('success + addendum signing + fallback copy match exactly', () => {
    expect(COLOR_COPY.successText).toBe(STATIC.successText);
    expect(COLOR_COPY.addendumHeading).toBe(STATIC.addendumHeading);
    expect(COLOR_COPY.addendumBody).toBe(STATIC.addendumBody);
    expect(COLOR_COPY.addendumIframeTitle).toBe(STATIC.addendumIframeTitle);
    expect(COLOR_COPY.addendumIframeTitle).toContain('—'); // literal em-dash
    expect(COLOR_COPY.addendumFallbackBase).toBe(STATIC.addendumFallbackBase);
  });

  it('color-board confirmation + mailto strings match exactly', () => {
    expect(COLOR_COPY.colorBoardAlreadyRequested).toBe(STATIC.colorBoardAlreadyRequested);
    expect(COLOR_COPY.colorBoardAlreadyRequestedAlert).toBe(STATIC.colorBoardAlreadyRequestedAlert);
    expect(COLOR_COPY.colorBoardMailtoSubject).toBe(STATIC.colorBoardMailtoSubject);
    expect(COLOR_COPY.colorBoardMailtoAddress).toBe('info@otterquote.com');
  });

  it('brand-unknown state copy matches exactly', () => {
    expect(COLOR_COPY.brandUnknownIcon).toBe('🔍');
    expect(COLOR_COPY.brandUnknownTitle).toBe(STATIC.brandUnknownTitle);
    expect(COLOR_COPY.brandUnknownText).toBe(STATIC.brandUnknownText);
  });

  it('OC widget copy + URLs match exactly', () => {
    expect(COLOR_COPY.ocLeadParagraph).toBe(STATIC.ocLeadParagraph);
    expect(COLOR_COPY.ocLauncherButton).toBe(STATIC.ocLauncherButton);
    expect(COLOR_COPY.ocLauncherSubNote).toBe(STATIC.ocLauncherSubNote);
    expect(COLOR_COPY.ocAfterVisualizingDesktop).toBe(STATIC.ocAfterVisualizingDesktop);
    expect(COLOR_COPY.ocAfterVisualizingMobile).toBe(STATIC.ocAfterVisualizingMobile);
    expect(COLOR_COPY.ocMobileButton).toBe(STATIC.ocMobileButton);
    expect(COLOR_COPY.ocMobileUrl).toBe(URLS.ocMobile);
    expect(COLOR_COPY.ocWidgetScriptUrl).toBe(URLS.ocWidgetScript);
  });

  it('link-out brand copy (paragraph/label/url/after-note) match exactly', () => {
    const lo = COLOR_COPY.linkOut;
    expect(lo.GAF.paragraph).toBe(STATIC.gafParagraph);
    expect(lo.GAF.label).toBe('Open GAF Design Tool');
    expect(lo.GAF.url).toBe(URLS.GAF);
    expect(lo.GAF.afterNote).toBe('After designing: Come back here and enter the color you selected.');
    expect(lo.CertainTeed.paragraph).toBe(STATIC.certainTeedParagraph);
    expect(lo.CertainTeed.label).toBe('Open CertainTeed ColorView');
    expect(lo.CertainTeed.url).toBe(URLS.CertainTeed);
    expect(lo.CertainTeed.afterNote).toBe('After selecting: Come back here and enter the color you chose.');
    expect(lo.TAMKO.paragraph).toBe(STATIC.tamkoParagraph);
    expect(lo.TAMKO.label).toBe('Open TAMKO Visualizer');
    expect(lo.TAMKO.url).toBe(URLS.TAMKO);
    expect(lo.TAMKO.afterNote).toBe('After visualizing: Come back here and enter your color selection.');
    expect(lo.Atlas.paragraph).toBe(STATIC.atlasParagraph);
    expect(lo.Atlas.label).toBe('Open Atlas Visualizer');
    expect(lo.Atlas.url).toBe(URLS.Atlas);
    expect(lo.Atlas.afterNote).toBe('After selecting: Come back here and enter the color you selected.');
    expect(lo.IKO.paragraph).toBe(STATIC.ikoParagraph);
    expect(lo.IKO.label).toBe('Open IKO RoofViewer');
    expect(lo.IKO.url).toBe(URLS.IKO);
    expect(lo.IKO.afterNote).toBe('After visualizing: Come back here and enter your color selection.');
    // OC is the embed brand and must NOT appear in the link-out map.
    expect((lo as Record<string, unknown>)['Owens Corning']).toBeUndefined();
  });
});

describe('interpolated copy builders', () => {
  it('subtitle builders produce the verbatim sentences', () => {
    expect(subtitleBrandKnown('Hoosier Roofing Co.', 'GAF')).toBe(
      "Your contractor Hoosier Roofing Co. uses GAF. Let's pick the perfect color for your home.",
    );
    expect(subtitleBrandUnconfirmed('Hoosier Roofing Co.')).toBe(
      "Your contractor Hoosier Roofing Co. will confirm the brand. Let's pick the perfect color for your home.",
    );
  });

  it('color-board visit-requested + phone suffix join verbatim', () => {
    const base = colorBoardVisitRequested('Hoosier Roofing Co.');
    expect(base).toBe(
      "✓ Visit requested! We've notified Hoosier Roofing Co. to schedule a color board visit. They'll reach out within 48 hours.",
    );
    expect(colorBoardPhoneSuffix('317-555-0100')).toBe(' To reach them directly: 317-555-0100');
    expect(base + colorBoardPhoneSuffix('317-555-0100')).toContain('within 48 hours. To reach them directly:');
  });

  it('addendum fallback clauses match verbatim', () => {
    expect(addendumFallbackWithPhone('Hoosier Roofing Co.', '317-555-0100')).toBe(
      'You can also confirm directly with Hoosier Roofing Co. at 317-555-0100.',
    );
    expect(addendumFallbackNoPhone('Hoosier Roofing Co.')).toBe(
      'Contact your contractor, Hoosier Roofing Co., to confirm.',
    );
  });

  it('mailto body matches verbatim, with newline separators', () => {
    expect(colorBoardMailtoBody('ABCD1234', 'Hoosier Roofing Co.')).toBe(
      'I would like to request an in-person color board visit.\n\nJob #ABCD1234\nContractor: Hoosier Roofing Co.',
    );
  });
});

describe('normalizeBrand', () => {
  it("collapses 'OC' (any case) and 'Owens Corning' variants to 'Owens Corning'", () => {
    expect(normalizeBrand('OC')).toBe('Owens Corning');
    expect(normalizeBrand('oc')).toBe('Owens Corning');
    expect(normalizeBrand('  Oc  ')).toBe('Owens Corning');
    expect(normalizeBrand('Owens Corning')).toBe('Owens Corning');
    expect(normalizeBrand('owens corning')).toBe('Owens Corning');
    expect(normalizeBrand('OwensCorning')).toBe('Owens Corning'); // \s* allows zero spaces
  });

  it('returns other brands UNCHANGED (untrimmed passthrough quirk)', () => {
    expect(normalizeBrand('GAF')).toBe('GAF');
    expect(normalizeBrand('CertainTeed')).toBe('CertainTeed');
    // faithful to static: non-OC values are returned untrimmed
    expect(normalizeBrand('  GAF  ')).toBe('  GAF  ');
  });

  it('returns null for falsy input', () => {
    expect(normalizeBrand('')).toBeNull();
    expect(normalizeBrand(null)).toBeNull();
    expect(normalizeBrand(undefined)).toBeNull();
  });
});

describe('extractZip', () => {
  it('extracts the first 5-digit ZIP', () => {
    expect(extractZip('123 Main St, Zionsville, IN 46077')).toBe('46077');
    expect(extractZip('PO Box 12, Indianapolis IN 46220-1234')).toBe('46220');
  });

  it("falls back to '46077' when there is no 5-digit match or no address", () => {
    expect(extractZip('No zip here')).toBe('46077');
    expect(extractZip('')).toBe('46077');
    expect(extractZip(null)).toBe('46077');
    expect(extractZip(undefined)).toBe('46077');
  });
});

describe('brand capability checks', () => {
  it('KNOWN_BRANDS and LINK_OUT_BRANDS hold the expected sets', () => {
    expect([...KNOWN_BRANDS]).toEqual(['Owens Corning', 'GAF', 'CertainTeed', 'TAMKO', 'Atlas', 'IKO']);
    expect([...LINK_OUT_BRANDS]).toEqual(['GAF', 'CertainTeed', 'TAMKO', 'Atlas', 'IKO']);
  });

  it('hasVisualizer is true for all six known brands, false otherwise', () => {
    for (const b of KNOWN_BRANDS) expect(hasVisualizer(b)).toBe(true);
    expect(hasVisualizer('Malarkey')).toBe(false);
    expect(hasVisualizer(null)).toBe(false);
    expect(hasVisualizer(undefined)).toBe(false);
  });

  it('isLinkOutBrand excludes the Owens Corning embed brand', () => {
    expect(isLinkOutBrand('Owens Corning')).toBe(false);
    for (const b of LINK_OUT_BRANDS) expect(isLinkOutBrand(b)).toBe(true);
    expect(isLinkOutBrand('Malarkey')).toBe(false);
    expect(isLinkOutBrand(null)).toBe(false);
  });
});

describe('getVisualizerDescription', () => {
  it('returns the brand-specific description for known brands', () => {
    expect(getVisualizerDescription('Owens Corning')).toBe(STATIC.vizOwensCorning);
    expect(getVisualizerDescription('IKO')).toBe(STATIC.vizIKO);
  });

  it('falls back to the default for unknown/absent brands', () => {
    expect(getVisualizerDescription('Malarkey')).toBe(STATIC.vizDefault);
    expect(getVisualizerDescription(null)).toBe(STATIC.vizDefault);
    expect(getVisualizerDescription(undefined)).toBe(STATIC.vizDefault);
  });
});

describe('resolveLinkOut', () => {
  it('resolves each link-out brand to its { url, label }', () => {
    expect(resolveLinkOut('GAF')).toEqual({ url: URLS.GAF, label: 'Open GAF Design Tool' });
    expect(resolveLinkOut('CertainTeed')).toEqual({
      url: URLS.CertainTeed,
      label: 'Open CertainTeed ColorView',
    });
    expect(resolveLinkOut('TAMKO')).toEqual({ url: URLS.TAMKO, label: 'Open TAMKO Visualizer' });
    expect(resolveLinkOut('Atlas')).toEqual({ url: URLS.Atlas, label: 'Open Atlas Visualizer' });
    expect(resolveLinkOut('IKO')).toEqual({ url: URLS.IKO, label: 'Open IKO RoofViewer' });
  });

  it('returns null for the OC embed brand, unknown brands, and falsy input', () => {
    expect(resolveLinkOut('Owens Corning')).toBeNull();
    expect(resolveLinkOut('Malarkey')).toBeNull();
    expect(resolveLinkOut(null)).toBeNull();
    expect(resolveLinkOut(undefined)).toBeNull();
  });
});

describe('resolvePrimaryPhone', () => {
  it('prefers the first notification phone', () => {
    expect(resolvePrimaryPhone(['317-555-0100', '317-555-0200'], '317-999-9999')).toBe('317-555-0100');
  });

  it('falls back to the contractor phone, then null', () => {
    expect(resolvePrimaryPhone([], '317-999-9999')).toBe('317-999-9999');
    expect(resolvePrimaryPhone(null, '317-999-9999')).toBe('317-999-9999');
    expect(resolvePrimaryPhone(null, null)).toBeNull();
    expect(resolvePrimaryPhone([], null)).toBeNull();
    expect(resolvePrimaryPhone(undefined, undefined)).toBeNull();
  });
});

describe('canCreateAddendum', () => {
  it('requires claimId, contractorId, AND signerEmail', () => {
    expect(
      canCreateAddendum({ claimId: 'c1', contractorId: 'k1', signerEmail: 'h@example.com' }),
    ).toBe(true);
    expect(canCreateAddendum({ claimId: '', contractorId: 'k1', signerEmail: 'h@example.com' })).toBe(false);
    expect(canCreateAddendum({ claimId: 'c1', contractorId: null, signerEmail: 'h@example.com' })).toBe(false);
    expect(canCreateAddendum({ claimId: 'c1', contractorId: 'k1', signerEmail: null })).toBe(false);
    expect(canCreateAddendum({ claimId: null, contractorId: null, signerEmail: null })).toBe(false);
  });
});

describe('buildColorReturnUrl', () => {
  it('targets the React /color-selection route with an encoded claim_id and signed=true', () => {
    expect(buildColorReturnUrl('https://app.otterquote.com', 'claim-123')).toBe(
      'https://app.otterquote.com/color-selection?claim_id=claim-123&signed=true',
    );
    // claim_id is encodeURIComponent-encoded
    expect(buildColorReturnUrl('https://app.otterquote.com', 'a b/c')).toBe(
      'https://app.otterquote.com/color-selection?claim_id=a%20b%2Fc&signed=true',
    );
  });
});

describe('buildColorAddendumPayload', () => {
  it("returns the EF body with document_type 'color_confirmation' and NO signer", () => {
    const payload = buildColorAddendumPayload({
      claimId: 'claim-123',
      contractorId: 'k-789',
      returnUrl: 'https://app.otterquote.com/color-selection?claim_id=claim-123&signed=true',
    });
    expect(payload).toEqual({
      claim_id: 'claim-123',
      contractor_id: 'k-789',
      document_type: 'color_confirmation',
      return_url: 'https://app.otterquote.com/color-selection?claim_id=claim-123&signed=true',
    });
    // CRITICAL (D-220): the EF derives the signer server-side — never send one.
    expect('signer' in payload).toBe(false);
    expect(payload.document_type).toBe(COLOR_CONFIRMATION_DOC_TYPE);
  });
});

describe('jobNumberFromClaimId', () => {
  it('returns the last 8 chars upper-cased', () => {
    expect(jobNumberFromClaimId('abcdef-1234567890')).toBe('34567890');
    expect(jobNumberFromClaimId('short')).toBe('SHORT');
  });

  it("falls back to 'UNKNOWN' when the claim id is absent", () => {
    expect(jobNumberFromClaimId(null)).toBe('UNKNOWN');
    expect(jobNumberFromClaimId(undefined)).toBe('UNKNOWN');
    expect(jobNumberFromClaimId('')).toBe('UNKNOWN');
  });
});
