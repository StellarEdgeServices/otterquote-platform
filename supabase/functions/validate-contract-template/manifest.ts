// validate-contract-template/manifest.ts — the D-199/D-274 anchor manifest and
// the pure text-scan that turns an extracted PDF's text into a validation_result
// `anchors` array.
//
// [gh-1315 / RUN 23] Lifted out of index.ts so that (a) revalidate-contract-templates
// can re-run the exact same scan against every stored template without importing
// a module whose top level calls Deno.serve, and (b) the manifest version has one
// source (CURRENT_TEMPLATE_MANIFEST_VERSION in _shared/template-validity.ts) that
// the validator, the invariant readers and the tests all share. No IO here.
//
// Everything below the imports is byte-for-byte the manifest that lived in
// index.ts (D-274 build, 2026-08-13); see index.ts's file header for the
// BoldSign Text Tag rationale and the SignerIndex coupling note.

// deno-lint-ignore-file no-explicit-any
import { CURRENT_TEMPLATE_MANIFEST_VERSION } from "./template-validity.ts";

// ─────────────────────────────────────────────────────────────────────────────
// BoldSign Text Tag builder — matches the syntax create-docusign-envelope's
// PDF generators (and, per this manifest, contractor-authored templates) must
// use: `{{FieldType|SignerIndex|Required|FieldLabel|FieldID}}`. FieldType tokens
// are the 7 documented at developers.boldsign.com/text-tags/supported-fields/:
// text, sign, init, date, editdate, title, company. Required is "*" or a
// single space (not-required) per the same page.
export function tag(fieldType: "text" | "sign" | "init" | "date", signerIndex: 1 | 2, required: boolean, label: string, fieldId: string): string {
  return `{{${fieldType}|${signerIndex}|${required ? "*" : " "}|${label}|${fieldId}}}`;
}
export const CONTRACTOR_IDX = 1; // Signers[0] in handleContractorSign — see file header coupling note.
export const HOMEOWNER_IDX = 2; // Signers[1] in handleContractorSign.

