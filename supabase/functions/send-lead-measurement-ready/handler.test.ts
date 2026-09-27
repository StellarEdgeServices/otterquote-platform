// gh-2272 — unit tests for send-lead-measurement-ready's handleSendRequest.
//
// Run: deno test supabase/functions/send-lead-measurement-ready/handler.test.ts
//
// Every Deps method is a fake; no network, no env, no real Supabase client.
// Coverage required by the gh-2272 work order:
//   - non-admin rejected (and triggers zero I/O)
//   - missing/unknown order rejected
//   - activity_log written before the send (call-order assertion)
//   - a second trigger does not send (idempotency), with the SAME two calls
//     run against the SAME stateful fake store used by the first call, so
//     removing/weakening the idempotency guard in handler.ts makes this test
//     fail (see the negative-control note on that test below)
//   - correct recipient (the lead's on-file email, not any admin address)

import { assert, assertEquals } from "https://deno.land/std@0.177.0/testing/asserts.ts";
import {
  ACTIVITY_LOG_EVENT_TYPE,
  buildLeadReadyEmail,
  Deps,
  handleSendRequest,
  LeadOrderRow,
  LeadRow,
} from "./handler.ts";

const ORDER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LEAD_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const FULFILLED_ORDER: LeadOrderRow = {
  id: ORDER_ID,
  lead_id: LEAD_ID,
  status: "fulfilled",
  product_code: "roof_basic",
  is_test: false,
};

const REAL_LEAD: LeadRow = {
  email: "homeowner@example.com",
  name: "Jamie Homeowner",
  is_synthetic: false,
  property_address: "123 Main St",
};

/**
 * Builds a fresh set of fakes plus a `calls` log recording, in order, every
 * deps method invoked. A shared `sentNotifications` Set simulates the
 * `notifications` table across repeated handleSendRequest calls against the
 * SAME deps object, which is what makes the idempotency test below a real
 * exercise of handler.ts's own guard rather than a mocked-away assumption.
 */
function makeDeps(overrides: Partial<{
  order: LeadOrderRow | null;
  lead: LeadRow | null;
  verifySend: boolean;
  sendOk: boolean;
}> = {}) {
  const calls: string[] = [];
  const sentNotifications = new Set<string>();
  const activityLogRows: Record<string, unknown>[] = [];
  const notificationRows: Record<string, unknown>[] = [];
  const sentTo: string[] = [];

  const order = overrides.order === undefined ? FULFILLED_ORDER : overrides.order;
  const lead = overrides.lead === undefined ? REAL_LEAD : overrides.lead;
  const sendOk = overrides.sendOk ?? true;

  const deps: Deps = {
    loadOrder: async (id: string) => {
      calls.push("loadOrder");
      return id === ORDER_ID ? order : null;
    },
    loadLead: async (_id: string) => {
      calls.push("loadLead");
      return lead;
    },
    findExistingNotification: async (id: string) => {
      calls.push("findExistingNotification");
      return sentNotifications.has(id);
    },
    writeActivityLog: async (row) => {
      calls.push("writeActivityLog");
      activityLogRows.push(row);
      return { error: null };
    },
    sendEmail: async (to: string, _msg) => {
      calls.push("sendEmail");
      sentTo.push(to);
      if (!sendOk) return { ok: false };
      return { ok: true, id: "mg-123" };
    },
    recordNotification: async (row) => {
      calls.push("recordNotification");
      notificationRows.push(row);
      sentNotifications.add(ORDER_ID);
      return { error: null };
    },
    insertActivityLogFailure: async (row) => {
      calls.push("insertActivityLogFailure");
      activityLogRows.push(row as Record<string, unknown>);
      return { error: null };
    },
    insertPlatformAlert: async (_row) => {
      calls.push("insertPlatformAlert");
      return { error: null };
    },
    verifySend: overrides.verifySend ?? false,
  };

  return { deps, calls, activityLogRows, notificationRows, sentTo };
}

Deno.test("gh-2272: a non-admin caller is rejected with 403 and triggers ZERO I/O", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleSendRequest(ORDER_ID, false, deps);
  assertEquals(result.status, 403);
  assertEquals(result.body.error, "Forbidden: admin role required");
  assertEquals(calls.length, 0, `expected no deps calls for a non-admin caller, got: ${JSON.stringify(calls)}`);
});

