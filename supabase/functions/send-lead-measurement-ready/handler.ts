/**
 * send-lead-measurement-ready — core logic (gh-2272, HO-3 no-account sender)
 *
 * The no-account (lead) sibling of send-measurement-ready (gh-1412). #2272's
 * ruling (Dustin, comment 5859997178, "Approved to all", answering #2226's
 * L4 gate): the L4 success-screen sentence on measure-lead.html ("We'll
 * email your roof measurement report...") needs a real sender before it can
 * go live. notify-measurement-order's lead_order branch (PR #2226,
 * lead-notify.ts) only alerts the ADMIN that a lead order needs manual
 * fulfilment — it never tells the LEAD anything. This function is what the
 * admin triggers, by hand, after fulfilling a lead_measurement_orders row,
 * to actually send that lead their "report is ready" email.
 *
 * All I/O is injected (the Deps interface below) so handleSendRequest is
 * unit-testable with fakes, with zero network/env access — same shape as
 * notify-measurement-order's handleLeadNotification (lead-notify.ts) and
 * create-lead-measurement-order's handleRequest (handler.ts).
 *
 * Mirrors send-measurement-ready's structure closely:
 *   - the SAME admin-only gate (PRIMARY_ADMIN_EMAIL fast-path, falling back
 *     to contractors.template_review_role === 'admin' — computed by
 *     index.ts, passed in here as `isAdmin` so the gate is checked before
 *     ANY other I/O, mirroring send-measurement-ready's 401/403-before-
 *     everything-else ordering);
 *   - loads the order by id (a lead_measurement_orders row, PR #2226 schema
 *     — see index.ts for the schema-dependency note), requires it to be
 *     status='fulfilled' (the lead equivalent of hover_orders.status ===
 *     'completed'), exactly like send-measurement-ready's order-status gate;
 *   - writes an activity_log row BEFORE the send, same ordering;
 *   - is idempotent against the `notifications` table (type + channel +
 *     order id in message_preview), the exact mechanism send-measurement-
 *     ready uses — no new column, no migration;
 *   - sends via Mailgun (index.ts wires the real fetch call);
 *   - a failed send is recorded loudly via notification-failure.ts
 *     (activity_log 'notification_failed' + platform_alerts_log), same as
 *     send-measurement-ready.
 *
 * WHERE IT DIFFERS FROM send-measurement-ready (both forced by the schema —
 * a lead has no auth.users row, unlike a homeowner's account):
 *   - activity_log.user_id is NOT NULL with a hard FK to auth.users(id)
 *     (baseline schema, `activity_log_user_id_fkey`). A lead order has no
 *     account and therefore no real user_id of its own to put there. Per
 *     REVIEW: FAIL 5860802819 must-fix 2 (a prod read-only count proved the
 *     all-zero sentinel this file previously used has never once satisfied
 *     that FK — 0 rows in auth.users, 0 rows in activity_log with that
 *     user_id, ever), the row is instead attributed to the TRIGGERING
 *     ADMIN's own `user.id` — a real, always-present auth.users row, since
 *     only an authenticated admin can ever reach this far (the admin gate
 *     runs first). `adminUserId` is passed in below rather than sourced from
 *     Deps, and a failed pre-send activity_log insert now ABORTS the send
 *     (502) instead of continuing — see handleSendRequest.
 *   - `notifications.user_id` has no such constraint (nullable, no FK — see
 *     baseline schema) so the notifications row this function inserts for
 *     idempotency simply carries `user_id: null, claim_id: null` for a lead
 *     order; nothing new needed there either.
 *   - the recipient is the lead's on-file email (public.leads.email via
 *     lead_measurement_orders.lead_id), not a homeowner profile row.
 *   - the email copy has no dashboard link and no login — there is no
 *     account for the lead to sign into. Every other sentence is reused
 *     from send-measurement-ready's copy verbatim; see buildLeadReadyEmail's
 *     doc comment below for the itemized list of the sentences that had to
 *     change and why.
 */

import {
  footerPostalAddressHtml,
  footerPostalAddressText,
} from "./email-footer.ts";
import {
  isVerifySendRequested,
  logNotificationFailureLoud,
} from "./notification-failure.ts";

export { isVerifySendRequested };

export const FUNCTION_NAME = "send-lead-measurement-ready";
export const NOTIFICATION_TYPE = "lead_measurement_report_ready";
export const ACTIVITY_LOG_EVENT_TYPE = "lead_measurement_report_sent";

