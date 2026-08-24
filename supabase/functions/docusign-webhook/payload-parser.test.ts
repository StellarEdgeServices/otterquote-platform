// Deno unit tests for the BoldSign webhook payload parser.
// Run: deno test supabase/functions/docusign-webhook/payload-parser.test.ts
//
// [D-274 / #631] Replaces the DocuSign Connect payload-shape tests (rich/flat/lean)
// with tests against BoldSign's single documented webhook shape
// (developers.boldsign.com/webhooks/sample-event-data/).

import {
  assertEquals,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { parsePayload } from "./payload-parser.ts";

function boldsignEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      id: "evt-1",
      created: 1669960054,
      eventType: "Completed",
      clientId: "client-1",
      environment: "Test",
    },
    context: { eventType: "Completed", actor: null, previousState: { status: "InProgress" } },
    data: {
      object: "document",
      documentId: "DOC-A",
      status: "Completed",
      signerDetails: [
        { signerName: "Contractor Co", signerEmail: "contractor@example.com", id: "contractor_1", status: "Completed", order: 1, signerType: "Signer" },
        { signerName: "Homeowner", signerEmail: "homeowner@example.com", id: "homeowner_1", status: "Completed", order: 2, signerType: "Signer" },
      ],
      ...overrides,
    },
  };
}

Deno.test("Completed event — documentId, status, signerDetails all parsed", () => {
  const parsed = parsePayload(boldsignEvent());
  assertEquals(parsed.recognized, true);
  assertEquals(parsed.envelopeId, "DOC-A");
  assertEquals(parsed.status, "completed");
  assertEquals(parsed.event, "Completed");
  assertEquals(parsed.recipientEmail, "contractor@example.com");
  assertEquals(parsed.completedDateTime, "2022-12-02T05:47:34.000Z");
  assertEquals(parsed.signerDetails.length, 2);
  assertEquals(parsed.signerDetails[0].clientUserId, "contractor_1");
  assertEquals(parsed.signerDetails[0].status, "completed");
  assertEquals(parsed.signerDetails[1].clientUserId, "homeowner_1");
});

Deno.test("Declined event — status maps to 'declined', declinedDateTime set", () => {
  const payload = boldsignEvent({ status: "Declined" });
  payload.event.eventType = "Declined";
  const parsed = parsePayload(payload);
  assertEquals(parsed.status, "declined");
  assertEquals(parsed.declinedDateTime, "2022-12-02T05:47:34.000Z");
  assertEquals(parsed.completedDateTime, null);
});

Deno.test("Revoked event — maps to 'voided' (this codebase's vocabulary)", () => {
  const payload = boldsignEvent({ status: "Revoked" });
  payload.event.eventType = "Revoked";
  const parsed = parsePayload(payload);
  assertEquals(parsed.status, "voided");
  assertEquals(parsed.voidedDateTime, "2022-12-02T05:47:34.000Z");
});

Deno.test("Expired event — also maps to 'voided' (documented as an approximation)", () => {
  const payload = boldsignEvent({ status: "Expired" });
  payload.event.eventType = "Expired";
  const parsed = parsePayload(payload);
  assertEquals(parsed.status, "voided");
});

Deno.test("Sent / Viewed — informational statuses map to sent/delivered", () => {
  const sent = boldsignEvent({ status: "Sent" });
  sent.event.eventType = "Sent";
  assertEquals(parsePayload(sent).status, "sent");

  const viewed = boldsignEvent({ status: "Sent" }); // data.status stays "Sent" pre-view in practice, but exercise Viewed via eventType too
  viewed.event.eventType = "Viewed";
  viewed.data.status = "Sent"; // BoldSign's data.status may lag the eventType; parser falls back to eventType
  assertEquals(parsePayload(viewed).status, "sent");
});

Deno.test("missing data.documentId → unrecognized", () => {
  const parsed = parsePayload({ event: { eventType: "Completed" }, data: {} });
  assertEquals(parsed.recognized, false);
  assertEquals(parsed.envelopeId, null);
});

Deno.test("no signerDetails → empty array, recipientEmail null, no throw", () => {
  const payload = boldsignEvent();
  // deno-lint-ignore no-explicit-any
  (payload.data as any).signerDetails = undefined;
  const parsed = parsePayload(payload);
  assertEquals(parsed.recognized, true);
  assertEquals(parsed.signerDetails, []);
  assertEquals(parsed.recipientEmail, null);
});

Deno.test("completely malformed payload → unrecognized, no throw", () => {
  const parsed = parsePayload({ foo: "bar" });
  assertEquals(parsed.recognized, false);
});

Deno.test("null/undefined payload → unrecognized, no throw", () => {
  assertEquals(parsePayload(null).recognized, false);
  assertEquals(parsePayload(undefined).recognized, false);
});
