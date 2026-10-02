// _shared/boldsign-tag-lint.ts — detect BoldSign Text Tags that BoldSign cannot create.
// gh-1314 (root cause measured 2026-09-30, comment 5912190043), same class as gh-1244's `init` finding.
//
// THE RULE. A `sign`, `init` or `date` Text Tag must carry an EMPTY Label
// (position 4):   {{sign|1|*||contractor_signature}}      works (readable ~8 s)
//                 {{sign|1|*|Contractor Signature|contractor_signature}}   FAILS
// When one is present, POST /v1/document/send still returns 201 + a documentId, then background
// creation fails permanently and silently: the document 403s on /properties forever, is in no
// /document/list status, and cannot be revoked. A labeled `text` tag is fine. Measured negative
// controls: labeled sign only, labeled date only, a label with no spaces ("Signature") and a 4-part
// tag with the id in position 4 all failed; empty-label sign/date passed beside them.
//
// Deliberately strict: ANY character in position 4 (including whitespace) is a violation. Only the
// empty form was measured to work, so it is the only form accepted.
//
// ── CANONICAL COPY. Consumers carry a byte-identical sibling copy ─────────────
// Same constraint and precedent as _shared/template-validity.ts:
//   create-docusign-envelope/boldsign-tag-lint.ts
//   validate-contract-template/boldsign-tag-lint.ts
// _shared/boldsign-tag-lint.test.ts asserts every copy is byte-identical to this file;
// edit HERE and copy, never edit a sibling.
//
// Pure. No IO, no Deno globals.

/** Tag types whose Label (position 4) MUST be empty. */
export const EMPTY_LABEL_TAG_TYPES = ["sign", "init", "date"] as const;

export interface LabeledTagViolation {
  /** The offending tag exactly as it appears in the document text. */
  tag: string;
  type: string;
  signerIndex: string;
  required: string;
  /** The non-empty position-4 content. */
  label: string;
  fieldId: string | null;
  /** The same tag with an empty label, which is what BoldSign can create. */
  fixedTag: string;
  message: string;
}

const TAG_RE = /\{\{\s*(sign|init|date)\s*\|([^{}]*)\}\}/gi;

/** Fold characters PDF text extraction commonly substitutes, so a tag is still recognised. */
function fold(text: string): string {
  return text.replace(/ /g, " ");
}

/**
 * Every sign/init/date tag in `text` whose position 4 is non-empty. Text tags (`text`, etc.) are
 * ignored: BoldSign accepts a Label on those.
 */
export function findLabeledSignTags(text: string): LabeledTagViolation[] {
  const out: LabeledTagViolation[] = [];
  const src = fold(String(text ?? ""));
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(src)) !== null) {
    const type = m[1].toLowerCase();
    const rest = m[2].split("|"); // [signerIndex, required, position4, fieldId, ...]
    if (rest.length < 3) continue; // fewer than 4 parts: no position 4 present
    const pos4 = rest[2];
    if (pos4.length === 0) continue;
    const signerIndex = rest[0];
    const required = rest[1];
    // 4-part form ({{sign|1|*|id}}): position 4 IS the id, so the fixed tag keeps it as the id.
    const fieldId = rest.length >= 4 ? rest[3] : pos4;
    const fixedTag = `{{${type}|${signerIndex}|${required}||${fieldId}}}`;
    out.push({
      tag: m[0],
      type,
      signerIndex,
      required,
      label: pos4,
      fieldId: fieldId || null,
      fixedTag,
      message:
        `${m[0]} has the label "${pos4}" in position 4. BoldSign cannot create a document from a ` +
        `${type} tag with a label. Remove the label and leave position 4 empty: ${fixedTag}`,
    });
  }
  return out;
}

/** One human-readable line per violation, or "" when there are none. */
export function describeLabeledSignTags(violations: LabeledTagViolation[]): string {
  return violations.map((v) => v.message).join(" | ");
}
