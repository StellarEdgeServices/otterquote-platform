// gh-1315 — tests for the template-validity invariant. Each case is a real
// shape production held on 2026-09-04 (see Docs/template-validation-invariant.md):
// a v2 auto_validated row (13/13 found, every completed contract used one), a
// seeded row with no result (#1584), a v3 result with contract_price missing,
// and the seed.mjs v3 shape that must pass.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CONTRACT_PRICE_FIELD_ID,
  CURRENT_TEMPLATE_MANIFEST_VERSION,
  TemplateNotUsableError,
  VALIDATED_STATUSES,
  fieldIdFromAnchor,
  foundFieldIds,
  isTemplateUsable,
} from "./template-validity.ts";
import { MANIFEST, tag } from "../validate-contract-template/manifest.ts";
import { PRICE_FIELD_ID } from "../docusign-webhook/price-verify.ts";

const ID = "f8223eb9-6e51-47ec-9866-e48a9d9eea66";

function v3Result(trade = "roofing", funding = "retail", opts: { dropFieldId?: string; markNotFound?: string } = {}) {
  const slot = MANIFEST.trades[trade][funding];
  // deno-lint-ignore no-explicit-any
  const anchors = slot.required
    .filter((r: any) => !opts.dropFieldId || !String(r.anchor).endsWith(`|${opts.dropFieldId}}}`))
    .map((r: any) => ({
      anchor: r.anchor,
      mechanism: r.mechanism,
      field: r.field,
      tabType: r.tabType,
      source: r.source,
      found: !(opts.markNotFound && String(r.anchor).endsWith(`|${opts.markNotFound}}}`)),
      manualOverride: false,
      manualOverrideValue: null,
    }));
  const found = anchors.filter((a: any) => a.found).length;
  return {
    manifestVersion: CURRENT_TEMPLATE_MANIFEST_VERSION,
    trade,
    funding_type: funding,
    requiredCount: slot.requiredCount,
    requiredFoundCount: found,
    allRequiredFound: found === slot.requiredCount,
    anchors,
    optional: [],
    missingMarkers: [],
    filledProposal: { detected: false, signals: [] },
    cancellationNotice: "placeholder",
    assistApplied: null,
    validatedAt: "2026-09-04T00:00:00.000Z",
    seeded: true,
  };
}

// The v2 result shape production row f8223eb9 carries (DocuSign anchorString grammar).
function v2Result() {
  const labels = ["/Customer/", "/CustomerDate/", "/Contractor/", "/ContractorDate/", "Name", "Address:", "Contract Price:", "Job Description:", "Shingle Type:", "Manufacturer's Warranty:", "Workmanship Warranty:", "Decking Per Sheet:", "Start Date:"];
  return {
    manifestVersion: "v2",
    trade: "roofing",
    funding_type: "retail",
    requiredCount: 13,
    requiredFoundCount: 13,
    allRequiredFound: true,
    anchors: labels.map((anchor) => ({ anchor, found: true, manualOverride: false })),
    validatedAt: "2026-07-27T00:00:00.000Z",
  };
}

Deno.test("manifest version: MANIFEST.version and the shared constant are one value", () => {
  assertEquals(MANIFEST.version, CURRENT_TEMPLATE_MANIFEST_VERSION);
  assertEquals(CURRENT_TEMPLATE_MANIFEST_VERSION, "v3");
});

Deno.test("contract_price: the invariant's field id is the one the #1314 price halt reads", () => {
  assertEquals(CONTRACT_PRICE_FIELD_ID, PRICE_FIELD_ID);
  // ...and every manifest slot requires a boldsign_tag carrying it.
  for (const trade of Object.keys(MANIFEST.trades)) {
    for (const funding of Object.keys(MANIFEST.trades[trade])) {
      // deno-lint-ignore no-explicit-any
      const hit = MANIFEST.trades[trade][funding].required.find((r: any) => fieldIdFromAnchor(r.anchor) === CONTRACT_PRICE_FIELD_ID);
      assert(hit, `${trade}/${funding} manifest slot must require a ${CONTRACT_PRICE_FIELD_ID} tag`);
      assertEquals(hit.mechanism, "boldsign_tag");
    }
  }
});

