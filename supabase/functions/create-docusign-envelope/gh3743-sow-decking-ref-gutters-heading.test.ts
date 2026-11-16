// [gh-3743, follow-up to #3719/#3724] Two signed-SOW accuracy fixes, no new wording:
//  (1) the "Decking replacement allowance ... See Contingencies" line prints the reference only when the bid carries a decking price (> 0),
//      i.e. only when the Contingencies table really has the "Decking replacement" row (the bid form turns an entered 0 into null);
//  (2) a GUTTERS heading is not printed when every gutters line under it is omitted.
// NEGATIVE CONTROL: against main's index.ts (31dae5e3) the null-decking-price fixture still prints "See Contingencies" and the
// gutters-oop-without-breakdown fixture still prints the GUTTERS heading. Both fail there and pass here.
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
const MEAS = { roofAreaSf: 2400, squares: 24 }; // "basic" measurement shape: the derived Work Item table (with the decking line) renders

// ---- (1) decking "See Contingencies" ----
Deno.test("null decking price: the decking line stays (qty, unit) but prints no 'See Contingencies', and there is no Decking row to point at", () => {
  const pdf = sow({ measurements: MEAS, deckingPricePerSheet: null });
  assert(has(pdf, "Decking replacement allowance"), "line is still present");
  assert(!has(pdf, "See Contingencies"), "no reference to a row that does not exist");
  assert(!has(pdf, "Decking replacement"), "and the Contingencies table has no decking row");
});

Deno.test("decking price of 0 (never stored by the form, but): no reference", () => {
  assert(!has(sow({ measurements: MEAS, deckingPricePerSheet: 0 }), "See Contingencies"));
});

Deno.test("decking price > 0: the reference prints AND the Contingencies decking row exists", () => {
  const pdf = sow({ measurements: MEAS, deckingPricePerSheet: 95 });
  assert(has(pdf, "Decking replacement allowance") && has(pdf, "See Contingencies"));
  assert(has(pdf, "Decking replacement") && pdf.includes("per sheet"), "Contingencies row carries the price");
});

// ---- (2) empty GUTTERS heading ----
Deno.test("gutters job, out-of-pocket gutters, no breakdown: every gutters line is omitted, so the GUTTERS heading is too", () => {
  const pdf = sow({ trades: ["gutters"], va: { gutters: { option: "5inch_additional" } }, declarations: null });
  assert(!has(pdf, "Gutters:"), "reference line omitted (existing behaviour)");
  assert(!has(pdf, "GUTTERS"), "no heading with nothing under it");
  assert(!pdf.includes("see Contingencies"));
});

Deno.test("gutters job with nothing bid at all: no GUTTERS heading", () => {
  assert(!has(sow({ trades: ["gutters"], va: {}, declarations: null }), "GUTTERS"));
});

Deno.test("controls: any printed gutters line keeps the heading (included, none, bid guards, matching extra row)", () => {
  for (const va of [{ gutters: { option: "6inch_included" } }, { gutters: { option: "none" } }, { gutter_guards: { pricing_on_request: true } }, { gutter_guards: { mesh_oop: 800 } }]) {
    const pdf = sow({ trades: ["gutters"], va, declarations: null });
    assert(has(pdf, "GUTTERS"), `heading present for ${JSON.stringify(va)}`);
  }
  const pdf = sow({ trades: ["gutters"], va: { gutters: { option: "5inch_additional" } }, declarations: { gutters: { state: "extra", rate_cents: 120000 } } });
  assert(has(pdf, "GUTTERS") && has(pdf, "Gutters:") && pdf.includes("homeowner out-of-pocket, see Contingencies"));
});
