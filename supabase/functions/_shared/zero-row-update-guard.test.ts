// gh-2105 (batch 2) -- unit tests for the shared zero-row-update guard used
// by the money-path edge-function sites fixed this batch (stripe-webhook,
// create-payment-intent, verify-payment-method, mark-payout-paid).
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { checkRowsWritten, zeroRowWriteMessage } from "./zero-row-update-guard.ts";

Deno.test("checkRowsWritten: a non-empty row array is a real write", () => {
  assertEquals(checkRowsWritten([{ id: "q1" }]), { wroteRows: true, rowCount: 1 });
  assertEquals(checkRowsWritten([{ id: "q1" }, { id: "q2" }]), { wroteRows: true, rowCount: 2 });
});

Deno.test("checkRowsWritten: an empty array is the gh-2105 silent-failure shape", () => {
  assertEquals(checkRowsWritten([]), { wroteRows: false, rowCount: 0 });
});

Deno.test("checkRowsWritten: null/undefined/non-array data all count as zero rows", () => {
  assertEquals(checkRowsWritten(null), { wroteRows: false, rowCount: 0 });
  assertEquals(checkRowsWritten(undefined), { wroteRows: false, rowCount: 0 });
  assertEquals(checkRowsWritten("not-an-array"), { wroteRows: false, rowCount: 0 });
  assertEquals(checkRowsWritten({ id: "q1" }), { wroteRows: false, rowCount: 0 });
});

Deno.test("zeroRowWriteMessage: includes the function name and the op description", () => {
  const msg = zeroRowWriteMessage("stripe-webhook", "quotes.payment_status=succeeded for quote q1");
  assertEquals(
    msg,
    "[stripe-webhook] gh-2105: zero-row update -- quotes.payment_status=succeeded for quote q1 matched no rows; the write silently did nothing.",
  );
});
