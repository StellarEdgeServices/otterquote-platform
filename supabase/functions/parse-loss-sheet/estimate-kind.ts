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

// gh-2559: which provider failures are about THIS FILE (mark the claim 'failed', it will fail the same way every time) and which are
// about the account or configuration (credit balance, auth, model, rate limits: transient for the claim, never 'failed').
// 413 is always the file. A 400 is the file only when the provider's error text names it (image / document / pdf / media / page / size /
// base64 / file) and does NOT name an account or config cause; anything else, including an unparseable body, is not the file.
const ACCOUNT_OR_CONFIG = /credit|balance|billing|payment|api[ _-]?key|x-api-key|authenticat|authoriz|permission|organization|workspace|model|overloaded|rate[ _-]?limit|quota|spend|usage limit/i;
const FILE_CAUSE = /image|document|pdf|media[ _-]?type|base64|page|too large|file size|exceeds|maximum|truncated|corrupt|encrypt|password|cannot be (?:processed|read|decoded)|could not (?:process|decode)/i;

export function isFileRejection(status: number, errorText: string): boolean {
  if (status === 413) return true;
  if (status !== 400) return false;
  let msg = errorText;
  try {
    const j = JSON.parse(errorText);
    msg = [j?.error?.type, j?.error?.message, j?.message].filter((x) => typeof x === "string").join(" ");
  } catch { /* not JSON: judge the raw text */ }
  if (ACCOUNT_OR_CONFIG.test(msg)) return false;
  return FILE_CAUSE.test(msg);
}
