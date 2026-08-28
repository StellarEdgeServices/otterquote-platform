// D-199 validate-contract-template Edge Function
// Scans a contractor's uploaded PDF for required signature-placement/anchor markers
// (per trade x funding_type) and updates contractor_templates.status with the result.
//
// [D-274 / #631, 2026-08-13] Re-grammared for BoldSign. DocuSign's `anchorString`
// mechanism could locate a field anywhere ORDINARY pre-existing text appeared (e.g.
// the literal word "Name" already printed in a contractor's PDF) — no special markup
// needed. BoldSign has NO equivalent. Confirmed against the live OpenAPI spec
// (api.boldsign.com/swagger/v1/swagger.json) and developer docs
// (developers.boldsign.com/text-tags/*): BoldSign's only text-based placement
// mechanism is "Text Tags" — a literal `{{FieldType|SignerIndex|Required|Label|FieldID}}`
// bracket string that must be typed into the document as its own contiguous, single-line
// run of text. There is no API-callable "find this arbitrary string and place a field
// near it" feature (BoldSign's "Anchor Text" is a human-driven web-UI-only feature in
// their template editor, not exposed via the REST API at all).
//
// Practical effect: every contractor-uploaded template that was previously validated
// under the v2 manifest (DocuSign anchors like "/Customer/", "/Contractor/", "Name",
// "Address:") is validated against the WRONG markers now — those strings no longer do
// anything at send time. Every contractor must add the new bracket tags to their PDF
// before their template will place fields correctly under BoldSign. This is a real
// operational migration (contractor communication + re-upload), not something this
// function can paper over. See the D-274 build report on issue #631 for the full
// rollout plan question this raises for Dustin.
//
// Scope-reduction decision (keeps the re-tagging burden as small as it can be):
// only anchors that ALSO drive live field PLACEMENT (the 4 signature/date anchors,
// plus the header fields that create-docusign-envelope's buildTextTabs equivalent
// auto-fills — customer_name, customer_address, contract_price, job_description,
// material_type, estimated_start, decking_per_sheet, insurance_company,
// claim_number, deductible) are converted to BoldSign bracket tags. Anchors that were
// PURE content-presence checks (e.g. "Manufacturer's Warranty:", "Wall Substrate:",
// "Linear Feet:" — proving required boilerplate/labels exist in the document, never
// wired to an auto-fill value) are UNCHANGED plain-text checks: this file's job of
// scanning extracted PDF text for a required substring is independent of BoldSign's
// API and works identically regardless of e-sign vendor. Each requirement below
// carries `mechanism: "boldsign_tag" | "label_text"` making this explicit.
//
// FRAGILE COUPLING (flagged, not solved, here): a Text Tag's SignerIndex is
// POSITIONAL — it refers to whichever signer occupies that slot in the `Signers`
// array of the send() call that uses this exact document, not a named role. This
// manifest bakes in SignerIndex 1 = contractor, 2 = homeowner, matching the fixed
// Signers order create-docusign-envelope's handleContractorSign always uses for the
// contractor_sign flow (the only flow these D-199 templates are used by — legacy
// "contract" document_type uses a different, unvalidated template path). If that
// signer order ever changes, every contractor template's baked-in tags break
// silently and would need re-tagging again. DocuSign's role-named anchors
// (/Customer/, /Contractor/) never had this coupling.
//
// 3-tier escalation per D-199 (unchanged):
//   Tier 1 (auto):    no manualOverrides supplied → "auto_validated" or "manual_mapping_pending"
//   Tier 2 (manual):  manualOverrides supplied   → "manual_validated" or "manual_mapping_pending"
//   Tier 3 (admin):   set by admin-template-review.html (manualOverrides === "admin" string)
//
// Auth gate (unchanged, added 2026-05-10, fixes Architect finding 86e1adykz):
//   All non-health-check calls require Authorization: Bearer <token>.
//   Contractor path (Tier 1 + 2): JWT verified + caller must own the template.
//   Admin path (manualOverrides === "admin"): JWT verified + caller must have app_metadata.role === "admin".
//
// Inputs (JSON POST body):
//   { contractor_template_id: uuid }                          — Tier 1 auto-validate
//   { contractor_template_id: uuid, manualOverrides: {...} }  — Tier 2 manual mapping submission
//   { contractor_template_id: uuid, manualOverrides: "admin" } — Tier 3 admin path
//   { health_check: true }                                    — keepalive ping (no auth required)
//
// Outputs:
//   { ok: true, status: "auto_validated" | "manual_validated" | "manual_mapping_pending",
//     validation_result: {...} }
//
// ClickUp: 86e15abkr · Decisions: D-199, D-274 (#631) · Manifest source: this file (v3)

