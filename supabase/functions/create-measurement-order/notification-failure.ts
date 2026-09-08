/**
 * notification-failure.ts (gh-1538)
 *
 * Builds and durably records a trace for an otherwise-silently-swallowed
 * notification-send failure. Before gh-1538, a failed email/invoke anywhere
 * in the measurement-order flow (create-measurement-order,
 * notify-measurement-order, send-measurement-ready) left only a
 * console.error line — Supabase does not forward those anywhere durable, so
 * a homeowner or contractor whose paid order's confirmation silently failed
 * had no trace anywhere (#1412's finding, filed as #1538).
 *
 * Per the issue's Do #1: every catch around a send writes one activity_log
 * row (event_type 'notification_failed', metadata {function, recipient_role,
 * error}) and calls Sentry.captureException where the function already
 * initialises Sentry. None of these three functions do (see
 * _shared/sentry.ts's canonical reporter — inlined into 3 unrelated EFs, not
 * these) — per the issue's own fallback clause, console.error with a
 * [NOTIFY-FAIL] prefix is the floor here.
 *
 * Colocated per Edge Function directory (not _shared/) because the EF
 * deploy path does not resolve `_shared/` imports — same constraint
 * documented in `_shared/sentry.ts` and `_shared/email.ts`. This file is
 * byte-identical across create-measurement-order, notify-measurement-order,
 * and send-measurement-ready; keep the three copies in sync by eye.
 */

export interface NotificationFailureContext {
  functionName: string;
  recipientRole: string;
  isTest: boolean;
  userId: string;
  extra?: Record<string, unknown>;
}

export interface NotificationFailureRow {
  event_type: "notification_failed";
  title: "notification_failed";
  user_id: string;
  is_test: boolean;
  metadata: Record<string, unknown>;
}

export interface InsertResult {
  error: { message: string } | null;
}

/** Pure: builds the activity_log row for a swallowed notification-send failure. */
export function buildNotificationFailureRow(
  err: unknown,
  ctx: NotificationFailureContext,
): NotificationFailureRow {
  return {
    event_type: "notification_failed",
    title: "notification_failed",
    user_id: ctx.userId,
    is_test: ctx.isTest,
    metadata: {
      function: ctx.functionName,
      recipient_role: ctx.recipientRole,
      error: String(err).slice(0, 200),
      ...(ctx.extra ?? {}),
    },
  };
}

/**
 * Records the failure via an injectable insert function (real callers pass
 * `(row) => supabase.from("activity_log").insert(row)`). Never throws — a
 * notification failure must never become a second failure on top of the
 * money path. Both the original error and any insert error are logged with
 * the [NOTIFY-FAIL] prefix (see module doc for why console.error is the
 * floor here).
 */
export async function logNotificationFailure(
  insertRow: (row: NotificationFailureRow) => PromiseLike<InsertResult>,
  err: unknown,
  ctx: NotificationFailureContext,
): Promise<NotificationFailureRow> {
  const row = buildNotificationFailureRow(err, ctx);
  const prefix = `[NOTIFY-FAIL][${ctx.functionName}]`;
  console.error(prefix, row.metadata.error, ctx.extra ?? "");
  try {
    const { error } = await insertRow(row);
    if (error) {
      console.error(`${prefix} activity_log insert failed:`, error.message);
    }
  } catch (writeErr) {
    console.error(`${prefix} activity_log write threw:`, writeErr);
  }
  return row;
}

/* ──────────────────────────────────────────────────────────────────────────
 * gh-1538 (second pass): the activity_log row above is durable but it is not
 * LOUD. `activity_log` is an append-only audit table with no admin surface
 * that filters it — a `notification_failed` row lands there and is seen by
 * nobody. Measured 2026-09-07: the row type had existed in the deployed bytes
 * of all three functions for five days and `select count(*) from activity_log
 * where event_type='notification_failed'` was still 0, with no operator
 * surface that would have shown one if it were there. The admin alert surface
 * that IS watched is `platform_alerts_log`, which admin-contractors.html
 * already reads and renders (see its `.from('platform_alerts_log')` queries).
 * So every swallowed notification failure now writes BOTH:
 *
 *   activity_log        — the per-user audit trail (unchanged, keeps is_test)
 *   platform_alerts_log — the operator-visible alert (alert_type
 *                         'notification_failed')
 *
 * Both writes are best-effort and independent: a failure of either must not
 * become a second failure on top of the money path, and must not suppress the
 * other. `platform_alerts_log` has no is_test column, so test traffic is
 * marked in the message text instead of being dropped — a verification run
 * must be able to see its own alert.
 * ────────────────────────────────────────────────────────────────────────── */