Deno.test("fieldIdFromAnchor parses a BoldSign tag and rejects label_text anchors", () => {
  assertEquals(fieldIdFromAnchor(tag("text", 1, true, "Contract Price", "contract_price")), "contract_price");
  assertEquals(fieldIdFromAnchor(tag("text", 1, false, "Deductible", "deductible")), "deductible");
  assertEquals(fieldIdFromAnchor("Manufacturer's Warranty:"), null);
  assertEquals(fieldIdFromAnchor("Contract Price:"), null);
  assertEquals(fieldIdFromAnchor(null), null);
});

Deno.test("usable: the seed.mjs v3 shape passes, with contract_price required", () => {
  const r = isTemplateUsable({ id: ID, status: "auto_validated", trade: "roofing", funding_type: "retail", validation_result: v3Result() }, "v3", { requireFieldIds: [CONTRACT_PRICE_FIELD_ID] });
  assertEquals(r.usable, true);
  assertEquals(r.code, null);
  assertEquals(r.storedManifestVersion, "v3");
  assertEquals(r.missingFieldIds, []);
});

Deno.test("usable: every validated status is accepted; the default manifest version is the shared constant", () => {
  for (const status of VALIDATED_STATUSES) {
    assertEquals(isTemplateUsable({ id: ID, status, validation_result: v3Result("roofing", "insurance") }).usable, true, status);
  }
});

Deno.test("NOT usable: status outside the validated set, whatever the result says", () => {
  for (const status of ["pending_validation", "manual_mapping_pending", "submitted_for_admin_review", "rejected", null, undefined]) {
    const r = isTemplateUsable({ id: ID, status, validation_result: v3Result() });
    assertEquals(r.usable, false, String(status));
    assertEquals(r.code, "status_not_validated");
    assertStringIncludes(r.reason, ID);
  }
});

Deno.test("NOT usable: auto_validated with validation_result null/absent (the #1584 seed shape)", () => {
  for (const vr of [null, undefined]) {
    const r = isTemplateUsable({ id: "4e70be64-21f0-4a10-94a7-1896e8e1630b", status: "auto_validated", trade: "roofing", funding_type: "retail", validation_result: vr });
    assertEquals(r.usable, false);
    assertEquals(r.code, "validation_result_missing");
    assertStringIncludes(r.reason, "4e70be64-21f0-4a10-94a7-1896e8e1630b");
    assertStringIncludes(r.reason, "roofing/retail");
  }
});

Deno.test("NOT usable: a v2 result — 13/13 found, allRequiredFound — is stale under v3 (the completed-contract shape)", () => {
  const r = isTemplateUsable({ id: ID, status: "auto_validated", trade: "roofing", funding_type: "retail", validation_result: v2Result() }, "v3");
  assertEquals(r.usable, false);
  assertEquals(r.code, "manifest_version_stale");
  assertEquals(r.storedManifestVersion, "v2");
  assertStringIncludes(r.reason, "'v2'");
  assertStringIncludes(r.reason, "'v3'");
  assertStringIncludes(r.reason, ID);
  // ...and the same v2 result is fine when v2 IS the current manifest (the helper is version-agnostic).
  assertEquals(isTemplateUsable({ id: ID, status: "auto_validated", validation_result: v2Result() }, "v2").usable, true);
});

Deno.test("NOT usable: v3 result with one required anchor not found", () => {
  const r = isTemplateUsable({ id: ID, status: "auto_validated", validation_result: v3Result("roofing", "retail", { markNotFound: "contract_price" }) }, "v3");
  assertEquals(r.usable, false);
  assertEquals(r.code, "required_fields_incomplete");
  assertStringIncludes(r.reason, "Total contract amount");
});

