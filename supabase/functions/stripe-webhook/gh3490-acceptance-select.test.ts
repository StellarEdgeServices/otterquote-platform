// gh-3490 (Ben ruling 6740655614): a changed or renewed bid writes its own fee_acceptances row, so one bid can have
// several rows with different fees. The webhook must use the NEWEST row whose fee equals the bid's current fee.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { pickFeeAcceptanceForBid } from "./fee-acceptance-select.ts";

const bid = (fee: number | string) => ({ id: "bid-1", fee_amount: fee });
const row = (id: string, fee: number | string) => ({ id, bid_id: "bid-1", fee_amount: fee });

Deno.test("single row that matches: used (unchanged)", () => {
  const r = pickFeeAcceptanceForBid([row("a", 750)], bid("750.00"));
  assertEquals(r.reason, "ok");
  assertEquals(r.row?.id, "a");
});

Deno.test("A -> B: newest row (B) matches the current fee and is used", () => {
  const r = pickFeeAcceptanceForBid([row("b", 800), row("a", 750)], bid(800)); // newest first
  assertEquals(r.reason, "ok");
  assertEquals(r.row?.id, "b");
});

Deno.test("A -> B -> A: no new row for the return to A; the older A row is used, not fee_differs_from_bid", () => {
  const r = pickFeeAcceptanceForBid([row("b", 800), row("a", 750)], bid(750)); // newest first, bid back at A
  assertEquals(r.reason, "ok");
  assertEquals(r.row?.id, "a");
});

Deno.test("several rows match: the newest matching one wins", () => {
  const r = pickFeeAcceptanceForBid([row("b", 800), row("a2", 750), row("a1", 750)], bid(750));
  assertEquals(r.row?.id, "a2");
});

Deno.test("no row matches the current fee: fee_differs_from_bid (unchanged)", () => {
  const r = pickFeeAcceptanceForBid([row("b", 800), row("a", 750)], bid(900));
  assertEquals(r.row, null);
  assertEquals(r.reason, "fee_differs_from_bid");
});
