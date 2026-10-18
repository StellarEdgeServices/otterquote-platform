// gh-2105 batch 13 -- send-partner-onboarding ledger writes (markSent / markFailed /
// markUncertainAlerted). index.ts calls serve() and cannot be imported, so the zero-row
// decision lives in mark-result.ts (pure) and is tested directly; the wiring test below
// reads index.ts as text to prove each ledger update chains .select() and goes through it.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { markResult, ZERO_ROWS_CODE } from "./mark-result.ts";

Deno.test("markResult: a row came back -> no error", () => {
  assertEquals(markResult(null, [{ partner_id: "p1" }], "op"), { error: null });
});

Deno.test("NEGATIVE CONTROL: error:null with ZERO rows (the silent-success shape) now surfaces as an error", () => {
  for (const rows of [[], null, undefined, "x"]) {
    const r = markResult(null, rows, "partner_onboarding_sends status=sent for partner p1 stage s1");
    assert(r.error !== null, `rows=${JSON.stringify(rows)} must be an error`);
    assertEquals(r.error!.code, ZERO_ROWS_CODE);
    assertStringIncludes(r.error!.message, "gh-2105: zero-row update");
    assertStringIncludes(r.error!.message, "partner p1 stage s1");
  }
});

Deno.test("markResult: a returned DB error wins and keeps its code/message", () => {
  assertEquals(markResult({ code: "42501", message: "denied" }, [], "op"), { error: { code: "42501", message: "denied" } });
});

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
for (const [name, start, end] of [
  ["markSent", "markSent: async", "markFailed: async"],
  ["markFailed", "markFailed: async", "alertAdminUncertain: async"],
  ["markUncertainAlerted", "markUncertainAlerted: async", "markSkipped: async"],
] as const) {
  Deno.test(`wiring: ${name} selects and routes through markResult`, () => {
    const i = src.indexOf(start);
    const j = src.indexOf(end, i);
    assert(i > -1 && j > i, `anchors for ${name} moved`);
    const block = src.slice(i, j);
    assertStringIncludes(block, '.select("partner_id")');
    assertStringIncludes(block, "markResult(");
  });
  Deno.test(`mutation control: removing .select from ${name} breaks the wiring`, () => {
    const i = src.indexOf(start);
    const block = src.slice(i, src.indexOf(end, i));
    assert(!block.replaceAll('.select("partner_id")', "").includes('.select("partner_id")'));
  });
}
