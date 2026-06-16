/**
 * Contractor Auto-Bid Settings — pure helpers (D-211 Phase 3, port of
 * contractor-auto-bids.html). Extracted so the parity test can exercise the
 * load/save/preview logic without importing page.tsx. All functions are pure;
 * the page is the only place that touches the network.
 *
 * Ported verbatim (behavior-for-behavior) from contractor-auto-bids.html:
 *   - load / hydrate auto_bid_value_adds   : :652-723
 *   - save payload shape                    : :731-799
 *   - "see what my auto bid looks like"     : :850-918
 *
 * The contractors-table update is the ONLY write; NO Edge Function is called from
 * this page (the process-auto-bids cron consumes these settings server-side).
 * §6.1 client fold: the static page nulls + re-creates the global `sb` behind a
 * guard on CONFIG.SUPABASE_ANON — the React port uses the shared supabase
 * singleton and simply does NOT replicate that pattern.
 */

// ── form state (one controlled object) ──────────────────────────────────────

export type GutterOption = 'none' | '5inch_included' | '6inch_included' | 'other';
export type ChimneyFlashing = 'na' | 'replace';
export type GutterGuards = 'insurance_covered' | 'included' | 'other';
export type GutterGuardType = 'mesh' | 'screw_in' | 'other';
export type ChimneyReflash = 'na' | 'included' | 'oop';
export type Underlayment = 'synthetic' | 'felt';
export type StarterStrip = 'eaves' | 'rakes' | 'eaves_and_rakes' | 'none';

export interface WarrantyRow {
  offered: boolean;
  description: string;
}
export type WarrantyKey = 'materialDefects' | 'labor' | 'algae' | 'hail' | 'wind';

export interface AutoBidForm {
  autoBidEnabled: boolean;
  gutterOption: GutterOption;
  gutterOther: string;
  chimneyFlashing: ChimneyFlashing;
  gutterGuards: GutterGuards;
  gutterGuardType: GutterGuardType;
  gutterGuardsOther: string;
  chimneyReflash: ChimneyReflash;
  chimneyReflashOop: string; // kept as string in the form; parsed on save
  preferredShingleBrand: string;
  preferredShingleLine: string;
  otherShingles: string[]; // values like "GAF|Timberline HDZ"
  underlayment: Underlayment;
  starterStrip: StarterStrip;
  ventRidgeUpgrade: boolean;
  ventOtherCheck: boolean;
  ventOtherText: string;
  freeAtticInspection: boolean;
  otherServices: string;
  cleanupGuarantee: string;
  propEquipter: boolean;
  propCatchAll: boolean;
  propOtherCheck: boolean;
  propOtherText: string;
  warranty: Record<WarrantyKey, WarrantyRow>;
  warrantyNotes: string;
  otherOffers: string;
  otherTrades: string[]; // values like "siding_full"
}

/** Default form — mirrors the static page's `checked` defaults exactly. */
export function emptyAutoBidForm(): AutoBidForm {
  return {
    autoBidEnabled: false,
    gutterOption: 'none',
    gutterOther: '',
    chimneyFlashing: 'na',
    gutterGuards: 'insurance_covered',
    gutterGuardType: 'mesh',
    gutterGuardsOther: '',
    chimneyReflash: 'na',
    chimneyReflashOop: '',
    preferredShingleBrand: '',
    preferredShingleLine: '',
    otherShingles: [],
    underlayment: 'synthetic',
    starterStrip: 'eaves',
    ventRidgeUpgrade: false,
    ventOtherCheck: false,
    ventOtherText: '',
    freeAtticInspection: false,
    otherServices: '',
    cleanupGuarantee: '',
    propEquipter: false,
    propCatchAll: false,
    propOtherCheck: false,
    propOtherText: '',
    warranty: {
      materialDefects: { offered: false, description: '' },
      labor: { offered: false, description: '' },
      algae: { offered: false, description: '' },
      hail: { offered: false, description: '' },
      wind: { offered: false, description: '' },
    },
    warrantyNotes: '',
    otherOffers: '',
    otherTrades: [],
  };
}

// ── load / hydrate (:652-723) ───────────────────────────────────────────────