// ─────────────────────────────────────────────────────────────────────────────
// v3 anchor manifest (APPROVED scope per D-274 #631 build; supersedes the v2
// DocuSign-anchor manifest APPROVED April 30, 2026). Same trades, same funding
// types, same required/optional field SET as v2 — only the `anchor` value and
// `mechanism` are new. Do NOT fetch at runtime (avoid IO dependency).
export const MANIFEST: any = {
  version: CURRENT_TEMPLATE_MANIFEST_VERSION,
  approvedDate: "2026-08-13",
  decision: "D-274",
  supersedes: "v2 (D-199, 2026-04-30) — DocuSign anchorString grammar retired, see file header",
  anchorOptions: { caseSensitive: true },
  trades: {
    roofing: {
      retail: {
        slot: "roofing/retail",
        requiredCount: 13,
        required: [
          { anchor: tag("sign", HOMEOWNER_IDX, true, "Homeowner Signature", "homeowner_signature"), mechanism: "boldsign_tag", field: "Homeowner signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", HOMEOWNER_IDX, true, "Homeowner Sign Date", "homeowner_signature_date"), mechanism: "boldsign_tag", field: "Homeowner sign date", tabType: "date", source: "HICA" },
          { anchor: tag("sign", CONTRACTOR_IDX, true, "Contractor Signature", "contractor_signature"), mechanism: "boldsign_tag", field: "Contractor signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", CONTRACTOR_IDX, true, "Contractor Sign Date", "contractor_signature_date"), mechanism: "boldsign_tag", field: "Contractor sign date", tabType: "date", source: "HICA" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Customer Name", "customer_name"), mechanism: "boldsign_tag", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Property Address", "customer_address"), mechanism: "boldsign_tag", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Contract Price", "contract_price"), mechanism: "boldsign_tag", field: "Total contract amount", tabType: "text", source: "Financial term" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Job Description", "job_description"), mechanism: "boldsign_tag", field: "Job description / See Exhibit A", tabType: "text", source: "Scope reference (D-186)" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Material Type", "material_type"), mechanism: "boldsign_tag", field: "Shingle product/brand", tabType: "text", source: "Material commitment" },
          { anchor: "Manufacturer's Warranty:", mechanism: "label_text", field: "Auto-filled from D-202 manifest", tabType: "text", source: "D-202" },
          { anchor: "Workmanship Warranty:", mechanism: "label_text", field: "Contractor workmanship years", tabType: "text", source: "Workmanship commitment" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Decking Per Sheet", "decking_per_sheet"), mechanism: "boldsign_tag", field: "Per-sheet decking replacement price", tabType: "text", source: "Roofing contingency" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Start Date", "estimated_start"), mechanism: "boldsign_tag", field: "Estimated start date", tabType: "text", source: "Scheduling commitment" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Single Manufacture", "Shingle Type:", "Shingle Color:", "Drip Edge Color:", "Vents", "Satellite", "Skylights", "Full Redeck:", "Permit Fee:", "Dumpster Fee:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Structures:", "Structure Names:", "Valley Type:", "Bad Decking:", "Project Notes:"],
      },
      insurance: {
        slot: "roofing/insurance",
        requiredCount: 14,
        required: [
          { anchor: tag("sign", HOMEOWNER_IDX, true, "Homeowner Signature", "homeowner_signature"), mechanism: "boldsign_tag", field: "Homeowner signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", HOMEOWNER_IDX, true, "Homeowner Sign Date", "homeowner_signature_date"), mechanism: "boldsign_tag", field: "Homeowner sign date", tabType: "date", source: "HICA" },
          { anchor: tag("sign", CONTRACTOR_IDX, true, "Contractor Signature", "contractor_signature"), mechanism: "boldsign_tag", field: "Contractor signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", CONTRACTOR_IDX, true, "Contractor Sign Date", "contractor_signature_date"), mechanism: "boldsign_tag", field: "Contractor sign date", tabType: "date", source: "HICA" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Customer Name", "customer_name"), mechanism: "boldsign_tag", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Property Address", "customer_address"), mechanism: "boldsign_tag", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Contract Price", "contract_price"), mechanism: "boldsign_tag", field: "Total contract amount (RCV-based)", tabType: "text", source: "Financial term" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Insurance Company", "insurance_company"), mechanism: "boldsign_tag", field: "Insurance carrier", tabType: "text", source: "Insurance-specific" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Claim Number", "claim_number"), mechanism: "boldsign_tag", field: "Carrier claim number", tabType: "text", source: "Insurance-specific" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Deductible", "deductible"), mechanism: "boldsign_tag", field: "Homeowner deductible amount", tabType: "text", source: "Financial term" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Material Type", "material_type"), mechanism: "boldsign_tag", field: "Shingle product/brand", tabType: "text", source: "Material commitment" },
          { anchor: "Manufacturer's Warranty:", mechanism: "label_text", field: "Auto-filled from D-202 manifest", tabType: "text", source: "D-202" },
          { anchor: "Workmanship Warranty:", mechanism: "label_text", field: "Contractor workmanship years", tabType: "text", source: "Workmanship commitment" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Decking Per Sheet", "decking_per_sheet"), mechanism: "boldsign_tag", field: "Per-sheet decking replacement price", tabType: "text", source: "Roofing contingency" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Single Manufacture", "Shingle Type:", "Shingle Color:", "Drip Edge Color:", "Vents", "Satellite", "Skylights", "Full Redeck:", "Permit Fee:", "Dumpster Fee:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Structures:", "Structure Names:", "Valley Type:", "Bad Decking:", "Project Notes:", "Non-Recoverable Dep:", "Work Not Done:", "Description:"],
      },
    },
    siding: {
      retail: {
        slot: "siding/retail",
        requiredCount: 13,
        required: [
          { anchor: tag("sign", HOMEOWNER_IDX, true, "Homeowner Signature", "homeowner_signature"), mechanism: "boldsign_tag", field: "Homeowner signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", HOMEOWNER_IDX, true, "Homeowner Sign Date", "homeowner_signature_date"), mechanism: "boldsign_tag", field: "Homeowner sign date", tabType: "date", source: "HICA" },
          { anchor: tag("sign", CONTRACTOR_IDX, true, "Contractor Signature", "contractor_signature"), mechanism: "boldsign_tag", field: "Contractor signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", CONTRACTOR_IDX, true, "Contractor Sign Date", "contractor_signature_date"), mechanism: "boldsign_tag", field: "Contractor sign date", tabType: "date", source: "HICA" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Customer Name", "customer_name"), mechanism: "boldsign_tag", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Property Address", "customer_address"), mechanism: "boldsign_tag", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Contract Price", "contract_price"), mechanism: "boldsign_tag", field: "Total contract amount", tabType: "text", source: "Financial term" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Job Description", "job_description"), mechanism: "boldsign_tag", field: "Job description / See Exhibit A", tabType: "text", source: "Scope reference (D-186)" },
          { anchor: "Siding Product:", mechanism: "label_text", field: "Siding product/brand", tabType: "text", source: "Material commitment" },
          { anchor: "Manufacturer's Warranty:", mechanism: "label_text", field: "Auto-filled from D-202 manifest", tabType: "text", source: "D-202" },
          { anchor: "Workmanship Warranty:", mechanism: "label_text", field: "Contractor workmanship years", tabType: "text", source: "Workmanship commitment" },
          { anchor: "Wall Substrate:", mechanism: "label_text", field: "Per-sheet sheathing replacement contingency", tabType: "text", source: "Siding contingency" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Start Date", "estimated_start"), mechanism: "boldsign_tag", field: "Estimated start date", tabType: "text", source: "Scheduling commitment" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Siding Color:", "Siding Profile:", "Trim Color:", "Trim Material:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Project Notes:"],
      },
      insurance: {
        slot: "siding/insurance",
        requiredCount: 14,
        required: [
          { anchor: tag("sign", HOMEOWNER_IDX, true, "Homeowner Signature", "homeowner_signature"), mechanism: "boldsign_tag", field: "Homeowner signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", HOMEOWNER_IDX, true, "Homeowner Sign Date", "homeowner_signature_date"), mechanism: "boldsign_tag", field: "Homeowner sign date", tabType: "date", source: "HICA" },
          { anchor: tag("sign", CONTRACTOR_IDX, true, "Contractor Signature", "contractor_signature"), mechanism: "boldsign_tag", field: "Contractor signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", CONTRACTOR_IDX, true, "Contractor Sign Date", "contractor_signature_date"), mechanism: "boldsign_tag", field: "Contractor sign date", tabType: "date", source: "HICA" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Customer Name", "customer_name"), mechanism: "boldsign_tag", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Property Address", "customer_address"), mechanism: "boldsign_tag", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Contract Price", "contract_price"), mechanism: "boldsign_tag", field: "Total contract amount (RCV-based)", tabType: "text", source: "Financial term" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Insurance Company", "insurance_company"), mechanism: "boldsign_tag", field: "Insurance carrier", tabType: "text", source: "Insurance-specific" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Claim Number", "claim_number"), mechanism: "boldsign_tag", field: "Carrier claim number", tabType: "text", source: "Insurance-specific" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Deductible", "deductible"), mechanism: "boldsign_tag", field: "Homeowner deductible amount", tabType: "text", source: "Financial term" },
          { anchor: "Siding Product:", mechanism: "label_text", field: "Siding product/brand", tabType: "text", source: "Material commitment" },
          { anchor: "Manufacturer's Warranty:", mechanism: "label_text", field: "Auto-filled from D-202 manifest", tabType: "text", source: "D-202" },
          { anchor: "Workmanship Warranty:", mechanism: "label_text", field: "Contractor workmanship years", tabType: "text", source: "Workmanship commitment" },
          { anchor: "Wall Substrate:", mechanism: "label_text", field: "Per-sheet sheathing replacement contingency", tabType: "text", source: "Siding contingency" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Start Date:", "Siding Color:", "Siding Profile:", "Trim Color:", "Trim Material:", "Description:", "Non-Recoverable Dep:", "Work Not Done:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Project Notes:"],
      },
    },
    gutters: {
      retail: {
        slot: "gutters/retail",
        requiredCount: 12,
        required: [
          { anchor: tag("sign", HOMEOWNER_IDX, true, "Homeowner Signature", "homeowner_signature"), mechanism: "boldsign_tag", field: "Homeowner signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", HOMEOWNER_IDX, true, "Homeowner Sign Date", "homeowner_signature_date"), mechanism: "boldsign_tag", field: "Homeowner sign date", tabType: "date", source: "HICA" },
          { anchor: tag("sign", CONTRACTOR_IDX, true, "Contractor Signature", "contractor_signature"), mechanism: "boldsign_tag", field: "Contractor signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", CONTRACTOR_IDX, true, "Contractor Sign Date", "contractor_signature_date"), mechanism: "boldsign_tag", field: "Contractor sign date", tabType: "date", source: "HICA" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Customer Name", "customer_name"), mechanism: "boldsign_tag", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Property Address", "customer_address"), mechanism: "boldsign_tag", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Contract Price", "contract_price"), mechanism: "boldsign_tag", field: "Total contract amount", tabType: "text", source: "Financial term" },
          { anchor: "Linear Feet:", mechanism: "label_text", field: "Gutter run linear footage", tabType: "text", source: "Scope measurement" },
          { anchor: "Gutter Size:", mechanism: "label_text", field: "Gutter size", tabType: "text", source: "Specification" },
          { anchor: "Downspout Count:", mechanism: "label_text", field: "Number of downspouts", tabType: "text", source: "Scope measurement" },
          { anchor: "Manufacturer's Warranty:", mechanism: "label_text", field: "Auto-filled from D-202 manifest", tabType: "text", source: "D-202" },
          { anchor: "Workmanship Warranty:", mechanism: "label_text", field: "Contractor workmanship years", tabType: "text", source: "Workmanship commitment" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Start Date:", "Description:", "Gutter Color:", "Gutter Guards:", "Splash Block Count:", "Hanger Spacing:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Project Notes:"],
      },
      insurance: {
        slot: "gutters/insurance",
        requiredCount: 13,
        required: [
          { anchor: tag("sign", HOMEOWNER_IDX, true, "Homeowner Signature", "homeowner_signature"), mechanism: "boldsign_tag", field: "Homeowner signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", HOMEOWNER_IDX, true, "Homeowner Sign Date", "homeowner_signature_date"), mechanism: "boldsign_tag", field: "Homeowner sign date", tabType: "date", source: "HICA" },
          { anchor: tag("sign", CONTRACTOR_IDX, true, "Contractor Signature", "contractor_signature"), mechanism: "boldsign_tag", field: "Contractor signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", CONTRACTOR_IDX, true, "Contractor Sign Date", "contractor_signature_date"), mechanism: "boldsign_tag", field: "Contractor sign date", tabType: "date", source: "HICA" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Customer Name", "customer_name"), mechanism: "boldsign_tag", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Property Address", "customer_address"), mechanism: "boldsign_tag", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Contract Price", "contract_price"), mechanism: "boldsign_tag", field: "Total contract amount (RCV-based)", tabType: "text", source: "Financial term" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Insurance Company", "insurance_company"), mechanism: "boldsign_tag", field: "Insurance carrier", tabType: "text", source: "Insurance-specific" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Claim Number", "claim_number"), mechanism: "boldsign_tag", field: "Carrier claim number", tabType: "text", source: "Insurance-specific" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Deductible", "deductible"), mechanism: "boldsign_tag", field: "Homeowner deductible amount", tabType: "text", source: "Financial term" },
          { anchor: "Linear Feet:", mechanism: "label_text", field: "Gutter run linear footage", tabType: "text", source: "Scope measurement" },
          { anchor: "Gutter Size:", mechanism: "label_text", field: "Gutter size", tabType: "text", source: "Specification" },
          { anchor: "Downspout Count:", mechanism: "label_text", field: "Number of downspouts", tabType: "text", source: "Scope measurement" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Start Date:", "Manufacturer's Warranty:", "Workmanship Warranty:", "Gutter Color:", "Gutter Guards:", "Splash Block Count:", "Hanger Spacing:", "Description:", "Non-Recoverable Dep:", "Work Not Done:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Project Notes:"],
      },
    },
    windows: {
      retail: {
        slot: "windows/retail",
        requiredCount: 11,
        required: [
          { anchor: tag("sign", HOMEOWNER_IDX, true, "Homeowner Signature", "homeowner_signature"), mechanism: "boldsign_tag", field: "Homeowner signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", HOMEOWNER_IDX, true, "Homeowner Sign Date", "homeowner_signature_date"), mechanism: "boldsign_tag", field: "Homeowner sign date", tabType: "date", source: "HICA" },
          { anchor: tag("sign", CONTRACTOR_IDX, true, "Contractor Signature", "contractor_signature"), mechanism: "boldsign_tag", field: "Contractor signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", CONTRACTOR_IDX, true, "Contractor Sign Date", "contractor_signature_date"), mechanism: "boldsign_tag", field: "Contractor sign date", tabType: "date", source: "HICA" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Customer Name", "customer_name"), mechanism: "boldsign_tag", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Property Address", "customer_address"), mechanism: "boldsign_tag", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Contract Price", "contract_price"), mechanism: "boldsign_tag", field: "Total contract amount", tabType: "text", source: "Financial term" },
          { anchor: "Window Manufacturer:", mechanism: "label_text", field: "Window manufacturer", tabType: "text", source: "Specification" },
          { anchor: "Window Count:", mechanism: "label_text", field: "Number of windows", tabType: "text", source: "Scope measurement" },
          { anchor: "Manufacturer's Warranty:", mechanism: "label_text", field: "Auto-filled from D-202 manifest", tabType: "text", source: "D-202" },
          { anchor: "Workmanship Warranty:", mechanism: "label_text", field: "Contractor workmanship years", tabType: "text", source: "Workmanship commitment" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Start Date:", "Description:", "Window Series:", "Glass Package:", "Frame Color:", "Trim Notes:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Project Notes:"],
      },
      insurance: {
        slot: "windows/insurance",
        requiredCount: 12,
        required: [
          { anchor: tag("sign", HOMEOWNER_IDX, true, "Homeowner Signature", "homeowner_signature"), mechanism: "boldsign_tag", field: "Homeowner signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", HOMEOWNER_IDX, true, "Homeowner Sign Date", "homeowner_signature_date"), mechanism: "boldsign_tag", field: "Homeowner sign date", tabType: "date", source: "HICA" },
          { anchor: tag("sign", CONTRACTOR_IDX, true, "Contractor Signature", "contractor_signature"), mechanism: "boldsign_tag", field: "Contractor signature", tabType: "sign", source: "HICA" },
          { anchor: tag("date", CONTRACTOR_IDX, true, "Contractor Sign Date", "contractor_signature_date"), mechanism: "boldsign_tag", field: "Contractor sign date", tabType: "date", source: "HICA" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Customer Name", "customer_name"), mechanism: "boldsign_tag", field: "Customer name", tabType: "text", source: "Party identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Property Address", "customer_address"), mechanism: "boldsign_tag", field: "Property address", tabType: "text", source: "Property identification" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Contract Price", "contract_price"), mechanism: "boldsign_tag", field: "Total contract amount (RCV-based)", tabType: "text", source: "Financial term" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Insurance Company", "insurance_company"), mechanism: "boldsign_tag", field: "Insurance carrier", tabType: "text", source: "Insurance-specific" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Claim Number", "claim_number"), mechanism: "boldsign_tag", field: "Carrier claim number", tabType: "text", source: "Insurance-specific" },
          { anchor: tag("text", CONTRACTOR_IDX, true, "Deductible", "deductible"), mechanism: "boldsign_tag", field: "Homeowner deductible amount", tabType: "text", source: "Financial term" },
          { anchor: "Window Manufacturer:", mechanism: "label_text", field: "Window manufacturer", tabType: "text", source: "Specification" },
          { anchor: "Window Count:", mechanism: "label_text", field: "Number of windows", tabType: "text", source: "Scope measurement" },
        ],
        optional: ["City/Zip:", "Phone", "Email:", "Start Date:", "Manufacturer's Warranty:", "Workmanship Warranty:", "Window Series:", "Glass Package:", "Frame Color:", "Trim Notes:", "Description:", "Non-Recoverable Dep:", "Work Not Done:", "Contractor:", "Contractor Phone:", "Contractor Email:", "Contractor Address:", "License #:", "Project Notes:"],
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// The scan. Case-sensitive substring match per manifest. For mechanism:
// "boldsign_tag" entries, `req.anchor` IS the literal `{{...}}` string BoldSign's
// UseTextTags parser needs — this proves the contractor's PDF actually contains
// it (not just the old human-readable label). For mechanism: "label_text"
// entries, behaviour is unchanged from v2 — a plain content-presence check with
// no BoldSign placement meaning.
//
// manualOverrides values may be:
//   "alt label"  — contractor's actual PDF text for this anchor; re-scanned against the PDF
//   anything else — not overridden
// A bare boolean `true` is NOT accepted (D-211 Phase 16 Unit 4 evidence-integrity
// fix, carried forward unchanged from v2) — an override is honored ONLY when the
// contractor-supplied string is actually present in the PDF (stringOverrideMatch).
export interface AnchorScanResult {
  anchor: string;
  mechanism: string;
  field: string;
  tabType: string;
  source: string;
  found: boolean;
  manualOverride: boolean;
  manualOverrideValue: string | null;
}

