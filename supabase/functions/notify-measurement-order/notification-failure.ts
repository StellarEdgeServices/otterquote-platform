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
