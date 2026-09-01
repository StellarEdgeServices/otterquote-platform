// Deno unit tests for the BoldSign webhook payload parser.
// Run: deno test supabase/functions/docusign-webhook/payload-parser.test.ts
//
// [D-274 / #631] Replaces the DocuSign Connect payload-shape tests (rich/flat/lean)
// with tests against BoldSign's single documented webhook shape
// (developers.boldsign.com/webhooks/sample-event-data/).

import {
  assertEquals,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  findCompletedContractSigner,
  parsePayload,
  resolveContractSignerRole,
} from "./payload-parser.ts";

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

// ── gh-1446: signer-role matcher (GUID ids killed the label match) ──────────
//
// Production payloads carry random-GUID signer ids (gh-1244: BoldSign rejects
// string labels), so the old `clientUserId === "contractor_1"` matching was
// dead code — measured live 2026-08-31 (#1351/#1446): contractor Signed event
// delivered + HMAC-verified, quotes.contractor_signed_at stayed NULL. Roles
// now resolve legacy-label-first, then BoldSign signer order (1 = contractor,
// 2 = homeowner — handleContractorSign's mint convention, the only live
// contract mint site).

/** The live v85 shape: GUID ids, orders 1/2 — what the label matcher could never match. */
function guidSignedEvent(contractorStatus: string, homeownerStatus: string) {
  const payload = boldsignEvent();
  payload.data.signerDetails = [
    {
      signerName: "Video Walk Test Roofing 2 LLC",
      signerEmail: "shared+fixture@example.com",
      id: "0b8674f0-4a51-4d5a-9a2e-2f4c8f6d1e77",
      status: contractorStatus,
      order: 1,
      signerType: "Signer",
    },
    {
      signerName: "Homeowner Test",
      signerEmail: "shared+fixture@example.com", // same email BOTH sides — the test-fixture reality
      id: "c3a1f9d2-8e07-42bb-b6a4-5d2e9c0f7a13",
      status: homeownerStatus,
      order: 2,
      signerType: "Signer",
    },
  ];
  return payload;
}

Deno.test("gh-1446: contractor Signed event (GUID ids) — contractor resolves completed, homeowner does not", () => {
  // The exact dead case from the live walk: contractor signed, homeowner
  // pending — delivered as event=Signed with document status still Sent
  // (function_logs 2026-08-31T22:21:10Z: "status=sent, event=Signed").
  const payload = guidSignedEvent("Completed", "NotCompleted");
  payload.event.eventType = "Signed";
  payload.data.status = "Sent";
  const parsed = parsePayload(payload);
  assertEquals(parsed.status, "sent");
  const contractor = findCompletedContractSigner(parsed.signerDetails, "contractor");
  const homeowner = findCompletedContractSigner(parsed.signerDetails, "homeowner");
  assertEquals(contractor?.order, 1);
  assertEquals(contractor?.status, "completed");
  assertEquals(homeowner, undefined); // drives contractor_signed_at, and ONLY that
});

Deno.test("gh-1446: homeowner Completed event (GUID ids) — homeowner resolves completed (drives homeowner_signed_at)", () => {
  const parsed = parsePayload(guidSignedEvent("Completed", "Completed"));
  const homeowner = findCompletedContractSigner(parsed.signerDetails, "homeowner");
  const contractor = findCompletedContractSigner(parsed.signerDetails, "contractor");
  assertEquals(homeowner?.order, 2);
  assertEquals(homeowner?.status, "completed");
  assertEquals(contractor?.order, 1);
});

Deno.test("gh-1446: shared signer email cannot misattribute — role keys on order, never email", () => {
  const parsed = parsePayload(guidSignedEvent("Completed", "Completed"));
  // Both fixture signers share one email; roles must still be distinct.
  assertEquals(resolveContractSignerRole(parsed.signerDetails[0]), "contractor");
  assertEquals(resolveContractSignerRole(parsed.signerDetails[1]), "homeowner");
});

Deno.test("gh-1446: legacy label ids still resolve without any order field (pre-gh-1244 envelopes unchanged)", () => {
  assertEquals(resolveContractSignerRole({ clientUserId: "contractor_1", order: null }), "contractor");
  assertEquals(resolveContractSignerRole({ clientUserId: "homeowner_1", order: null }), "homeowner");
});

Deno.test("gh-1446: legacy label outranks a conflicting order (resolution ladder is label-first)", () => {
  assertEquals(resolveContractSignerRole({ clientUserId: "contractor_1", order: 2 }), "contractor");
});

Deno.test("gh-1446: unknown signer shape → null role, no match, no misattribution, no throw", () => {
  // GUID id and no usable order: nothing should resolve, even when completed.
  const payload = boldsignEvent();
  // deno-lint-ignore no-explicit-any
  (payload.data as any).signerDetails = [
    { signerName: "X", signerEmail: "x@example.com", id: "9d3b1a2c-0000-4000-8000-000000000000", status: "Completed", signerType: "Signer" },
    { signerName: "Y", signerEmail: "y@example.com", id: "9d3b1a2c-1111-4111-8111-111111111111", status: "Completed", order: 3, signerType: "Signer" },
  ];
  const parsed = parsePayload(payload);
  assertEquals(parsed.recognized, true);
  assertEquals(resolveContractSignerRole(parsed.signerDetails[0]), null); // order absent
  assertEquals(resolveContractSignerRole(parsed.signerDetails[1]), null); // order 3 — not a contract party slot
  assertEquals(findCompletedContractSigner(parsed.signerDetails, "contractor"), undefined);
  assertEquals(findCompletedContractSigner(parsed.signerDetails, "homeowner"), undefined);
});

Deno.test("gh-1446: order normalization — numeric strings and send-side signerOrder accepted; garbage → null", () => {
  const payload = boldsignEvent();
  // deno-lint-ignore no-explicit-any
  (payload.data as any).signerDetails = [
    { id: "g-1", status: "Completed", order: "1" }, // numeric string
    { id: "g-2", status: "Completed", signerOrder: 2 }, // send-side property name fallback
    { id: "g-3", status: "Completed", order: true }, // boolean garbage
    { id: "g-4", status: "Completed", order: 0 }, // non-positive
    { id: "g-5", status: "Completed", order: "abc" }, // non-numeric string
  ];
  const parsed = parsePayload(payload);
  assertEquals(parsed.signerDetails[0].order, 1);
  assertEquals(parsed.signerDetails[1].order, 2);
  assertEquals(parsed.signerDetails[2].order, null);
  assertEquals(parsed.signerDetails[3].order, null);
  assertEquals(parsed.signerDetails[4].order, null);
});
