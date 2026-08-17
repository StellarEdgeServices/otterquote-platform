/**
 * Pure helpers for the help-materials wizard (H8) — D-211.
 *
 * These mirror the static help-materials.html branching/labelling logic exactly
 * so the React port is behaviour-faithful. In-wizard value strings are PRESERVED
 * verbatim (the designer path carries material_catalog.impact_class as stored —
 * see types.ts), but the DB write boundary normalizes impact_class to the
 * canonical hyphenated form (gh-425). Kept side-effect-free for unit testing.
 */

import type {
  ClaimMaterialUpdate,
  ConfirmSummary,
  ManufacturerGroup,
  MaterialCatalogRow,
  MaterialSelectionState,
  ProductBadge,
} from './types';

/** Empty initial wizard state — mirrors the static `state` literal. */
export function initialSelectionState(): MaterialSelectionState {
  return {
    category: null,
    shingleType: null,
    metalType: null,
    impactClass: null,
    metalMaterial: null,
    designerProduct: null,
    designerManufacturer: null,
    designerCatalogId: null,
  };
}

/**
 * Whether the terminal leaf of the chosen branch is reached, so pricing +
 * confirmation should show. Mirrors when the static page called
 * showPricing()/showConfirmation():
 *   shingles + 3-tab        → immediately on type select
 *   shingles + architectural → once an impact class is picked
 *   shingles + designer      → once a designer product is picked
 *   metal                    → once a metal material is picked
 */
export function isConfirmReady(state: MaterialSelectionState): boolean {
  if (state.category === 'shingles') {
    if (state.shingleType === '3-tab') return true;
    if (state.shingleType === 'architectural') return state.impactClass !== null;
    if (state.shingleType === 'designer') return state.designerCatalogId !== null;
    return false;
  }
  if (state.category === 'metal') {
    return state.metalType !== null && state.metalMaterial !== null;
  }
  return false;
}

/** The active 1-4 progress step, derived from selection state. */
export function currentStep(state: MaterialSelectionState): number {
  if (!state.category) return 1;
  const typeChosen = state.shingleType !== null || state.metalType !== null;
  if (!typeChosen) return 2;
  if (isConfirmReady(state)) return 4;
  return 3;
}

/**
 * Normalize an impact-class value to the canonical stored form for
 * claims.impact_class: 'none' | 'class-3' | 'class-4' (gh-425, Bridge ruling
 * 2026-08-10). The designer path carries material_catalog.impact_class
 * verbatim ('class3'/'class4'); the architectural path is already hyphenated.
 * Applied at the DB write boundary ONLY — wizard state and display logic keep
 * the verbatim value (catalog badges/labels compare against the stored
 * catalog spelling).
 */
export function normalizeImpactClass(impactClass: string): string {
  return impactClass.replace(/^class(\d)$/i, 'class-$1');
}

/**
 * Build the exact update object written to the claims row — port of the static
 * submitSelection() (help-materials.html). impact_class is normalized to the
 * canonical hyphenated form at this write boundary (gh-425); all other values
 * are preserved verbatim.
 */
export function buildClaimMaterialUpdate(
  state: MaterialSelectionState,
): ClaimMaterialUpdate {
  const update: ClaimMaterialUpdate = {
    material_category: state.category as string,
    has_material_selection: true,
  };

  if (state.category === 'shingles') {
    if (state.shingleType) update.shingle_type = state.shingleType;
    if (state.impactClass) update.impact_class = normalizeImpactClass(state.impactClass);
    if (state.designerProduct) {
      update.designer_product = state.designerProduct;
      update.designer_manufacturer = state.designerManufacturer;
    }
  } else {
    if (state.metalType) update.metal_type = state.metalType;
    if (state.metalMaterial) update.metal_material = state.metalMaterial;
  }

  return update;
}

/** Group designer products by manufacturer, preserving catalog (sort_order) order. */
export function groupByManufacturer(
  products: MaterialCatalogRow[],
): ManufacturerGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, MaterialCatalogRow[]>();
  for (const p of products) {
    const mfr = (p.manufacturer && p.manufacturer.trim()) || 'Other';
    if (!buckets.has(mfr)) {
      buckets.set(mfr, []);
      order.push(mfr);
    }
    buckets.get(mfr)!.push(p);
  }
  return order.map((manufacturer) => ({
    manufacturer,
    products: buckets.get(manufacturer)!,
  }));
}

