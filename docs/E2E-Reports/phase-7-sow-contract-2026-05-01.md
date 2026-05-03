# E2E Phase 7 — SOW + Contract Capture & CTO/GC Review
**Date:** 2026-05-01
**Tester:** Ram (AI Technical Co-Founder)
**ClickUp Task:** [86e132b9a](https://app.clickup.com/t/86e132b9a)
**Supabase Project:** yeszghaspzwwstvsrioa
**Method:** Static source analysis of `create-docusign-envelope/index.ts` + DB inspection + cross-reference to locked decisions (D-152, D-185, D-186, D-199, D-200, D-201, D-202, D-203)

---

## Summary

| Metric | Count |
|---|---|
| Compliance requirements evaluated | 14 |
| Requirements passed | 12 |
| Requirements with defects | 2 |
| CRITICAL defects (legal/compliance breach) | 1 |
| HIGH defects (functional / visible-to-user) | 2 |
| NORMAL defects (cosmetic) | 1 |
| LOW defects (documentation) | 1 |
| **Total defects filed** | **5** |

**Verdict: BLOCKED on CRITICAL — D-P7-001 must resolve before first real homeowner. Retail envelopes can silently omit Exhibit A on any SOW generation error. Fixes for D-P7-002 and D-P7-004 are low-risk and can ship in the same deployment. D-P7-003 and D-P7-005 are process/documentation items only.**

---

## Scope Note: Static Analysis vs. Live Testing

Phase 7 was planned to review executed PDFs from Phases 1+2 (ClickUp 86e132b9a step 10.1). Those artifacts do not exist — no Phase 1+2 PDF files were preserved to `Docs/test-runs/`. See defect D-P7-003.

This report is based on **static analysis of the `create-docusign-envelope` Edge Function source** (2,461 lines, commit reviewed May 1, 2026), supplemented by:
- `data/contract-anchor-manifest.json` (D-199 v2, approved 2026-04-30)
- `otterquote-ref-legal.md` (D-147, D-152, D-185, D-186, D-199, D-200, D-201, D-202, D-203)
- `otterquote-ref-product.md` (D-202 manifest structure)
- Existing test claims in production Supabase (1 retail roofing test envelope: `190e0cf3-68c7-8ff3-83e6-d48cae4898e5`)

Phase 5 report does not exist — no cross-reference available from that phase.

Cross-cutting carry-forward from Phase 3: no Phase 3 defects directly affect the document-generation surface (Phase 3 defects D-P3-001 through D-P3-006 all block at the Hover order and D-164 gate layer, upstream of contract signing). No Phase 3 issues carry into Phase 7.

---

## Document Architecture (Verified Against Source)

| Job Type | Doc 1 | Doc 2 | Doc 3 |
|---|---|---|---|
| **Insurance (any trade)** | Contractor's uploaded PDF template | IC 24-5-11 Compliance Addendum | — |
| **Retail (any trade)** | Contractor's uploaded PDF template | Exhibit A — Scope of Work (D-200 form-driven PDF) | IC 24-5-11 Compliance Addendum |
| **Retail (SOW generation failure)** | Contractor's uploaded PDF template | IC 24-5-11 Compliance Addendum | — *(DEFECT D-P7-001)* |

Signing order: Contractor → Homeowner (routingOrder 1 → 2). Verified D-152 compliant.

---

## Compliance Pass/Fail Table

| Requirement | Decision | Result | Notes |
|---|---|---|---|
| Insurance envelopes contain NO Exhibit A SOW | D-201 | ✅ PASS | `isRetail = fundingType !== "insurance"` correctly gates SOW generation. Insurance path: [contractor PDF] + [addendum] only. |
| D-203 measurement disclaimer verbatim on every retail Exhibit A | D-203 | ✅ PASS | Constant `D203_DISCLAIMER` embedded verbatim. Text matches locked D-203 amendment exactly ("either party shall have the right" singular + third option "proceed under the terms"). |
| D-200 §10 footer disclosure verbatim on every retail Exhibit A page | D-200 | ✅ PASS | Constant `D200_FOOTER_DISCLOSURE` = "This Exhibit A is a scope reference incorporated by reference into the contract between Contractor and Homeowner. The contractor's signed agreement is the binding contract. OtterQuote is not a party to this agreement." Matches D-186/D-200 spec. |
| D-200 PDF title "EXHIBIT A — SCOPE OF WORK" | D-200 | ✅ PASS | PDF section header set to `"EXHIBIT A — SCOPE OF WORK"` at line 966. |
| Retail Exhibit A: dual-party initials per page (`/ContractorInitial/` + `/HomeownerInitial/`) | D-186 | ✅ PASS | `buildSowInitialTabs(sowDocId, "contractor")` and `buildSowInitialTabs(sowDocId, "homeowner")` wired for all retail envelopes. Anchors: `/ContractorInitial/` routing order 1, `/HomeownerInitial/` routing order 2. |
| Sequential signing: Contractor signs first, Homeowner second | D-152 | ✅ PASS | Contractor `routingOrder: "1"`, Homeowner `routingOrder: "2"`. |
| All tabs (signature, date, field) anchored on contractor's PDF (Doc 1) — not a separate signature page | D-199 | ✅ PASS | `documentId = "1"` for all `buildTextTabs` and `buildSignerTabs` calls. Signature page architecture confirmed rejected in code. |
| D-202 manufacturer × tier warranty auto-populated from `warranty_options.display_string` | D-202 | ✅ PASS | EF fetches `warranty_options` row by `bidData.warranty_option_id`, falls back to `bidData.warranty_snapshot`. Auto-populates `Manufacturer's Warranty:` anchor on contractor PDF. |
| D-200 §3 Material Selection block at top of Exhibit A | D-200 | ✅ PASS | 8-category block with Generic fallback present in SOW section builder. |
| IC 24-5-11 addendum: Right to Cancel (IC 24-5-11-10.6) | D-147/D-170 | ✅ PASS | 3-business-day cancellation right with insurance carve-out present and verbatim. GC review recommended for line-by-line statutory match (see GC note below). |
| IC 24-5-11 addendum: Notice of Cancellation form | D-147/D-170 | ✅ PASS | 10-point boldface equivalent, homeowner signature anchor, cancellation deadline computed. |
| IC 24-5-11 addendum: Down payment cap disclosure (IC 24-5-11-12) | D-147 | ✅ PASS | "$1,000 or 10% of contract price, whichever is less" present on addendum. |
| Retail SOW generation failure causes envelope abort (fail-loud) | D-185/D-200 | ❌ **FAIL — CRITICAL** | See D-P7-001. |
| Envelope document name = "Exhibit A — Scope of Work" | D-200 | ❌ **FAIL — HIGH** | See D-P7-002. |

---

## Defect Register

### CRITICAL — Legal/Compliance Breach

#### D-P7-001 · [86e16e393](https://app.clickup.com/t/86e16e393)
**File:** `supabase/functions/create-docusign-envelope/index.ts` (~line 1781)
**Decisions violated:** D-185, D-200
**Issue:** The `catch` block for retail SOW PDF generation is marked **non-fatal**. If `generateRetailScopeOfWorkPdf()` throws for any reason (pdf-lib error, missing bid data, memory pressure, etc.), `scopeOfWorkBase64` silently becomes `null` and the envelope is sent to signers with no Exhibit A. The comment in the code reads: "Non-fatal: proceed without SOW if generation fails for any reason."

Per D-185: "PDF generation failure must fail loudly — no silent envelope without Exhibit A." Per D-200: "Fail-loud per D-185 — envelope creation aborts if Exhibit A generation fails for in-scope retail jobs."

A homeowner who signs a retail contract without Exhibit A may later argue undefined scope at time of signing — a potential IC 24-5-11-10(a)(4)+(5) vulnerability.

**Fix:** Re-throw the error for retail jobs. One-line change in the catch block. **Attorney/GC review required before fix ships per D-tier rule (Tier 3 — legally sensitive).**

---

### HIGH — Functional / Visible-to-User

#### D-P7-002 · [86e16e39j](https://app.clickup.com/t/86e16e39j)
**File:** `supabase/functions/create-docusign-envelope/index.ts` (~line 1835)
**Decision violated:** D-200
**Issue:** The DocuSign envelope document name for the retail SOW is `"Scope of Work"`. D-200 specifies: "Document name in the DocuSign envelope: 'Exhibit A — Scope of Work'." What signers see in the DocuSign signing UI is the envelope-level name, not the internal PDF title. The internal PDF title is correctly "EXHIBIT A — SCOPE OF WORK" (confirmed); the mismatch is only at the envelope wrapper level.

**Fix:** Change `name: "Scope of Work"` to `name: "Exhibit A — Scope of Work"`. Low-risk, no attorney review required.

#### D-P7-003 · [86e16e3cw](https://app.clickup.com/t/86e16e3cw)
**Scope:** Process / Artifact Preservation
**Issue:** Phase 7 ClickUp task (step 10.1) calls for reviewing executed PDFs from Phases 1+2 at `Docs/test-runs/2026-04-26/`. That directory does not exist. No Phase 1+2 PDF artifacts were preserved. The CTO Review (10.2) and GC Review (10.3) of actual rendered+executed documents — including verbatim comparison of the IC 24-5-11 addendum and the Exhibit A SOW against the locked decision text — cannot be performed.

One test envelope exists (`190e0cf3`, retail roofing claim `d83ba00d`) but the homeowner has not signed, and the generated PDFs were never downloaded and committed.

**Fix:** Download envelope `190e0cf3` documents via DocuSign API GET `/envelopes/190e0cf3-68c7-8ff3-83e6-d48cae4898e5/documents`, save to `Docs/test-runs/2026-05-01/`. Establish artifact preservation protocol for all future E2E phases.

---

### NORMAL — Cosmetic / Minor UX

#### D-P7-004 · [86e16e3e9](https://app.clickup.com/t/86e16e3e9)
**File:** `supabase/functions/create-docusign-envelope/index.ts` (`getDocumentLabel()`)
**Issue:** The function returns `"Repair Contract"` as the document label for ALL contract types including full roof replacement and retail installation jobs. This is what signers see as the document tab name in the DocuSign signing ceremony. "Repair Contract" is semantically inaccurate for a full replacement job.

**Fix:** Differentiate label by job type. Simplest option: use `"Home Improvement Contract"` universally (aligns with IC 24-5-11 framing). No attorney review required.

---

### LOW — Documentation / Memory Hygiene

#### D-P7-005 · [86e16e3ga](https://app.clickup.com/t/86e16e3ga)
**File:** `Claude's Memories/otterquote-memory.md` (Build Status table, ~line 95)
**Issue:** Entry reads: "DocuSign Tab Placement Strategy — Signature Page insert (Doc 2) | LIVE ✅". This describes the **pre-D-199 architecture** that D-199 explicitly rejected. The actual code correctly places all tabs on Doc 1 (contractor PDF). The memory entry is misleading and could cause incorrect behavior during future EF modifications.

**Fix:** Update entry to reflect current D-199 compliant architecture. Address at archive.

---

## GC Standing Notes (Not Defects — Flags for Review)

1. **IC 24-5-11-10.6 verbatim compliance:** The Right to Cancel statement text in `generateComplianceAddendumPdf()` is substantively correct and includes the insurance-policy-determination carve-out. A line-by-line comparison against the current enrolled statute text is recommended before first live homeowner — GC should confirm the addendum text exactly satisfies IC 24-5-11-10.6(a) and (b) requirements. This is a CTO/GC review item per the Phase 7 ClickUp task (step 10.3) that remains open because the actual rendered PDF artifacts were not preserved (D-P7-003).

2. **D-185 fail-loud and IC 24-5-11-10(a)(4)+(5):** The risk scenario created by D-P7-001 (retail homeowner signs without Exhibit A) directly implicates the GC sign-off that cleared D-186. The D-186 GC sign-off was conditional on "See Exhibit A" in the contract body satisfying (4)'s detailed description requirement and Exhibit A SOW satisfying (5)'s specifications-before-work requirement. If Exhibit A is missing from the envelope due to silent SOW failure, the contract may not satisfy those requirements. GC should confirm whether a non-fatal SOW failure constitutes a HICA violation and whether the platform has any exposure on prior test envelopes sent without Exhibit A.

3. **D-155 Stohler reference comparison (ClickUp 86e132b9a step 10.4):** Cannot be performed without rendered SOW PDFs. The `Stohler_Roofing_Project_Confirmation_Template.md` reference document was not found at the expected path (`Stellar Edge Services/OtterQuote/Docs/`). This comparison is deferred to the post-D-P7-003-fix rerun.

---

## CTO Review Notes (10.2)

CTO review via static analysis — executed PDF not available (see D-P7-003).

| Check | Result | Notes |
|---|---|---|
| Variable substitution (homeowner name, address, contract price) | ✅ PASS (code path) | `buildTextTabs(autoFields, documentId, "contractor_sign")` wires `autoPopulateFields()` result to DocuSign text tabs on contractor PDF. |
| D-202 warranty auto-population | ✅ PASS (code path) | `warranty_option_id` → `warranty_options.display_string` → `Manufacturer's Warranty:` anchor. Falls back to `warranty_snapshot`. |
| Edge case: no `warranty_option_id`, no `warranty_snapshot` | ⚠️ NEEDS LIVE TEST | If both are null (e.g., a legacy bid), the warranty anchor tab is populated with an empty string. The anchor still fires — the field is blank. Whether this creates a DocuSign validation error or passes silently is untested. |
| Edge case: no deductible (retail job) | ✅ PASS (code path) | `DEDUCTIBLE:` anchor is in the insurance-only required set. Retail template not expected to contain this anchor; omission is by design. |
| Edge case: missing Hover measurements on retail SOW | ✅ PASS (code path) | `fetchHoverMeasurements()` returns `null` on error (never throws). SOW generator renders measurement fields as empty/0 if null — does not abort. |
| Hover measurement data integrity | ⚠️ UNTESTABLE (no real Hover data in staging) | Cannot verify field mapping (`roofSqFt`, `wallSqFt`, `perimeterFt`, `pitch`) without a real Hover job. Phase 3 confirmed `hover_orders` path works for roofing. |
| D-200 line-item deletion rule (qty=0 or empty → skip) | ✅ PASS (code path) | Deletion rule implemented in section resolvers. Cannot verify without a fully populated bid. |
| Multi-page pagination for long SOW | ✅ PASS (code path) | `paginateBlocks()` logic present with `D_200_FOOTER_DISCLOSURE` footer and `buildSowInitialTabs()` anchor on every page. |

---

## Recommended Fix Order

1. **D-P7-001** (CRITICAL — change non-fatal catch to re-throw for retail) → Tier 3, requires attorney/GC review before ship. Create ClickUp Tier 3 approval task.
2. **D-P7-002** (HIGH — document name correction) → Bundle with D-P7-001 deploy. One-line change, Tier 1 once D-P7-001 clears legal.
3. **D-P7-004** (NORMAL — document label) → Bundle with above deploy. Tier 1.
4. **D-P7-003** (HIGH — artifact preservation) → Separate operational task. Download envelope `190e0cf3` now; establish protocol for future phases.
5. **D-P7-005** (LOW — memory hygiene) → Address at session archive.

After fixes: Re-run Phase 7 with a live retail roofing envelope captured end-to-end to verify the fail-loud behavior fires correctly and the document name appears correctly in the DocuSign signing UI.

---

## Test Data (Staging — Existing)

| Resource | Value |
|---|---|
| Test retail roofing claim | `d83ba00d-43b1-4123-8dcd-0c8255230856` |
| Test user email | `testqa+retail-roof@otterquote.com` |
| Existing DocuSign envelope | `190e0cf3-68c7-8ff3-83e6-d48cae4898e5` (retail roofing, contractor step — homeowner not yet signed) |
| Phase 3 test siding claim A | `a1a1a1a1-0001-0001-0001-000000000001` (status: submitted, no contractor selected) |
| Phase 3 test siding claim B | `a1a1a1a1-0002-0002-0002-000000000002` (status: bidding, D-164 gate pending) |

No insurance test envelope exists. Creating one requires: insurance test claim with `funding_type = 'insurance'` + a contractor with an insurance roofing template + a submitted quote + homeowner selecting that contractor.

---

*Report generated by Ram. Parent task: [86e132b9a](https://app.clickup.com/t/86e132b9a). Task left OPEN — 1 CRITICAL defect unresolved.*
