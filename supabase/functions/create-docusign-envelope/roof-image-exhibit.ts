// gh-1413 / D-317 cl. 6: the roof image on the homeowner Scope of Work (Exhibit A). DARK: nothing here runs unless the secret ROOF_IMAGE_ENABLED equals "true"
// (the same secret fetch-roof-image reads; unset today, and only Dustin switches it on).
//
// ACCESS: this module never creates a URL, never makes a bucket public and adds no storage policy. It reads the image the homeowner-side flow already stored in the
// PRIVATE claim-roof-images bucket, with the service role this Edge Function already holds for every other claim read, and puts the bytes into the PDF.
// It does not call fetch-roof-image and never reads claim-documents (the RoofScope report path, D-317 cl. 7). Because Exhibit A is also signed by the selected
// contractor, the image is embedded only after the Platform Fee is collected (the same gate as D-386 / D-390 for the homeowner's contact details), and it
// fails closed: any missing, oversized or unreadable image means the document prints exactly as it does today.
//
// WORDS: the only text this adds is the credit line the claim page already uses (js/claim-roof-image.js ATTRIBUTION). No heading, no measurement or accuracy statement.

export const ROOF_IMAGE_BUCKET = "claim-roof-images";
export const ROOF_IMAGE_OBJECT_PREFIX = "roof-"; // must equal OBJECT_PREFIX in ../fetch-roof-image/naip.ts (pinned by a test)
export const ROOF_IMAGE_EXHIBIT_CAPTION = "Imagery: USDA/USGS NAIP"; // must equal ATTRIBUTION in js/claim-roof-image.js (pinned by a test)
export const ROOF_IMAGE_MAX_BYTES = 2 * 1024 * 1024; // the bucket's own file_size_limit

export interface RoofImageForPdf { bytes: Uint8Array; width: number; height: number; components: 1 | 3; caption: string }

export const roofImageExhibitEnabled = (secret: string | undefined | null): boolean => secret === "true";

// Contractor-bound document: no image before the fee is collected (D-371 / D-386; the selected-contractor access rule is a separate decision).
export const mayEmbedRoofImage = (o: { enabled: boolean; feeCollected: boolean }): boolean => o.enabled === true && o.feeCollected === true;

/** Baseline or progressive 8-bit JPEG with 1 or 3 components. Anything else (CMYK, truncated, not a JPEG) is null. */
export function jpegInfo(b: Uint8Array): { width: number; height: number; components: 1 | 3 } | null {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) { i++; m = b[i + 1]; } // fill bytes
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null; // end / scan before any frame header
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return null;
    const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSof) {
      if (len < 8) return null;
      const precision = b[i + 4];
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      const components = b[i + 9];
      if (precision !== 8 || !width || !height || (components !== 1 && components !== 3)) return null;
      return { width, height, components: components as 1 | 3 };
    }
    i += 2 + len;
  }
  return null;
}

export interface ExhibitImageDeps {
  list(claimId: string): Promise<string[]>;      // object names under {claim_id}/
  download(path: string): Promise<Uint8Array | null>;
}

/** Newest stored image for the claim, validated; null on ANY problem (never throws). Caller must already have checked mayEmbedRoofImage. */
export async function loadRoofImageForExhibit(claimId: string, d: ExhibitImageDeps): Promise<RoofImageForPdf | null> {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claimId)) return null;
    const names = (await d.list(claimId)).filter((n) => n.startsWith(ROOF_IMAGE_OBJECT_PREFIX) && n.endsWith(".jpg"));
    if (names.length !== 1) return null; // none, or ambiguous: print nothing rather than guess which address the image is for
    const bytes = await d.download(`${claimId}/${names[0]}`);
    if (!bytes || bytes.length === 0 || bytes.length > ROOF_IMAGE_MAX_BYTES) return null;
    const info = jpegInfo(bytes);
    if (!info) return null;
    return { bytes, width: info.width, height: info.height, components: info.components, caption: ROOF_IMAGE_EXHIBIT_CAPTION };
  } catch { return null; }
}
