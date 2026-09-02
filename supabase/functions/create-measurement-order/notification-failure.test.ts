// Deno unit tests for gh-1538's notification-failure trace: before this,
// a failed notify-measurement-order invoke inside create-measurement-order
// left only a console.error line, with no activity_log/Sentry/notifications
// row anywhere.
// Run: deno test supabase/functions/create-measurement-order/notification-failure.test.ts

import { assertEquals, assertExists } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import { buildNotificationFailureRow, logNotificationFailure } from "./notification-failure.ts";

const CTX = {
  functionName: "create-measurement-order",
  recipientRole: "homeowner",
  isTest: false,
  userId: "11111111-1111-1111-1111-111111111111",
  extra: {
    order_id: "22222222-2222-2222-2222-222222222222",
    claim_id: "33333333-3333-3333-3333-333333333333",
  },
};

Deno.test("buildNotificationFailureRow: fixed event_type/title, error/recipient_role/function in metadata", () => {
  const row = buildNotificationFailureRow(new Error("boom"), CTX);
  assertEquals(row.event_type, "notification_failed");
  assertEquals(row.title, "notification_failed");
  assertEquals(row.user_id, CTX.userId);
  assertEquals(row.is_test, false);
  assertEquals(row.metadata.function, "create-measurement-order");
  assertEquals(row.metadata.recipient_role, "homeowner");
  assertEquals(row.metadata.error, "Error: boom");
  assertEquals(row.metadata.order_id, CTX.extra.order_id);
  assertEquals(row.metadata.claim_id, CTX.extra.claim_id);
});

Deno.test("buildNotificationFailureRow: non-Error thrown value is stringified", () => {
  const row = buildNotificationFailureRow("plain string failure", CTX);
  assertEquals(row.metadata.error, "plain string failure");
});

Deno.test("buildNotificationFailureRow: error text truncated to 200 chars", () => {
  const long = "x".repeat(500);
  const row = buildNotificationFailureRow(new Error(long), CTX);
  assertEquals((row.metadata.error as string).length, 200);
});

Deno.test("buildNotificationFailureRow: is_test propagates true for test claims", () => {
  const row = buildNotificationFailureRow(new Error("boom"), { ...CTX, isTest: true });
  assertEquals(row.is_test, true);
});

Deno.test("buildNotificationFailureRow: contractor recipient_role passes through unchanged", () => {
  const row = buildNotificationFailureRow(new Error("boom"), { ...CTX, recipientRole: "contractor" });
  assertEquals(row.metadata.recipient_role, "contractor");
});

Deno.test("logNotificationFailure: a stubbed failing notify-measurement-order invoke yields one activity_log row (gh-1538 AC)", async () => {
  const inserted: unknown[] = [];
  const row = await logNotificationFailure(
    (r) => {
      inserted.push(r);
      return Promise.resolve({ error: null });
    },
    new Error("notify-measurement-order returned 500: mailgun down"),
    CTX,
  );
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0], row);
  assertEquals(row.event_type, "notification_failed");
  assertEquals(row.metadata.function, "create-measurement-order");
});

Deno.test("logNotificationFailure: never throws when the activity_log insert itself errors", async () => {
  const row = await logNotificationFailure(
    () => Promise.resolve({ error: { message: "db down" } }),
    new Error("mailgun down"),
    CTX,
  );
  assertExists(row);
});

Deno.test("logNotificationFailure: never throws when insertRow itself rejects", async () => {
  const row = await logNotificationFailure(
    () => Promise.reject(new Error("network")),
    new Error("mailgun down"),
    CTX,
  );
  assertExists(row);
});
