// gh-3408 - dispute evidence must state the dollar fee the contractor accepted.
//
// UNIT: fee_acceptances.fee_amount is DOLLARS (numeric(10,2)). Writers:
//   contractor-bid-form.html:4726  feeAmount = (bidAmount * feePct) / 100
//   contractor-bid-form.html:5442  fee_amount: _feeAmount
//   react-app/app/contractor/bid/[claimId]/utils.ts:238 / :569 (same, dollars)
// A $175.00 fee is stored as 175.00. Only Stripe amounts are cents.
//
// index.ts starts a server at import time, so this pins (a) the helper
// behaviourally with a real-shape row and (b) index.ts structurally.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { formatAcceptedFeeDollars } from "./dispute-evidence-fields.ts";
import { stripComments } from "./test-source-utils.ts";

// Real shape: the column set stripe-webhook selects, values as the bid form
// writes them (5% of a $3,500.00 bid = 175.00 dollars).
const feeRow = {
  id: "00000000-0000-4000-8000-000000000001",
  contractor_id: "00000000-0000-4000-8000-000000000002",
  claim_id: "00000000-0000-4000-8000-000000000003",
  bid_id: "00000000-0000-4000-8000-000000000004",
  fee_pct: 5,
  fee_amount: 175,
  fee_text_displayed:
    "By submitting this bid, you agree to pay Otter Quotes a platform fee of 5.00% ($175.00) upon contract execution.",
  accepted_at: "2026-11-04T12:00:00+00:00",
  ip_address: "203.0.113.7",
  user_agent: "UA",
  invoice_url: null,
};

Deno.test("gh-3408: today's output ($1.75) differs from the accepted $175.00", () => {
  const today = `$${(feeRow.fee_amount / 100).toFixed(2)}`; // what main printed
  assertEquals(today, "$1.75");
  assertEquals(formatAcceptedFeeDollars(feeRow.fee_amount), "$175.00");
  assert(feeRow.fee_text_displayed.includes(formatAcceptedFeeDollars(feeRow.fee_amount)));
});

Deno.test("gh-3408: numeric arriving as a string, and a sub-dollar fee, format correctly", () => {
  assertEquals(formatAcceptedFeeDollars("175.00"), "$175.00");
  assertEquals(formatAcceptedFeeDollars(0.5), "$0.50");
});

Deno.test("gh-3408: index.ts prints fee_amount through the dollar helper, never /100", () => {
  const src = stripComments(Deno.readTextFileSync(new URL("./index.ts", import.meta.url)));
  assert(!/fee_amount\s*\/\s*100/.test(src), "fee_amount must not be divided by 100");
  const uses = src.match(/formatAcceptedFeeDollars\(feeAcceptance\.fee_amount\)/g) ?? [];
  assertEquals(uses.length, 2); // dispute notice + service documentation
});
