// gh-2559 (Marty ruling, #2559 / PR #2929 review blocker 1): decide from the file's BYTES (not its name) what the estimate is, so the
// parser sends the provider the real media type. Anthropic's messages API takes PDFs as a "document" block and JPEG/PNG/GIF/WebP as an
// "image" block (5 MB per image, measured on the base64). Anything else (Word, HEIC, text, an empty or truncated file, an oversize image) is NOT readable by
// the parser: the caller records loss_sheet_parse_status = 'unsupported' instead of failing forever. Pure; no Deno API, no network.
export type EstimateKind =
  | { block: "document"; mediaType: "application/pdf" }
  | { block: "image"; mediaType: "image/jpeg" | "image/png" };

// The provider names the limit on image.source.base64 ("image exceeds 5 MB maximum: N bytes > 5242880 bytes"), so it is measured on the
// base64 text, which is 4/3 of the raw size. Conservative cap: the largest raw size whose base64 stays within 5 MiB.
export const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024) / 4) * 3; // 3,932,160

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

// gh-2559: which provider failures are about THIS FILE (mark the claim 'failed': it will fail the same way every time) and which are
// not (account, key, model, configuration, rate limits, outages: transient for the claim, never 'failed').
// WHITELIST (REVIEW 6277457123): HTTP 413 is the file. A 400 is the file only when the provider's error either points into the request's
// image/document content block (messages.N.content.N.image|document...) or carries one of the known file texts below. Everything else,
// including a 400 about max_tokens, the model, the key, credit or usage limits, an unparseable body, is NOT the file.
const FILE_BLOCK_PATH = /messages\.\d+\.content\.\d+\.(?:image|document)\b/i;
const FILE_TEXTS: RegExp[] = [
  /image exceeds/i,
  /image dimensions/i,
  /maximum of \d+ pdf pages/i,
  /too many pages/i,
  /pdf specified/i,
  /password[ -]protected/i,
  /could not process (?:image|document)/i,
  /does not match the provided media type/i,
  /prompt is too long/i, // a huge PDF/image set: more tokens than the context window
  /input length and `?max_tokens`? exceed context limit/i, // same cause, other wording
];

export function isFileRejection(status: number, errorText: string): boolean {
  if (status === 413) return true;
  if (status !== 400) return false;
  let msg = errorText;
  try {
    const j = JSON.parse(errorText);
    msg = [j?.error?.message, j?.message].filter((x) => typeof x === "string").join(" ");
  } catch { /* not JSON: judge the raw text */ }
  return FILE_BLOCK_PATH.test(msg) || FILE_TEXTS.some((r) => r.test(msg));
}
