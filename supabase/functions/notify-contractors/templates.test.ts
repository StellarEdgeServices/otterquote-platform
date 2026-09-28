// Deno unit test for gh-1824 footer-batch-4: notify-contractors' rendered
// email bodies must carry the D-237 postal address.
// Run: deno test supabase/functions/notify-contractors/templates.test.ts

import { assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  newOpportunityEmailText,
  newOpportunityEmailHtml,
  contractSignedEmailText,
  contractSignedEmailHtml,
  bidAcceptedEmailText,
  bidAcceptedEmailHtml,
  bidUpdateEmailText,
  bidUpdateEmailHtml,
  agreementRequestedEmailText,
  agreementRequestedEmailHtml,
  bidExpiredEmailText,
  bidExpiredEmailHtml,
  bidRenewalRequestedEmailText,
  bidRenewalRequestedEmailHtml,
} from "./templates.ts";
import { POSTAL_ADDRESS } from "./email-footer.ts";

Deno.test("gh-1824 notify-contractors: newOpportunityEmailText includes the D-237 postal address", () => {
  assertEquals(newOpportunityEmailText("Jane", "Indianapolis", "IN", "roofing", "insurance_rcv").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: newOpportunityEmailHtml includes the D-237 postal address", () => {
  assertEquals(newOpportunityEmailHtml("Jane", "Indianapolis", "IN", "roofing", "insurance_rcv").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: contractSignedEmailText includes the D-237 postal address", () => {
  assertEquals(contractSignedEmailText("Jane").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: contractSignedEmailHtml includes the D-237 postal address", () => {
  assertEquals(contractSignedEmailHtml("Jane", "claim-123").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: bidAcceptedEmailText includes the D-237 postal address", () => {
  assertEquals(bidAcceptedEmailText("Jane", "123 Main St", "$10,000").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: bidAcceptedEmailHtml includes the D-237 postal address", () => {
  assertEquals(bidAcceptedEmailHtml("Jane", "123 Main St", "$10,000").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: bidUpdateEmailText includes the D-237 postal address", () => {
  assertEquals(bidUpdateEmailText("Jane").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: bidUpdateEmailHtml includes the D-237 postal address", () => {
  assertEquals(bidUpdateEmailHtml("Jane").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: agreementRequestedEmailText includes the D-237 postal address", () => {
  assertEquals(agreementRequestedEmailText("Jane", "Indianapolis, IN", "https://example.com/sign").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: agreementRequestedEmailHtml includes the D-237 postal address", () => {
  assertEquals(agreementRequestedEmailHtml("Jane", "Indianapolis, IN", "https://example.com/sign").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: bidExpiredEmailText includes the D-237 postal address", () => {
  assertEquals(bidExpiredEmailText("Jane", "Indianapolis, IN", "Roofing", "quote-1", "claim-1").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: bidExpiredEmailHtml includes the D-237 postal address", () => {
  assertEquals(bidExpiredEmailHtml("Jane", "Indianapolis, IN", "Roofing", "quote-1", "claim-1", "mg.example.com").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: bidRenewalRequestedEmailText includes the D-237 postal address", () => {
  assertEquals(bidRenewalRequestedEmailText("Jane", "Indianapolis, IN", "Roofing").includes(POSTAL_ADDRESS), true);
});

Deno.test("gh-1824 notify-contractors: bidRenewalRequestedEmailHtml includes the D-237 postal address", () => {
  assertEquals(bidRenewalRequestedEmailHtml("Jane", "Indianapolis, IN", "Roofing").includes(POSTAL_ADDRESS), true);
});