/** Loose shape of the stored `auto_bid_value_adds` JSON (all optional). */
export interface StoredValueAdds {
  gutters?: { option?: string | null; other_text?: string | null } | null;
  chimney_flashing?: string | null;
  gutter_guards?: { option?: string | null; type?: string | null; other_text?: string | null } | null;
  chimney_reflash?: { option?: string | null; oop_price?: number | null } | null;
  preferred_shingle?: { brand?: string | null; line?: string | null } | null;
  other_shingles?: string[] | null;
  underlayment?: string | null;
  starter_strip?: string | null;
  ventilation?: { free_ridge_vent?: boolean | null; other_check?: boolean | null; other_text?: string | null } | null;
  attic_inspection?: { free?: boolean | null; other_services?: string | null } | null;
  cleanup_guarantee?: string | null;
  property_protection?: { equipter?: boolean | null; catch_all?: boolean | null; other_check?: boolean | null; other_text?: string | null } | null;
  warranty?: {
    material_defects?: { offered?: boolean | null; description?: string | null } | null;
    labor?: { offered?: boolean | null; description?: string | null } | null;
    algae?: { offered?: boolean | null; description?: string | null } | null;
    hail?: { offered?: boolean | null; description?: string | null } | null;
    wind?: { offered?: boolean | null; description?: string | null } | null;
    notes?: string | null;
  } | null;
  other_offers?: string | null;
  other_trades?: string[] | null;
  [key: string]: unknown;
}

function parseValueAdds(raw: unknown): StoredValueAdds {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as StoredValueAdds;
    } catch {
      return {};
    }
  }
  return raw as StoredValueAdds;
}

function warrantyRow(row: { offered?: boolean | null; description?: string | null } | null | undefined): WarrantyRow {
  return { offered: !!row?.offered, description: row?.description ?? '' };
}

/**
 * Build the form state from the contractor's stored auto-bid columns. Missing
 * fields fall back to the static defaults (matches contractor-auto-bids.html,
 * which only assigns a field when present in the stored JSON). `valueAdds` may be
 * a JSON string or an object (static :660-662).
 */
export function hydrateAutoBidForm(
  autoBidEnabled: unknown,
  valueAdds: unknown,
): AutoBidForm {
  const f = emptyAutoBidForm();
  if (autoBidEnabled !== undefined && autoBidEnabled !== null) {
    f.autoBidEnabled = !!autoBidEnabled;
  }
  const va = parseValueAdds(valueAdds);

  if (va.gutters?.option) f.gutterOption = va.gutters.option as GutterOption;
  if (va.gutters?.other_text) f.gutterOther = va.gutters.other_text;
  if (va.chimney_flashing) f.chimneyFlashing = va.chimney_flashing as ChimneyFlashing;
  if (va.gutter_guards?.option) f.gutterGuards = va.gutter_guards.option as GutterGuards;
  if (va.gutter_guards?.type) f.gutterGuardType = va.gutter_guards.type as GutterGuardType;
  if (va.gutter_guards?.other_text) f.gutterGuardsOther = va.gutter_guards.other_text;
  if (va.chimney_reflash?.option) f.chimneyReflash = va.chimney_reflash.option as ChimneyReflash;
  if (va.chimney_reflash?.oop_price != null) f.chimneyReflashOop = String(va.chimney_reflash.oop_price);
  if (va.preferred_shingle?.brand) f.preferredShingleBrand = va.preferred_shingle.brand;
  if (va.preferred_shingle?.line) f.preferredShingleLine = va.preferred_shingle.line;
  if (Array.isArray(va.other_shingles)) f.otherShingles = va.other_shingles.slice();
  if (va.underlayment) f.underlayment = va.underlayment as Underlayment;
  if (va.starter_strip) f.starterStrip = va.starter_strip as StarterStrip;

  if (va.ventilation) {
    f.ventRidgeUpgrade = !!va.ventilation.free_ridge_vent;
    f.ventOtherCheck = !!va.ventilation.other_check;
    if (va.ventilation.other_text) f.ventOtherText = va.ventilation.other_text;
  }
  if (va.attic_inspection) {
    f.freeAtticInspection = !!va.attic_inspection.free;
    if (va.attic_inspection.other_services) f.otherServices = va.attic_inspection.other_services;
  }
  if (va.cleanup_guarantee) f.cleanupGuarantee = va.cleanup_guarantee;
  if (va.property_protection) {
    f.propEquipter = !!va.property_protection.equipter;
    f.propCatchAll = !!va.property_protection.catch_all;
    f.propOtherCheck = !!va.property_protection.other_check;
    if (va.property_protection.other_text) f.propOtherText = va.property_protection.other_text;
  }
  if (va.warranty) {
    f.warranty = {
      materialDefects: warrantyRow(va.warranty.material_defects),
      labor: warrantyRow(va.warranty.labor),
      algae: warrantyRow(va.warranty.algae),
      hail: warrantyRow(va.warranty.hail),
      wind: warrantyRow(va.warranty.wind),
    };
    if (va.warranty.notes) f.warrantyNotes = va.warranty.notes;
  }
  if (va.other_offers) f.otherOffers = va.other_offers;
  if (Array.isArray(va.other_trades)) f.otherTrades = va.other_trades.slice();

  return f;
}

