// [gh-1315] Structural cover for the template-validity invariant in
// create-docusign-envelope. index.ts is a single-file EF whose top level calls
// serve(), so — like rate-limit-split.test.ts and exhibit-a-shapes.test.ts —
// this reads the source as text and (a) asserts ordering, (b) extracts
// assertContractorTemplateUsable and runs it against fake clients.
import { assert, assertEquals, assertRejects, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CONTRACT_PRICE_FIELD_ID,
  CURRENT_TEMPLATE_MANIFEST_VERSION,
  TemplateNotUsableError,
  isTemplateUsable,
} from "./template-validity.ts";
import { MANIFEST } from "../validate-contract-template/manifest.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
function mustFind(needle: string, from = 0): number {
  const i = src.indexOf(needle, from);
  if (i === -1) throw new Error(`Expected to find ${JSON.stringify(needle)} in index.ts — source has moved; update this test's anchors.`);
  return i;
}

const idxHandler = mustFind("async function handleContractorSign(");
const idxAssert = mustFind("await assertContractorTemplateUsable(supabase, contractor_id, trade, fundingType);", idxHandler);
const idxLegacyLookup = mustFind("const templates = contractorData?.contract_templates || [];", idxHandler);
const idxDownload = mustFind('await supabase.storage.from("contractor-templates").download(storagePath);', idxHandler);
const idxFundingType = mustFind('const fundingType = rawClaimFunding.includes("insurance") ? "insurance" : "retail";', idxHandler);

Deno.test("wiring: the invariant runs inside handleContractorSign, after trade/fundingType are resolved and BEFORE the legacy JSONB lookup and any PDF download", () => {
  assert(idxFundingType < idxAssert, "fundingType must be resolved before the invariant is applied");
  assert(idxAssert < idxLegacyLookup, "the invariant must precede the contractors.contract_templates fallback chain");
  assert(idxAssert < idxDownload, "no template bytes may be fetched before the invariant passes");
});

Deno.test("wiring: the error mapper returns TemplateNotUsableError as a specific non-500 response carrying the template id and reason code", () => {
  const i = mustFind("if (error instanceof TemplateNotUsableError) {");
  const block = src.slice(i, i + 700);
  assertStringIncludes(block, "template_id: error.templateId");
  assertStringIncludes(block, "reason_code: error.usability.code");
  assertStringIncludes(block, "status: error.statusCode");
  assert(i < mustFind("if (error instanceof DocumentTooLargeError) {"), "mapped before the generic handlers");
});

Deno.test("wiring: the gate declares contract_price load-bearing and compares against the deployed manifest version", () => {
  const i = mustFind("async function assertContractorTemplateUsable(");
  const fn = src.slice(i, src.indexOf("// ========== HANDLER: CONTRACTOR SIGN", i));
  assertStringIncludes(fn, "requireFieldIds: [CONTRACT_PRICE_FIELD_ID]");
  assertStringIncludes(fn, "isTemplateUsable(row, CURRENT_TEMPLATE_MANIFEST_VERSION");
  assertStringIncludes(fn, 'throw new TemplateNotUsableError(usability, null)', "a missing row is refused, not fallen through");
});

// ─── Execute the real assertContractorTemplateUsable against fake clients ────
const fnStart = mustFind("async function assertContractorTemplateUsable(");
const fnEnd = src.indexOf("// ========== HANDLER: CONTRACTOR SIGN", fnStart);
const fnSrc = src.slice(fnStart, fnEnd);
const modSrc =
  `import { CONTRACT_PRICE_FIELD_ID, CURRENT_TEMPLATE_MANIFEST_VERSION, TemplateNotUsableError, isTemplateUsable } from ${JSON.stringify(new URL("./template-validity.ts", import.meta.url).href)};\n` +
  `type TemplateUsability = import(${JSON.stringify(new URL("./template-validity.ts", import.meta.url).href)}).TemplateUsability;\n` +
  fnSrc + "\nexport { assertContractorTemplateUsable };\n";
// deno-lint-ignore no-explicit-any
const { assertContractorTemplateUsable } = await import("data:application/typescript," + encodeURIComponent(modSrc)) as any;

// deno-lint-ignore no-explicit-any
function fakeClient(rows: any[] | null, error: { message: string } | null = null) {
  const calls: Record<string, unknown[]> = {};
  const chain = {
    select(...a: unknown[]) { calls.select = a; return chain; },
    eq(...a: unknown[]) { calls.eq = a; return chain; },
    ilike(...a: unknown[]) { (calls.ilike ??= []).push(a); return chain; },
    order(...a: unknown[]) { calls.order = a; return chain; },
    limit(...a: unknown[]) { calls.limit = a; return Promise.resolve({ data: rows, error }); },
  };
  return { calls, from(table: string) { calls.from = [table]; return chain; } };
}
function v3Result(trade = "roofing", funding = "retail") {
  const slot = MANIFEST.trades[trade][funding];
  // deno-lint-ignore no-explicit-any
  const anchors = slot.required.map((r: any) => ({ anchor: r.anchor, mechanism: r.mechanism, field: r.field, tabType: r.tabType, source: r.source, found: true, manualOverride: false, manualOverrideValue: null }));
  return { manifestVersion: CURRENT_TEMPLATE_MANIFEST_VERSION, trade, funding_type: funding, requiredCount: slot.requiredCount, requiredFoundCount: anchors.length, allRequiredFound: true, anchors, validatedAt: "2026-09-04T00:00:00Z" };
}
const TID = "f8223eb9-6e51-47ec-9866-e48a9d9eea66";