/**
 * [gh-1315] Typographic punctuation is folded to ASCII before the substring
 * scan. Found live: a v3-tagged production template (12 of 13 markers, every
 * BoldSign tag present including contract_price) failed on exactly one
 * label_text anchor because Word had written "Manufacturer’s Warranty:" with
 * U+2019 where the manifest spells the ASCII apostrophe. Any Word/Pages-authored
 * contract will do this. Tags never contain these characters, so the boldsign_tag
 * checks are unaffected; the manifest's anchor strings are unchanged.
 */
export function normalizeForScan(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/\u00A0/g, " ");
}

export function scanRequiredAnchors(rawPdfText: string, tradeManifest: any, manualOverrides?: any): AnchorScanResult[] {
  const pdfText = normalizeForScan(rawPdfText);
  return tradeManifest.required.map((req: any) => {
    const literalMatch = pdfText.includes(req.anchor);
    const override = manualOverrides ? manualOverrides[req.anchor] : undefined;
    const stringOverride = (typeof override === "string" && override.trim().length > 0)
      ? override.trim()
      : null;
    const stringOverrideMatch = stringOverride !== null && pdfText.includes(stringOverride);
    const overridden = stringOverrideMatch;
    return {
      anchor: req.anchor,
      mechanism: req.mechanism,
      field: req.field,
      tabType: req.tabType,
      source: req.source,
      found: literalMatch || overridden,
      manualOverride: overridden && !literalMatch,
      manualOverrideValue: stringOverride,
    };
  });
}

export function scanOptionalAnchors(rawPdfText: string, tradeManifest: any): Array<{ anchor: string; found: boolean }> {
  const pdfText = normalizeForScan(rawPdfText);
  return tradeManifest.optional.map((anchor: string) => ({
    anchor,
    found: pdfText.includes(anchor),
  }));
}

/** Manifest slot for a template row, or null when the trade/funding pair has no manifest. */
export function manifestSlotFor(trade: string, fundingType: string): any | null {
  return MANIFEST.trades?.[String(trade || "").toLowerCase()]?.[String(fundingType || "").toLowerCase()] ?? null;
}