/** Impact-class badge for a designer product, or null when unrated. */
export function impactBadge(impactClass: string | null | undefined): ProductBadge | null {
  if (impactClass === 'class4') return { label: 'Class 4', variant: 'impact4' };
  if (impactClass === 'class3') return { label: 'Class 3', variant: 'impact3' };
  return null;
}

/** Price-tier badge — only 'premium' is Premium; everything else is Moderate. */
export function tierBadge(priceTier: string | null | undefined): ProductBadge {
  return priceTier === 'premium'
    ? { label: 'Premium', variant: 'tier-premium' }
    : { label: 'Moderate', variant: 'tier-mid' };
}

/** Truncate a product description for the card (mirrors static 160/157 rule). */
export function truncateDescription(desc: string | null | undefined): string {
  if (!desc) return '';
  return desc.length > 160 ? desc.substring(0, 157) + '...' : desc;
}

const SHINGLE_NAMES: Record<string, string> = {
  architectural: 'Architectural Shingle',
  designer: 'Designer Shingle',
  '3-tab': '3-Tab Shingle',
};
const IMPACT_NAMES: Record<string, string> = {
  none: 'No Impact Class',
  'class-3': 'Class 3 Hail Resistance',
  'class-4': 'Class 4 Hail Resistance (Recommended)',
};
const METAL_NAMES: Record<string, string> = {
  'standing-seam': 'Standing Seam',
  'exposed-fastener': 'Exposed Fastener',
};
const MATERIAL_NAMES: Record<string, string> = {
  steel: 'Steel (Galvalume)',
  aluminum: 'Aluminum',
};

/**
 * Build the Review-Your-Selection summary — faithful port of the static
 * showConfirmation() (help-materials.html:1276-1331), including the designer
 * auto-impact label branch (which reads 'class3'/'class4', not the hyphenated
 * architectural values).
 */
export function confirmSummary(state: MaterialSelectionState): ConfirmSummary {
  const category = state.category === 'shingles' ? 'Shingles' : 'Metal Roofing';

  if (state.category === 'shingles') {
    if (state.shingleType === 'designer' && state.designerProduct) {
      const details =
        state.impactClass === 'class4'
          ? 'Class 4 Impact Resistant'
          : state.impactClass === 'class3'
            ? 'Class 3 Impact Resistant'
            : 'Standard (no impact rating)';
      return {
        category,
        type: `${state.designerManufacturer ?? ''} ${state.designerProduct}`.trim(),
        details,
      };
    }
    return {
      category,
      type: state.shingleType ? SHINGLE_NAMES[state.shingleType] : '',
      details: state.impactClass ? IMPACT_NAMES[state.impactClass] ?? null : null,
    };
  }

  return {
    category,
    type: state.metalType ? METAL_NAMES[state.metalType] : '',
    details: state.metalMaterial ? MATERIAL_NAMES[state.metalMaterial] ?? null : null,
  };
}

/** A relative-pricing guidance row (informational copy ported from the static page). */
export interface PricingRow {
  key: string;
  name: string;
  value: string;
}

/**
 * Which pricing-guidance blocks to show, by selection — faithful port of the
 * static showPricing() (help-materials.html:1251-1273). Informational copy.
 */
export function pricingRows(state: MaterialSelectionState): PricingRow[] {
  const rows: PricingRow[] = [];
  if (state.category === 'shingles') {
    rows.push({
      key: 'architectural',
      name: 'Architectural Shingle',
      value: 'Included in most insurance claims at no additional cost',
    });
    if (state.shingleType === 'designer') {
      rows.push({
        key: 'designer',
        name: 'Designer Shingle',
        value: 'Premium upgrade — expect out-of-pocket cost',
      });
    }
  } else if (state.category === 'metal') {
    if (state.metalType === 'exposed-fastener') {
      rows.push({
        key: 'metal-exposed',
        name: 'Exposed Fastener Metal',
        value: 'Budget metal — typically an upgrade over architectural',
      });
    } else if (state.metalType === 'standing-seam') {
      rows.push({
        key: 'metal-standing',
        name: 'Standing Seam Metal',
        value: 'Premium metal — significant upgrade, 40+ year lifespan',
      });
    }
  }
  return rows;
}
