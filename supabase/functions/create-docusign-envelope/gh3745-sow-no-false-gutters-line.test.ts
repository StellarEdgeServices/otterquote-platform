// [gh-3745] The signed SOW never prints "Gutters: No gutter work included" when gutters is a contracted trade or the bid carries gutter
// pricing/footage. No new wording: the line (and, if nothing else prints, the GUTTERS heading per #3744) is omitted.
// NEGATIVE CONTROL: against #3744's head (9ba9037e) the gutters-only fixtures fail (the false line prints); the roofing-only control passes on both.
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
const NONE = { gutters: { option: "none" } };

Deno.test("gutters-only job, option 'none' (the form default): no false 'No gutter work included', no empty GUTTERS heading", () => {
  const pdf = sow({ trades: ["gutters"], va: NONE });
  assert(!pdf.includes("No gutter work included"));
  assert(!has(pdf, "Gutters:"));
  assert(!has(pdf, "GUTTERS"), "nothing else prints, so no heading");
});

Deno.test("gutters-only job with bid gutter prices / footage and option 'none': line omitted", () => {
  for (const g of [{ gutter_5inch_price: 11 }, { gutter_6inch_price: 14 }, { gutters: { option: "none", linearFootage: 180 } }]) {
    const va = { gutters: { option: "none" }, ...g };
    assert(!sow({ trades: ["gutters"], va }).includes("No gutter work included"), JSON.stringify(g));
  }
});

Deno.test("roofing+gutters job, option 'none': line omitted; a bid gutter-guard line still prints under the heading", () => {
  const pdf = sow({ trades: ["roofing", "gutters"], va: { ...NONE, gutter_guards: { pricing_on_request: true } } });
  assert(!pdf.includes("No gutter work included"));
  assert(has(pdf, "GUTTERS") && has(pdf, "Gutter Guards:"));
});

Deno.test("CONTROL (unchanged by #3745): roofing-only job, option 'none': the GUTTERS block is gated on a gutters trade, so nothing prints, before and after", () => {
  const pdf = sow({ trades: ["roofing"], va: NONE });
  assert(!pdf.includes("No gutter work included"));
  assert(!has(pdf, "GUTTERS"));
  // The roofing-only render is byte-identical with and without a 'none' gutter option.
  assert(pdf === sow({ trades: ["roofing"], va: {} }));
});

Deno.test("CONTROL: gutters job with an included option still prints it", () => {
  assert(sow({ trades: ["gutters"], va: { gutters: { option: "6inch_included" } } }).includes('6" Gutters - Included'));
});
