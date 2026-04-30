# `create-docusign-envelope` Audit v1

**Date:** April 30, 2026
**Audited against:** D-186 (measurement disclaimer) · D-199 v2 (anchor manifest) · D-201 (no insurance Exhibit A) · D-202 (manufacturer × tier warranty) · D-203 (D-186 amendment)
**Source:** Production v11, downloaded April 30, 2026 (2,170 lines, 81 KB)
**ClickUp:** 86e153vw6
**Recommendation:** Fix all 9 findings below in a single deploy after Dustin review.

---

## TL;DR

The current `create-docusign-envelope` function predates the D-199/D-200/D-202/D-203 architecture lockdown. It works for the legacy single-anchor pattern and roofing-focused field set, but does **not** comply with the new approved manifests. Three blocking bugs (the original ClickUp 86e153vw6 scope) plus six additional drift items found during this audit.

| # | Bug | Severity | Lines | Source decision |
|---|-----|----------|-------|-----------------|
| 1 | Generated SOW PDF lacks `EXHIBIT A — SCOPE OF WORK` title | HIGH | 720–1009 | D-200 §1 |
| 2 | No verbatim D-203-amended measurement disclaimer in SOW | HIGH | 720–1009 | D-186 amended by D-203 |
| 3 | No `/ContractorInitial/` or `/HomeownerInitial/` anchors anywhere | HIGH | 1211–1230 | D-200 §9 |
| 4 | `warranty_years` uses single `Warranty:` anchor — must split into `Manufacturer's Warranty:` + `Workmanship Warranty:` | HIGH | 1141–1184 | D-199 v2 + D-202 |
| 5 | Field anchor map missing siding anchors (`Siding Product:`, `Wall Substrate:`) | HIGH | 1141–1184 | D-199 v2 |
| 6 | Field anchor map missing gutters anchors (`Linear Feet:`, `Gutter Size:`, `Downspout Count:`) | HIGH | 1141–1184 | D-199 v2 |
| 7 | Field anchor map missing windows anchors (`Window Manufacturer:`, `Window Count:`) | HIGH | 1141–1184 | D-199 v2 |
| 8 | SOW lacks Material Selection block at top + Manufacturer × Tier warranty block | MEDIUM | 720–1009 | D-200 §3, §7 |
| 9 | Manufacturer's Warranty anchor on contractor PDF needs auto-population from D-202 manifest (display string) | MEDIUM | 1320–1340 | D-202 |

The **3 named bugs** in ClickUp 86e153vw6 (Bugs 1, 3, 4 above) map cleanly to the original "1, 3, 8" naming. The other 6 are drift discovered while reviewing — they all need fixing for D-199/D-200/D-202 compliance, but they're sympathetic fixes to the same code paths.

---

## Detailed findings

### Bug 1 — SOW PDF missing `EXHIBIT A — SCOPE OF WORK` title (HIGH)

**Where:** `generateRetailScopeOfWorkPdf`, lines 720–1009. The PDF header is generated starting around line 820 but uses generic header text — no `EXHIBIT A — SCOPE OF WORK` title or `Prepared by OtterQuote on behalf of [Contractor Name]` subtitle.

**D-200 §1 requires:**
> Title: `EXHIBIT A — SCOPE OF WORK`
> Subtitle: `Prepared by OtterQuote on behalf of [Contractor Name]`
> Project info block: Property Address · Homeowner Name · Contractor Name · Date · Job Reference (claim ID prefix)

**Fix:**
- Add the title and subtitle text at the top of the PDF.
- Confirm project info block contents match D-200 §1 exactly.

---

### Bug 2 — Missing verbatim D-203-amended measurement disclaimer (HIGH)

**Where:** Searched the entire 2,170-line file for `"measurements contained"`, `"either party"`, `"right to perform"`, `"prior to starting"`. **No matches.** The verbatim D-186 disclaimer (as amended by D-203 on April 29, 2026) is not present in the SOW PDF.

**D-203 verbatim text required (D-200 §2):**
> "The measurements contained in this Statement of Work were provided to Contractor on behalf of Customer. Both parties have relied upon the accuracy of this information in negotiating the terms of this Agreement. Prior to starting the work set forth in this agreement, **either party** shall have the right to perform his or her own measurements of the items listed in this statement of work. If any measurement in this statement of work is off by more than 10%, **either party** shall have the right to: (1) negotiate a change order to be signed by both parties prior to starting the work; (2) cancel the Agreement; or **(3) proceed under the terms set forth in the Agreement**."

