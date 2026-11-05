// [gh-3288 / D-407 7/8] The cash Scope of Work (D-317 Exhibit A) carries the colour the homeowner selected, with no Project Confirmation.
// Today's code reads colour only from claims.project_confirmation, which nothing writes any more (#3300), so a claim with a saved colour and
// no PC prints no shingle line. NEGATIVE CONTROL: on the pre-change source mergeSowSelections does not exist and the wiring assertion fails.
// Wording: none added. The existing "Shingle:" label prints the value. Bad-decking / non-recoverable-depreciation initials and payment terms
// have no approved text and are deliberately NOT built here (see #3288 Q:).
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
  assert(src.includes("claimData.project_confirmation = mergeSowSelections(claimData.project_confirmation, claimData)"), "SOW builder must merge claim colour selection");
  assert(src.includes("projectConfirmation: d390Pc"), "SOW still receives the merged object");
});
