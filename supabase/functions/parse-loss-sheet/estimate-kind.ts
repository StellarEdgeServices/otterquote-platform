// gh-2559 (Marty ruling, #2559 / PR #2929 review blocker 1): decide from the file's BYTES (not its name) what the estimate is, so the
// parser sends the provider the real media type. Anthropic's messages API takes PDFs as a "document" block and JPEG/PNG/GIF/WebP as an
// "image" block (5 MB per image). Anything else (Word, HEIC, text, an empty or truncated file, an oversize image) is NOT readable by
// the parser: the caller records loss_sheet_parse_status = 'unsupported' instead of failing forever. Pure; no Deno API, no network.
export type EstimateKind =
  | { block: "document"; mediaType: "application/pdf" }
  | { block: "image"; mediaType: "image/jpeg" | "image/png" };

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function detectEstimateKind(b: Uint8Array): EstimateKind | null {
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) {
    return { block: "document", mediaType: "application/pdf" }; // %PDF
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return b.length <= MAX_IMAGE_BYTES ? { block: "image", mediaType: "image/jpeg" } : null;
  }
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return b.length <= MAX_IMAGE_BYTES ? { block: "image", mediaType: "image/png" } : null;
  }
  return null;
}
