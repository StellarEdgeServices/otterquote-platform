/**
 * [#2862] Decking-price reconciliation. Uses a namespace import so that on main
 * (where the functions do not exist) the tests FAIL on an assertion -- "two
 * different numbers accepted" -- rather than only on a missing import.
 */
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as pv from "./price-verify.ts";

// deno-lint-ignore no-explicit-any
const m = pv as any;
const signers = (v: string | null) => [
  {
    formFields: [
      { id: "contract_price", value: "$13,560.00" },
      ...(v === null ? [] : [{ id: "decking_per_sheet", value: v }]),
    ],
  },
];
const disp = (v: string | null, exp: number | null) => {
  if (typeof m.deckingVerdictFor !== "function") return "ACCEPTED (no decking comparison exists)";
  return m.deckingDispositionFor(m.deckingVerdictFor(signers(v), exp));
};

Deno.test("gh-2862: a signed decking price that differs from the quote HALTS ($95 vs $75)", () => {
  assertEquals(disp("$95.00", 75), "halt");
});
Deno.test("gh-2862: an under-statement halts too", () => {
  assertEquals(disp("60", 75), "halt");
});
Deno.test("gh-2862: matching prices proceed, across currency formats", () => {
  assertEquals(disp("$75.00", 75), "proceed");
  assertEquals(disp(" 75 ", 75), "proceed");
  assertEquals(disp("$1,075.00", 1075), "proceed");
});
Deno.test("gh-2862: an unparseable typed value halts", () => {
  assertEquals(disp("TBD", 75), "halt");
});
Deno.test("gh-2862: blank/absent tab or NULL quote rate does NOT block signing (flag)", () => {
  assertEquals(disp(null, 75), "flag");
  assertEquals(disp("   ", 75), "flag");
  assertEquals(disp("$95", null), "flag");
  assertEquals(disp(null, null), "flag");
});

// Wiring: index.ts must call the decking gate, before the D-127 charge block.
const idx = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
Deno.test("gh-2862: index.ts wires the decking halt ahead of the D-127 charge", () => {
  const gate = idx.indexOf("deckingDispositionFor(deckingVerdict)");
  const charge = idx.indexOf("HANDLE PAYMENT CHARGING (D-127)");
  assertEquals(gate > -1, true, "decking gate not wired in index.ts");
  assertEquals(gate < charge, true, "decking gate must run before the charge block");
  assertEquals(idx.includes('defect: "decking_price_mismatch"'), true);
});
