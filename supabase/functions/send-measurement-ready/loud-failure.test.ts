// gh-1538 (second pass) — Deno unit tests for the two things this pass adds:
//
//   1. LOUDNESS. Before this, a swallowed notification-send failure wrote one
//      activity_log row and nothing else. activity_log has no filtered admin
//      surface, so in practice the failure stayed silent: measured
//      2026-09-07, `select count(*) from activity_log where
//      event_type='notification_failed'` was 0 five days after the row type
//      shipped, and no operator surface would have shown one if it were
//      there. platform_alerts_log IS rendered by admin-contractors.html, so
//      the failure now writes there too.
//
//   2. THE X-Verify-Send OPT-IN. notify-measurement-order and
//      send-measurement-ready return early on is_test data before the Mailgun
//      call, which made this issue's own closes-on artifact (a
//      notification_failed row "produced by a forced-failure test against an
//      is_test order") unproducible: the fixture hit the early return, wrote
//      nothing, and read as a pass. The header stops the early return only.
//
// Run: deno test supabase/functions/<function>/loud-failure.test.ts

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  buildPlatformAlertRow,
  isVerifySendRequested,
  logNotificationFailureLoud,
  VERIFY_SEND_HEADER,
} from "./notification-failure.ts";

const CTX = {
  functionName: "gh1538-fixture",
  recipientRole: "homeowner",
  isTest: false,
  userId: "11111111-1111-1111-1111-111111111111",
  extra: {
    order_id: "22222222-2222-2222-2222-222222222222",
    claim_id: "33333333-3333-3333-3333-333333333333",
  },
};

// ── 1. platform_alerts_log row shape

Deno.test("gh-1538: buildPlatformAlertRow writes the alert_type the admin surface filters on", () => {
  const alert = buildPlatformAlertRow(new Error("Mailgun error 401: Forbidden"), CTX);
  assertEquals(alert.alert_type, "notification_failed");
  assertEquals(alert.function_name, "gh1538-fixture");
  assertStringIncludes(alert.message, "homeowner");
  assertStringIncludes(alert.message, CTX.extra.order_id);
  assertStringIncludes(alert.message, "Mailgun error 401");
});

Deno.test("gh-1538: the alert row carries exactly the three NOT NULL columns platform_alerts_log declares", () => {
  // platform_alerts_log (sql/v52b-platform-monitoring.sql, confirmed against
  // information_schema on 2026-09-08): id and sent_at default server-side;
  // alert_type / function_name / message are NOT NULL. An extra key here
  // would be a PostgREST 400 at runtime, which the catch would swallow —
  // exactly the silence this issue is about.
  const alert = buildPlatformAlertRow(new Error("boom"), CTX);
  assertEquals(Object.keys(alert).sort(), ["alert_type", "function_name", "message"]);
});

Deno.test("gh-1538: alert error text is truncated, so one huge upstream body cannot bloat the alert table", () => {
  const alert = buildPlatformAlertRow(new Error("x".repeat(5000)), CTX);
  assertEquals(alert.message.length < 400, true);
});

Deno.test("gh-1538: test traffic is MARKED in the alert, not dropped — a verification must see its own alert", () => {
  const alert = buildPlatformAlertRow(new Error("boom"), { ...CTX, isTest: true });
  assertStringIncludes(alert.message, "[TEST]");
});

Deno.test("gh-1538: a verify-send-triggered failure is distinguishable from organic traffic", () => {
  const alert = buildPlatformAlertRow(new Error("boom"), {
    ...CTX,
    isTest: true,
    extra: { ...CTX.extra, verify_send: true },
  });
  assertStringIncludes(alert.message, "[VERIFY-SEND]");
  const organic = buildPlatformAlertRow(new Error("boom"), {
    ...CTX,
    isTest: true,
    extra: { ...CTX.extra, verify_send: false },
  });
  assertEquals(organic.message.includes("[VERIFY-SEND]"), false);
});

// ── 2. both surfaces are written, and neither can suppress the other

Deno.test("gh-1538: one failure writes BOTH activity_log and platform_alerts_log", async () => {
  const logRows: unknown[] = [];
  const alertRows: unknown[] = [];
  const { row, alert } = await logNotificationFailureLoud(
    (r) => {
      logRows.push(r);
      return Promise.resolve({ error: null });
    },
    new Error("Mailgun error 401: Forbidden"),
    CTX,
    (a) => {
      alertRows.push(a);
      return Promise.resolve({ error: null });
    },
  );
  assertEquals(logRows.length, 1);
  assertEquals(alertRows.length, 1);
  assertEquals(row.event_type, "notification_failed");
  assertEquals(alert?.alert_type, "notification_failed");
});

Deno.test("gh-1538: a failing activity_log insert does not stop the alert from being written", async () => {
  const alertRows: unknown[] = [];
  const { alert } = await logNotificationFailureLoud(
    () => Promise.resolve({ error: { message: "activity_log RLS denied" } }),
    new Error("boom"),
    CTX,
    (a) => {
      alertRows.push(a);
      return Promise.resolve({ error: null });
    },
  );
  assertEquals(alertRows.length, 1);
  assertExists(alert);
});

Deno.test("gh-1538: a throwing alert insert never becomes a second failure on the money path", async () => {
  const { row, alert } = await logNotificationFailureLoud(
    () => Promise.resolve({ error: null }),
    new Error("boom"),
    CTX,
    () => Promise.reject(new Error("platform_alerts_log unreachable")),
  );
  assertExists(row);
  assertExists(alert);
});

Deno.test("gh-1538: omitting insertAlert keeps the previous single-surface behaviour", async () => {
  const { row, alert } = await logNotificationFailureLoud(
    () => Promise.resolve({ error: null }),
    new Error("boom"),
    CTX,
  );
  assertExists(row);
  assertEquals(alert, null);
});

// ── 3. the X-Verify-Send opt-in is exact-match only

function hdrs(v?: string): { get(n: string): string | null } {
  const m = new Map<string, string>();
  if (v !== undefined) m.set(VERIFY_SEND_HEADER, v);
  return { get: (n: string) => m.get(n) ?? null };
}

Deno.test("gh-1538: X-Verify-Send: 1 opts in", () => {
  assertEquals(isVerifySendRequested(hdrs("1")), true);
});

Deno.test("gh-1538: every other value, including truthy-looking ones, does NOT opt in", () => {
  for (const v of ["true", "TRUE", "yes", "0", "", "2", " 1", "1 ", "on"]) {
    assertEquals(
      isVerifySendRequested(hdrs(v)),
      false,
      `value ${JSON.stringify(v)} must not opt in`,
    );
  }
});

Deno.test("gh-1538: a missing header does NOT opt in — the bypass is never a default", () => {
  assertEquals(isVerifySendRequested(hdrs()), false);
});