/** Same test-account patterns as send-measurement-ready / notify-measurement-order. */
export function isTestAccount(email: string): boolean {
  const lower = (email ?? "").toLowerCase();
  return (
    lower.includes("otterquote-internal.test") ||
    lower.includes("pfw-") ||
    lower.includes("authdoctor")
  );
}

export function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface LeadOrderRow {
  id: string;
  lead_id: string;
  status: string;
  product_code: string | null;
  is_test: boolean | null;
}

export interface LeadRow {
  email: string | null;
  name: string | null;
  is_synthetic: boolean | null;
  property_address: string | null;
}

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
}

export interface SendResult {
  ok: boolean;
  id?: string;
}

export interface Deps {
  /** SELECT id, lead_id, status, product_code, is_test FROM lead_measurement_orders WHERE id = orderId. */
  loadOrder: (orderId: string) => Promise<LeadOrderRow | null>;
  /** SELECT email, name, is_synthetic, property_address FROM leads WHERE id = leadId. */
  loadLead: (leadId: string) => Promise<LeadRow | null>;
  /**
   * Checks whether a `notifications` row already exists for this order
   * (notification_type=NOTIFICATION_TYPE, channel='email', order id in
   * message_preview) — the exact idempotency check send-measurement-ready
   * uses. Checked BEFORE the activity_log write / send, so a re-trigger on
   * an already-sent order never reaches either.
   *
   * FAILS CLOSED (REVIEW: FAIL 5860802819 must-fix 3): `error: true` means
   * the query itself could not be answered (a transient PostgREST/DB error),
   * NOT "no row found" — handleSendRequest treats that as "cannot confirm
   * not-yet-sent" and returns 5xx without sending, rather than defaulting to
   * `exists: false` and risking a double send.
   */
  findExistingNotification: (orderId: string) => Promise<{ exists: boolean; error: boolean }>;
  /**
   * INSERT INTO activity_log(...); called once, before sendEmail. Return
   * type is PromiseLike (not Promise) so the real wiring can hand back a
   * Supabase PostgrestFilterBuilder directly (thenable, not a full Promise —
   * same convention as notification-failure.ts's InsertResult callers).
   */
  writeActivityLog: (row: {
    event_type: string;
    title: string;
    user_id: string;
    is_test: boolean;
    metadata: Record<string, unknown>;
  }) => PromiseLike<{ error: { message: string } | null }>;
  /** The Mailgun send (index.ts wires the real fetch call). `to` is the resolved lead recipient. */
  sendEmail: (to: string, msg: EmailMessage) => Promise<SendResult>;
  /** INSERT INTO notifications(...) — the idempotency record for the NEXT call. */
  recordNotification: (row: {
    user_id: null;
    claim_id: null;
    channel: "email";
    notification_type: string;
    recipient: string;
    message_preview: string;
    sent_at: string;
    delivered: boolean;
    mailgun_id: string | null;
  }) => PromiseLike<{ error: { message: string } | null }>;
  /** activity_log('notification_failed') writer, passed through to notification-failure.ts. */
  insertActivityLogFailure: (row: unknown) => PromiseLike<{ error: { message: string } | null }>;
  /** platform_alerts_log writer, passed through to notification-failure.ts. */
  insertPlatformAlert: (row: unknown) => PromiseLike<{ error: { message: string } | null }>;
  /** X-Verify-Send: 1 — admin-only bypass of the is_test send skip (gh-1538 pattern). */
  verifySend: boolean;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * buildLeadReadyEmail — reuses send-measurement-ready's buyer-facing wording
 * as closely as possible. Every changed sentence, itemized:
 *
 *   1. Greeting / good-news line: UNCHANGED verbatim ("Hi {name}," / "Good
 *      news — the {product} you ordered for {address} is ready.").
 *   2. "The measurements are now on your project, and contractors bidding
 *      your job can use them right away. You can review everything from
 *      your dashboard." -> REMOVED, NO REPLACEMENT PROMISE COPY (REVIEW:
 *      FAIL 5860802819 must-fix 1 / Ben's RETURNED 5860911206). This
 *      sentence originally said the report was "attached to this email" —
 *      false: nothing attaches it, and there is no report/storage column on
 *      lead_measurement_orders to attach from (#2226's migration). HOW a
 *      lead actually receives the report is now a Tier C question with
 *      Dustin (Ben's options: A — key measurements rendered in the email
 *      body, no D-317 change, Ben's recommendation; B — an expiring
 *      branded report link; C — the vendor PDF attached, which needs a
 *      D-317 cl.7 carve-out, since main's send-measurement-ready header
 *      states the vendor PDF is "NEVER served to a contractor or
 *      homeowner"). Until Dustin answers, this function sends NO delivery
 *      promise at all rather than inventing one — see the PR/HANDOFF-LIVE
 *      for the hold. THIS PR MUST NOT MERGE until that answer is
 *      implemented here.
 *   3. The "View your project" button, linking to DASHBOARD_URL -> REMOVED.
 *      No equivalent exists for a no-account lead; nothing replaces it.
 *   4. "Questions? Just reply to this email or write to
 *      support@otterquote.com." -> UNCHANGED verbatim.
 *   5. Footer (Otter Quotes / support email / postal address) -> UNCHANGED,
 *      same footer-address module as send-measurement-ready.
 *
 * No new legal, consent or pricing claim is introduced anywhere in this
 * copy (#2272 Tier A ruling: "no new legal/consent text; the [L4] sentence
 * is already approved").
 */
export function buildLeadReadyEmail(args: {
  firstName: string;
  productLabel: string;
  address: string;
}): EmailMessage {
  const subject = `Your ${args.productLabel} is ready`;

  const textBody = [
    `Hi ${args.firstName},`,
    ``,
    `Good news — the ${args.productLabel} you ordered for ${args.address} is ready.`,
    ``,
    `Questions? Just reply to this email or write to support@otterquote.com.`,
    ``,
    `— Otter Quotes`,
    ``,
    footerPostalAddressText(),
  ].join("\n");

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#F1F5F9;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
  <tr>
    <td align="center" style="padding:24px 16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td style="background:#0B1929;padding:20px 24px;">
            <h2 style="color:#F59E0B;margin:0;font-size:1.1rem;font-family:sans-serif;">
              🦦 Your measurement report is ready
            </h2>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;font-family:sans-serif;color:#0B1929;">
            <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">
              Hi ${escapeHtml(args.firstName)},
            </p>
            <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">
              Good news — the ${escapeHtml(args.productLabel)} you ordered for
              <strong>${escapeHtml(args.address)}</strong> is ready.
            </p>
            <p style="margin:0;font-size:13px;color:#64748B;line-height:1.6;">
              Questions? Just reply to this email or write to
              <a href="mailto:support@otterquote.com" style="color:#0EA5E9;">support@otterquote.com</a>.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center"
              style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px;
                     font-family:sans-serif;font-size:12px;color:#94A3B8;">
            Otter Quotes &nbsp;|&nbsp;
            <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
            ${footerPostalAddressHtml()}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();

  return { subject, text: textBody, html: htmlBody };
}

/**
 * Core handler. `isAdmin` is resolved by index.ts (the same two-step check
 * as send-measurement-ready: PRIMARY_ADMIN_EMAIL fast-path, then
 * contractors.template_review_role === 'admin') and checked HERE first,
 * before any deps call — a non-admin caller triggers zero I/O.
 *
 * `adminUserId` is the triggering admin's own `user.id` (index.ts already
 * has it from `userClient.auth.getUser()`), used to attribute the
 * activity_log row — see the module doc comment and REVIEW: FAIL
 * 5860802819 must-fix 2 for why a lead's own id can never be used there.
 */
export async function handleSendRequest(
  orderId: string | undefined,
  isAdmin: boolean,
  adminUserId: string | undefined,
  deps: Deps,
): Promise<HandlerResult> {
  if (!isAdmin) {
    return { status: 403, body: { error: "Forbidden: admin role required" } };
  }
  if (!orderId) {
    return { status: 400, body: { error: "Missing required field: order_id" } };
  }
  if (!adminUserId) {
    // Defensive: isAdmin=true should always come with a resolved caller id.
    // If it somehow doesn't, attributing the activity_log row to nothing
    // would just trade one FK violation for another — abort instead.
    return { status: 500, body: { error: "Internal server error" } };
  }

  const order = await deps.loadOrder(orderId);
  if (!order) {
    return { status: 404, body: { error: "Order not found" } };
  }
  if (order.status !== "fulfilled") {
    return {
      status: 409,
      body: { error: `Order is not fulfilled (status: ${order.status}). Fulfil it first.` },
    };
  }

  const lead = await deps.loadLead(order.lead_id);
  if (!lead) {
    return { status: 404, body: { error: "Lead not found" } };
  }
  const recipientEmail = lead.email || "";
  if (!recipientEmail) {
    return { status: 422, body: { error: "No lead email on file" } };
  }

  const isTest = order.is_test === true || lead.is_synthetic === true || isTestAccount(recipientEmail);
  if (isTest && !deps.verifySend) {
    return { status: 200, body: { success: true, skipped: true, reason: "test_account" } };
  }

  // Idempotency: one "report ready" email per order, ever. FAILS CLOSED
  // (REVIEW: FAIL 5860802819 must-fix 3): a query error means "cannot
  // confirm not-yet-sent", not "not sent" — never send on that ambiguity.
  const existingCheck = await deps.findExistingNotification(orderId);
  if (existingCheck.error) {
    return {
      status: 502,
      body: { error: "Could not confirm this order has not already been notified. Try again." },
    };
  }
  if (existingCheck.exists) {
    return { status: 200, body: { success: true, skipped: true, reason: "already_notified" } };
  }

  // ── activity_log BEFORE the send — a failure here ABORTS the send ───────
  // (REVIEW: FAIL 5860802819 must-fix 2). Unlike send-measurement-ready
  // (whose activity_log row logs a SEPARATE, already-true fact — order
  // fulfilment — so a failed write there doesn't invalidate sending), this
  // function's activity_log row IS the audit record for the send itself
  // (#2226 Step 0(c) requires "an activity_log row recorded before the
  // send"); if it can't be written, the send must not happen either.
  const { error: logErr } = await deps.writeActivityLog({
    event_type: ACTIVITY_LOG_EVENT_TYPE,
    title: ACTIVITY_LOG_EVENT_TYPE,
    user_id: adminUserId,
    is_test: isTest,
    metadata: {
      order_id: order.id,
      lead_id: order.lead_id,
      product_code: order.product_code,
      verify_send: deps.verifySend,
    },
  });
  if (logErr) {
    console.error(`[${FUNCTION_NAME}] activity_log insert failed for order=${orderId}, aborting send:`, logErr.message);
    return { status: 502, body: { error: "Failed to record activity_log; send aborted." } };
  }

  const firstName = (lead.name || "").trim().split(/\s+/)[0] || "there";
  const address = lead.property_address || "your property";
  const productLabel = order.product_code === "roof_basic" ? "roof measurement report" : "measurement report";
  const msg = buildLeadReadyEmail({ firstName, productLabel, address });

  let sent: SendResult;
  try {
    sent = await deps.sendEmail(recipientEmail, msg);
  } catch (sendErr) {
    sent = { ok: false };
    await logNotificationFailureLoud(
      (row) => deps.insertActivityLogFailure(row),
      sendErr,
      {
        functionName: FUNCTION_NAME,
        recipientRole: "lead",
        isTest,
        userId: adminUserId,
        extra: { order_id: orderId, lead_id: order.lead_id, verify_send: deps.verifySend },
      },
      (alert) => deps.insertPlatformAlert(alert),
    );
    return { status: 502, body: { error: "Failed to send notification" } };
  }
  if (!sent.ok) {
    await logNotificationFailureLoud(
      (row) => deps.insertActivityLogFailure(row),
      new Error("Mailgun send returned ok:false"),
      {
        functionName: FUNCTION_NAME,
        recipientRole: "lead",
        isTest,
        userId: adminUserId,
        extra: { order_id: orderId, lead_id: order.lead_id, verify_send: deps.verifySend },
      },
      (alert) => deps.insertPlatformAlert(alert),
    );
    return { status: 502, body: { error: "Failed to send notification" } };
  }

  const { error: notifyErr } = await deps.recordNotification({
    user_id: null,
    claim_id: null,
    channel: "email",
    notification_type: NOTIFICATION_TYPE,
    recipient: recipientEmail,
    message_preview: `Lead measurement report ready — order ${order.id} (${productLabel})`,
    sent_at: new Date().toISOString(),
    delivered: true,
    mailgun_id: sent.id ?? null,
  });
  if (notifyErr) {
    console.warn(`[${FUNCTION_NAME}] failed to log notification for order=${orderId}:`, notifyErr.message);
  }

  return { status: 200, body: { success: true, mailgun_id: sent.id ?? null } };
}
