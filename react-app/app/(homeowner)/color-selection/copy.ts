/**
 * Homeowner color-selection copy — D-211 Phase 27, PR 1/2 (ADDITIVE).
 *
 * Source file:  color-selection.html (repo root)
 * Branched from: main (feature/d211-h5-color-selection-copy-utils)
 *
 * VERBATIM-LOCKED. Every user-facing string below is ported BYTE-FOR-BYTE (rendered text
 * content) from color-selection.html and asserted by ./__tests__/color-selection.test.ts —
 * any reword trips the lock. This page carries no Tier-3 legal disclosure (unlike H3/H4),
 * but the parity discipline is identical.
 *
 * Faithful-port notes (same idiom as the H4 project-confirmation copy.ts):
 *   • HTML entities are decoded to their rendered glyph because React renders text nodes,
 *     not HTML:  &mdash;→—  (the iframe title and OC sub-note use a literal em-dash, kept).
 *   • Inline <strong> markup is presentation-only and flattened to plain text (the words are
 *     what is locked). e.g. "<strong>Note:</strong> Your color…" → "Note: Your color…".
 *   • Strings that interpolate runtime values (subtitle, the
 *     addendum fallback) are exposed as small pure builder functions below
 *     the data object. The fixed boilerplate inside each is still byte-for-byte from the
 *     static and asserted by the parity test.
 *   • Two near-identical Owens Corning sentences are intentionally DISTINCT and both
 *     preserved: the option-card description (visualizerDescriptions['Owens Corning'],
 *     static:770 — "…different Owens Corning colors in real time.") vs the OC widget lead
 *     paragraph (ocLeadParagraph, static:855/869 — "…different Owens Corning shingle colors
 *     in real time."). The "shingle" word is the only difference. Do NOT collapse them.
 *   • Likewise the GAF card description (visualizerDescriptions['GAF'] — "online design tool
 *     … different color options.") differs from the GAF link-out paragraph (linkOut.GAF
 *     — "comprehensive design tool … color and style options."). Both kept verbatim.
 *
 * Source line ranges (color-selection.html):
 *   H1 + subtitle placeholder ........................ 447-450
 *   No-rush banner ................................... 455-457
 *   Option cards (titles/descs/buttons/note) ......... 722-762
 *   Visualizer description map ....................... 769-777
 *   Visualizer section title ......................... 468
 *   In-person section ................................ 476-482
 *   Confirmation section + form ...................... 490-526
 *   Success state .................................... 525
 *   Brand-unknown state .............................. 813-815
 *   OC widget (desktop + mobile) ..................... 855-881
 *   Link-out paragraphs/buttons/URLs ................. 910-985
 *   Color-board confirmations / mailto ............... 1014-1057
 *   Addendum signing + fallback ...................... 1177-1208
 */

