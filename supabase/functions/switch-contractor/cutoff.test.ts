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

// gh-3350: day three is open. Start date S: allowed through 23:59:59 Central on S-3, closed from 00:00 Central on S-2.
// 2026-10-26 is CDT (UTC-5), so 00:00 Central on Oct 26 is 05:00Z.
Deno.test("gh-3350: start date exactly 3 days out is NOT within the cutoff, at any time of day", () => {
  const start = deriveEstimatedStartDate(q("2026-10-29"));
  for (const iso of ["2026-10-26T05:00:00Z", "2026-10-26T12:00:00Z", "2026-10-26T23:59:00Z", "2026-10-27T04:59:59Z"]) {
    assertEquals(isWithinCutoff(start, new Date(iso)), false, iso);
  }
});
Deno.test("gh-3350: the cutoff closes at 00:00 Central on day S-2", () => {
  const start = deriveEstimatedStartDate(q("2026-10-29"));
  assertEquals(isWithinCutoff(start, new Date("2026-10-27T04:59:59Z")), false); // 23:59:59 Central, Oct 26
  assertEquals(isWithinCutoff(start, new Date("2026-10-27T05:00:00Z")), true); // 00:00:00 Central, Oct 27
  assertEquals(isWithinCutoff(start, new Date("2026-10-28T12:00:00Z")), true);
});
Deno.test("gh-3350: 2 days out, the start day itself and a past start date are all closed; 4 days out is open", () => {
  const n = new Date("2026-10-26T12:00:00Z");
  assertEquals(isWithinCutoff("2026-10-28", n), true);
  assertEquals(isWithinCutoff("2026-10-26", n), true);
  assertEquals(isWithinCutoff("2026-10-20", n), true);
  assertEquals(isWithinCutoff("2026-10-30", n), false);
});
Deno.test("gh-3350: the boundary holds across the November 1 clock change", () => {
  // 2026-11-04 start: day three is Nov 1 (clocks go back at 02:00 that day), so Nov 1 stays open all day (00:00 CDT = 05:00Z,
  // 23:59 CST = Nov 2 05:59Z) and Nov 2 00:00 CST (06:00Z) is closed.
  assertEquals(isWithinCutoff("2026-11-04", new Date("2026-11-01T05:00:00Z")), false);
  assertEquals(isWithinCutoff("2026-11-04", new Date("2026-11-02T05:59:59Z")), false);
  assertEquals(isWithinCutoff("2026-11-04", new Date("2026-11-02T06:00:00Z")), true);
});
Deno.test("gh-3350: a full timestamp start date is read as its Central calendar day; an impossible date allows the switch", () => {
  assertEquals(isWithinCutoff("2026-10-29T15:00:00Z", new Date("2026-10-26T12:00:00Z")), false);
  assertEquals(isWithinCutoff("2026-10-28T15:00:00Z", new Date("2026-10-26T12:00:00Z")), true);
  assertEquals(isWithinCutoff("2026-02-30", new Date("2026-10-26T12:00:00Z")), false);
});