export interface PlatformAlertRow {
  alert_type: "notification_failed";
  function_name: string;
  message: string;
}

/** Pure: builds the platform_alerts_log row for a swallowed notification-send failure. */
export function buildPlatformAlertRow(
  err: unknown,
  ctx: NotificationFailureContext,
): PlatformAlertRow {
  const orderId = (ctx.extra?.order_id as string | undefined) ?? "(no order id)";
  const marks = `${ctx.isTest ? "[TEST]" : ""}${ctx.extra?.verify_send === true ? "[VERIFY-SEND]" : ""}`;
  const prefix = marks ? marks + " " : "";
  return {
    alert_type: "notification_failed",
    function_name: ctx.functionName,
    message:
      `${prefix}notification send failed for ${ctx.recipientRole} ` +
      `(order ${orderId}): ${String(err).slice(0, 200)}`,
  };
}

/**
 * Records the failure on BOTH surfaces. `insertRow` writes activity_log (as
 * before); `insertAlert`, when supplied, writes platform_alerts_log. Callers
 * that omit `insertAlert` keep the previous behaviour, so this is additive at
 * every existing call site.
 *
 * Never throws, and neither write can suppress the other: each is wrapped
 * independently.
 */
export async function logNotificationFailureLoud(
  insertRow: (row: NotificationFailureRow) => PromiseLike<InsertResult>,
  err: unknown,
  ctx: NotificationFailureContext,
  insertAlert?: (row: PlatformAlertRow) => PromiseLike<InsertResult>,
): Promise<{ row: NotificationFailureRow; alert: PlatformAlertRow | null }> {
  const row = await logNotificationFailure(insertRow, err, ctx);
  if (!insertAlert) return { row, alert: null };

  const alert = buildPlatformAlertRow(err, ctx);
  const prefix = `[NOTIFY-FAIL][${ctx.functionName}]`;
  try {
    const { error } = await insertAlert(alert);
    if (error) {
      console.error(`${prefix} platform_alerts_log insert failed:`, error.message);
    }
  } catch (writeErr) {
    console.error(`${prefix} platform_alerts_log write threw:`, writeErr);
  }
  return { row, alert };
}

/* ──────────────────────────────────────────────────────────────────────────
 * gh-1538: the X-Verify-Send escape hatch, and why it is shaped this way.
 *
 * This issue's closes-on needs one `activity_log` row of
 * event_type='notification_failed' "produced by a forced-failure test against
 * an is_test order". That artifact was unproducible for a structural reason
 * measured on 2026-09-07: notify-measurement-order and send-measurement-ready
 * both RETURN EARLY on is_test data, BEFORE the Mailgun call — so any
 * forced-failure fixture aimed at an is_test order exercises the early
 * return, writes no row, and reads as a pass. A false pass is worse than no
 * evidence.
 *
 * The bypass is deliberately the narrowest thing that makes the artifact
 * producible:
 *   - it fires ONLY on an explicit `X-Verify-Send: 1` request header — never
 *     on a body field, a query param, an env var or a default;
 *   - it is evaluated ONLY after the function's existing caller
 *     authorization has already passed (admin JWT in send-measurement-ready,
 *     service-role bearer in notify-measurement-order), so it grants an
 *     authorized caller nothing they could not already do to non-test data;
 *   - it bypasses the is_test SKIP only. It does not bypass the admin gate,
 *     the idempotency guard, the order-status guard, or any money gate;
 *   - it never suppresses a send and never enables one that was not already
 *     configured — it only stops the early return, so the real send path runs;
 *   - it is recorded: `verify_send: true` lands in the activity_log metadata
 *     and `[VERIFY-SEND]` in the alert message, so a verification-triggered
 *     email is never mistaken for organic traffic in the audit trail.
 *
 * Consequence to state plainly: with this header, a real email IS sent to the
 * address on an is_test row. That is the point — a verification that does not
 * send proves nothing — and it is why the header is admin-only and logged.
 * ────────────────────────────────────────────────────────────────────────── */

/** The request header that opts a single call out of the is_test send skip. */
export const VERIFY_SEND_HEADER = "X-Verify-Send";

/**
 * Pure: true only for an exact `X-Verify-Send: 1`. Any other value — "true",
 * "yes", "0", "", a missing header — is false, so the opt-in cannot be
 * tripped by a proxy that stuffs headers or by a truthy-string mistake.
 */
export function isVerifySendRequested(headers: {
  get(name: string): string | null;
}): boolean {
  return headers.get(VERIFY_SEND_HEADER) === "1";
}
