/**
 * Homeowner color-selection pure helpers — D-211 Phase 27, PR 1/2 (ADDITIVE).
 *
 * Every function here is pure, DOM-free, and network-free — ported 1:1 from the inline JS
 * in color-selection.html. The eventual page (PR 2/2) is the only place that touches the
 * DOM, Supabase, or the create-docusign-envelope call; it collects raw claim/contractor
 * state and hands it to these helpers.
 *
 * FAITHFUL-PORT NOTES:
 *   • normalizeBrand returns the ORIGINAL (untrimmed) raw value for non-OC brands, exactly
 *     as the static does (color-selection.html:670-677): it trims only to TEST for OC /
 *     "Owens Corning", but assigns this.brand = rawBrand (the untrimmed original) otherwise.
 *     So a value like "  GAF  " stays "  GAF  " and would NOT match KNOWN_BRANDS — same as
 *     the static. Do not "fix" this by returning the trimmed value.
 *   • hasVisualizer uses the full six-brand KNOWN_BRANDS list (static:729/805); isLinkOutBrand
 *     uses the five link-out brands only — Owens Corning is the embedded widget, not a
 *     link-out (static:752/821-840).
 *   • buildColorAddendumPayload omits the `signer` field. The static (color-selection.html:
 *     1130-1140) DID send signer:{email,name}; this React port follows the H4 / D-220
 *     convention — create-docusign-envelope derives the signer server-side and ignores a
 *     request-body signer — and instead sends a return_url targeting the React route.
 */

import { COLOR_COPY } from './copy';

// ── Constants ────────────────────────────────────────────────────────────────────

/** create-docusign-envelope document_type for the color addendum (color-selection.html:1133). */
export const COLOR_CONFIRMATION_DOC_TYPE = 'color_confirmation' as const;

/** Brands with any visualizer (embed OR link-out). Mirrors static:729 / static:805. */
export const KNOWN_BRANDS = [
  'Owens Corning',
  'GAF',
  'CertainTeed',
  'TAMKO',
  'Atlas',
  'IKO',
] as const;

/** Brands rendered as an external link-out (Owens Corning is the embedded widget). static:752. */
export const LINK_OUT_BRANDS = ['GAF', 'CertainTeed', 'TAMKO', 'Atlas', 'IKO'] as const;

// ── Brand normalization (color-selection.html:670-677) ────────────────────────────

/**
 * Normalize a contractor's preferred_brand. Trims only to TEST for the OC aliases; 'OC'
 * (case-insensitive) or anything matching /owens\s*corning/i collapses to 'Owens Corning'.
 * Any other truthy value is returned UNCHANGED (untrimmed) — faithful to the static. Falsy
 * input → null.
 */
export function normalizeBrand(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (t.toUpperCase() === 'OC' || /owens\s*corning/i.test(t)) {
    return 'Owens Corning';
  }
  return raw || null;
}

// ── ZIP extraction (color-selection.html:680-681) ─────────────────────────────────

/**
 * Extract the first 5-digit ZIP from a property address for the OC widget; falls back to
 * '46077' when there is no match (or no address). Mirrors the static regex + fallback.
 */
export function extractZip(propertyAddress: string | null | undefined): string {
  const match = propertyAddress?.match(/\b(\d{5})\b/);
  return match ? match[1] : '46077';
}

// ── Brand capability checks ────────────────────────────────────────────────────────

/** True when the (normalized) brand has any visualizer. Mirrors static:729 includes-check. */
export function hasVisualizer(brand: string | null | undefined): boolean {
  if (!brand) return false;
  return (KNOWN_BRANDS as readonly string[]).includes(brand);
}

/** True when the brand renders as an external link-out (not the OC embed). static:752. */
export function isLinkOutBrand(brand: string | null | undefined): boolean {
  if (!brand) return false;
  return (LINK_OUT_BRANDS as readonly string[]).includes(brand);
}

// ── Visualizer description (color-selection.html:768-779) ──────────────────────────

/**
 * Option-card visualizer description for the brand, falling back to the 'default' copy.
 * Mirrors `descriptions[this.brand] || descriptions['default']`.
 */
export function getVisualizerDescription(brand: string | null | undefined): string {
  const map = COLOR_COPY.visualizerDescriptions as Record<string, string>;
  return (brand != null && map[brand]) || map.default;
}

// ── Link-out resolver (color-selection.html:907-992) ───────────────────────────────

export interface LinkOutTarget {
  url: string;
  label: string;
}

/**
 * Resolve a link-out brand to its { url, label } from COLOR_COPY.linkOut. Returns null for
 * a falsy brand, the OC embed brand, or any unlisted value.
 */
export function resolveLinkOut(brand: string | null | undefined): LinkOutTarget | null {
  if (!brand) return null;
  const map = COLOR_COPY.linkOut as Record<string, { url: string; label: string }>;
  const entry = map[brand];
  return entry ? { url: entry.url, label: entry.label } : null;
}

// ── Primary contact phone (color-selection.html:684-685) ───────────────────────────

/**
 * First notification phone, else the contractor's primary phone, else null. Mirrors
 * `(phones && phones.length > 0) ? phones[0] : (phone || null)`.
 */
export function resolvePrimaryPhone(
  notificationPhones: string[] | null | undefined,
  phone: string | null | undefined,
): string | null {
  if (notificationPhones && notificationPhones.length > 0) {
    return notificationPhones[0];
  }
  return phone || null;
}

// ── DocuSign color addendum (color-selection.html:1123-1140) ───────────────────────

/**
 * Guard for whether a color addendum envelope can be created. Mirrors the static early-out
 * (`if (!this.claimId || !this.contractorId || !this.signerEmail) return`): all three must
 * be present. signerEmail is required to gate the attempt even though it is NOT sent in the
 * payload (the EF derives the signer server-side).
 */
export function canCreateAddendum({
  claimId,
  contractorId,
  signerEmail,
}: {
  claimId: string | null | undefined;
  contractorId: string | null | undefined;
  signerEmail: string | null | undefined;
}): boolean {
  return !!(claimId && contractorId && signerEmail);
}

export interface ColorAddendumEnvelopeRequest {
  claim_id: string;
  contractor_id: string;
  document_type: 'color_confirmation';
  return_url: string;
}

/**
 * The embedded-signing return URL targeting the REACT color-selection route (not the static
 * .html page). claim_id is encodeURIComponent-encoded. Mirrors the H4 return-url shape.
 */
export function buildColorReturnUrl(origin: string, claimId: string): string {
  return `${origin}/color-selection?claim_id=${encodeURIComponent(claimId)}&signed=true`;
}

/**
 * Build the body for the create-docusign-envelope EF call.
 * CRITICAL: NO `signer` field — the EF derives the signer server-side (D-220). The static
 * sent signer + no return_url; this PR sends return_url + no signer (mirrors H4).
 */
export function buildColorAddendumPayload({
  claimId,
  contractorId,
  returnUrl,
}: {
  claimId: string;
  contractorId: string;
  returnUrl: string;
}): ColorAddendumEnvelopeRequest {
  return {
    claim_id: claimId,
    contractor_id: contractorId,
    document_type: COLOR_CONFIRMATION_DOC_TYPE,
    return_url: returnUrl,
  };
}

// ── Job number for the mailto fallback (color-selection.html:1056) ─────────────────

/** Last 8 chars of the claim id, upper-cased; 'UNKNOWN'-ish fallback when absent. */
export function jobNumberFromClaimId(claimId: string | null | undefined): string {
  return (claimId || 'unknown').slice(-8).toUpperCase();
}
