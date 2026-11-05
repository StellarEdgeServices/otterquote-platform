// gh-3409 (REVIEW 6668449870 B1): the dispute evidence row must be the SELECTED bid's, with the bid's own fee.
// Shapes S1-S3 are the ones the reviewer reproduced on Postgres; each row below is "true at its own instant".
// On main the webhook took the newest row for (claim, contractor) and these returned the $0.05 row.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { pickFeeAcceptanceForBid } from "./fee-acceptance-select.ts";
import { stripComments } from "./test-source-utils.ts";

const genuine = { id: "a1", bid_id: "bid-selected", fee_amount: 750 };
const secondBidRow = { id: "a2", bid_id: "bid-second", fee_amount: 0.05 };
const dipRow = { id: "a3", bid_id: "bid-dipped", fee_amount: 0.05 };

// what main did: rows[0] of a newest-first list
const oldPick = (rows: { fee_amount: number }[]) => rows[0];

Deno.test("S1: a second $1 bid with its own row is newer, main picked it; the selected bid's row is picked now", () => {
  const rows = [secondBidRow, genuine]; // newest first
  assertEquals(oldPick(rows).fee_amount, 0.05); // negative control: the defect
  const r = pickFeeAcceptanceForBid(rows, { id: "bid-selected", fee_amount: 750 });
  assertEquals(r.reason, "ok");
  assertEquals(r.row?.fee_amount, 750);
});

Deno.test("S2/S3: price dipped to $1, accepted, raised back: the row's fee differs from the bid's fee, so it is not evidence", () => {
  const rows = [dipRow];
  assertEquals(oldPick(rows).fee_amount, 0.05); // negative control
  const r = pickFeeAcceptanceForBid(rows, { id: "bid-dipped", fee_amount: "750.00" });
  assertEquals(r.row, null);
  assertEquals(r.reason, "fee_differs_from_bid");
});

Deno.test("no selected bid, or no row for it: not evidence (manual)", () => {
  assertEquals(pickFeeAcceptanceForBid([genuine], null).reason, "no_selected_bid");
  assertEquals(pickFeeAcceptanceForBid([secondBidRow], { id: "bid-selected", fee_amount: 750 }).reason, "no_row_for_selected_bid");
  assertEquals(pickFeeAcceptanceForBid(null, { id: "bid-selected", fee_amount: 750 }).reason, "no_row_for_selected_bid");
});

Deno.test("genuine rows still work: numeric strings, half-cent rounding, sub-dollar fee", () => {
  assertEquals(pickFeeAcceptanceForBid([{ bid_id: "b", fee_amount: "617.28" }], { id: "b", fee_amount: 617.28 }).reason, "ok");
  assertEquals(pickFeeAcceptanceForBid([{ bid_id: "b", fee_amount: 0.05 }], { id: "b", fee_amount: "0.05" }).reason, "ok");
  assertEquals(pickFeeAcceptanceForBid([{ bid_id: "b", fee_amount: 750 }], { id: "b", fee_amount: null }).reason, "fee_differs_from_bid");
});

Deno.test("index.ts uses the picker and no longer takes rows[0] blindly", () => {
  const src = stripComments(Deno.readTextFileSync(new URL("./index.ts", import.meta.url)));
  assert(/pickFeeAcceptanceForBid\(/.test(src), "index.ts must call pickFeeAcceptanceForBid");
  assert(!/feeAcceptance\s*=\s*feeRows\[0\]/.test(src), "index.ts must not take feeRows[0] directly");
});