// deno-lint-ignore-file no-explicit-any
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.104.0";
import * as pdfjsLib from "npm:pdfjs-dist@4.0.379/legacy/build/pdf.mjs";
// Deno cannot spawn pdfjs web workers; importing the worker module sets
// globalThis.pdfjsWorker so the "fake worker" path works. Without this,
// EVERY validation failed 422 "Setting up fake worker failed" (E2E walk fix
// 2026-07-07 — no real contractor template could ever validate).
import "npm:pdfjs-dist@4.0.379/legacy/build/pdf.worker.mjs";
import {
  describeMissingMarkers,
  detectFilledProposal,
  cancellationNoticeState,
  buildExecutionPagePdf,
  appendExecutionPage,
} from "./starter-template.ts";

// ─────────────────────────────────────────────────────────────────────────────
// BoldSign Text Tag builder — matches the syntax create-docusign-envelope's
// PDF generators (and, per this manifest, contractor-authored templates) must
// use: `{{FieldType|SignerIndex|Required|FieldLabel|FieldID}}`. FieldType tokens
// are the 7 documented at developers.boldsign.com/text-tags/supported-fields/:
// text, sign, init, date, editdate, title, company. Required is "*" or a
// single space (not-required) per the same page.
function tag(fieldType: "text" | "sign" | "init" | "date", signerIndex: 1 | 2, required: boolean, label: string, fieldId: string): string {
  return `{{${fieldType}|${signerIndex}|${required ? "*" : " "}|${label}|${fieldId}}}`;
}
const CONTRACTOR_IDX = 1; // Signers[0] in handleContractorSign — see file header coupling note.
const HOMEOWNER_IDX = 2; // Signers[1] in handleContractorSign.

