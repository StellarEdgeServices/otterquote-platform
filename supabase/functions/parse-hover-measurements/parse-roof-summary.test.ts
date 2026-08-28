// [C4, 2026-08-27] Regression cover for the areas_by_pitch breakout.
//
// parseRoofSummary is not exported (the function is a single-file EF), so this
// test extracts it from the source the same way the render harness does. That
// keeps the production file unchanged and still exercises the real regex.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

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
const mod = grab("parseRoofSummary").replace("function parseRoofSummary", "export function parseRoofSummary");
const url = "data:application/typescript," + encodeURIComponent(mod);
// deno-lint-ignore no-explicit-any
const { parseRoofSummary } = await import(url) as any;

// Hover ROOF SUMMARY shape, mixed pitch. Cell order is the one unpdf produces
// after whitespace collapse: "<label> <count> <length>" then the pitch rows.
const MIXED = `
Roof Facets 4,150 ft
Ridges / Hips - 7 91' 2"
Valleys - 4 99' 8"
Rakes - 9 226' 3"
Eaves - 5 86' 8"
Flashing - 2 24' 4"
Step Flashing - 3 55' 10"
Drip Edge / Perimeter - 12 312' 11"
4 / 12 1,009 ft 24 %
6 / 12 100 ft 2 %
10 / 12 2,761 ft 67 %
24 / 12 280 ft 7 %
ROOF SUMMARY
`;

Deno.test("areas_by_pitch captures every pitch row, not just the winner", () => {
  const out = parseRoofSummary(MIXED);
  assertEquals(out.predominant_pitch, "10/12");
  assertEquals(out.areas_by_pitch?.length, 4);
  assertEquals(out.areas_by_pitch?.map((r: { pitch: string }) => r.pitch), ["4/12", "6/12", "10/12", "24/12"]);
  assertEquals(out.areas_by_pitch?.[2], { pitch: "10/12", area_sf: 2761, squares: 27.61, pct: 67 });
});

Deno.test("the existing roofline fields still parse (no regression)", () => {
  const out = parseRoofSummary(MIXED);
  assertEquals(out.roof_area_sf, 4150);
  assertEquals(out.squares, 41.5);
  assertEquals(out.ridge_hip_lf, 91.17);
  assertEquals(out.valley_lf, 99.67);
  assertEquals(out.rake_lf, 226.25);
  assertEquals(out.eave_lf, 86.67);
  assertEquals(out.drip_edge_perimeter_lf, 312.92);
});

Deno.test("areas_by_pitch is null, not [], when no pitch table is present", () => {
  const out = parseRoofSummary("Roof Facets 2,260 ft\nEaves - 5 86' 8\"\nROOF SUMMARY\n");
  assertEquals(out.areas_by_pitch, null);
  assertEquals(out.predominant_pitch, null);
});

Deno.test("an image-only PDF (RoofScope) yields nothing rather than guessing", () => {
  // unpdf returns "" for RoofScope/RoofScope X -- verified 2026-08-27. The
  // parser must degrade to all-nulls so the caller reports an honest miss.
  const out = parseRoofSummary("");
  assertEquals(out.roof_area_sf, null);
  assertEquals(out.areas_by_pitch, null);
});
