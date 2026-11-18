// [gh-3751] On a multi-trade claim (roofing + siding) the signed SOW's "Complete siding installation" / "Complete roofing installation" print only
// from the bid's per-trade declaration (declarations.siding / declarations.roofing .state), same state values as gutters (gh-3747). No new wording.
// NEGATIVE CONTROL: on main (48235598) the siding-not-declared / not_offered / extra / other fixtures fail (the line printed from the claim's trades).
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
    homeownerName: "Test Homeowner", contractorName: "Test Roofing", propertyAddress: "1 Main St", claimId: "abcdefgh12345678", trades: over.trades ?? ["roofing", "siding"],
    contractPrice: 12000, valueAdds: over.va ?? {}, declarations: over.declarations ?? null, bidBrand: "GAF", projectConfirmation: pc,
    measurements: over.measurements ?? null, deckingPricePerSheet: null, fundingType: "retail", insurance: null,
  });
  return atob(b64);
}
const has = (pdf: string, label: string) => pdf.includes(`(${label})`);
const SID = "Complete siding installation";
const ROOF = "Complete roofing installation";
const DRIP_INC = { drip_edge: { state: "included", rate_cents: null } };

Deno.test("roofing+siding claim, roofing bid with no siding declaration: siding line absent, roofing line and drip row kept", () => {
  const pdf = sow({ declarations: DRIP_INC });
  assert(!has(pdf, SID), "siding line must not print");
  assert(has(pdf, ROOF));
  assert(has(pdf, "Drip Edge - included at no extra cost"));
});

Deno.test("roofing+siding claim, siding declared not_offered / extra / other: siding line absent", () => {
  for (const siding of [{ state: "not_offered", rate_cents: null }, { state: "extra", rate_cents: 90000 }, { state: "other", rate_cents: null }]) {
    const pdf = sow({ declarations: { ...DRIP_INC, siding } });
    assert(!has(pdf, SID), siding.state);
    assert(has(pdf, ROOF), siding.state);
  }
});

Deno.test("roofing+siding claim, siding declared included: both lines print (control)", () => {
  const pdf = sow({ declarations: { ...DRIP_INC, siding: { state: "included", rate_cents: null } } });
  assert(has(pdf, SID));
  assert(has(pdf, ROOF));
});

Deno.test("roofing+siding claim, roofing declared not_offered / extra / other (siding included): roofing line absent, siding line present", () => {
  for (const roofing of [{ state: "not_offered", rate_cents: null }, { state: "extra", rate_cents: 90000 }, { state: "other", rate_cents: null }]) {
    const pdf = sow({ declarations: { ...DRIP_INC, roofing, siding: { state: "included", rate_cents: null } } });
    assert(!has(pdf, ROOF), roofing.state);
    assert(has(pdf, SID), roofing.state);
  }
});

Deno.test("roofing+siding claim, neither declared roofing/siding: never falls back to the roofing line for a siding claim", () => {
  const pdf = sow({ declarations: { ...DRIP_INC, roofing: { state: "not_offered", rate_cents: null } } });
  assert(!has(pdf, SID));
  assert(!has(pdf, ROOF));
});

Deno.test("CONTROL: single-trade claims are unchanged (roofing-only and siding-only lines print without a per-trade declaration)", () => {
  assert(has(sow({ trades: ["roofing"], declarations: DRIP_INC }), ROOF));
  const s = sow({ trades: ["siding"], declarations: DRIP_INC });
  assert(has(s, SID));
  assert(!has(s, ROOF));
});

Deno.test("CONTROL: roofing-only job's render is byte-identical regardless of a siding declaration", () => {
  const a = sow({ trades: ["roofing"], declarations: DRIP_INC });
  assert(a === sow({ trades: ["roofing"], declarations: { ...DRIP_INC, siding: { state: "not_offered", rate_cents: null } } }));
});

Deno.test("CONTROL: no recognised trade still falls back to the roofing line", () => {
  assert(has(sow({ trades: ["windows"], declarations: DRIP_INC }), ROOF));
});

Deno.test("CONTROL: roofing+siding+gutters, gutters declared included, siding not declared: gutter line prints, siding line does not", () => {
  const pdf = sow({ trades: ["roofing", "siding", "gutters"], declarations: { gutters: { state: "included", rate_cents: null } } });
  assert(has(pdf, "Complete gutter installation"));
  assert(!has(pdf, SID));
});
