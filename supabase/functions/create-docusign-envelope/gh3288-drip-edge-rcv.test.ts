// [gh-3288 / D-407 7/8, defaults 1 and 5 accepted by Dustin 2026-11-05, issue comment 6668572026] The ONE signed document per route (RCV, ACV->OOP, OOP) carries
// colour and drip edge in the Scope of Work (Exhibit A) itself: drip edge prints from the contractor's bid (value_adds.drip_edge), not from a homeowner
// colour that nothing collects any more. No new contract wording: the existing line layout is reused.
// NEGATIVE CONTROL: on main, sowDripEdgeFromBid does not exist (grab() throws "not found") and the SOW prints "Drip Edge Color:" from pc.dripEdgeColor
// only, so a bid-only drip edge prints nothing.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

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
const names = ["base64EncodeBinary", "pitchOver12", "pitchRangeLabel", "bucketByBands", "contractorAuthoredMessage", "mergeSowSelections", "resolveMeasurementShape", "insurerScopeRows", "sowDripEdgeFromBid", "generateRetailScopeOfWorkPdf"];
const code = "// @ts-nocheck\n" + names.map((n) => grab(n).replace(`function ${n}`, `export function ${n}`)).join("\n");
// deno-lint-ignore no-explicit-any
const m = await import("data:application/typescript," + encodeURIComponent(code)) as any;

// deno-lint-ignore no-explicit-any
function sow(over: any): string {
  const claim = { color_brand: "GAF", color_name: "Slate", ...(over.claim ?? {}) };
  const pc = m.mergeSowSelections(over.pc ?? null, claim, "GAF");
  const b64 = m.generateRetailScopeOfWorkPdf({
    homeownerName: "Test Homeowner", contractorName: "Test Roofing", propertyAddress: "1 Main St", claimId: "abcdefgh12345678", trades: ["roofing"],
    contractPrice: 12000, valueAdds: over.va ?? {}, declarations: null, bidBrand: "GAF", projectConfirmation: pc, measurements: null,
    fundingType: over.fundingType ?? "retail", insurance: over.insurance ?? null,
  });
  return atob(b64);
}

Deno.test("helper: each bid option maps to a line, na and missing print nothing", () => {
  assertEquals(m.sowDripEdgeFromBid({ drip_edge: { option: "included_black" } }), "Black - Included");
  assertEquals(m.sowDripEdgeFromBid({ drip_edge: { option: "included_white" } }), "White - Included");
  assertEquals(m.sowDripEdgeFromBid({ drip_edge: { option: "included_custom" } }), "Custom color / special order - Included");
  assertEquals(m.sowDripEdgeFromBid({ drip_edge: { option: "oop", oop_price: 300 } }), "Homeowner out-of-pocket option - see Contingencies");
  assertEquals(m.sowDripEdgeFromBid({ drip_edge: { option: "na" } }), null);
  assertEquals(m.sowDripEdgeFromBid({}), null);
  assertEquals(m.sowDripEdgeFromBid(null), null);
  assertEquals(m.sowDripEdgeFromBid({ drip_edge: { option: "constructor" } }), null);
});

for (const [route, fundingType, insurance] of [
  ["RCV", "insurance", { rcv: 20000, acv: 15000, deductible: 1000 }],
  ["ACV to OOP (cash job)", "retail", null],
  ["OOP", "retail", null],
] as const) {
  Deno.test(`${route}: one SOW carries colour and the bid's drip edge together`, () => {
    const pdf = sow({ fundingType, insurance, va: { drip_edge: { option: "included_white" } } });
    assert(pdf.includes("(Shingle:)") && pdf.includes("(GAF - Slate)"), "saved colour on the Shingle line");
    assert(pdf.includes("(Drip Edge:)") && pdf.includes("(White - Included)"), "drip edge from the bid");
    assert(!pdf.includes("Drip Edge Color:"), "no homeowner drip-edge colour line");
  });
}

Deno.test("a legacy pc.dripEdgeColor is no longer printed; the bid value wins", () => {
  const pdf = sow({ pc: { dripEdgeColor: "Purple" }, va: { drip_edge: { option: "included_black" } } });
  assert(!pdf.includes("Purple"), "legacy homeowner colour not printed");
  assert(pdf.includes("(Black - Included)"));
});

Deno.test("bid says na or nothing: no drip-edge line at all (even with a legacy pc colour)", () => {
  assert(!sow({ pc: { dripEdgeColor: "Purple" }, va: { drip_edge: { option: "na" } } }).includes("(Drip Edge:)"));
  assert(!sow({ va: {} }).includes("(Drip Edge:)"));
});