Deno.test("gate: a v3, all-found, contract_price-carrying row passes and is returned", async () => {
  const sb = fakeClient([{ id: TID, contractor_id: "c1", trade: "roofing", funding_type: "retail", status: "auto_validated", validation_result: v3Result(), pdf_storage_path: "c1/roofing/retail.pdf" }]);
  const row = await assertContractorTemplateUsable(sb, "c1", "roofing", "retail");
  assertEquals(row.id, TID);
  assertEquals(sb.calls.from, ["contractor_templates"]);
  assertEquals(sb.calls.eq, ["contractor_id", "c1"]);
  assertEquals(sb.calls.ilike, [["trade", "roofing"], ["funding_type", "retail"]]);
});

Deno.test("gate: the v2-validated row every completed contract used is REFUSED with the template id and 'v2' vs 'v3' in the message", async () => {
  const v2 = { manifestVersion: "v2", requiredCount: 13, requiredFoundCount: 13, allRequiredFound: true, anchors: [{ anchor: "Contract Price:", found: true }] };
  const sb = fakeClient([{ id: TID, contractor_id: "2bc792be", trade: "roofing", funding_type: "retail", status: "auto_validated", validation_result: v2, pdf_storage_path: "x.pdf" }]);
  const err = await assertRejects(() => assertContractorTemplateUsable(sb, "2bc792be", "roofing", "retail"), TemplateNotUsableError);
  assertEquals(err.statusCode, 422);
  assertEquals(err.code, "TEMPLATE_NOT_USABLE");
  assertEquals(err.templateId, TID);
  assertEquals(err.usability.code, "manifest_version_stale");
  assertStringIncludes(err.message, TID);
  assertStringIncludes(err.message, "'v2'");
  assertStringIncludes(err.message, "'v3'");
});

Deno.test("gate: auto_validated with a null result (#1584 seed shape) is REFUSED", async () => {
  const sb = fakeClient([{ id: "4e70be64", contractor_id: "bb07fc40", trade: "roofing", funding_type: "retail", status: "auto_validated", validation_result: null, pdf_storage_path: "ci-test/placeholder.pdf" }]);
  const err = await assertRejects(() => assertContractorTemplateUsable(sb, "bb07fc40", "roofing", "retail"), TemplateNotUsableError);
  assertEquals(err.usability.code, "validation_result_missing");
  assertEquals(err.templateId, "4e70be64");
});

Deno.test("gate: a v3 row whose contract_price tag was not found is REFUSED naming the field", async () => {
  const vr = v3Result();
  // deno-lint-ignore no-explicit-any
  const price = vr.anchors.find((a: any) => String(a.anchor).endsWith(`|${CONTRACT_PRICE_FIELD_ID}}}`));
  price.found = false;
  vr.requiredFoundCount -= 1;
  vr.allRequiredFound = false;
  const sb = fakeClient([{ id: TID, contractor_id: "c1", trade: "roofing", funding_type: "retail", status: "auto_validated", validation_result: vr, pdf_storage_path: "x.pdf" }]);
  const err = await assertRejects(() => assertContractorTemplateUsable(sb, "c1", "roofing", "retail"), TemplateNotUsableError);
  assertEquals(err.usability.code, "required_fields_incomplete");
  assertStringIncludes(err.message, "Total contract amount");
});

Deno.test("gate: no row for the slot is REFUSED (no fall-through to the legacy JSONB/URL chain)", async () => {
  const sb = fakeClient([]);
  const err = await assertRejects(() => assertContractorTemplateUsable(sb, "c9", "roofing", "insurance"), TemplateNotUsableError);
  assertEquals(err.templateId, null);
  assertStringIncludes(err.message, "no contractor_templates row for contractor c9 slot roofing/insurance");
});

Deno.test("gate: a lookup error is a hard failure, not a pass", async () => {
  const sb = fakeClient(null, { message: "connection reset" });
  const err = await assertRejects(() => assertContractorTemplateUsable(sb, "c1", "roofing", "retail"), Error);
  assertStringIncludes(err.message, "contractor_templates lookup failed");
  assert(!(err instanceof TemplateNotUsableError));
});

Deno.test("sanity: the shared helper and the gate agree on the usable shape", () => {
  assertEquals(isTemplateUsable({ id: TID, status: "auto_validated", validation_result: v3Result() }, CURRENT_TEMPLATE_MANIFEST_VERSION, { requireFieldIds: [CONTRACT_PRICE_FIELD_ID] }).usable, true);
});
