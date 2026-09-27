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
 *     account and therefore no real user_id to put there. This repo already
 *     has a standing convention for exactly this gap — stripe-webhook and
 *     send-sms both fall back to the all-zero sentinel UUID
 *     "00000000-0000-0000-0000-000000000000" when there is no associated
 *     claim/user (see stripe-webhook/index.ts's two
 *     `claim?.user_id ?? "00000000-0000-0000-0000-000000000000"` call
 *     sites). SYSTEM_USER_ID below reuses that exact, already-shipped
 *     convention rather than inventing a new one or shipping a migration to
 *     make the column nullable.
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

/**
 * gh-2272: activity_log.user_id is NOT NULL with a hard FK to auth.users.
 * A lead (no-account) order has no user to attribute the row to. This is
 * the SAME all-zero sentinel already used by stripe-webhook and send-sms
 * for exactly this "no associated account" case — not a new convention.
 */
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

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
   * True iff a `notifications` row already exists for this order
   * (notification_type=NOTIFICATION_TYPE, channel='email', order id in
   * message_preview) — the exact idempotency check send-measurement-ready
   * uses. Checked BEFORE the activity_log write / send, so a re-trigger on
   * an already-sent order never reaches either.
   */
  findExistingNotification: (orderId: string) => Promise<boolean>;
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
 *      your dashboard." -> CHANGED. A lead has no dashboard and no account
 *      to review anything from. Replaced with: "Your full report is
 *      attached to this email — there's nothing else you need to do."
 *      (matches the L4 success-screen sentence's own promise: "We'll email
 *      your roof measurement report... as soon as it's ready.")
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
    `Your full report is attached to this email — there's nothing else you need to do.`,
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
            <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6;">
              Your full report is attached to this email — there's nothing else you need to do.
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
 */
export async function handleSendRequest(
  orderId: string | undefined,
  isAdmin: boolean,
  deps: Deps,
): Promise<HandlerResult> {
  if (!isAdmin) {
    return { status: 403, body: { error: "Forbidden: admin role required" } };
  }
  if (!orderId) {
    return { status: 400, body: { error: "Missing required field: order_id" } };
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

  // Idempotency: one "report ready" email per order, ever.
  const alreadySent = await deps.findExistingNotification(orderId);
  if (alreadySent) {
    return { status: 200, body: { success: true, skipped: true, reason: "already_notified" } };
  }

  // ── activity_log BEFORE the send ────────────────────────────────────────
  const { error: logErr } = await deps.writeActivityLog({
    event_type: ACTIVITY_LOG_EVENT_TYPE,
    title: ACTIVITY_LOG_EVENT_TYPE,
    user_id: SYSTEM_USER_ID,
    is_test: isTest,
    metadata: {
      order_id: order.id,
      lead_id: order.lead_id,
      product_code: order.product_code,
      verify_send: deps.verifySend,
    },
  });
  if (logErr) {
    // Loud but non-fatal: mirrors send-measurement-ready — the send path continues.
    console.error(`[${FUNCTION_NAME}] activity_log insert failed for order=${orderId}:`, logErr.message);
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
        userId: SYSTEM_USER_ID,
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
        userId: SYSTEM_USER_ID,
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
