/**
 * Homeowner project-confirmation pure helpers — D-211 Phase 26, PR 1/2 (ADDITIVE).
 *
 * Every function here is pure, DOM-free, and network-free — ported 1:1 from the inline
 * JS in project-confirmation.html. The eventual page (PR 2/2) is the only place that
 * touches the DOM, Supabase, or the create-docusign-envelope call; it collects raw form
 * values + claim/quote state and hands them to these helpers.
 *
 * FAITHFUL-PORT NOTE — two divergent trade-detection schemes are preserved AS-IS:
 *
 *   1. detectTrades() mirrors the page's section show/hide logic
 *      (project-confirmation.html:2315-2322): CASE-INSENSITIVE (.toLowerCase()), treats an
 *      empty/absent selected_trades as roofing, and counts the singular "gutter" toward
 *      gutters.
 *
 *   2. buildAckIds() and buildPayload() mirror the page's inline detection
 *      (project-confirmation.html:1840-1850, 1868-1872): CASE-SENSITIVE (raw
 *      Array.prototype.includes on state.selectedTrades) and do NOT count "gutter"
 *      singular.
 *
 *   The static keeps state.selectedTrades RAW (not lowercased — line 2316), so a claim
 *   whose selected_trades carries mixed casing (e.g. ['Roofing']) gets the bad-decking ack
 *   SHOWN (detectTrades, case-insensitive) but NOT REQUIRED (buildAckIds, case-sensitive).
 *   This inconsistency is REPRODUCED here deliberately to keep behavior identical; the
 *   canonical lowercase inputs ('roofing','siding','gutters','downspouts') behave the same
 *   under both. The casing-unification is flagged in the PR-1 handoff and ticketed
 *   separately — do NOT "fix" it in this port.
 */

// ── Trade detection (section show/hide) — project-confirmation.html:2315-2322 ──

export interface TradeFlags {
  hasRoofing: boolean;
  hasSiding: boolean;
  hasGutters: boolean;
  hasWindows: boolean;
}

/**
 * Normalize claim.selected_trades to a string[]: a non-array (missing column, null) becomes
 * []. Mirrors `Array.isArray(claimData.selected_trades) ? claimData.selected_trades : []`
 * (project-confirmation.html:2315). The page assigns this verbatim to state.selectedTrades
 * (RAW casing) and feeds it to buildAckIds / buildPayload.
 */
export function normalizeSelectedTrades(selectedTrades: unknown): string[] {
  return Array.isArray(selectedTrades) ? (selectedTrades as string[]) : [];
}

/**
 * CASE-INSENSITIVE trade flags driving section show/hide. Empty/absent trades ⇒ roofing
 * (the page's roofing fallback). Mirrors project-confirmation.html:2319-2322 exactly,
 * including the singular "gutter" alias and the standalone "windows" section.
 */
export function detectTrades(selectedTrades: unknown): TradeFlags {
  const trades = normalizeSelectedTrades(selectedTrades);
  const lc = (t: string) => String(t).toLowerCase();
  return {
    hasRoofing: trades.length === 0 || trades.some((t) => lc(t) === 'roofing'),
    hasSiding: trades.some((t) => lc(t) === 'siding'),
    hasGutters: trades.some((t) => ['gutters', 'downspouts', 'gutter'].includes(lc(t))),
    hasWindows: trades.some((t) => lc(t) === 'windows'),
  };
}

/**
 * Insurance vs retail. Mirrors project-confirmation.html:2317:
 * `claimData.funding_type === 'insurance' || claimData.job_type?.includes('insurance')`.
 * Coerced to a strict boolean (the static stored the raw `||` result, which could be
 * `undefined`; downstream it was only read as truthy, so the coercion is behavior-neutral).
 */
export function isInsuranceClaim(
  claim: { funding_type?: string | null; job_type?: string | null } | null | undefined,
): boolean {
  if (!claim) return false;
  return claim.funding_type === 'insurance' || !!claim.job_type?.includes('insurance');
}

// ── Required acknowledgment set — project-confirmation.html:1838-1850 ──

/**
 * The dynamic required-ack id list. Always includes the three universal acks; adds
 * trade/claim-specific acks. CASE-SENSITIVE on the raw trades (state.selectedTrades), per
 * the static — see the module-level faithful-port note. `isInsurance` is
 * `state.isInsuranceClaim` (typically from isInsuranceClaim()).
 *
 * Ordering matches the static (project-confirmation.html:1845-1848): trade/claim acks
 * first, universal acks last.
 */
export function buildAckIds(selectedTrades: string[], isInsurance: boolean): string[] {
  const ids: string[] = [];
  const trades = selectedTrades;
  const hasRoofing = trades.length === 0 || trades.includes('roofing');
  const hasSiding = trades.includes('siding');
  if (hasRoofing) ids.push('ackBadDecking');
  if (hasSiding) ids.push('ackRottenSheathing');
  if (isInsurance) ids.push('ackDepreciation');
  ids.push('ackPaymentTerms', 'ackProjectChanges', 'ackInfoCorrect');
  return ids;
}