// ── save payload (:731-799) ─────────────────────────────────────────────────

const trimOrNull = (s: string): string | null => {
  const t = s.trim();
  return t.length ? t : null;
};

export interface AutoBidPayload {
  auto_bid_enabled: boolean;
  auto_bid_settings: { funding_type: string; scope: string; trade: string; pricing: string };
  auto_bid_value_adds: StoredValueAdds;
  updated_at: string;
}

/** Build the exact `contractors` update payload from the form (static :738-799). */
export function buildAutoBidPayload(
  form: AutoBidForm,
  nowIso: string = new Date().toISOString(),
): AutoBidPayload {
  const w = form.warranty;
  return {
    auto_bid_enabled: form.autoBidEnabled,
    auto_bid_settings: {
      funding_type: 'insurance',
      scope: 'full_replacement',
      trade: 'roofing',
      pricing: 'rcv',
    },
    auto_bid_value_adds: {
      gutters: {
        option: form.gutterOption,
        other_text: form.gutterOption === 'other' ? trimOrNull(form.gutterOther) : null,
      },
      chimney_flashing: form.chimneyFlashing || 'na',
      gutter_guards: {
        option: form.gutterGuards,
        type: form.gutterGuards === 'included' ? (form.gutterGuardType || 'mesh') : null,
        other_text: form.gutterGuards === 'other' ? trimOrNull(form.gutterGuardsOther) : null,
      },
      chimney_reflash: {
        option: form.chimneyReflash,
        oop_price:
          form.chimneyReflash === 'oop'
            ? (Number.parseFloat(form.chimneyReflashOop) || null)
            : null,
      },
      preferred_shingle: {
        brand: trimOrNull(form.preferredShingleBrand),
        line: trimOrNull(form.preferredShingleLine),
      },
      other_shingles: form.otherShingles,
      underlayment: form.underlayment || 'synthetic',
      starter_strip: form.starterStrip || 'eaves',
      ventilation: {
        free_ridge_vent: form.ventRidgeUpgrade,
        other_check: form.ventOtherCheck,
        other_text: trimOrNull(form.ventOtherText),
      },
      attic_inspection: {
        free: form.freeAtticInspection,
        other_services: trimOrNull(form.otherServices),
      },
      cleanup_guarantee: trimOrNull(form.cleanupGuarantee),
      property_protection: {
        equipter: form.propEquipter,
        catch_all: form.propCatchAll,
        other_check: form.propOtherCheck,
        other_text: trimOrNull(form.propOtherText),
      },
      warranty: {
        material_defects: { offered: w.materialDefects.offered, description: trimOrNull(w.materialDefects.description) },
        labor: { offered: w.labor.offered, description: trimOrNull(w.labor.description) },
        algae: { offered: w.algae.offered, description: trimOrNull(w.algae.description) },
        hail: { offered: w.hail.offered, description: trimOrNull(w.hail.description) },
        wind: { offered: w.wind.offered, description: trimOrNull(w.wind.description) },
        notes: trimOrNull(form.warrantyNotes),
      },
      other_offers: trimOrNull(form.otherOffers),
      other_trades: form.otherTrades,
      review_sites: {},
    },
    updated_at: nowIso,
  };
}

// ── bid preview (:850-918) ──────────────────────────────────────────────────

