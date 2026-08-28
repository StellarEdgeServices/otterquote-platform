// [#1313 Part A, 2026-08-28] The three things that stood between a real
// contractor and `auto_validated`, plus the two artifacts that remove the work
// entirely.
//
// Found by running onboarding with real documents from Mitchel Dotson /
// Indy Rooftops, LLC — the launch contractor named in D-280. His actual
// contract scored 0 of 12 required v3 markers, and what he uploaded was not a
// template at all: a filled sample proposal made out to himself, $544.78, five
// of its twelve pages itemising his own house. The onboarding copy asked for
// "your contract" and he answered the question he was asked.
//
// The validator counted tags, so a tagless filled proposal and a tagless blank
// template failed identically, with a message that named neither problem.
// Worse: a filled proposal that DID carry the tags would sail through, and
// create-docusign-envelope attaches Document 1 verbatim — a homeowner asked to
// sign a contract naming a different customer, a different property and a
// different price.
//
// Everything here is pure and unit-tested. Nothing in this file reads the
// network, the database or the environment.
//
// A NOTE ON WHAT WE WILL AND WILL NOT WRITE, because it constrains the design.
// Dustin, 2026-08-27, verbatim: "I don't want us adding the right to cancel,
// the notice of cancellation form, the platform disclosure, or the down payment
// cap. We shouldn't be adding terms to their contracts. We shouldn't have our
// name on their contract. But we also aren't taking terms out, either."
//
// So the starter carries NO substantive terms. It carries the execution page —
// the signature lines and the fields the platform auto-fills, all of which
// already exist in any contract — plus clearly-marked EMPTY blocks the
// contractor replaces with his own terms and his own Notice of Cancellation.
// We check that the notice is present; we never supply its words. That
// requirement is live: IC 24-5-11-10 requires the notice be furnished, and
// Indy Rooftops' own T&C section 11 cites "the attached Notice of
// Cancellation" — which, since C1 retired our Document 3, nothing else in the
// envelope carries.

import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

// ─────────────────────────────────────────────────────────────────────────────
// Human copy for every field id in the v3 manifest.
//
// The validator has always known exactly which markers were missing. What it
// returned was the raw tag string — `{{text|1|*|Customer Name|customer_name}}`
// — which tells a roofer nothing about what to do. This table is what turns
// "MISSING customer_name" into a sentence a person can act on.
export interface FieldGuideEntry {
  /** What a contractor would call this. */
  name: string;
  /** Where in his document it belongs. */
  where: string;
  /** Why the platform needs it — never "because the validator says so". */
  why: string;
}

