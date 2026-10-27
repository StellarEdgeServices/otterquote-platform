// gh-3092: 3-day switch cutoff reads the winning quote's scope_summary start date.
// Run: deno test supabase/functions/switch-contractor/cutoff.test.ts
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { deriveEstimatedStartDate, isWithinCutoff } from "./cutoff.ts";

const now = new Date("2026-10-26T12:00:00Z");
const q = (d: string) => ({ scope_summary: JSON.stringify({ brand: "X", estimated_start_date: d }) });

Deno.test("start date inside 3 days -> within cutoff", () => {
  assertEquals(isWithinCutoff(deriveEstimatedStartDate(q("2026-10-28")), now), true);
  assertEquals(isWithinCutoff(deriveEstimatedStartDate(q("2026-10-27")), now), true);
});
Deno.test("start date outside 3 days -> not within cutoff", () => {
  assertEquals(isWithinCutoff(deriveEstimatedStartDate(q("2026-11-15")), now), false);
});
Deno.test("scope_summary as an object works", () => {
  assertEquals(deriveEstimatedStartDate({ scope_summary: { estimated_start_date: "2026-10-27" } }), "2026-10-27");
});
Deno.test("absent / garbage -> not within cutoff (allowed)", () => {
  for (const quote of [null, undefined, {}, { scope_summary: null }, { scope_summary: "" }, { scope_summary: "not json{" },
    { scope_summary: "null" }, { scope_summary: "{}" }, { scope_summary: { estimated_start_date: 5 } },
    { scope_summary: { estimated_start_date: "soon" } }]) {
    assertEquals(isWithinCutoff(deriveEstimatedStartDate(quote as never), now), false);
  }
});
Deno.test("no date -> false", () => {
  assertEquals(isWithinCutoff(null, now), false);
  assertEquals(isWithinCutoff(undefined, now), false);
});
