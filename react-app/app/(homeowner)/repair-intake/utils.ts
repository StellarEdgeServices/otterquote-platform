/**
 * Pure helpers for the repair-intake wizard (H9) — D-211 Phase 24.
 *
 * These mirror the static repair-intake.html branching/labelling/submit logic so
 * the React port is behaviour-faithful, kept side-effect-free for direct unit
 * testing. Two static quirks are intentionally PRESERVED (flagged in the report):
 *   • roofAge / shinglesCount are collected but never written to the claim.
 *   • The INSERT payload sets funding_type:'insurance' + status:'draft'; the
 *     UPDATE payload omits them.
 * One static bug is corrected (Tier-1-only material read — see types.ts), and one
 * promised-but-missing guard is added (the 10 MB client size check).
 */

import type {
  ClaimRepairInsert,
  ClaimRepairUpdate,
  MaterialIdentity,
  PhotoTier,
  RepairSubmission,
  RepairType,
  RepairTypeCard,
  Trade,
  UploadedPhotos,
} from './types';

/** Client-side per-file size ceiling. The static copy promised "up to 10MB"
 *  but never enforced it; we add the guard (brief item 3 / test c). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Faithful port of the static `repairTypeMap` for the three roofing cards. */
export const ROOFING_REPAIR_CARDS: RepairTypeCard[] = [
  { type: 'leak', icon: '💧', title: 'Leak', description: 'Water is coming into my home' },
  {
    type: 'shingles',
    icon: '💨',
    title: 'Blown-off Shingles',
    description: 'Shingles are missing or damaged from wind',
  },
  { type: 'other', icon: '❓', title: 'Other', description: 'Something else is wrong' },
];

/** Trades that show the three roofing cards. All others use the textarea path. */
export function isRoofing(trade: Trade): boolean {
  return trade === 'roofing';
}

/**
 * Resolve the homeowner's selected trade from sessionStorage `oq_trade_selections`
 * (the static read the first truthy entry). Returns null when absent/unparseable.
 * Guarded for SSR.
 */
export function getTradeFromSession(): Trade | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem('oq_trade_selections');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const trade = Object.keys(parsed).find((t) => parsed[t]);
    return trade ?? null;
  } catch {
    return null;
  }
}

/** Read ?claim_id= from the current URL (SSR-guarded). */
export function getClaimIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('claim_id');
  } catch {
    return null;
  }
}

/** Per-repair-type photo guidance (faithful port of getPhotoInstructions). */
export function getPhotoInstructions(type: RepairType | null): string[] {
  const instructions: Record<string, string[]> = {
    leak: [
      '📸 Interior damage — ceiling stains, dripping, water marks',
      '📸 Roof area above the leak (from the ground is fine)',
      '📸 Any flashing, vents, or penetrations near the suspected area',
    ],
    shingles: [
      '📸 Wide shot showing the missing area',
      '📸 Close-up of surrounding shingles (helps identify the product)',
      '📸 Photo of any shingles found on the ground',
    ],
    other: ['📸 Photos of whatever you’re seeing (the more the better)'],
    describe: ['📸 Photos of the issue (the more the better)'],
  };
  return (type && instructions[type]) || [];
}

/** Only the Tier-1 (paperwork) upload accepts PDFs; everything else is image-only. */
export function tierAcceptsPdf(tier: PhotoTier): boolean {
  return tier === 'tier1';
}

/** The `accept` attribute for a tier's file input. */
export function acceptAttr(tier: PhotoTier): string {
  return tierAcceptsPdf(tier) ? 'image/*,application/pdf' : 'image/*';
}

export interface FileValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validate a single selected file for a tier: must be an image (or a PDF for
 * Tier 1) and within the 10 MB ceiling. Returns a human message on rejection.
 */
export function validatePhotoFile(file: File, tier: PhotoTier): FileValidation {
  const isImage = file.type.startsWith('image/');
  const isPdf = file.type === 'application/pdf';
  const typeOk = isImage || (tierAcceptsPdf(tier) && isPdf);
  if (!typeOk) {
    return {
      ok: false,
      error: `"${file.name}" is not a supported file type (${
        tierAcceptsPdf(tier) ? 'images or PDF' : 'images'
      } only).`,
    };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: `"${file.name}" is larger than 10MB.` };
  }
  return { ok: true };
}

/** File extension for the storage key (faithful: fall back to 'jpg'). */
export function fileExt(file: File): string {
  const parts = file.name.split('.');
  return parts.length > 1 ? parts.pop()! : 'jpg';
}

/**
 * Build the Supabase Storage object key for a repair photo.
 *
 * D-220 STORAGE-RLS decision (2026-06-23, Dustin): the static used
 * `${claimId}/...`, but the claim-documents INSERT policy requires the FIRST
 * folder segment to equal auth.uid() — so the static path was rejected by RLS
 * and its photos silently never stored. We adopt the established, RLS-compliant
 * homeowner convention used by the React dashboard (#336) and trade-selector:
 * UID-first, with the claim id retained as the second segment. No storage/policy
 * change; access is not broadened.
 */
export function buildStoragePath(
  userId: string,
  claimId: string,
  tier: PhotoTier,
  ext: string,
  ts: number,
  rand: string,
): string {
  return `${userId}/${claimId}/repair-${tier}-${ts}-${rand}.${ext}`;
}

/** Trim a field to null (faithful to the static `.trim() || null`). */
export function trimToNull(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v.length ? v : null;
}

/** Whether any material identity field is populated (summary "Provided"). */
export function hasMaterialIdentity(material: MaterialIdentity): boolean {
  return Boolean(material.brand || material.product || material.color);
}

/** Total selected photos across every tier. */
export function totalPhotoCount(photos: UploadedPhotos): number {
  return (Object.keys(photos) as PhotoTier[]).reduce(
    (sum, tier) => sum + photos[tier].length,
    0,
  );
}

/** Submit is allowed once a repair type is chosen and at least one photo exists. */
export function canSubmit(repairType: RepairType | null, photoCount: number): boolean {
  return Boolean(repairType) && photoCount > 0;
}

/** Empty per-tier photo state. */
export function emptyPhotos(): UploadedPhotos {
  return { main: [], tier1: [], tier2: [], tier3: [], tier4: [] };
}

/** Empty material identity. */
export function emptyMaterial(): MaterialIdentity {
  return { brand: '', product: '', color: '' };
}

/**
 * The INSERT payload for a new repair claim — exact field-set of the static
 * submitForm() insert. Material fields are trimmed-to-null.
 */
export function buildClaimInsert(sub: RepairSubmission): ClaimRepairInsert {
  return {
    user_id: sub.userId,
    job_type: 'repair',
    funding_type: 'insurance',
    status: 'draft',
    trades: [sub.trade || 'roofing'],
    existing_shingle_brand: trimToNull(sub.material.brand),
    existing_shingle_product: trimToNull(sub.material.product),
    existing_shingle_color: trimToNull(sub.material.color),
    homeowner_notes: trimToNull(sub.notes),
  };
}

/**
 * The UPDATE payload for an existing repair claim — exact field-set of the static
 * submitForm() update (omits user_id / funding_type / status, per static).
 */
export function buildClaimUpdate(sub: RepairSubmission): ClaimRepairUpdate {
  return {
    job_type: 'repair',
    trades: [sub.trade || 'roofing'],
    existing_shingle_brand: trimToNull(sub.material.brand),
    existing_shingle_product: trimToNull(sub.material.product),
    existing_shingle_color: trimToNull(sub.material.color),
    homeowner_notes: trimToNull(sub.notes),
  };
}