export const FIELD_GUIDE: Record<string, FieldGuideEntry> = {
  homeowner_signature: {
    name: "Homeowner signature line",
    where: "On your signature page, next to the homeowner's printed name.",
    why: "This is where the homeowner actually signs. Without it the contract cannot be executed.",
  },
  homeowner_signature_date: {
    name: "Homeowner signature date",
    where: "Beside the homeowner's signature line.",
    why: "Indiana's three-day right to cancel runs from the date the homeowner signs, so the date has to be captured on the document.",
  },
  contractor_signature: {
    name: "Your signature line",
    where: "On your signature page, next to your printed name.",
    why: "This is where you sign. It is filled in first, before the homeowner ever sees the document.",
  },
  contractor_signature_date: {
    name: "Your signature date",
    where: "Beside your signature line.",
    why: "Records when you executed the agreement.",
  },
  customer_name: {
    name: "Customer name",
    where: "In the header block where you write who the contract is with.",
    why: "Filled automatically from the accepted bid, so you never retype it and it can never disagree with the job.",
  },
  customer_address: {
    name: "Property address",
    where: "In the header block, on the job-address line.",
    why: "Filled automatically from the claim. This is the property the work is performed on.",
  },
  contract_price: {
    name: "Total contract price",
    where: "Wherever your agreement states the total amount.",
    why: "Filled automatically from the bid the homeowner accepted. This is the single most important field on the document: if it is typed by hand it can disagree with what the homeowner agreed to.",
  },
  job_description: {
    name: "Job description",
    where: "In your scope-of-work section. A single line is enough - the detail lives in Exhibit A.",
    why: "Filled automatically, and points at the Scope of Work exhibit attached to the same envelope.",
  },
  material_type: {
    name: "Shingle product / brand",
    where: "In your materials section.",
    why: "Filled from your bid, so the product the homeowner was quoted is the product named in the contract.",
  },
  estimated_start: {
    name: "Estimated start date",
    where: "In your scheduling section.",
    why: "Filled from your bid.",
  },
  decking_per_sheet: {
    name: "Decking replacement price per sheet",
    where: "With your other contingency pricing.",
    why: "Filled from your bid. Concealed decking rot is the most common change order on a roof; stating the rate up front is what keeps it from becoming an argument.",
  },
  insurance_company: {
    name: "Insurance carrier",
    where: "In the header block of your insurance agreement.",
    why: "Filled automatically from the claim.",
  },
  claim_number: {
    name: "Carrier claim number",
    where: "In the header block of your insurance agreement.",
    why: "Filled automatically from the claim.",
  },
  deductible: {
    name: "Homeowner deductible",
    where: "Wherever your agreement states the homeowner's out-of-pocket amount.",
    why: "Filled automatically from the claim.",
  },
  gutter_linear_feet: {
    name: "Gutter linear footage",
    where: "In your quantities section.",
    why: "Filled from your bid.",
  },
  gutter_size: {
    name: "Gutter size",
    where: "In your materials section.",
    why: "Filled from your bid.",
  },
  window_count: {
    name: "Window count",
    where: "In your quantities section.",
    why: "Filled from your bid.",
  },
};

// Label-text markers carry no BoldSign meaning — they are proof that required
// boilerplate exists in the document. They need their own copy, because
// "add this exact text" is a different instruction from "add this tag".
export const LABEL_GUIDE: Record<string, FieldGuideEntry> = {
  "Manufacturer's Warranty:": {
    name: "Manufacturer's warranty label",
    where: "In your warranty section, as a label followed by the warranty you offer.",
    why: "The manufacturer warranty you selected is a term of the contract, so the contract has to have somewhere to state it.",
  },
  "Workmanship Warranty:": {
    name: "Workmanship warranty label",
    where: "In your warranty section, as a label followed by the number of years.",
    why: "Your own labor warranty is a term of the contract and a selling point. It needs a stated home.",
  },
  "Siding Product:": {
    name: "Siding product label",
    where: "In your materials section.",
    why: "The siding product quoted is a material commitment.",
  },
  "Wall Substrate:": {
    name: "Wall substrate label",
    where: "With your contingency pricing.",
    why: "Rotten sheathing found behind siding is the siding equivalent of bad decking. The rate belongs in the contract.",
  },
};

export interface ManifestRequirement {
  anchor: string;
  mechanism: "boldsign_tag" | "label_text";
  field: string;
  tabType: string;
  source: string;
}

export interface MissingMarker {
  anchor: string;
  mechanism: string;
  /** The v3 field id, parsed out of the tag. Null for label_text markers. */
  fieldId: string | null;
  name: string;
  where: string;
  why: string;
  /** Exactly what to put in the document, ready to copy. */
  example: string;
  /** How to add it, in one sentence. */
  howTo: string;
}

/** Pull the FieldID out of `{{type|idx|req|Label|FieldID}}`. */
export function fieldIdFromTag(anchor: string): string | null {
  const m = /^\{\{[^|]+\|[^|]*\|[^|]*\|[^|]*\|([^}|]+)\}\}$/.exec(String(anchor).trim());
  return m ? m[1] : null;
}

/**
 * Turn the validator's own per-anchor results into instructions.
 *
 * The validator already knew all of this. It just never said it: the UI
 * rendered the raw anchor string with a red cross beside it, which is a
 * description of the failure and not of the fix.
 */
