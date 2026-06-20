// Deno unit tests for the docusign-webhook payload parser.
// Run: deno test supabase/functions/docusign-webhook/payload-parser.test.ts
//
// Covers the THREE Connect payload shapes the webhook must handle, plus the
// unrecognized fallback. Shape (c) — the lean Connect 2.0 payload — is the
// Phase 17/18 fix: v53 dropped it as "Unrecognized" and never charged the fee.

import {
  assertEquals,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { parsePayload } from "./payload-parser.ts";

Deno.test("(a) rich payload — data.envelopeSummary", () => {
  const parsed = parsePayload({
    event: "envelope-completed",
    data: {
      envelopeId: "ENV-A",
      envelopeSummary: {
        status: "completed",
        completedDateTime: "2026-06-20T12:00:00Z",
        recipients: { signers: [{ email: "homeowner@example.com" }] },
      },
    },
  });
  assertEquals(parsed.recognized, true);
  assertEquals(parsed.envelopeId, "ENV-A");
  assertEquals(parsed.status, "completed");
  assertEquals(parsed.recipientEmail, "homeowner@example.com");
  assertEquals(parsed.completedDateTime, "2026-06-20T12:00:00Z");
  assertEquals(parsed.event, "envelope-completed");
});

Deno.test("(b) flat payload — top-level envelopeId + status", () => {
  const parsed = parsePayload({ envelopeId: "ENV-B", status: "completed" });
  assertEquals(parsed.recognized, true);
  assertEquals(parsed.envelopeId, "ENV-B");
  assertEquals(parsed.status, "completed");
  assertEquals(parsed.recipientEmail, null);
});

Deno.test("(c) lean Connect 2.0 payload — event + data.envelopeId only [THE FIX]", () => {
  const parsed = parsePayload({
    event: "envelope-completed",
    apiVersion: "v2.1",
    uri: "/restapi/v2.1/accounts/123/envelopes/ENV-C",
    data: { accountId: "123", envelopeId: "ENV-C" },
  });
  assertEquals(parsed.recognized, true);
  assertEquals(parsed.envelopeId, "ENV-C");
  assertEquals(parsed.status, "completed");
  assertEquals(parsed.event, "envelope-completed");
  // No recipients in the lean shape.
  assertEquals(parsed.recipientEmail, null);
});

Deno.test("(c) lean — status derived from event for declined/voided/delivered/sent", () => {
  const cases: Array<[string, string]> = [
    ["envelope-declined", "declined"],
    ["envelope-voided", "voided"],
    ["recipient-delivered", "delivered"],
    ["envelope-sent", "sent"],
  ];
  for (const [event, expected] of cases) {
    const parsed = parsePayload({ event, data: { accountId: "123", envelopeId: "ENV-X" } });
    assertEquals(parsed.recognized, true, `event=${event}`);
    assertEquals(parsed.envelopeId, "ENV-X", `event=${event}`);
    assertEquals(parsed.status, expected, `event=${event}`);
  }
});

Deno.test("(c) lean — completedDateTime falls back to generatedDateTime", () => {
  const parsed = parsePayload({
    event: "envelope-completed",
    generatedDateTime: "2026-06-20T13:30:00Z",
    data: { accountId: "123", envelopeId: "ENV-D" },
  });
  assertEquals(parsed.completedDateTime, "2026-06-20T13:30:00Z");
});

Deno.test("unrecognized payload → recognized:false", () => {
  const parsed = parsePayload({ foo: "bar" });
  assertEquals(parsed.recognized, false);
  assertEquals(parsed.envelopeId, null);
});

Deno.test("precedence — rich shape wins over a stray top-level envelopeId", () => {
  const parsed = parsePayload({
    envelopeId: "STRAY",
    data: { envelopeId: "ENV-RICH", envelopeSummary: { status: "completed" } },
  });
  assertEquals(parsed.envelopeId, "ENV-RICH");
  assertEquals(parsed.status, "completed");
});