// ─────────────────────────────────────────────────────────────────────────────
// v3 anchor manifest (APPROVED scope per D-274 #631 build; supersedes the v2
// DocuSign-anchor manifest APPROVED April 30, 2026). Same trades, same funding
// types, same required/optional field SET as v2 — only the `anchor` value and
// `mechanism` are new. Do NOT fetch at runtime (avoid IO dependency).
const MANIFEST: any = {
  version: "v3",
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

// CORS — D-211 Phase 16 Unit 4: matched-origin allow-list replaces wildcard "*".
// Mirrors record-attestation (D-210). Only these production origins are echoed back;
// any other Origin falls back to the canonical apex (effectively denied for browsers).
const ALLOWED_ORIGINS = [
  "https://otterquote.com",
  "https://app.otterquote.com",
  "https://app-staging.otterquote.com",
  "https://jade-alpaca-b82b5e.netlify.app",
  "https://staging--jade-alpaca-b82b5e.netlify.app",
];

function buildCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function base64FromBytes(bytes: Uint8Array): string {
  // Chunked so a multi-megabyte template does not blow the argument limit on
  // String.fromCharCode. btoa is the only base64 encoder available here.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function jsonResponse(body: any, status = 200, corsHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function extractPdfText(pdfBytes: Uint8Array): Promise<string> {
  // Disable worker (Deno serverless can't spawn pdfjs workers)
  // @ts-ignore — runtime property
  pdfjsLib.GlobalWorkerOptions.workerSrc = "";
  const loadingTask = pdfjsLib.getDocument({
    data: pdfBytes,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  let fullText = "";
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str ?? "").join(" ");
    fullText += pageText + "\n";
  }
  return fullText;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = buildCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // Keepalive — no auth required
    if (body.health_check === true) {
      return jsonResponse({ ok: true, function: "validate-contract-template", manifestVersion: MANIFEST.version }, 200, corsHeaders);
    }

    const { contractor_template_id } = body;
    // Use let so the admin path can clear this after role verification
    let manualOverrides = body.manualOverrides;
    // Set by the assisted path below; reported on the validation result so the
    // contractor is told his file was rewritten and where the original went.
    let assistApplied: { archivedOriginalPath: string; pagesAdded: boolean } | null = null;

    if (!contractor_template_id) {
      return jsonResponse({ error: "Missing contractor_template_id" }, 400, corsHeaders);
    }

    // ─── Auth Gate ────────────────────────────────────────────────────────────
    // All non-health-check paths require a valid caller JWT.
    // Contractor path: caller must own the template (contractor_id match).
    // Admin path (manualOverrides === "admin"): caller must have app_metadata.role === "admin".
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Missing or invalid Authorization header" }, 401, corsHeaders);
    }
    const bearerToken = authHeader.slice(7);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // Verify the caller's JWT
    const { data: { user }, error: authErr } = await supabase.auth.getUser(bearerToken);
    if (authErr || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
    }

    // ─── #1313 piece 1: the pre-tagged starter ──────────────────────────────
    // "Rename the ask. 'Upload your blank contract template' - with a
    // downloadable pre-tagged starter for each trade/funding slot, because most
    // roofers will not hand-place 12 text tags in a PDF." (#1313)
    //
    // Generated FROM this file's own MANIFEST rather than kept beside it as a
    // static asset, so the starter and the validator cannot drift: every marker
    // the scan below requires is a marker the starter draws. A static PDF would
    // have been correct on the day it was made and silently wrong at the next
    // manifest revision, which is the whole reason v2 templates are all
    // invalid today.
    if (body.starter === true) {
      const sTrade = String(body.trade || "").toLowerCase();
      const sFunding = String(body.funding_type || "").toLowerCase();
      const slot = MANIFEST.trades?.[sTrade]?.[sFunding];
      if (!slot) {
        return jsonResponse({ error: `No manifest for ${sTrade}/${sFunding}` }, 400, corsHeaders);
      }
      const { data: cRec } = await supabase
        .from("contractors").select("company_name").eq("user_id", user.id).maybeSingle();
      const pdf = await buildExecutionPagePdf({
        trade: sTrade,
        fundingType: sFunding,
        requirements: slot.required,
        companyName: cRec?.company_name ?? null,
        standalone: true,
        manifestVersion: MANIFEST.version,
      });
      return jsonResponse({
        ok: true,
        filename: `otterquote-${sTrade}-${sFunding}-template-${MANIFEST.version}.pdf`,
        manifestVersion: MANIFEST.version,
        pdf_base64: base64FromBytes(pdf),
      }, 200, corsHeaders);
    }

    // Determine path: admin vs contractor
    const isAdminPath = manualOverrides === "admin";

    if (isAdminPath) {
      // Admin path: verify admin role in JWT claims
      const callerRole = (user.app_metadata as any)?.role;
      if (callerRole !== "admin") {
        return jsonResponse({ error: "Forbidden: admin role required" }, 403, corsHeaders);
      }
      // Clear admin flag — not used as anchor overrides downstream
      manualOverrides = undefined;
    }
    // ─── End Auth Gate ────────────────────────────────────────────────────────

    // Load template row
    const { data: tmpl, error: loadErr } = await supabase
      .from("contractor_templates")
      .select("id, contractor_id, trade, funding_type, pdf_storage_path, status")
      .eq("id", contractor_template_id)
      .single();
    if (loadErr || !tmpl) {
      return jsonResponse({ error: "Template not found", details: loadErr?.message }, 404, corsHeaders);
    }

    // Contractor path ownership check (runs after template load to avoid extra round-trip)
    if (!isAdminPath) {
      const { data: contractorRec, error: contractorErr } = await supabase
        .from("contractors")
        .select("id")
        .eq("user_id", user.id)
        .single();
      if (contractorErr || !contractorRec) {
        return jsonResponse({ error: "Forbidden: no contractor record for this user" }, 403, corsHeaders);
      }
      if (tmpl.contractor_id !== contractorRec.id) {
        return jsonResponse({ error: "Forbidden: you do not own this template" }, 403, corsHeaders);
      }
    }

    // Manifest lookup
    const tradeManifest = MANIFEST.trades?.[tmpl.trade]?.[tmpl.funding_type];
    if (!tradeManifest) {
      return jsonResponse({ error: `No manifest for ${tmpl.trade}/${tmpl.funding_type}` }, 400, corsHeaders);
    }

    // ─── #1313 piece 4: the assisted path ───────────────────────────────────
    // "Offer the assisted path. For a contractor who cannot tag a PDF, take
    // their contract and return a tagged version. That is what was done by hand
    // here and it took about twenty minutes." (#1313)
    //
    // His pages are copied byte-for-byte and a tagged execution page is
    // appended. Nothing of his is edited, reordered or removed - Dustin,
    // 2026-08-27: "we also aren't taking terms out, either." The page carries
    // no terms of ours; it carries the signature lines and the fields the
    // platform auto-fills, all of which already exist in any contract.
    //
    // The slot path is canonical (<contractor_id>/<trade>/<funding>.pdf) and is
    // read by BOTH contractor_templates.pdf_storage_path and the legacy
    // contractors.contract_templates JSONB that create-docusign-envelope
    // actually attaches. Writing back to the same path is what keeps those two
    // from disagreeing - a new path would have updated one and left the
    // envelope attaching the old untagged file. The original is archived first,
    // so nothing the contractor uploaded is destroyed.
    if (body.assist === true) {
      if (isAdminPath) {
        return jsonResponse({ error: "The assisted path runs as the contractor, not as admin." }, 400, corsHeaders);
      }
      const { data: origBlob, error: origErr } = await supabase.storage
        .from("contractor-templates").download(tmpl.pdf_storage_path);
      if (origErr || !origBlob) {
        return jsonResponse({ error: "PDF not found in storage", path: tmpl.pdf_storage_path, details: origErr?.message }, 404, corsHeaders);
      }
      const origBytes = new Uint8Array(await origBlob.arrayBuffer());
      let taggedBytes: Uint8Array;
      try {
        taggedBytes = await appendExecutionPage(origBytes, {
          trade: tmpl.trade,
          fundingType: tmpl.funding_type,
          requirements: tradeManifest.required,
          companyName: null,
          manifestVersion: MANIFEST.version,
        });
      } catch (assistErr: any) {
        // A PDF we cannot open is a PDF we must not silently replace.
        return jsonResponse({
          error: "Could not add the execution page to this PDF.",
          details: assistErr?.message,
          hint: "The file may be password-protected or damaged. Download the blank starter template instead and paste your terms into it.",
        }, 422, corsHeaders);
      }
      const archivePath = tmpl.pdf_storage_path.replace(/\.pdf$/i, "") +
        `-original-${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`;
      const archived = await supabase.storage.from("contractor-templates")
        .upload(archivePath, origBytes, { contentType: "application/pdf", upsert: true });
      if (archived.error) {
        return jsonResponse({ error: "Could not archive your original before replacing it; nothing was changed.", details: archived.error.message }, 500, corsHeaders);
      }
      const written = await supabase.storage.from("contractor-templates")
        .upload(tmpl.pdf_storage_path, taggedBytes, { contentType: "application/pdf", upsert: true });
      if (written.error) {
        return jsonResponse({ error: "Could not write the tagged template.", details: written.error.message, archived_original: archivePath }, 500, corsHeaders);
      }
      assistApplied = { archivedOriginalPath: archivePath, pagesAdded: true };
      // Fall through: the scan below now reads the tagged file and reports the
      // real outcome, rather than this endpoint asserting success.
    }

    // Download PDF from Supabase Storage
    const { data: pdfBlob, error: downloadErr } = await supabase.storage
      .from("contractor-templates")
      .download(tmpl.pdf_storage_path);
    if (downloadErr || !pdfBlob) {
      return jsonResponse({ error: "PDF not found in storage", path: tmpl.pdf_storage_path, details: downloadErr?.message }, 404, corsHeaders);
    }

    // Extract text
    let pdfText: string;
    try {
      const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
      pdfText = await extractPdfText(pdfBytes);
    } catch (parseErr: any) {
      return jsonResponse({ error: "Failed to parse PDF", details: parseErr.message }, 422, corsHeaders);
    }

    // Scan required anchors (case-sensitive substring match per manifest).
    // For mechanism: "boldsign_tag" entries, `req.anchor` IS the literal
    // `{{...}}` string BoldSign's UseTextTags parser needs — this scan proves
    // the contractor's PDF actually contains it (not just the old human-readable
    // label). For mechanism: "label_text" entries, behavior is unchanged from
    // v2 — a plain content-presence check with no BoldSign placement meaning.
    //
    // manualOverrides values may be:
    //   "alt label"  — contractor's actual PDF text for this anchor; re-scanned against the PDF
    //   anything else — not overridden
    // A bare boolean `true` is NOT accepted (D-211 Phase 16 Unit 4 evidence-integrity
    // fix, carried forward unchanged from v2) — an override is honored ONLY when the
    // contractor-supplied string is actually present in the PDF (stringOverrideMatch).
    // For boldsign_tag entries, a manual override effectively lets a contractor supply
    // their own FieldID/label text for that slot — same mechanism, just scanning for a
    // tag string instead of a label string.
    const anchorResults = tradeManifest.required.map((req: any) => {
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

    const optionalResults = tradeManifest.optional.map((anchor: string) => ({
      anchor,
      found: pdfText.includes(anchor),
    }));

    const requiredFoundCount = anchorResults.filter((a: any) => a.found).length;
    const allRequiredFound = requiredFoundCount === tradeManifest.required.length;

    // ─── #1313 piece 3: make the failure legible ────────────────────────────
    // "The validator already knows exactly which of the 13 markers are missing
    // and where they belong. Say so, per marker, with an example." (#1313)
    //
    // It always knew. What it returned was the raw tag string with a red cross
    // beside it, which describes the failure and not the fix. Indy Rooftops
    // scored 0 of 12 and was told "Upload and validate it on your profile
    // before bidding."
    const missingMarkers = describeMissingMarkers(anchorResults);

    // ─── #1313 piece 2: is this a template at all? ──────────────────────────
    // The worse of the two problems. A tagless filled PROPOSAL and a tagless
    // blank TEMPLATE failed identically, so the message never named the actual
    // mistake - and a filled proposal that DID carry the tags would have sailed
    // through to a homeowner asked to sign a contract naming somebody else's
    // house and somebody else's price.
    //
    // Deliberately a warning, not a rejection. Blocking a legitimate template
    // means a contractor who cannot onboard at all; a missed filled proposal
    // means a warning he reads. Only the tag count decides auto_validated.
    // The contractor's own letterhead address is passed in so his own address
    // cannot be the thing that accuses him.
    const { data: ownRec } = await supabase
      .from("contractors")
      .select("company_name, address_line1, address_city")
      .eq("id", tmpl.contractor_id)
      .maybeSingle();
    const filledProposal = detectFilledProposal(pdfText, {
      companyName: ownRec?.company_name ?? null,
      addressLine1: ownRec?.address_line1 ?? null,
      addressCity: ownRec?.address_city ?? null,
    });

    // IC 24-5-11-10 requires the Notice of Cancellation be furnished. Since C1
    // retired the platform-generated Document 3 (Dustin, 2026-08-27: "I don't
    // want us adding ... the notice of cancellation form"), it has to be in the
    // contractor's own template - and a template whose terms cite "the attached
    // Notice of Cancellation", as Indy Rooftops' section 11 does, now cites an
    // attachment nothing carries. Reported, never supplied.
    const cancellationNotice = cancellationNoticeState(pdfText);

    const validationResult = {
      manifestVersion: MANIFEST.version,
      trade: tmpl.trade,
      funding_type: tmpl.funding_type,
      requiredCount: tradeManifest.requiredCount,
      requiredFoundCount,
      allRequiredFound,
      anchors: anchorResults,
      optional: optionalResults,
      missingMarkers,
      filledProposal,
      cancellationNotice,
      assistApplied,
      validatedAt: new Date().toISOString(),
    };

    // Determine new status per D-199 state machine
    let newStatus: string;
    if (allRequiredFound) {
      newStatus = manualOverrides ? "manual_validated" : "auto_validated";
    } else {
      newStatus = "manual_mapping_pending";
    }

    const { error: updateErr } = await supabase
      .from("contractor_templates")
      .update({
        validation_result: validationResult,
        manual_overrides: manualOverrides ?? null,
        status: newStatus,
      })
      .eq("id", contractor_template_id);

    if (updateErr) {
      return jsonResponse({ error: "Failed to update template", details: updateErr.message }, 500, corsHeaders);
    }

    return jsonResponse({
      ok: true,
      status: newStatus,
      validation_result: validationResult,
    }, 200, corsHeaders);
  } catch (e: any) {
    console.error("validate-contract-template error:", e);
    return jsonResponse({ error: "Server error", message: e.message }, 500, corsHeaders);
  }
});