**Fix:** Insert the disclaimer block as Section 2 of the SOW (just below header, above Material Selection). Use `addWrappedText()` (already in the file at line 792) with the verbatim text above. Test wrapping carefully — must be word-perfect.

---

### Bug 3 — No `/ContractorInitial/` or `/HomeownerInitial/` anchors anywhere (HIGH)

**Where:** `buildSignerTabs` at line 1211–1230 only emits `signHereTabs` and `dateSignedTabs`. Searched entire file for `Initial`, `initialHere`, `InitialTabs` — **no matches** for `/ContractorInitial/` or `/HomeownerInitial/`.

**D-200 §9 requires:**
> Dual-party initial fields (per D-186): `/ContractorInitial/` anchor at bottom of each page · `/HomeownerInitial/` anchor at bottom of each page

**Fix:**
1. In `generateRetailScopeOfWorkPdf`, emit `/ContractorInitial/` and `/HomeownerInitial/` text strings at the bottom of every page (use the page break logic).
2. Add `initialHereTabs` to the DocuSign tab payload, anchored to those strings, with `documentId = sowDocId` ("2") for the SOW document.
3. Verify that the contractor's source PDF (Doc 1) does NOT need initial anchors — D-186 dual-party initials are specifically on Exhibit A pages. *(Confirm with Dustin if initials should also appear on contractor PDF pages.)*

---

### Bug 4 — Single `Warranty:` anchor must split into `Manufacturer's Warranty:` + `Workmanship Warranty:` (HIGH)

**Where:** `fieldAnchors` map at line 1157: `warranty_years: "Warranty:"`. D-199 v2 explicitly splits this into two required anchors (per D-202).

**D-199 v2 + D-202 requires:**
- `Manufacturer's Warranty:` — auto-populated from `warranty_options.display_string` (e.g., "GAF Golden Pledge — Material: 50 years (non-prorated); Labor: 25 years; …")
- `Workmanship Warranty:` — contractor-specified years

**Fix:**
1. Remove `warranty_years: "Warranty:"` from `fieldAnchors`.
2. Add: `manufacturer_warranty: "Manufacturer's Warranty:"` and `workmanship_warranty: "Workmanship Warranty:"`.
3. Update `buildAutoFields` (around line 1320) to populate:
   - `fields.manufacturer_warranty = warrantyOptions.display_string` (joined to bid via `quotes.warranty_options_id` — needs schema add, see Bug 9)
   - `fields.workmanship_warranty = String(bidData.workmanship_warranty_years) + " years"`

---

### Bug 5 — Field anchor map missing siding-specific anchors (HIGH)

**Where:** `fieldAnchors` map at lines 1141–1184. No `Siding Product:` or `Wall Substrate:`.

**D-199 v2 (siding/retail + siding/insurance) requires:**
- `Siding Product:` (Material commitment)
- `Wall Substrate:` (Per-sheet sheathing replacement contingency)

**Fix:** Add these two entries to `fieldAnchors`. Wire them in `buildAutoFields` to read from `quotes.value_adds.siding_product` and `quotes.value_adds.wall_substrate_price_per_sheet` (or equivalent).

---

### Bug 6 — Field anchor map missing gutters-specific anchors (HIGH)

**Where:** `fieldAnchors` map at lines 1141–1184. No `Linear Feet:`, `Gutter Size:`, `Downspout Count:`.

**D-199 v2 (gutters/retail + gutters/insurance) requires:** all 3.

**Fix:** Add to `fieldAnchors`. Wire to `quotes.value_adds.gutters.linear_feet`, `quotes.value_adds.gutters.size`, `quotes.value_adds.gutters.downspout_count` (verify shapes against current bid form output).

---

### Bug 7 — Field anchor map missing windows-specific anchors (HIGH)

**Where:** Same map. No `Window Manufacturer:` or `Window Count:`.

**Fix:** Add to `fieldAnchors`. Wire to whatever `quotes.value_adds.windows.*` fields the bid form populates.

---

### Bug 8 — SOW lacks Material Selection block + Manufacturer × Tier warranty block (MEDIUM)

**Where:** SOW PDF body (lines 820–990) has trade-specific sections (Roofing, Gutters, Siding, Windows) but no top-level Material Selection block per D-200 §3, and no Manufacturer × Tier warranty block per D-200 §7.

**D-200 §3 requires:** Material Selection block at TOP (right after header + disclaimer), with rows per material category (Shingles, Underlayment, Hip & Ridge Cap, Starter Strip, Drip Edge, Ice & Water Shield, Ridge Vent, Pipe Boots) — each with Brand + Product Line + Type + Color where applicable. "Generic" rendered when not selected.

