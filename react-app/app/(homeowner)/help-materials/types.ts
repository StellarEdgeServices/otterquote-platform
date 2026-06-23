/**
 * Homeowner help-materials (H8) data shapes — D-211.
 *
 * The claims/material_catalog rows are owned by SQL (Tier-3, out of scope);
 * these interfaces describe only the columns this page reads/writes. Loose by
 * design (index signature) to tolerate columns this page doesn't touch.
 *
 * Column names verified against sql/v2-migration.sql (material_catalog
 * CREATE + the claims ALTER ADD COLUMN block) — every field the static
 * help-materials.html consumed exists, so nothing is omitted.
 */

/** A row from material_catalog (subcategory='designer', active=true). */
export interface MaterialCatalogRow {
  id: string;
  manufacturer?: string | null;
  product_name?: string | null;
  description?: string | null;
  /** Stored as 'class3' | 'class4' | 'none' | null (NOT hyphenated). */
  impact_class?: string | null;
  /** 'standard' | 'mid' | 'premium' — only 'premium' earns the Premium badge. */
  price_tier?: string | null;
  visualizer_url?: string | null;
  sort_order?: number | null;
  subcategory?: string | null;
  active?: boolean | null;
  [key: string]: unknown;
}

/** The roofing category the wizard branches on. */
export type MaterialCategory = 'shingles' | 'metal';
export type ShingleType = 'architectural' | 'designer' | '3-tab';
export type MetalType = 'standing-seam' | 'exposed-fastener';
export type MetalMaterial = 'steel' | 'aluminum';

/**
 * The wizard's branching selection state — mirrors the static page's `state`
 * object 1:1 (help-materials.html:989-998).
 */
export interface MaterialSelectionState {
  category: MaterialCategory | null;
  shingleType: ShingleType | null;
  metalType: MetalType | null;
  /**
   * Preserve EXACTLY what each path writes — do NOT normalize (brief item 5):
   *   Architectural path → 'none' | 'class-3' | 'class-4' (hyphenated)
   *   Designer path      → product.impact_class verbatim ('class3' | 'class4' | 'none')
   * Downstream SOW / contractor-bid logic reads claims.impact_class and may
   * depend on the stored string. Flagged as a candidate follow-up ticket.
   */
  impactClass: string | null;
  metalMaterial: MetalMaterial | null;
  designerProduct: string | null;
  designerManufacturer: string | null;
  designerCatalogId: string | null;
}

/**
 * The exact object written to the homeowner's current claim row on confirm —
 * shape matches the static submitSelection() (help-materials.html:1354-1371).
 * Values are PRESERVED verbatim from the selection (no normalization).
 */
export interface ClaimMaterialUpdate {
  material_category: string;
  has_material_selection: true;
  shingle_type?: string;
  impact_class?: string;
  designer_product?: string;
  designer_manufacturer?: string | null;
  metal_type?: string;
  metal_material?: string;
}

/** A manufacturer-grouped bucket of designer products (for the catalog grid). */
export interface ManufacturerGroup {
  manufacturer: string;
  products: MaterialCatalogRow[];
}

/** A small badge descriptor rendered as SAFE JSX (never innerHTML). */
export interface ProductBadge {
  label: string;
  /** CSS modifier class suffix, e.g. 'impact4' | 'impact3' | 'tier-premium'. */
  variant: string;
}

/** The Review-Your-Selection summary the confirmation card renders. */
export interface ConfirmSummary {
  category: string;
  type: string;
  details: string | null;
}