/** Preview-only label map for "Other Trades" (static :891). */
export const TRADE_PREVIEW_LABELS: Record<string, string> = {
  siding_full: 'Siding (full replace)',
  siding_repair: 'Siding (repair)',
  gutters_full: 'Gutters (full replace)',
  gutters_repair: 'Gutters (repair)',
  interior_repairs: 'Interior repairs',
  paint: 'Paint',
};

export interface BidPreview {
  companyName: string;
  includes: string[];
  warranty: string[];
  warrantyDisclaimer: string | null;
}

export interface PreviewContractor {
  company_name?: string | null;
  contact_name?: string | null;
}

/** Build the "what the homeowner sees" preview from the form (static :850-918). */
export function buildBidPreview(
  form: AutoBidForm,
  contractor: PreviewContractor | null | undefined,
): BidPreview {
  const companyName = contractor?.company_name || contractor?.contact_name || 'Your Company';
  const brand = form.preferredShingleBrand.trim();
  const line = form.preferredShingleLine.trim();

  const includes: string[] = [];
  if (brand || line) includes.push('🏗 Preferred Shingle: ' + [brand, line].filter(Boolean).join(' — '));

  if (form.gutterOption === '5inch_included') includes.push('✅ 5" Gutters Included');
  else if (form.gutterOption === '6inch_included') includes.push('✅ 6" Gutters Included');

  if (form.gutterGuards === 'included') {
    const t = form.gutterGuardType || '';
    includes.push('✅ Gutter Guards Included' + (t ? ` (${t})` : ''));
  } else if (form.gutterGuards === 'insurance_covered') {
    includes.push('🛡 Gutter Guards: As covered by insurance or paid for by homeowner');
  } else if (form.gutterGuards === 'other') {
    const o = form.gutterGuardsOther.trim();
    if (o) includes.push('ℹ️ Gutter Guards: ' + o);
  }

  if (form.ventRidgeUpgrade) includes.push('✅ Free Ridge Vent Upgrade');
  const ventOther = form.ventOtherText.trim();
  if (form.ventOtherCheck && ventOther) includes.push('✅ ' + ventOther);

  if (form.freeAtticInspection) includes.push('✅ Free Attic Inspection');
  const otherSvcs = form.otherServices.trim();
  if (otherSvcs) includes.push('✅ ' + otherSvcs);

  const cleanup = form.cleanupGuarantee.trim();
  if (cleanup) includes.push('🧹 Cleanup: ' + cleanup);

  const ppItems: string[] = [];
  if (form.propEquipter) ppItems.push('Equipter');
  if (form.propCatchAll) ppItems.push('Catch-All');
  const ppOther = form.propOtherText.trim();
  if (form.propOtherCheck && ppOther) ppItems.push(ppOther);
  if (ppItems.length) includes.push('🛡 Property Protection: ' + ppItems.join(', '));

  const otherOffers = form.otherOffers.trim();
  if (otherOffers) includes.push('🎁 ' + otherOffers);

  const selectedTrades = form.otherTrades.map((v) => TRADE_PREVIEW_LABELS[v] || v);
  if (selectedTrades.length) {
    includes.push('🏠 Other Trades (if covered by insurance): ' + selectedTrades.join(', '));
  }

  const warranty: string[] = [];
  const shingleName = [brand, line].filter(Boolean).join(' ') || 'your preferred shingle';
  const w = form.warranty;
  if (w.materialDefects.offered) warranty.push('📋 Material Defects' + descSuffix(w.materialDefects.description));
  if (w.labor.offered) warranty.push('🔨 Labor' + descSuffix(w.labor.description));
  if (w.algae.offered) warranty.push('🌿 Algae Resistance' + descSuffix(w.algae.description));
  if (w.hail.offered) warranty.push('🌨 Hail' + descSuffix(w.hail.description));
  if (w.wind.offered) warranty.push('💨 Wind' + descSuffix(w.wind.description));

  const warrantyDisclaimer = warranty.length
    ? `* Warranty terms apply only to ${shingleName}. Different warranty terms may apply to other shingles.`
    : null;

  return { companyName, includes, warranty, warrantyDisclaimer };
}

function descSuffix(desc: string): string {
  const d = desc.trim();
  return d ? ': ' + d : '';
}
