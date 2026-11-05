// [gh-3288 / D-407 7/8] The cash Scope of Work (D-317 Exhibit A) carries the colour the homeowner selected, with no Project Confirmation.
// Today's code reads colour only from claims.project_confirmation, which nothing writes any more (#3300), so a claim with a saved colour and
// no PC prints no shingle line. NEGATIVE CONTROL: on the pre-change source mergeSowSelections does not exist and the wiring assertion fails.
// Wording: none added. The existing "Shingle:" label prints the value. Bad-decking / non-recoverable-depreciation initials and payment terms
// have no approved text and are deliberately NOT built here (see #3288 Q:).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { redactSowTextOrRefuse, RedactionUnavailableError } from "../_shared/homeowner-text-redact.ts";

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
const code = "// @ts-nocheck\n" + grab("mergeSowSelections").replace("function mergeSowSelections", "export function mergeSowSelections");
// deno-lint-ignore no-explicit-any
const { mergeSowSelections } = await import("data:application/typescript," + encodeURIComponent(code)) as any;

Deno.test("a saved colour and no PC yields the Shingle line inputs", () => {
  const pc = mergeSowSelections(null, { color_brand: "GAF", color_name: "Charcoal" });
  assertEquals(pc.shingleManufacturer, "GAF");
  assertEquals(pc.shingleColor, "Charcoal");
});

Deno.test("no saved colour and no PC stays null (no invented line)", () => {
  assertEquals(mergeSowSelections(null, { color_name: "  ", color_brand: "GAF" }), null);
  assertEquals(mergeSowSelections(undefined, {}), null);
});

Deno.test("legacy PC data is kept for history and fills what the selection lacks", () => {
  const pc = mergeSowSelections({ shingleColor: "Old", shingleManufacturer: "CertainTeed", dripEdgeColor: "White" }, { color_name: "Slate" });
  assertEquals(pc.shingleColor, "Slate");
  assertEquals(pc.shingleManufacturer, "CertainTeed");
  assertEquals(pc.dripEdgeColor, "White");
});

Deno.test("the retail/insurance Scope of Work input is built from the merged selections", () => {
  assert(src.includes("claimData.project_confirmation = mergeSowSelections(claimData.project_confirmation, claimData, bidBrand)"), "SOW builder must merge claim colour selection");
  assert(src.includes("projectConfirmation: d390Pc"), "SOW still receives the merged object");
});

// ---- review 6668152181: run the real handler block (merge + D-390 redaction) against a claim --------------------------------------------------
const bStart = src.indexOf("if (claimData) claimData.project_confirmation = mergeSowSelections(");
const bEnd = src.indexOf("        : null;", bStart) + "        : null;".length;
assert(bStart > -1 && bEnd > bStart, "handler block moved; update this test's anchors");
const blockSrc = "// @ts-nocheck\n" + grab("mergeSowSelections").replace("function mergeSowSelections", "export function mergeSowSelections") +
  "\nexport function build(claimData, bidBrand, d390FeeCollected, redactSowTextOrRefuse) {\n" + src.slice(bStart, bEnd) + "\nreturn d390Pc;\n}\n";
// deno-lint-ignore no-explicit-any
const { build } = await import("data:application/typescript," + encodeURIComponent(blockSrc)) as any;
const PHONE = "317-555-0142", EMAIL = "jane@example.com";

Deno.test("F1: a phone number and e-mail typed into the colour are removed before the fee and print after it", () => {
  const claim = () => ({ color_brand: "GAF", color_name: `Charcoal call ${PHONE} ${EMAIL}`, project_confirmation: null });
  const before = build(claim(), "GAF", false, redactSowTextOrRefuse);
  assert(!before.shingleColor.includes(PHONE) && !before.shingleColor.includes(EMAIL), `unredacted: ${before.shingleColor}`);
  assert(before.shingleColor.startsWith("Charcoal call"));
  assertEquals(build(claim(), "GAF", true, redactSowTextOrRefuse).shingleColor, `Charcoal call ${PHONE} ${EMAIL}`);
});

Deno.test("F1: the saved brand is redacted too", () => {
  const out = build({ color_brand: `GAF ${PHONE}`, color_name: "Slate", project_confirmation: null }, "GAF", false, redactSowTextOrRefuse);
  assert(!out.shingleManufacturer.includes(PHONE));
});

Deno.test("F1: a redaction failure still refuses (never prints raw)", () => {
  const boom = () => { throw new RedactionUnavailableError("boom"); };
  let threw = false;
  try { build({ color_name: "Slate", project_confirmation: null }, null, false, boom); } catch (e) { threw = e instanceof RedactionUnavailableError; }
  assert(threw);
});

Deno.test("F2: a saved brand that disagrees with the bid brand prints no Shingle selection", () => {
  assertEquals(mergeSowSelections(null, { color_brand: "GAF", color_name: "Charcoal" }, "Owens Corning"), null);
  assertEquals(build({ color_brand: "GAF", color_name: "Charcoal", project_confirmation: null }, "Owens Corning", true, redactSowTextOrRefuse), null);
});

Deno.test("F2: matching, containing or unknown bid brands still print the selection", () => {
  assertEquals(mergeSowSelections(null, { color_brand: "GAF", color_name: "Charcoal" }, "GAF Timberline")?.shingleColor, "Charcoal");
  assertEquals(mergeSowSelections(null, { color_brand: "gaf", color_name: "Charcoal" }, "GAF")?.shingleColor, "Charcoal");
  assertEquals(mergeSowSelections(null, { color_brand: "GAF", color_name: "Charcoal" }, null)?.shingleColor, "Charcoal");
});