// ── Submit gate — project-confirmation.html:1852-1861 ──

/** UI state of a single ack checkbox, as the page would read it from the DOM. */
export interface AckCheckboxState {
  /** false when no element exists for this ack id (static: getElementById null ⇒ satisfied). */
  present: boolean;
  /** true when the enclosing .ack-item is display:none (trade not applicable ⇒ satisfied). */
  hidden: boolean;
  /** the checkbox's checked state. */
  checked: boolean;
}

/**
 * True when every required ack is satisfied. Missing (absent element) and hidden acks are
 * treated as SATISFIED, exactly as the static does (project-confirmation.html:1852-1861):
 *   const el = getElementById(id); if (!el) return true;          // missing ⇒ satisfied
 *   if (section.style.display === 'none') return true;            // hidden  ⇒ satisfied
 *   return el.checked;
 * A required id with no entry in `states` is treated as absent ⇒ satisfied.
 */
export function allAcksChecked(
  ackIds: string[],
  states: Record<string, AckCheckboxState | undefined>,
): boolean {
  return ackIds.every((id) => {
    const s = states[id];
    if (!s || !s.present) return true; // missing element ⇒ satisfied
    if (s.hidden) return true; // hidden ack ⇒ satisfied
    return s.checked;
  });
}

// ── Payload builder — project-confirmation.html:1867-1961 ──

/** One structure row, as collectStructureData() produces it (project-confirmation.html:1668-1684). */
export interface StructureData {
  name: string;
  roofAsphalt: string;
  roofMetal: string;
  siding: string;
  gutters: string;
  downspouts: string;
  skylightsReplace: string;
  skylightsReflash: string;
}

/** One skylight row, as collectSkylightData() produces it (project-confirmation.html:1755-1773). */
export interface SkylightData {
  scope: string;
  length?: string;
  width?: string;
  hinge?: string;
  operation?: string;
  blinds?: string;
}

/**
 * Raw form field values, named exactly as the static reads them via getSelectVal /
 * getInputVal / getCheckVal. DOM getters yield `string | null`; checkbox getters yield
 * `boolean`. Collected by PR 2/2's page and handed in here.
 */
export interface ConfirmationFormValues {
  numStructures?: string | null;
  shingleManufacturer?: string | null;
  shingleType?: string | null;
  shingleColor?: string | null;
  dripEdgeColor?: string | null;
  valleys?: string | null;
  gutterGuards?: string | null;
  gutterGuardsNotes?: string | null;
  ventBox?: string | null;
  ventRidge?: string | null;
  ventOther?: string | null;
  satelliteDish?: string | null;
  badDecking?: string | null;
  badDeckingSheets?: string | null;
  chimney1Material?: string | null;
  chimney1Size?: string | null;
  chimney1Cricket?: string | null;
  chimney1Reflash?: string | null;
  chimney2Material?: string | null;
  chimney2Size?: string | null;
  chimney2Cricket?: string | null;
  chimney2Reflash?: string | null;
  exclusions?: string | null;
  projectNotes?: string | null;
  // Siding (only read when siding is active)
  soffitFascia?: string | null;
  windowWraps?: string | null;
  windowWrapsColor?: string | null;
  rottenSheathing?: string | null;
  rottenSheathingSqFt?: string | null;
  ackRottenSheathing?: boolean;
  // Gutters (only read when gutters is active)
  gutterSize?: string | null;
  gutterColorInput?: string | null;
  downspoutColorType?: string | null;
  downspoutColorOther?: string | null;
  splashBlocks?: string | null;
  gutterNotes?: string | null;
  // Disclosure checkboxes
  ackBadDecking?: boolean;
  ackDepreciation?: boolean;
  ackPaymentTerms?: boolean;
  ackProjectChanges?: boolean;
  ackInfoCorrect?: boolean;
}

/** Audit-trail sources for the payload's _autoFill block (state.* in the static). */
export interface ConfirmationAutoFill {
  homeownerName?: string | null;
  propertyAddress?: string | null;
  shingleMftrFromBid?: string | null;
  shingleTypeFromBid?: string | null;
  depreciation?: number | null;
  deckingRatePerSheet?: number | null;
  contractorName?: string | null;
}

export interface BuildPayloadInput {
  /** state.selectedTrades (RAW casing). Drives activeTrades + the case-sensitive siding/gutters blocks. */
  trades: string[];
  /** ISO timestamp the page stamps at submit time (new Date().toISOString()). Injected to keep this pure. */
  submittedAt: string;
  form: ConfirmationFormValues;
  /** Pre-collected (collectStructureData) — collection is DOM-bound and lives in PR 2/2. */
  structures: StructureData[];
  /** Pre-collected (collectSkylightData). */
  skylights: SkylightData[];
  autoFill: ConfirmationAutoFill;
}

