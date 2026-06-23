/**
 * Homeowner repair-intake (H9) data shapes — D-211 Phase 24.
 *
 * Behaviour-faithful port of the static repair-intake.html "Repair Diagnostic"
 * wizard. The claims / contractors_public / profiles rows are owned by SQL
 * (Tier-3, out of scope); these interfaces describe only the columns this page
 * reads or writes. Loose by design (index signature) to tolerate columns this
 * page does not touch.
 *
 * Column names verified against the LIVE database (project yeszghaspzwwstvsrioa,
 * 2026-06-23):
 *   • claims               — user_id, job_type, funding_type, status, trades,
 *                            existing_shingle_brand/_product/_color,
 *                            homeowner_notes, id, created_at  → ALL exist.
 *   • contractors_public   — id, company_name, years_in_business, rating,
 *                            service_counties, repairs_accepted, trades exist;
 *                            `phone` DOES NOT EXIST. The static interpolated
 *                            `c.phone` (never selected), so its phone block was
 *                            always falsy → we OMIT phone entirely rather than
 *                            render undefined.
 *   • profiles             — full_name exists.
 */

/** The trade the homeowner picked upstream (sessionStorage `oq_trade_selections`). */
export type Trade = 'roofing' | 'siding' | 'gutters' | 'windows' | string;

/**
 * Repair type. For roofing the static shows three cards; for the other trades it
 * collapses to a single free-text path keyed 'describe'.
 */
export type RepairType = 'leak' | 'shingles' | 'other' | 'describe';

/**
 * Which upload bucket a photo belongs to. 'main' is the top-of-page repair
 * photos; tier1–tier4 are the roofing material-identification accordions.
 */
export type PhotoTier = 'main' | 'tier1' | 'tier2' | 'tier3' | 'tier4';

/** A repair-type card descriptor (mirrors the static `repairTypeMap`). */
export interface RepairTypeCard {
  type: RepairType;
  icon: string;
  title: string;
  description: string;
}

/**
 * A selected photo plus its locally-generated preview. `previewUrl` is a
 * FileReader data URL for images; null for non-image files (e.g. a Tier-1 PDF),
 * which render as a document chip instead of an <img>.
 */
export interface SelectedPhoto {
  id: string;
  file: File;
  previewUrl: string | null;
  isImage: boolean;
}

/** Per-tier photo state. */
export type UploadedPhotos = Record<PhotoTier, SelectedPhoto[]>;

/**
 * Existing-shingle material identity (roofing only). The static rendered
 * brand/product/color inputs under BOTH Tier 1 and Tier 2 but only ever read
 * the first-in-DOM (Tier 1) on submit — the Tier 2 inputs were dead. Both tiers
 * capture the SAME roof's identity, so we unify them into one shared value:
 * either accordion edits this state, and it is what the claim is written with.
 * This corrects the static's read-only-Tier-1 oversight for the common
 * single-tier path without broadening anything written. Flagged in the report.
 */
export interface MaterialIdentity {
  brand: string;
  product: string;
  color: string;
}

/** Repair-type-specific dynamic field values (rendered, see note on persistence). */
export interface RepairSpecificFields {
  /** leak → "How old is your roof?" — collected, NOT persisted (static parity). */
  roofAge: string;
  /** shingles → "How many shingles missing?" — collected, NOT persisted. */
  shinglesCount: string;
  /** other → free-text issue description — persisted to homeowner_notes. */
  issueDescription: string;
  /** describe (siding/gutters/windows) free-text — persisted to homeowner_notes. */
  otherDescription: string;
}

/** A contractor row from the PUBLIC-SAFE view (never the base contractors table). */
export interface ContractorPublicRow {
  id: string;
  company_name?: string | null;
  years_in_business?: number | null;
  rating?: number | null;
  service_counties?: string[] | null;
  [key: string]: unknown;
}

/**
 * The exact INSERT payload for a brand-new repair claim — faithful port of the
 * static submitForm() insert (repair-intake.html:1228-1242).
 */
export interface ClaimRepairInsert {
  user_id: string;
  job_type: 'repair';
  funding_type: 'insurance';
  status: 'draft';
  trades: Trade[];
  existing_shingle_brand: string | null;
  existing_shingle_product: string | null;
  existing_shingle_color: string | null;
  homeowner_notes: string | null;
}

/**
 * The exact UPDATE payload applied to an existing claim — faithful port of the
 * static submitForm() update (repair-intake.html:1251-1257). Note it omits
 * user_id / funding_type / status (those are not re-written here).
 */
export interface ClaimRepairUpdate {
  job_type: 'repair';
  trades: Trade[];
  existing_shingle_brand: string | null;
  existing_shingle_product: string | null;
  existing_shingle_color: string | null;
  homeowner_notes: string | null;
}

/** Everything the submit orchestration needs from the page. */
export interface RepairSubmission {
  userId: string;
  /** Existing claim id (URL ?claim_id= or sessionStorage), or null to create one. */
  claimId: string | null;
  trade: Trade;
  repairType: RepairType;
  material: MaterialIdentity;
  /** Resolved homeowner_notes (issueDescription || otherDescription || null). */
  notes: string | null;
  photos: { tier: PhotoTier; file: File }[];
}

/** Result of a submit — the claim id that was created/updated. */
export interface RepairSubmitResult {
  claimId: string;
}