export const COLOR_COPY = {
  // ── Page header (color-selection.html:447-450) ──
  headerTitle: 'Choose Your Color',
  // The hardcoded HTML default subtitle with the literal "[Brand]" token (static:449),
  // shown only before JS replaces it. Ported AS-IS, token included.
  subtitleStaticPlaceholder:
    "Your contractor uses [Brand]. Let's pick the perfect color for your home.",

  // ── Option cards (color-selection.html:722-762) ──
  // Card 1 "visualize" description is brand-dependent → see visualizerDescriptions below.
  optionVisualizeTitle: 'See It On Your House',
  optionVisualizeIcon: '🏡',
  optionVisualizeButton: 'Start Visualizing',
  // external-link-indicator on the option card for link-out brands (static:754-756)
  externalLinkIcon: '↗',
  opensInNewTabLabel: 'Opens in new tab',

  // ── Visualizer section title (color-selection.html:468) ──
  visualizerSectionTitle: 'See It On Your House',

  // ── Color confirmation section (color-selection.html:490-512) ──
  confirmationTitle: 'What Color Did You Choose?',
  confirmationSubtitle: 'Tell us the color you selected from the tool above or physical boards.',
  brandLabel: 'Brand',
  colorNameLabel: 'Color Name',
  colorNamePlaceholder: 'e.g., Estate Gray, Charcoal, Weathered Wood',
  // #brand-display-value default glyph (&mdash;, static:499). Runtime replaces it.
  brandDisplayDefault: '—',
  // brand-display fallback when brand is unknown (static:701)
  brandDisplayUnconfirmed: 'To be confirmed',
  // contractor-name fallback used in the subtitle/confirmations (static:667)
  contractorNameFallback: 'Your Contractor',
  // signer-name fallback (static:639) — retained for parity; NOT sent in the addendum
  // payload (the EF derives the signer server-side; see utils.buildColorAddendumPayload).
  signerNameFallback: 'Homeowner',
  confirmButton: 'Confirm My Color',
  confirmButtonSaving: 'Saving...',
  confirmButtonConfirmed: 'Color Confirmed ✓',
  backToDashboardButton: 'Back to Dashboard',

  // ── Success state (color-selection.html:525) — "<strong>✓ Color confirmed!</strong> …" ──
  successText:
    "✓ Color confirmed! We've saved your selection.",

  // gh-3287 (Ben, 6584752880, items 69-71): the colour signing panel (heading, body, frame
  // title) is removed. D-393 as amended retired that envelope.

  // ── Save failure (gh-3287, Ben 6584752880, item 67): item 68's words; a raw database
  // message is never shown. Also the zero-row save failure.
  saveError: 'Error saving color. Please try again.',

  // ── Claim lookup failed (gh-3287, Ben 6584752880, items 76/78). "Missing claim ID" is kept
  // for the no-claim_id case only (item 77).
  claimNotFoundTitle: 'Claim not found',

  // ── Addendum fallback (color-selection.html:1205) — "<strong>Your color choice is saved.</strong> …" ──
  // The whole note (gh-3287, Ben 2026-11-02T17:12Z): nothing is appended after it.
  addendumFallbackBase:
    'Your color choice is saved. Please confirm it with your contractor.',

  // ── Brand-unknown state (color-selection.html:813-815) ──
  brandUnknownIcon: '🔍',
  brandUnknownTitle: 'Brand Not Yet Confirmed',
  brandUnknownText:
    "Your contractor hasn't specified a shingle brand yet. Once confirmed, the right color visualization tool will appear here.",

  // ── OC Design EyeQ widget (color-selection.html:855-881) ──
  // Lead paragraph is identical for desktop (869) and mobile (855). NOTE the word "shingle"
  // — distinct from the OC option-card description (visualizerDescriptions['Owens Corning']).
  ocLeadParagraph:
    'Upload a photo of your home and try on different Owens Corning shingle colors in real time.',
  ocLauncherButton: '🎨 Click to Preview Colors',
  ocLauncherSubNote:
    'Opens an interactive visualizer — upload a photo of your home to see real shingle colors.',
  // desktop after-visualizing note (static:880) — "<strong>After visualizing:</strong> …"
  ocAfterVisualizingDesktop:
    'After visualizing: Come back here and enter the color you selected.',
  // mobile after-visualizing note (static:861)
  ocAfterVisualizingMobile:
    'After visualizing: Come back here and enter the color you selected in the form below.',
  ocMobileButton: 'Open OC Design EyeQ',
  ocMobileUrl: 'https://designeyeq.owenscorning.com/',
  ocWidgetScriptUrl: 'https://apis.owenscorning.com/client/widget.js',

  // ── Per-brand visualizer descriptions (color-selection.html:769-777) ──
  // This is the OPTION-CARD description (card 1). Keyed by normalized brand; 'default' is the
  // fallback. getVisualizerDescription() in utils.ts reads this map.
  visualizerDescriptions: {
    'Owens Corning':
      'Upload a photo of your home and try on different Owens Corning colors in real time.',
    GAF: "Use GAF's online design tool to visualize your roof with different color options.",
    CertainTeed: 'Explore CertainTeed colors with their interactive visualizer.',
    TAMKO: 'See TAMKO shingle colors on your home with their visualization tool.',
    Atlas: 'Try Atlas shingle colors and see how they look on your roof.',
    IKO: "Use IKO's roofing visualizer to preview different colors and styles.",
    default: 'Upload a photo and try different colors to see what works best for your home.',
  },

  // ── Link-out brand copy (color-selection.html:910-985) ──
  // paragraph + button label + URL + after-note for each link-out brand (OC is embed, not
  // link-out, so it is NOT here). URLs are verbatim from the static and match the brief.
  linkOut: {
    GAF: {
      paragraph:
        "Use GAF's comprehensive design tool to visualize your roof with different color and style options.",
      label: 'Open GAF Design Tool',
      url: 'https://www.gaf.com/en-us/plan-design/design-your-roof',
      afterNote: 'After designing: Come back here and enter the color you selected.',
    },
    CertainTeed: {
      paragraph: 'Explore CertainTeed color options with their interactive ColorView visualizer.',
      label: 'Open CertainTeed ColorView',
      url: 'https://www.certainteed.com/colorview',
      afterNote: 'After selecting: Come back here and enter the color you chose.',
    },
    TAMKO: {
      paragraph: 'Try TAMKO shingle colors on your home with their RenoWorks visualizer.',
      label: 'Open TAMKO Visualizer',
      url: 'https://tamko.renoworks.com/',
      afterNote: 'After visualizing: Come back here and enter your color selection.',
    },
    Atlas: {
      paragraph: 'Visualize Atlas shingle colors and see how they look on your roof.',
      label: 'Open Atlas Visualizer',
      url: 'https://www.atlasroofing.com/visualizer',
      afterNote: 'After selecting: Come back here and enter the color you selected.',
    },
    IKO: {
      paragraph: "Use IKO's RoofViewer to preview different colors and styles on your home.",
      label: 'Open IKO RoofViewer',
      url: 'https://www.iko.com/na/roofviewer/',
      afterNote: 'After visualizing: Come back here and enter your color selection.',
    },
  },
} as const;

// ── Interpolated copy builders ───────────────────────────────────────────────────
// Each returns a string whose fixed text is byte-for-byte from color-selection.html.

/** True when the lookup returned a real company name (not empty, not the generic fallback). */
function hasContractorName(contractorName: string): boolean {
  return !!contractorName && contractorName !== COLOR_COPY.contractorNameFallback;
}

/**
 * Subtitle when the contractor's brand is known (color-selection.html:692).
 * gh-3287 (Ben, 6584752880, items 2/3): when the name is missing, the name is dropped.
 */
export function subtitleBrandKnown(contractorName: string, brand: string): string {
  const who = hasContractorName(contractorName) ? `Your contractor ${contractorName}` : 'Your contractor';
  return `${who} uses ${brand}. Let's pick the perfect color for your home.`;
}

/** Subtitle when the brand is not yet confirmed (color-selection.html:694). Name dropped when missing. */
export function subtitleBrandUnconfirmed(contractorName: string): string {
  const who = hasContractorName(contractorName) ? `Your contractor ${contractorName}` : 'Your contractor';
  return `${who} will confirm the brand. Let's pick the perfect color for your home.`;
}