/**
 * `parseInt(value) || fallback` — faithful to the static's coercion, where BOTH NaN and 0
 * fall through to the fallback (e.g. numStructures '0' ⇒ 1; ventBox '0' ⇒ 0).
 */
function parseIntOr(value: string | null | undefined, fallback: number): number {
  return parseInt(String(value ?? ''), 10) || fallback;
}

/**
 * Build the `project_confirmation` JSONB payload. Pure 1:1 port of buildPayload()
 * (project-confirmation.html:1868-1961): same field set, same defaults (|| '', || 'None',
 * || 'Unexpected'), same parseInt coercions, and the same CASE-SENSITIVE conditional
 * siding/gutters blocks (trades.includes(...) on raw trades). `submittedAt` and the
 * structures/skylights arrays are injected (the static reads them from the DOM / Date) so
 * this function stays pure.
 */
export function buildPayload(input: BuildPayloadInput): Record<string, unknown> {
  const { trades, form, autoFill } = input;
  const hasSiding = trades.includes('siding');
  const hasGutters = trades.includes('gutters') || trades.includes('downspouts');

  return {
    // Which trades are confirmed in this submission
    activeTrades: trades.length > 0 ? trades : ['roofing'],
    submittedAt: input.submittedAt,

    // Structures
    numStructures: parseIntOr(form.numStructures, 1),
    structures: input.structures,

    // Materials
    shingleManufacturer: form.shingleManufacturer || '',
    shingleType: form.shingleType || '',
    shingleColor: form.shingleColor || '',
    dripEdgeColor: form.dripEdgeColor || '',
    valleys: form.valleys || '',
    gutterGuards: form.gutterGuards || 'None',
    gutterGuardsNotes: form.gutterGuardsNotes || '',

    // Vents
    ventBox: parseIntOr(form.ventBox, 0),
    ventRidge: parseIntOr(form.ventRidge, 0),
    ventOther: form.ventOther || '',

    // Satellite dish
    satelliteDish: form.satelliteDish || 'None',

    // Bad decking
    badDecking: form.badDecking || 'Unexpected',
    badDeckingSheets: parseIntOr(form.badDeckingSheets, 0),

    // Chimneys
    chimney1Material: form.chimney1Material || '',
    chimney1Size: form.chimney1Size || '',
    chimney1Cricket: form.chimney1Cricket || '',
    chimney1Reflash: form.chimney1Reflash || '',
    chimney2Material: form.chimney2Material || '',
    chimney2Size: form.chimney2Size || '',
    chimney2Cricket: form.chimney2Cricket || '',
    chimney2Reflash: form.chimney2Reflash || '',

    // Skylights
    skylights: input.skylights,

    // Exclusions & notes
    exclusions: form.exclusions || '',
    projectNotes: form.projectNotes || '',

    // ── Siding (only populated when siding is an active trade) ──
    ...(hasSiding
      ? {
          // D-164/D-158 amendment: sidingMaterial, sidingProfile, sidingColor, trimColor
          // are captured pre-bid in Hover and NOT re-entered on this form.
          soffitFascia: form.soffitFascia || '',
          windowWraps: form.windowWraps || '',
          windowWrapsColor: form.windowWrapsColor || '',
          rottenSheathing: form.rottenSheathing || 'Unexpected',
          rottenSheathingSqFt: parseIntOr(form.rottenSheathingSqFt, 0),
          ackRottenSheathing: !!form.ackRottenSheathing,
        }
      : {}),

    // ── Gutters (only populated when gutters is an active trade) ──
    ...(hasGutters
      ? {
          gutterSize: form.gutterSize || '',
          gutterColorInput: form.gutterColorInput || '',
          downspoutColorType: form.downspoutColorType || '',
          downspoutColorOther: form.downspoutColorOther || '',
          splashBlocks: form.splashBlocks || '',
          gutterNotes: form.gutterNotes || '',
        }
      : {}),

    // Disclosures
    ackBadDecking: !!form.ackBadDecking,
    ackDepreciation: !!form.ackDepreciation,
    ackPaymentTerms: !!form.ackPaymentTerms,
    ackProjectChanges: !!form.ackProjectChanges,
    ackInfoCorrect: !!form.ackInfoCorrect,

    // Auto-filled metadata (stored for audit trail)
    _autoFill: {
      homeownerName: autoFill.homeownerName || '',
      propertyAddress: autoFill.propertyAddress || '',
      shingleMftrFromBid: autoFill.shingleMftrFromBid || '',
      shingleTypeFromBid: autoFill.shingleTypeFromBid || '',
      depreciation: autoFill.depreciation ?? null,
      deckingRatePerSheet: autoFill.deckingRatePerSheet ?? null,
      contractorName: autoFill.contractorName || '',
    },
  };
}
