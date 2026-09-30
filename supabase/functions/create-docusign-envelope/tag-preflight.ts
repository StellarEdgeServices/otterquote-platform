// gh-1314: send-time guard. BoldSign accepts POST /v1/document/send for a PDF whose sign/init/date
// Text Tag carries a label (position 4), returns 201 + a documentId, then fails document creation
// permanently and silently: an unsignable, unrevocable, billable corpse plus a dead pointer on the
// quote and claim. Refuse BEFORE the send instead. See boldsign-tag-lint.ts for the measured rule.
//
// Pure with respect to IO: the PDF text extractor is injected so the unit test needs no pdfjs.
import { describeLabeledSignTags, findLabeledSignTags, type LabeledTagViolation } from "./boldsign-tag-lint.ts";

export const LABELED_SIGN_TAG_CODE = "TEMPLATE_LABELED_SIGN_TAG";

/** Thrown before /v1/document/send. Nothing has been sent, so nothing needs un-recording. */
export class LabeledSignTagError extends Error {
  statusCode = 422;
  code = LABELED_SIGN_TAG_CODE;
  violations: LabeledTagViolation[];
  constructor(violations: LabeledTagViolation[], context: string) {
    super(
      `${context}: refusing to send to BoldSign. ${violations.length} sign/init/date tag(s) carry a label ` +
      `in position 4, which BoldSign accepts and then silently fails to build (the document could never ` +
      `be signed or revoked). Fix the template: ${describeLabeledSignTags(violations)}`,
    );
    this.name = "LabeledSignTagError";
    this.violations = violations;
  }
}

/** Throws LabeledSignTagError when `text` holds any sign/init/date tag with a non-empty label. */
export function assertNoLabeledSignTags(text: string, context: string): void {
  const violations = findLabeledSignTags(text);
  if (violations.length > 0) throw new LabeledSignTagError(violations, context);
}

export type PdfTextExtractor = (bytes: Uint8Array) => Promise<string>;

/** Default extractor. Dynamic import so pdfjs is only loaded when a send actually needs it. */
const defaultExtractor: PdfTextExtractor = async (bytes) => {
  const { extractPdfText } = await import("./pdf-text.ts");
  return await extractPdfText(bytes);
};

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Extract the template PDF's text and refuse a labeled sign/init/date tag.
 *
 * If the text cannot be extracted the send is NOT blocked: the same PDF already passed
 * validate-contract-template's extraction at upload, and blocking every signing on a pdfjs quirk
 * would trade one outage for another. The failure is logged loudly instead. The guard's job is to
 * stop a KNOWN-bad tag, and it cannot know without text.
 */
export async function preflightTemplateTags(
  templateBase64: string,
  context: string,
  extract: PdfTextExtractor = defaultExtractor,
): Promise<{ scanned: boolean }> {
  let text: string;
  try {
    text = await extract(base64ToBytes(templateBase64));
  } catch (e) {
    console.error(`gh-1314: tag preflight could not extract text for ${context}; sending WITHOUT the labeled-tag check: ${String(e)}`);
    return { scanned: false };
  }
  assertNoLabeledSignTags(text, context);
  return { scanned: true };
}