export function describeMissingMarkers(
  anchors: Array<{ anchor: string; mechanism: string; found: boolean; field?: string }>,
): MissingMarker[] {
  const out: MissingMarker[] = [];
  for (const a of anchors) {
    if (a.found) continue;
    const fieldId = a.mechanism === "boldsign_tag" ? fieldIdFromTag(a.anchor) : null;
    const guide = (fieldId && FIELD_GUIDE[fieldId]) || LABEL_GUIDE[a.anchor] || null;
    out.push({
      anchor: a.anchor,
      mechanism: a.mechanism,
      fieldId,
      name: guide?.name || a.field || a.anchor,
      where: guide?.where || "Anywhere in the document body.",
      why: guide?.why || "Required by the roofing/siding contract manifest for this slot.",
      example: a.anchor,
      howTo: a.mechanism === "boldsign_tag"
        ? "Type this exactly, on one line, with nothing between the braces and no line break inside it. It disappears when the document is sent and becomes the fill-in field."
        : "The document must contain this exact text, including the colon.",
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filled-proposal detection.
//
// "A dollar total, a named customer, or a street address in the body means it
// is almost certainly a filled proposal" (#1313). Each of those alone produces
// false positives on a legitimate blank template — a blank contract has the
// contractor's OWN letterhead address, and may print "$" beside an empty rule.
// So each signal is reported separately with the text that triggered it, the
// contractor's own address is excluded by name, and the result is a WARNING
// with its reasons shown, never a silent fail.
//
// This is deliberately a warning and not a rejection: the cost of blocking a
// legitimate template is a contractor who cannot onboard at all, and the cost
// of a missed filled proposal is a warning he reads and ignores. Only the tag
// count decides `auto_validated`.
export interface ProposalSignal {
  kind: "money" | "address" | "customer" | "quantities";
  detail: string;
  sample: string;
}

export interface FilledProposalVerdict {
  detected: boolean;
  signals: ProposalSignal[];
}

const MONEY_RE = /\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$\s?\d+\.\d{2}/g;
const STREET_RE =
  /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][A-Za-z'.-]*\s+){0,3}(?:County\s+Road|CR|Road|Rd|Street|St|Avenue|Ave|Drive|Dr|Lane|Ln|Court|Ct|Boulevard|Blvd|Way|Circle|Cir|Place|Pl|Terrace|Ter|Trail|Trl|Highway|Hwy|Parkway|Pkwy)\b\.?/g;
const TOTAL_RE = /\b(?:Grand\s+Total|Total\s+Due|Contract\s+Total|Total)\b[^\n]{0,40}?\$\s?\d/i;

function norm(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function detectFilledProposal(
  pdfText: string,
  own: { companyName?: string | null; addressLine1?: string | null; addressCity?: string | null } = {},
): FilledProposalVerdict {
  const text = String(pdfText || "");
  const signals: ProposalSignal[] = [];

  // 1. Real money amounts. A blank template writes "$______" or "$ /sheet";
  //    a filled proposal writes $544.78. Two or more distinct amounts is the
  //    bar, because one stray figure is often a printed fee schedule.
  const amounts = Array.from(new Set((text.match(MONEY_RE) || []).map((s) => s.replace(/\s/g, ""))));
  if (amounts.length >= 2) {
    signals.push({
      kind: "money",
      detail: `${amounts.length} filled-in dollar amounts appear in the document. A blank template normally has empty lines here.`,
      sample: amounts.slice(0, 5).join(", "),
    });
  }

  // 2. A stated total. Much stronger than a loose amount.
  const totalHit = TOTAL_RE.exec(text);
  if (totalHit) {
    signals.push({
      kind: "money",
      detail: "The document states a contract total. A template should have an empty total.",
      sample: totalHit[0].trim().slice(0, 80),
    });
  }

  // 3. A street address that is NOT the contractor's own. His letterhead
  //    address is expected and must not trip this, which is why the caller
  //    passes it in rather than this function guessing.
  const ownNorm = [own.addressLine1, own.addressCity].filter(Boolean).map((s) => norm(String(s)));
  const addresses = Array.from(new Set(text.match(STREET_RE) || []))
    .map((s) => s.trim())
    // Bidirectional on purpose. The street regex stops at the street-type
    // token, so a hit reads "5001 N County Road" while the contractor's stored
    // address reads "5001 N County Road 1000 E" - a one-way `includes` misses
    // that and accuses him of his own letterhead. Caught by running it.
    .filter((s) => !ownNorm.some((o) => {
      const n = norm(s);
      return o.length > 4 && n.length > 4 && (n.includes(o) || o.includes(n));
    }));
  if (addresses.length > 0) {
    signals.push({
      kind: "address",
      detail: "A street address appears in the body that is not your business address. A blank template names no property.",
      sample: addresses.slice(0, 3).join(" | "),
    });
  }

  // 4. Itemised quantities. A filled proposal itemises a specific roof; a
  //    blank template does not carry measured numbers.
  const qty = Array.from(new Set(text.match(/\b\d+(?:\.\d+)?\s?(?:SQ|LF|SF|EA)\b/g) || []));
  if (qty.length >= 3) {
    signals.push({
      kind: "quantities",
      detail: `${qty.length} measured quantities appear in the document, which is what a priced proposal for one specific house looks like.`,
      sample: qty.slice(0, 5).join(", "),
    });
  }

  return { detected: signals.length >= 2, signals };
}

/**
 * IC 24-5-11-10 requires the Notice of Cancellation be furnished to the
 * homeowner. Before C1 the platform generated one and appended it as Document
 * 3; Dustin retired that on 2026-08-27 because it is the contractor's term to
 * state, not ours. So it now has to be in HIS template, and Indy Rooftops'
 * T&C section 11 already cites "the attached Notice of Cancellation" — which,
 * as of C1, is attached to nothing.
 *
 * We detect its absence and say so. We never supply its words.
 */
export type CancellationNoticeState = "present" | "placeholder" | "absent";

/** The starter's own instruction block, so it cannot be mistaken for a notice. */
export const NOTICE_PLACEHOLDER_HEAD = "REPLACE THIS BLOCK WITH YOUR NOTICE OF CANCELLATION";

export function cancellationNoticeState(pdfText: string): CancellationNoticeState {
  const text = String(pdfText || "");
  // Order matters. The starter's own placeholder CONTAINS the phrase "Notice
  // of Cancellation", so a bare phrase test reports "present" on an unedited
  // starter and tells a contractor his notice is fine when the document holds
  // an instruction to write one. Caught by running the detector against the
  // starter this same file generates.
  if (text.includes(NOTICE_PLACEHOLDER_HEAD)) return "placeholder";
  return /notice\s+of\s+cancell?ation/i.test(text) ? "present" : "absent";
}

/** Back-compat shim: true only when a real notice is present. */
export function hasCancellationNotice(pdfText: string): boolean {
  return cancellationNoticeState(pdfText) === "present";
}

// ─────────────────────────────────────────────────────────────────────────────
// The pre-tagged execution page.
//
// Generated FROM the manifest rather than kept beside it as a static file, so
// the starter and the validator can never drift: every marker the validator
// requires is drawn by walking the same array the validator scans.
//
// Tags are drawn in white, exactly as create-docusign-envelope draws its own,
// so the page reads as an ordinary signature block on paper and BoldSign's
// UseTextTags parser still finds them. Each has a visible human label and its
// own ruled line, which is the #1314 lesson: a signature box drawn on top of a
// heading and identified as nothing at all is worse than no field.

export interface StarterOptions {
  trade: string;
  fundingType: string;
  requirements: ManifestRequirement[];
  companyName?: string | null;
  /** true = a standalone blank template (adds the two empty terms blocks). */
  standalone: boolean;
  manifestVersion: string;
}

const PAGE_W = 612;
const PAGE_H = 792;
const LEFT = 54;
const RIGHT = 558;

export async function buildExecutionPagePdf(opts: StarterOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const grey = rgb(0.42, 0.45, 0.5);
  const white = rgb(1, 1, 1);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - 60;

  const nl = (n: number) => { y -= n; if (y < 70) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - 60; } };
  const text = (s: string, x: number, size: number, f = font, color = black) =>
    page.drawText(s, { x, y, size, font: f, color });
  const rule = (x1: number, x2: number, dy = 0) =>
    page.drawLine({ start: { x: x1, y: y + dy }, end: { x: x2, y: y + dy }, thickness: 0.7, color: rgb(0.6, 0.63, 0.68) });
  const wrap = (s: string, size: number, maxWidth: number): string[] => {
    const words = String(s).split(" ");
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const next = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(next, size) > maxWidth && line) { lines.push(line); line = w; }
      else line = next;
    }
    if (line) lines.push(line);
    return lines;
  };
  const para = (s: string, size: number, color = grey) => {
    for (const ln of wrap(s, size, RIGHT - LEFT)) { text(ln, LEFT, size, font, color); nl(size * 1.45); }
  };

  const tradeLabel = opts.trade.charAt(0).toUpperCase() + opts.trade.slice(1);
  const fundingLabel = opts.fundingType === "insurance" ? "Insurance" : "Retail";

  // ---- Header ----
  text(opts.standalone ? "CONTRACT TEMPLATE" : "CONTRACT EXECUTION PAGE", LEFT, 18, bold);
  nl(22);
  text(`${tradeLabel} - ${fundingLabel}`, LEFT, 11, bold, grey);
  nl(16);
  para(
    opts.standalone
      ? "This is a starter template. It carries the signature block and the fields Otter Quotes fills in automatically, and nothing else. The terms of the agreement are yours: replace the two marked blocks below with your own contract language before you upload it. Otter Quotes does not supply contract terms and is not a party to your agreement."
      : "This page was added to your own contract by Otter Quotes so that the fields below can be filled in automatically and signed electronically. It adds no terms to your agreement. Your contract, as you wrote it, is unchanged and governs.",
    8.5,
  );
  nl(6);
  rule(LEFT, RIGHT);
  nl(20);

  // ---- Auto-filled fields ----
  text("FILLED IN AUTOMATICALLY", LEFT, 11, bold);
  nl(12);
  para("You do not type any of these. They come from the bid the homeowner accepted, which is what stops the contract from ever stating a price the homeowner did not agree to.", 8);
  nl(8);

  const tagReqs = opts.requirements.filter((r) => r.mechanism === "boldsign_tag");
  const signatureIds = new Set([
    "homeowner_signature", "homeowner_signature_date",
    "contractor_signature", "contractor_signature_date",
  ]);
  const dataReqs = tagReqs.filter((r) => !signatureIds.has(fieldIdFromTag(r.anchor) || ""));
  const sigReqs = tagReqs.filter((r) => signatureIds.has(fieldIdFromTag(r.anchor) || ""));

  for (const r of dataReqs) {
    const id = fieldIdFromTag(r.anchor) || r.field;
    const g = FIELD_GUIDE[id] || null;
    if (y < 110) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - 60; }
    const label = (g?.name || r.field) + ":";
    text(label, LEFT, 9.5, bold);
    // Start the rule AFTER the label rather than at a fixed 210pt. "Decking
    // replacement price per sheet:" is 216pt wide at 9.5pt bold and struck
    // through the line on the first render.
    const ruleX = Math.max(210, LEFT + bold.widthOfTextAtSize(label, 9.5) + 12);
    rule(ruleX, RIGHT, -2);
    // The tag itself, invisible, on its own contiguous single-line run.
    page.drawText(r.anchor, { x: ruleX + 4, y, size: 7, font, color: white });
    nl(20);
  }

  nl(4);
  rule(LEFT, RIGHT);
  nl(18);

  // ---- Label-text markers the contractor must state himself ----
  const labelReqs = opts.requirements.filter((r) => r.mechanism === "label_text");
  if (labelReqs.length > 0) {
    text("YOU STATE THESE", LEFT, 11, bold);
    nl(12);
    para("These are your terms, not ours. The label has to appear in the document; what follows it is yours to write.", 8);
    nl(6);
    for (const r of labelReqs) {
      if (y < 100) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - 60; }
      text(r.anchor, LEFT, 9.5, bold);
      rule(Math.max(210, LEFT + bold.widthOfTextAtSize(r.anchor, 9.5) + 12), RIGHT, -2);
      nl(20);
    }
    nl(4);
    rule(LEFT, RIGHT);
    nl(18);
  }

  // ---- Your terms / your notice (standalone only) ----
  if (opts.standalone) {
    for (const block of [
      {
        head: "REPLACE THIS BLOCK WITH YOUR TERMS AND CONDITIONS",
        body: "Paste your own contract terms here. Otter Quotes does not write contract terms and does not add any to your agreement. Whatever you put here is what the homeowner agrees to.",
      },
      {
        head: "REPLACE THIS BLOCK WITH YOUR NOTICE OF CANCELLATION",
        body: "Indiana Code 24-5-11-10 requires that a Notice of Cancellation be furnished to the homeowner with a home improvement contract. Otter Quotes does not supply one - it is a term of your agreement, and many contracts already reference \"the attached Notice of Cancellation\" in their terms. Put yours here so the document the homeowner signs actually contains the notice your terms point at. If you do not have one, your attorney should give you the form; this is the one block on this page you should not leave empty.",
      },
    ]) {
      if (y < 190) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - 60; }
      const lines = wrap(block.body, 8.5, RIGHT - LEFT - 24);
      const boxH = 26 + lines.length * 12 + 60;
      page.drawRectangle({
        x: LEFT, y: y - boxH + 14, width: RIGHT - LEFT, height: boxH,
        borderColor: rgb(0.85, 0.45, 0), borderWidth: 1, color: rgb(1, 0.98, 0.94),
      });
      text(block.head, LEFT + 12, 9.5, bold, rgb(0.72, 0.36, 0));
      nl(15);
      for (const ln of lines) { text(ln, LEFT + 12, 8.5, font, grey); nl(12); }
      nl(74); // clear the box, then leave a gap before the next one
    }
    nl(8);
  }

  // ---- Signature block ----
  if (y < 200) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - 60; }
  text("SIGNATURES", LEFT, 11, bold);
  nl(16);
  const sigOrder = [
    { id: "contractor_signature", label: "Contractor signature" },
    { id: "contractor_signature_date", label: "Date" },
    { id: "homeowner_signature", label: "Homeowner signature" },
    { id: "homeowner_signature_date", label: "Date" },
  ];
  for (const s of sigOrder) {
    const req = sigReqs.find((r) => fieldIdFromTag(r.anchor) === s.id);
    if (!req) continue;
    const sLabel = s.label + ":";
    text(sLabel, LEFT, 9.5, bold);
    const sx = Math.max(210, LEFT + bold.widthOfTextAtSize(sLabel, 9.5) + 12);
    rule(sx, s.id.endsWith("_date") ? Math.max(sx + 150, 380) : RIGHT, -2);
    page.drawText(req.anchor, { x: sx + 4, y, size: 7, font, color: white });
    nl(28);
  }
  if (opts.companyName) {
    nl(6);
    text(`Contractor: ${opts.companyName}`, LEFT, 9, font, grey);
    nl(14);
  }
  nl(10);
  text(
    `Otter Quotes field scaffold - ${opts.trade}/${opts.fundingType} - manifest ${opts.manifestVersion}. Fields only; no contract terms.`,
    LEFT, 7, font, grey,
  );

  return await doc.save();
}

/**
 * The assisted path: take the contractor's own PDF and return it with a tagged
 * execution page appended. Doing this by hand for Indy Rooftops took about
 * twenty minutes; this is that, without the human.
 *
 * His pages are copied byte-for-byte. Nothing of his is edited, reordered or
 * removed — "we also aren't taking terms out, either."
 */
export async function appendExecutionPage(
  contractorPdf: Uint8Array,
  opts: Omit<StarterOptions, "standalone">,
): Promise<Uint8Array> {
  const src = await PDFDocument.load(contractorPdf, { ignoreEncryption: true });
  const exec = await PDFDocument.load(await buildExecutionPagePdf({ ...opts, standalone: false }));
  const out = await PDFDocument.create();
  const srcPages = await out.copyPages(src, src.getPageIndices());
  for (const p of srcPages) out.addPage(p);
  const execPages = await out.copyPages(exec, exec.getPageIndices());
  for (const p of execPages) out.addPage(p);
  return await out.save();
}
