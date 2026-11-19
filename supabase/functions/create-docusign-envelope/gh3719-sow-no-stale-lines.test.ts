// [gh-3719 / D-407, default 1 on #3288] The signed SOW prints no line for a homeowner choice the contractor never bid.
//  (a) valleys, gutter guards and satellite dish no longer print from retired project-confirmation (pc) data;
//  (b) a drip-edge or chimney "see Contingencies" reference prints only when a matching Contingencies row exists in the same document.
// NEGATIVE CONTROL: on PR #3709's head (0c615ce2) the legacy-claim fixture prints Valleys / Gutter Guards / Satellite Dish from pc, and the
// no-breakdown fixture prints "see Contingencies" with no Contingencies row behind it. Both tests fail there and pass here.
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
// sowContingenciesRowExists is new in this change; load it only when present so the fixtures fail on ASSERTIONS (not on a missing symbol) against #3709's head.
const names = ["base64EncodeBinary", "pitchOver12", "pitchRangeLabel", "bucketByBands", "contractorAuthoredMessage", "mergeSowSelections", "resolveMeasurementShape", "insurerScopeRows", "sowDripEdgeFromBid", "sowContingenciesRowExists", "generateRetailScopeOfWorkPdf"]
  .filter((n) => src.includes(`function ${n}(`));
const code = "// @ts-nocheck\n" + names.map((n) => grab(n).replace(`function ${n}`, `export function ${n}`)).join("\n");
// deno-lint-ignore no-explicit-any
const m = await import("data:application/typescript," + encodeURIComponent(code)) as any;

// deno-lint-ignore no-explicit-any
function sow(over: any): string {
  const pc = m.mergeSowSelections(over.pc ?? null, { color_brand: "GAF", color_name: "Slate" }, "GAF");
  const b64 = m.generateRetailScopeOfWorkPdf({
    homeownerName: "Test Homeowner", contractorName: "Test Roofing", propertyAddress: "1 Main St", claimId: "abcdefgh12345678", trades: over.trades ?? ["roofing"],
    contractPrice: 12000, valueAdds: over.va ?? {}, declarations: over.declarations ?? null, bidBrand: "GAF", projectConfirmation: pc, measurements: null,
    fundingType: "retail", insurance: null,
  });
  return atob(b64);
}
const has = (pdf: string, label: string) => pdf.includes(`(${label})`);

// Fixture 1: legacy claim carrying old project-confirmation valley / gutter-guard / satellite-dish data. The bid carries none of the three.
const LEGACY_PC = { valleyType: "open", gutterGuards: "Mesh guards", satelliteDish: "REMOVE-RESET" };

Deno.test("legacy claim: old PC valleys, gutter guards and satellite dish are not printed", () => {
  const pdf = sow({ pc: LEGACY_PC, va: { drip_edge: { option: "included_black" } } });
  assert(!has(pdf, "Valleys:"), "Valleys line must not print from retired PC data");
  assert(!has(pdf, "Gutter Guards:"), "Gutter Guards line must not print from retired PC data");
  assert(!has(pdf, "Satellite Dish:"), "Satellite Dish line must not print from retired PC data");
  assert(!pdf.includes("Open / Metal") && !pdf.includes("Mesh guards") && !pdf.includes("Remove & reset after install"));
  // The rest of the SOW is untouched: colour and the bid's drip edge still print.
  assert(has(pdf, "Shingle:") && has(pdf, "GAF - Slate") && has(pdf, "Drip Edge:") && has(pdf, "Black - Included"));
});

Deno.test("legacy claim with a closed-cut valley and discard dish: still nothing from PC", () => {
  const pdf = sow({ pc: { valleyType: "closed", gutterGuards: "Screw-in", satelliteDish: "REMOVE-TRASH" } });
  assert(!has(pdf, "Valleys:") && !has(pdf, "Gutter Guards:") && !has(pdf, "Satellite Dish:"));
});

Deno.test("if the BID carries gutter guards, they still print from the bid (GUTTERS), never from PC", () => {
  const pdf = sow({ pc: LEGACY_PC, trades: ["gutters"], va: { gutter_guards: { mesh_oop: 800 } } });
  assert(has(pdf, "Gutter Guards:") && has(pdf, "Available at homeowner cost - see Contingencies"), "bid gutter guards print");
  assert(!pdf.includes("Mesh guards"), "PC value not printed");
  assert(!has(pdf, "Valleys:") && !has(pdf, "Satellite Dish:"));
});