Deno.test("gh-2272: a missing order_id is rejected with 400", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleSendRequest(undefined, true, deps);
  assertEquals(result.status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("gh-2272: an unknown order_id is rejected with 404", async () => {
  const { deps } = makeDeps({ order: null });
  const result = await handleSendRequest(ORDER_ID, true, deps);
  assertEquals(result.status, 404);
  assertEquals(result.body.error, "Order not found");
});

Deno.test("gh-2272: an order that is not yet fulfilled is rejected with 409", async () => {
  const { deps } = makeDeps({ order: { ...FULFILLED_ORDER, status: "awaiting_fulfillment" } });
  const result = await handleSendRequest(ORDER_ID, true, deps);
  assertEquals(result.status, 409);
  assert(String(result.body.error).includes("not fulfilled"));
});

Deno.test("gh-2272: an order whose lead cannot be found is rejected with 404", async () => {
  const { deps } = makeDeps({ lead: null });
  const result = await handleSendRequest(ORDER_ID, true, deps);
  assertEquals(result.status, 404);
  assertEquals(result.body.error, "Lead not found");
});

Deno.test("gh-2272: a lead with no email on file is rejected with 422", async () => {
  const { deps } = makeDeps({ lead: { ...REAL_LEAD, email: "" } });
  const result = await handleSendRequest(ORDER_ID, true, deps);
  assertEquals(result.status, 422);
  assertEquals(result.body.error, "No lead email on file");
});

Deno.test("gh-2272: activity_log is written BEFORE the send (call-order assertion)", async () => {
  const { deps, calls } = makeDeps();
  const result = await handleSendRequest(ORDER_ID, true, deps);
  assertEquals(result.status, 200);
  const logIdx = calls.indexOf("writeActivityLog");
  const sendIdx = calls.indexOf("sendEmail");
  assert(logIdx >= 0, "writeActivityLog must be called");
  assert(sendIdx >= 0, "sendEmail must be called");
  assert(logIdx < sendIdx, `writeActivityLog (call ${logIdx}) must precede sendEmail (call ${sendIdx}); order was: ${JSON.stringify(calls)}`);
});

Deno.test("gh-2272: the email goes to the lead's on-file address, not any other", async () => {
  const { deps, sentTo } = makeDeps({ lead: { ...REAL_LEAD, email: "specific-lead@example.com" } });
  const result = await handleSendRequest(ORDER_ID, true, deps);
  assertEquals(result.status, 200);
  assertEquals(sentTo, ["specific-lead@example.com"]);
});

Deno.test("gh-2272: a successful send records a notifications row carrying the order id (the idempotency key)", async () => {
  const { deps, notificationRows } = makeDeps();
  await handleSendRequest(ORDER_ID, true, deps);
  assertEquals(notificationRows.length, 1);
  assert(String(notificationRows[0].message_preview).includes(ORDER_ID));
  assertEquals(notificationRows[0].channel, "email");
});

Deno.test(
  "gh-2272: a SECOND trigger on the same order does not send again (idempotency) — " +
    "NEGATIVE CONTROL: this exercises handler.ts's real findExistingNotification/notifications-check " +
    "guard against a stateful fake store shared across both calls, not a mocked assumption. " +
    "Removing or weakening that guard in handler.ts (e.g. deleting the " +
    "`if (alreadySent) return ...` branch, or the deps.findExistingNotification call " +
    "itself) makes calls.filter('sendEmail').length equal 2 here and this test FAILS.",
  async () => {
    const { deps, calls } = makeDeps();

    const first = await handleSendRequest(ORDER_ID, true, deps);
    assertEquals(first.status, 200);
    assertEquals(first.body.skipped, undefined);

    const second = await handleSendRequest(ORDER_ID, true, deps);
    assertEquals(second.status, 200);
    assertEquals(second.body.skipped, true);
    assertEquals(second.body.reason, "already_notified");

    const sendCount = calls.filter((c) => c === "sendEmail").length;
    assertEquals(sendCount, 1, `expected exactly one Mailgun send across two triggers, got ${sendCount}`);
  },
);

Deno.test("gh-2272: a test-account/synthetic lead is skipped without X-Verify-Send, and never reaches sendEmail", async () => {
  const { deps, calls } = makeDeps({ lead: { ...REAL_LEAD, is_synthetic: true } });
  const result = await handleSendRequest(ORDER_ID, true, deps);
  assertEquals(result.status, 200);
  assertEquals(result.body.skipped, true);
  assertEquals(result.body.reason, "test_account");
  assert(!calls.includes("sendEmail"), "sendEmail must not be called for a skipped test-account send");
});

Deno.test("gh-2272: X-Verify-Send bypasses the test-account skip and a real send occurs", async () => {
  const { deps, calls } = makeDeps({ lead: { ...REAL_LEAD, is_synthetic: true }, verifySend: true });
  const result = await handleSendRequest(ORDER_ID, true, deps);
  assertEquals(result.status, 200);
  assert(calls.includes("sendEmail"), "X-Verify-Send must cause a real send even for a synthetic lead");
});

Deno.test("gh-2272: a failed Mailgun send is recorded loudly and returns 502, without recording a notifications row", async () => {
  const { deps, notificationRows, calls } = makeDeps({ sendOk: false });
  const result = await handleSendRequest(ORDER_ID, true, deps);
  assertEquals(result.status, 502);
  assertEquals(notificationRows.length, 0);
  assert(calls.includes("insertActivityLogFailure"));
  assert(calls.includes("insertPlatformAlert"));
});

Deno.test("gh-2272: buildLeadReadyEmail carries no dashboard link or login reference (no account exists for a lead)", () => {
  const msg = buildLeadReadyEmail({ firstName: "Jamie", productLabel: "roof measurement report", address: "123 Main St" });
  assert(!msg.html.includes("dashboard.html"));
  assert(!msg.text.toLowerCase().includes("dashboard"));
  assert(msg.text.includes("Good news — the roof measurement report you ordered for 123 Main St is ready."));
  assert(msg.text.includes("Questions? Just reply to this email or write to support@otterquote.com."));
});

Deno.test("gh-2272: ACTIVITY_LOG_EVENT_TYPE is a fixed, non-empty event type", () => {
  assert(typeof ACTIVITY_LOG_EVENT_TYPE === "string" && ACTIVITY_LOG_EVENT_TYPE.length > 0);
});
