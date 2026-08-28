// [Part 2, 2026-08-28] Cover for the four Exhibit A measurement shapes.
//
// resolveMeasurementShape and insurerScopeRows are not exported (the function
// is a single-file EF), so this test extracts them from the source the same way
// parse-hover-measurements/parse-roof-summary.test.ts does. That keeps the
// production file unchanged and still exercises the real implementations.
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
const mod = [
  grab("resolveMeasurementShape").replace("function resolveMeasurementShape", "export function resolveMeasurementShape"),
  grab("insurerScopeRows").replace("function insurerScopeRows", "export function insurerScopeRows"),
].join("\n\n");
const url = "data:application/typescript," + encodeURIComponent(mod);
// deno-lint-ignore no-explicit-any
const { resolveMeasurementShape, insurerScopeRows } = await import(url) as any;

// The live hover_measurements on claim 73208937 (Paulsen / Indy Rooftops),
// read from production 2026-08-28. A Hover report: linear measurements present.
const FULL_HOVER = {
  roofSqFt: 2260, squares: 22.6, roofAreaSf: 2260,
  ridgeHipLf: 91.17, valleyLf: 99.67, rakeLf: 226.25, eaveLf: 86.67,
  dripEdgeLf: 312.92, stepFlashingLf: 55.83, flashingLf: 24.33,
  predominantPitch: "9/12", areasByPitch: null,
};

// RoofScope X, from the real reference report: per-pitch table and total
// squares, and NOT ONE linear measurement. Note the colon pitch notation.
const BASIC_ROOFSCOPE_X = {
  roofSqFt: 6305, squares: 63.05, roofAreaSf: 6305,
  ridgeHipLf: null, valleyLf: null, rakeLf: null, eaveLf: null,
  dripEdgeLf: null, stepFlashingLf: null, flashingLf: null,
  predominantPitch: "10:12",
  areasByPitch: [
    { pitch: "1:12", squares: 0.55 }, { pitch: "3:12", squares: 0.90 },
    { pitch: "4:12", squares: 10.09 }, { pitch: "5:12", squares: 4.60 },
    { pitch: "6:12", squares: 1.00 }, { pitch: "10:12", squares: 43.11 },
    { pitch: "24:12", squares: 2.80 },
  ],
};

Deno.test("shape: a full report with linear measurements resolves to full", () => {
  assertEquals(resolveMeasurementShape(FULL_HOVER), "full");
});

Deno.test("shape: RoofScope X (areas only, zero linear) resolves to basic", () => {
  assertEquals(resolveMeasurementShape(BASIC_ROOFSCOPE_X), "basic");
});

Deno.test("shape: ONE linear measurement is enough to make a report full", () => {
  // Guards the boundary in both directions: this is the difference between
  // rendering seven LF rows and suppressing them.
  assertEquals(resolveMeasurementShape({ squares: 30, eaveLf: 12 }), "full");
  assertEquals(resolveMeasurementShape({ squares: 30 }), "basic");
});

Deno.test("shape: area alone from a pitch table, with no total, is still basic", () => {
  assertEquals(
    resolveMeasurementShape({ areasByPitch: [{ pitch: "6:12", squares: 12 }] }),
    "basic",
  );
});

Deno.test("shape: nothing on the claim resolves to none, and so does an empty object", () => {
  assertEquals(resolveMeasurementShape(null), "none");
  assertEquals(resolveMeasurementShape(undefined), "none");
  assertEquals(resolveMeasurementShape({}), "none");
  // An all-null measurement row is what a failed parse leaves behind. It must
  // NOT read as basic, or Exhibit A claims a report it does not have.
  assertEquals(
    resolveMeasurementShape({ squares: null, roofAreaSf: null, eaveLf: null, areasByPitch: [] }),
    "none",
  );
});

Deno.test("insurer rows: parse-loss-sheet sections flatten, section label included", () => {
  const rows = insurerScopeRows({
    parsedLineItems: {
      sections: [
        {
          section_name: "ROOFPLAN",
          area_name: "Roof",
          line_items: [
            { description: "Remove Comp Shingles", quantity: 24.85, unit: "SQ", unit_price: 61.2, notes: "" },
            { description: "Ice & water barrier", quantity: 186.33, unit: "SF", unit_price: 1.9, notes: "10% waste" },
          ],
        },
        { section_name: "EXTERIOR PLAN", area_name: null, line_items: [
          { description: "R&R Gutter", quantity: 86.67, unit: "LF" },
        ] },
      ],
    },
  });
  assertEquals(rows?.length, 3);
  assertEquals(rows?.[0].section, "ROOFPLAN - Roof");
  assertEquals(rows?.[0].quantity, "24.85");
  assertEquals(rows?.[1].notes, "10% waste");
  assertEquals(rows?.[2].section, "EXTERIOR PLAN");
  // The insurer's unit_price is deliberately NOT carried through: it is not the
  // contract price and must never reach the page beside one.
  assertEquals(Object.hasOwn(rows![0], "unit_price"), false);
});

Deno.test("insurer rows: legacy key names and a missing quantity survive", () => {
  const rows = insurerScopeRows({
    parsedLineItems: { sections: [{ name: "SHINGLES", items: [{ description: "Ridge cap" }] }] },
  });
  assertEquals(rows?.length, 1);
  assertEquals(rows?.[0].section, "SHINGLES");
  assertEquals(rows?.[0].quantity, "per estimate");
});

Deno.test("insurer rows: no loss sheet returns null, and so does an empty one", () => {
  // null is load-bearing: it is what makes the caller pick the derived basis
  // rather than render an empty insurer table.
  assertEquals(insurerScopeRows(null), null);
  assertEquals(insurerScopeRows({ parsedLineItems: null }), null);
  assertEquals(insurerScopeRows({ parsedLineItems: { sections: [] } }), null);
  assertEquals(insurerScopeRows({ parsedLineItems: { sections: [{ section_name: "X", line_items: [] }] } }), null);
  // A line item with no description is not a line item.
  assertEquals(
    insurerScopeRows({ parsedLineItems: { sections: [{ section_name: "X", line_items: [{ quantity: 3 }] }] } }),
    null,
  );
});