// Fixture 2: a bid with no included/extra breakdown (no declarations: pre-gh-1377 or React bid form) that marks drip edge and chimney out-of-pocket.
Deno.test("no-breakdown bid, drip edge + chimney out-of-pocket: no 'see Contingencies' with nothing behind it", () => {
  const pdf = sow({ va: { drip_edge: { option: "oop", oop_price: 300 }, chimney: { option: "oop", oop_price: 500 } }, declarations: null });
  assert(pdf.includes("included / extra breakdown is not yet available"), "document shows the existing no-breakdown note");
  assert(!pdf.includes("Extra Charges If Needed"), "and has no Contingencies rows");
  assert(!has(pdf, "Drip Edge:"), "drip-edge reference omitted");
  assert(!has(pdf, "Chimney Flashing:"), "chimney reference omitted");
  assert(!pdf.includes("see Contingencies"), "no cross-reference to nothing");
});

Deno.test("no-breakdown bid: chimney replace_oop is omitted too; non-reference chimney values still print", () => {
  assert(!has(sow({ va: { chimney: { option: "replace_oop" } } }), "Chimney Flashing:"));
  const pdf = sow({ va: { chimney: { option: "reuse" }, drip_edge: { option: "included_white" } } });
  assert(has(pdf, "Chimney Flashing:") && has(pdf, "Reuse existing") && has(pdf, "White - Included"));
});

Deno.test("declarations present but no extra row with a rate (state extra, no rate; or not_offered): reference omitted", () => {
  const pdf = sow({
    va: { drip_edge: { option: "oop" }, chimney: { option: "oop" } },
    declarations: { drip_edge: { state: "extra" }, chimney: { state: "not_offered" } },
  });
  assert(!has(pdf, "Drip Edge:") && !has(pdf, "Chimney Flashing:") && !pdf.includes("see Contingencies"));
});

Deno.test("breakdown present with matching extra rows: the reference prints AND the Contingencies rows exist", () => {
  const pdf = sow({
    va: { drip_edge: { option: "oop", oop_price: 300 }, chimney: { option: "oop", oop_price: 500 } },
    declarations: { drip_edge: { state: "extra", rate_cents: 30000 }, chimney: { state: "extra", rate_cents: 50000 } },
  });
  assert(has(pdf, "Drip Edge:") && has(pdf, "Chimney Flashing:"));
  assertEquals(pdf.split("Homeowner out-of-pocket option - see Contingencies").length - 1, 2);
  assert(pdf.includes("Extra Charges If Needed"));
  // Table rows (the trigger text wraps and escapes parentheses in the PDF stream, so match the row names and trigger openers).
  assert(has(pdf, "Drip Edge") && pdf.includes("Homeowner elects drip edge"), "drip-edge Contingencies row");
  assert(has(pdf, "Chimney Flashing") && pdf.includes("Homeowner elects chimney flashing work"), "chimney Contingencies row");
});

// Gutters out-of-pocket ("see Contingencies") follows the same rule.
Deno.test("gutters oop, no breakdown: line omitted; with a matching extra row with a rate: line and row both present", () => {
  const va = { gutters: { option: "5inch_additional" } };
  const none = sow({ trades: ["gutters"], va, declarations: null });
  assert(!has(none, "Gutters:") && !none.includes("see Contingencies"), "no cross-reference to nothing");
  const norate = sow({ trades: ["gutters"], va, declarations: { gutters: { state: "extra" } } });
  assert(!has(norate, "Gutters:"));
  const ok = sow({ trades: ["gutters"], va, declarations: { gutters: { state: "extra", rate_cents: 120000 } } });
  assert(has(ok, "Gutters:") && ok.includes("homeowner out-of-pocket, see Contingencies"));
  assert(ok.includes("Extra Charges If Needed") && ok.includes("Homeowner elects gutters upgrade"));
  // non-reference gutter values still print without any breakdown
  assert(has(sow({ trades: ["gutters"], va: { gutters: { option: "6inch_included" } } }), "Gutters:"));
});
