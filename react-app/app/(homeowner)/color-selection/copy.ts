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
 *   • Strings that interpolate runtime values (subtitle, visit-requested confirmation, the
 *     addendum fallback, the mailto body) are exposed as small pure builder functions below
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

  // ── No-rush banner (color-selection.html:455-457) ──
  noRushIcon: '⏳',
  noRushText:
    "Take your time — your contract is already signed and your contractor has been notified. There's no rush to pick a color.",

  // ── Option cards (color-selection.html:722-762) ──
  // Card 1 "visualize" description is brand-dependent → see visualizerDescriptions below.
  optionVisualizeTitle: 'See It On Your House',
  optionVisualizeIcon: '🏡',
  optionVisualizeButton: 'Start Visualizing',
  optionBrowseTitle: 'Browse Colors',
  optionBrowseIcon: '🎨',
  optionBrowseDescription: 'See our color catalog and make your selection.',
  optionBrowseButton: 'View Colors',
  optionInPersonTitle: "I'd Rather See Colors In Person",
  optionInPersonIcon: '👁️',
  optionInPersonDescription: 'Request physical color boards for a closer look at your options.',
  optionInPersonButton: 'Request Visit',
  // external-link-indicator on the option card for link-out brands (static:754-756)
  externalLinkIcon: '↗',
  opensInNewTabLabel: 'Opens in new tab',

  // ── Visualizer section title (color-selection.html:468) ──
  visualizerSectionTitle: 'See It On Your House',

  // ── In-person section (color-selection.html:476-482) ──
  inPersonIcon: '🏠',
  inPersonTitle: 'Prefer to See Colors In Person?',
  inPersonDescription:
    'Request physical color boards. Your contractor will bring shingle samples to your home so you can see the real colors in your own lighting and against your exterior.',
  inPersonButton: 'Request In-Person Color Samples',

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
  // Confirmation note (static:516) — "<strong>Note:</strong> …" flattened.
  confirmationNote:
    'Note: Your color selection will be added to your contract as a separate addendum for signature.',
  confirmButton: 'Confirm My Color',
  confirmButtonSaving: 'Saving...',
  confirmButtonConfirmed: 'Color Confirmed ✓',
  backToDashboardButton: 'Back to Dashboard',

  // ── Success state (color-selection.html:525) — "<strong>✓ Color confirmed!</strong> …" ──
  successText:
    "✓ Color confirmed! We've saved your selection. You'll see the addendum on your next contract review.",

  // ── Addendum signing (color-selection.html:1177-1185) — note literal em-dash in title ──
  addendumHeading: 'Sign Color Addendum',
  addendumBody:
    'Almost done! Please sign the color addendum below to add your selected color to your contract.',
  addendumIframeTitle: 'Color Addendum — E-Sign',

  // ── Addendum fallback (color-selection.html:1205) — "<strong>Color saved.</strong> …" ──
  // Base sentence; the phone / no-phone clause is appended via the builders below.
  addendumFallbackBase:
    'Color saved. Your contractor will include the color selection in your final contract documents.',

  // ── Color-board request confirmations (color-selection.html:1014-1017) ──
  colorBoardAlreadyRequested:
    '✓ Already requested. Your contractor will reach out soon with physical color samples.',
  colorBoardAlreadyRequestedAlert:
    "You've already requested a color board visit. Your contractor will reach out soon.",
  // mailto fallback (static:1055-1057)
  colorBoardMailtoSubject: 'Color Board Visit Request',
  colorBoardMailtoAddress: 'info@otterquote.com',

  // ── Brand-unknown state (color-selection.html:813-815) ──
  brandUnknownIcon: '🔍',
  brandUnknownTitle: 'Brand Not Yet Confirmed',
  brandUnknownText:
    "Your contractor hasn't specified a shingle brand yet. Once confirmed, the right color visualization tool will appear here. In the meantime, you can request in-person color samples below.",

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
    "After visualizing: Once you've found a color you like, enter it in the form below to lock it in.",
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

/** Subtitle when the contractor's brand is known (color-selection.html:692). */
export function subtitleBrandKnown(contractorName: string, brand: string): string {
  return `Your contractor ${contractorName} uses ${brand}. Let's pick the perfect color for your home.`;
}

/** Subtitle when the brand is not yet confirmed (color-selection.html:694). */
export function subtitleBrandUnconfirmed(contractorName: string): string {
  return `Your contractor ${contractorName} will confirm the brand. Let's pick the perfect color for your home.`;
}

/** Color-board "visit requested" confirmation, base sentence (color-selection.html:1041). */
export function colorBoardVisitRequested(contractorName: string): string {
  return `✓ Visit requested! We've notified ${contractorName} to schedule a color board visit. They'll reach out within 48 hours.`;
}

/**
 * Phone clause appended to the visit-requested confirmation when a contractor phone is
 * known (color-selection.html:1038). Leading space is intentional — it joins the base
 * sentence above.
 */
export function colorBoardPhoneSuffix(phone: string): string {
  return ` To reach them directly: ${phone}`;
}

/** Addendum-fallback clause when a contractor phone is known (color-selection.html:1207). */
export function addendumFallbackWithPhone(contractorName: string, phone: string): string {
  return `You can also confirm directly with ${contractorName} at ${phone}.`;
}

/** Addendum-fallback clause when no contractor phone is known (color-selection.html:1208). */
export function addendumFallbackNoPhone(contractorName: string): string {
  return `Contact your contractor, ${contractorName}, to confirm.`;
}

/**
 * mailto body for the color-board fallback (color-selection.html:1056). `jobNumber` comes
 * from utils.jobNumberFromClaimId; `contractorName` is the caller's resolved name (the
 * static applies its own 'unknown' fallback before calling).
 */
export function colorBoardMailtoBody(jobNumber: string, contractorName: string): string {
  return `I would like to request an in-person color board visit.\n\nJob #${jobNumber}\nContractor: ${contractorName}`;
}