Deno.test("NOT usable: v3 result whose counts disagree with its anchors (a forged/partial artefact)", () => {
  const vr = v3Result();
  vr.requiredFoundCount = vr.requiredCount - 1;
  const r = isTemplateUsable({ id: ID, status: "auto_validated", validation_result: vr }, "v3");
  assertEquals(r.usable, false);
  assertEquals(r.code, "required_fields_incomplete");
  const vr2 = { ...v3Result(), anchors: undefined };
  assertEquals(isTemplateUsable({ id: ID, status: "auto_validated", validation_result: vr2 }, "v3").code, "required_fields_incomplete");
  const vr3 = { ...v3Result(), anchors: [] };
  assertEquals(isTemplateUsable({ id: ID, status: "auto_validated", validation_result: vr3 }, "v3").code, "required_fields_incomplete");
});

Deno.test("NOT usable: load-bearing field id absent from the found tags even though the artefact is internally consistent", () => {
  // A result whose anchors list simply never included the contract_price tag
  // (counts agree with itself) — the shape a hand-written or older seeded result
  // could take. The caller declares contract_price load-bearing and is refused.
  const vr = v3Result("roofing", "retail", { dropFieldId: "contract_price" });
  vr.requiredCount = vr.anchors.length;
  vr.requiredFoundCount = vr.anchors.length;
  vr.allRequiredFound = true;
  const r = isTemplateUsable({ id: ID, status: "auto_validated", validation_result: vr }, "v3", { requireFieldIds: [CONTRACT_PRICE_FIELD_ID] });
  assertEquals(r.usable, false);
  assertEquals(r.code, "load_bearing_field_absent");
  assertEquals(r.missingFieldIds, ["contract_price"]);
  assertStringIncludes(r.reason, "field_absent");
  // Without the caller's declaration the same artefact is (only) internally valid.
  assertEquals(isTemplateUsable({ id: ID, status: "auto_validated", validation_result: vr }, "v3").usable, true);
});

Deno.test("foundFieldIds: only FOUND boldsign_tag anchors count", () => {
  const vr = v3Result("roofing", "insurance", { markNotFound: "deductible" });
  const ids = foundFieldIds(vr);
  assert(ids.has("contract_price"));
  assert(ids.has("claim_number"));
  assert(!ids.has("deductible"), "a not-found tag must not count as carried");
  assertEquals(foundFieldIds(v2Result()).size, 0, "v2 label anchors carry no field ids");
  assertEquals(foundFieldIds(null).size, 0);
});

Deno.test("null/undefined template is refused, never throws", () => {
  assertEquals(isTemplateUsable(null).code, "status_not_validated");
  assertEquals(isTemplateUsable(undefined).code, "status_not_validated");
});

Deno.test("TemplateNotUsableError carries a 422, the code, the template id and the reason", () => {
  const u = isTemplateUsable({ id: ID, status: "auto_validated", validation_result: v2Result() }, "v3");
  const e = new TemplateNotUsableError(u, ID);
  assertEquals(e.statusCode, 422);
  assertEquals(e.code, "TEMPLATE_NOT_USABLE");
  assertEquals(e.templateId, ID);
  assertEquals(e.message, u.reason);
  assert(e instanceof Error);
});

// ─── The sibling copies are byte-identical to this canonical file ────────────
// (the deploy path does not resolve _shared imports; see the file header)
const CANONICAL = await Deno.readTextFile(new URL("./template-validity.ts", import.meta.url));
for (const consumer of ["create-docusign-envelope", "validate-contract-template"]) {
  Deno.test(`copy drift: ${consumer}/template-validity.ts is byte-identical to _shared/template-validity.ts`, async () => {
    const copy = await Deno.readTextFile(new URL(`../${consumer}/template-validity.ts`, import.meta.url));
    assertEquals(copy, CANONICAL, `${consumer}/template-validity.ts has drifted from _shared/template-validity.ts — edit _shared and copy`);
  });
}
