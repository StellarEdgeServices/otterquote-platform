// [gh-3747] The signed SOW's "Included in Your Price" entry "Complete gutter installation" prints only when the BID shows gutter work included
// (declarations.gutters.state === 'included', an included gutters option, or on a gutters-only job a bid gutter price/footage), never because the
// claim's trades list gutters. No new wording. NEGATIVE CONTROL: on the base (5cce035d) the not_offered / extra / other fixtures fail.
import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
function grab(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`not found: ${name}`);
  let depth = 0;
  const open = src.indexOf("{", start);
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced: ${name}`);
}
const names = ["base64EncodeBinary", "pitchOver12", "pitchRangeLabel", "bucketByBands", "contractorAuthoredMessage", "mergeSowSelections", "resolveMeasurementShape", "insurerScopeRows", "sowDripEdgeFromBid", "sowContingenciesRowExists", "generateRetailScopeOfWorkPdf"]
  .filter((n) => src.includes(`function ${n}(`));
const code = "// @ts-nocheck\n" + names.map((n) => grab(n).replace(`function ${n}`, `export function ${n}`)).join("\n");
// deno-lint-ignore no-explicit-any
const m = await import("data:application/typescript," + encodeURIComponent(code)) as any;

// deno-lint-ignore no-explicit-any
function sow(over: any): string {
  const pc = m.mergeSowSelections(null, { color_brand: "GAF", color_name: "Slate" }, "GAF");
  const b64 = m.generateRetailScopeOfWorkPdf({
    homeownerName: "Test Homeowner", contractorName: "Test Roofing", propertyAddress: "1 Main St", claimId: "abcdefgh12345678", trades: over.trades ?? ["roofing"],
    contractPrice: 12000, valueAdds: over.va ?? {}, declarations: over.declarations ?? null, bidBrand: "GAF", projectConfirmation: pc,
    measurements: over.measurements ?? null, deckingPricePerSheet: over.deckingPricePerSheet ?? null, fundingType: "retail", insurance: null,
  });
  return atob(b64);
}
const has = (pdf: string, label: string) => pdf.includes(`(${label})`);
const GUT = "Complete gutter installation";
const DRIP_INC = { drip_edge: { state: "included", rate_cents: null } };

Deno.test("roofing+gutters, gutters declared not_offered (drip edge included): 'Complete gutter installation' absent, exclusion and drip line kept", () => {
  const pdf = sow({ trades: ["roofing", "gutters"], va: { gutters: { option: "none" } }, declarations: { ...DRIP_INC, gutters: { state: "not_offered", rate_cents: null } } });
  assert(!has(pdf, GUT), "line must not print");
  assert(has(pdf, "Complete roofing installation"));
  assert(has(pdf, "Drip Edge - included at no extra cost"));
  assert(pdf.includes("No gutter work included"));
});

Deno.test("roofing+gutters, gutters declared extra / other: line absent", () => {
  for (const gutters of [{ state: "extra", rate_cents: 90000 }, { state: "other", rate_cents: null }]) {
    const pdf = sow({ trades: ["roofing", "gutters"], va: {}, declarations: { ...DRIP_INC, gutters } });
    assert(!has(pdf, GUT), gutters.state);
  }
});

Deno.test("roofing+gutters, no gutters declaration and no included option: line absent", () => {
  assert(!has(sow({ trades: ["roofing", "gutters"], va: { gutters: { option: "none" } }, declarations: DRIP_INC }), GUT));
  assert(!has(sow({ trades: ["roofing", "gutters"], va: { gutters: { option: "5inch_additional" } }, declarations: DRIP_INC }), GUT));
});

Deno.test("roofing+gutters, gutters declared included: line present (control)", () => {
  const pdf = sow({ trades: ["roofing", "gutters"], va: {}, declarations: { gutters: { state: "included", rate_cents: null } } });
  assert(has(pdf, GUT));
  assert(has(pdf, "Gutters - included at no extra cost"));
});

Deno.test("roofing+gutters, included gutters option with an unrelated declaration: line present (control)", () => {
  assert(has(sow({ trades: ["roofing", "gutters"], va: { gutters: { option: "6inch_included" } }, declarations: DRIP_INC }), GUT));
});

Deno.test("gutters-only bid with gutter prices (and a declared included row): line present (control)", () => {
  for (const va of [{ gutter_5inch_price: 11 }, { gutter_6inch_price: 14 }, { gutters: { option: "none", linearFootage: 180 } }]) {
    assert(has(sow({ trades: ["gutters"], va, declarations: DRIP_INC }), GUT), JSON.stringify(va));
  }
});

Deno.test("gutters-only claim with no gutter price, footage or included option: no gutter line, and never a roofing line in its place", () => {
  const pdf = sow({ trades: ["gutters"], va: { gutters: { option: "none" } }, declarations: DRIP_INC });
  assert(!has(pdf, GUT));
  assert(!has(pdf, "Complete roofing installation"));
});

Deno.test("CONTROL: roofing-only job's render is unchanged (byte-identical regardless of gutter fields; roofing line prints)", () => {
  const decl = DRIP_INC;
  const a = sow({ trades: ["roofing"], va: {}, declarations: decl });
  assert(has(a, "Complete roofing installation"));
  assert(!has(a, GUT));
  assert(a === sow({ trades: ["roofing"], va: { gutters: { option: "none" } }, declarations: decl }));
});

Deno.test("CONTROL: no recognised trade still falls back to the roofing line", () => {
  assert(has(sow({ trades: ["windows"], va: {}, declarations: DRIP_INC }), "Complete roofing installation"));
});
