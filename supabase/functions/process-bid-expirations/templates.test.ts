// Deno unit test for gh-1824 footer-batch-4: process-bid-expirations'
// rendered email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/process-bid-expirations/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  buildBidExpiredEmail,
  buildAutoRenewedEmail,
  buildRenewalCapEmail,
  buildBidWindowExpiredHomeownerEmail,
} from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 process-bid-expirations: buildBidExpiredEmail includes the D-237 postal address", () => {
  const { text, html } = buildBidExpiredEmail({
    contractorName: "Jane",
    homeownerAddress: "123 Main St",
    tradeLabel: "roofing",
    quoteId: "quote-1",
    mailgunDomain: "mg.example.com",
  });
  assertEquals(text.includes(POSTAL_ADDRESS), true);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 process-bid-expirations: buildAutoRenewedEmail includes the D-237 postal address", () => {
  const { text, html } = buildAutoRenewedEmail({
    contractorName: "Jane",
    homeownerAddress: "123 Main St",
    tradeLabel: "roofing",
    newQuoteId: "quote-2",
    newExpiresAt: "2026-10-15",
    stopUrl: "https://example.com/stop",
    mailgunDomain: "mg.example.com",
  });
  assertEquals(text.includes(POSTAL_ADDRESS), true);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 process-bid-expirations: buildRenewalCapEmail includes the D-237 postal address", () => {
  const { text, html } = buildRenewalCapEmail({
    contractorName: "Jane",
    homeownerAddress: "123 Main St",
    tradeLabel: "roofing",
    mailgunDomain: "mg.example.com",
  });
  assertEquals(text.includes(POSTAL_ADDRESS), true);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 process-bid-expirations: buildBidWindowExpiredHomeownerEmail includes the D-237 postal address", () => {
  const { text, html } = buildBidWindowExpiredHomeownerEmail({
    homeownerName: "Jane",
    propertyAddress: "123 Main St",
    bidsUrl: "https://example.com/bids",
    mailgunDomain: "mg.example.com",
  });
  assertEquals(text.includes(POSTAL_ADDRESS), true);
  assertEquals(html.includes(POSTAL_ADDRESS), true);
});