**D-200 §7 requires:** Manufacturer × Tier Warranty Block — Manufacturer · Tier · Coverage (Material/Labor/Tear-off auto-populated from D-202) · Source citation.

**Fix:**
- Add Material Selection block (Section 3 per schema) reading from `quotes.material_selection` JSONB (needs schema add — propose `quotes.material_selection JSONB` column in v64 migration).
- Add Manufacturer × Tier warranty block (Section 7) reading from `warranty_options` table joined via new `quotes.warranty_options_id` FK.

This is medium-severity because the SOW PDF currently still functions; it just doesn't match the D-200 v2 schema. Bug 4 fixes the contractor PDF anchor layer; this fixes the OtterQuote-generated SOW layer.

---

### Bug 9 — Manufacturer's Warranty anchor needs D-202 display-string auto-population (MEDIUM)

**Where:** `buildAutoFields` around line 1320. Currently no logic to read from `warranty_options` table.

**Fix (depends on Bug 4 & Bug 8 schema work):**
- Add `quotes.warranty_options_id UUID REFERENCES public.warranty_options(id)` in v64 migration
- In `buildAutoFields`, fetch `warranty_options.display_string` for the bid's selected manufacturer × tier and set `fields.manufacturer_warranty` to that value

---

## Recommended fix order (single PR)

1. **SQL v64**: add `quotes.warranty_options_id` (FK to warranty_options), `quotes.material_selection JSONB`, `quotes.workmanship_warranty_years INTEGER` (if not present)
2. **`create-docusign-envelope` patches** (one Edge Function deploy):
   - Add `EXHIBIT A — SCOPE OF WORK` title + subtitle (Bug 1)
   - Insert verbatim D-203 disclaimer (Bug 2)
   - Add `/ContractorInitial/` + `/HomeownerInitial/` anchors per page + `initialHereTabs` payload (Bug 3)
   - Split warranty anchor into 2 entries (Bug 4)
   - Add siding/gutters/windows anchors to `fieldAnchors` (Bugs 5, 6, 7)
   - Add Material Selection block + Mfr × Tier warranty block to SOW (Bug 8)
   - Wire `warranty_options.display_string` lookup in `buildAutoFields` (Bug 9)
3. **Frontend updates** (separate PR, not in scope of this audit):
   - `contractor-bid-form.html` D-202 refactor (Item 7 of this session — already in queue)
   - Material Selection block on bid form (deferred — D-200 form-driven generator full build is separate task 86e15abq0)

---

## Test plan after patch

1. Sandbox envelope with retail roofing bid:
   - Verify `EXHIBIT A — SCOPE OF WORK` header
   - Verify D-203 disclaimer text matches verbatim (paste-compare)
   - Verify both `/ContractorInitial/` and `/HomeownerInitial/` resolve to initial-here tabs in DocuSign UI
   - Verify both `Manufacturer's Warranty:` and `Workmanship Warranty:` anchors populate correctly
2. Sandbox envelope with retail gutters bid:
   - Verify `Linear Feet:`, `Gutter Size:`, `Downspout Count:` anchors populate
3. Sandbox envelope with retail siding bid:
   - Verify `Siding Product:`, `Wall Substrate:` anchors populate
4. Sandbox envelope with insurance roofing bid:
   - Verify NO Exhibit A document (D-201)
   - Verify `Manufacturer's Warranty:` + `Workmanship Warranty:` anchors on contractor PDF (D-201 — required, not optional)
5. Verify rate limits / billing not affected (no DocuSign envelope changes that affect quota)

---

## Deferred / out of audit scope

- Replacing `generateRetailScopeOfWorkPdf` entirely with the D-200 form-driven generator (pdf-lib spike GREEN; ClickUp 86e15abq0). The patches above are minimum-viable D-200 v2 compliance for the existing generator. The full form-driven rewrite is a separate task and will eventually replace this generator wholesale.
- Repair-mode handling per D-080 (out of scope per D-200 v2 footer note).
- Multi-structure rendering (D-200 §"Multi-Structure Rule" — defer until first multi-structure bid).

---

## Stop point

Per the agreed plan, I am NOT patching `create-docusign-envelope` until Dustin reviews this audit. Once you say "patch all 9" or "patch only 1/3/4 (the original ClickUp scope)" I will execute. Other Phase 4 frontend work continues in parallel and does not depend on this patch.
