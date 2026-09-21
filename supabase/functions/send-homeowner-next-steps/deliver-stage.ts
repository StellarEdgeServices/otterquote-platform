// gh-1570 / gh-1580 — the per-(claim, stage) delivery decision, extracted from
// index.ts so it can be TESTED with fake dependencies.
//
// WHY IT MOVED HERE (PR #1859 REVIEW: FAIL, comment 5584464326)
// -------------------------------------------------------------
// The first version of the dry-run mode was guarded by the POSITION of one
// `if (dryRun) { …; continue; }` inside index.ts's stage loop, above the
// stamp. The reviewer's words: "Move that `continue` five lines down in a
// future refactor and the function stamps and emails, with a green suite."
// That was correct — the three properties the mode's safety rests on (the
// scan filter, no activity_log insert, no Mailgun call) had zero assertions
// between them, because none of them was reachable from a test.
//
// They are reachable now. `deliverStage` takes its database and mail
// dependencies as arguments, so a test can hand it recording fakes and assert
// that a dry run calls NEITHER. The mutant that motivated this — moving the
// dry-run branch below the insert — fails those tests.
//
// gh-2069 (this change) — STAMP ORDER FLIPPED, ON PURPOSE, PER THE ISSUE.
// -------------------------------------------------------------------------
// The prior version stamped `activity_log` with "Next-steps nudge sent"
// BEFORE calling Mailgun, specifically so a failed send and a delivered send
// could not produce an identical row (gh-1580 review fix, PR #1601 comment
// 5532245612) — a deliberate "at most once" choice: skipping a nudge on crash
// is recoverable, double-emailing a real homeowner is not.
//
// gh-2069 found the cost of that choice: the activity_log line said "Sent"
// for a send that had not happened yet, so a failed send and a delivered send
// were STILL indistinguishable in the one place a human reads — the row said
// "Sent" either way, because it was written before the outcome existed to
// report. Issue #2069 (filed by Ben, CEO RUN 57, from the investigation in
// `In Flight/reports/ceo57-nudge-pipeline-20260921.md`) asks for the order to
// flip: call Mailgun first, then write ONE row that says what actually
// happened ("Next-steps nudge sent" on an accepted send, "FAILED …: <error>"
// on a rejected one), plus a `notifications` row carrying the Mailgun message
// id so the record outlives Mailgun's ~5-day event retention.
//
// This is a real trade-off, not a free improvement, and it is taken
// knowingly: the "at most once" guard above depended on the stamp landing
// BEFORE the send so a losing concurrent invocation's 23505 unique-violation
// (once the Tier 3B unique partial index on activity_log lands — see the
// ORIGINAL comment block below, still accurate, now applying to the
// post-send insert) would stop it from calling Mailgun at all. With the
// stamp moved after the send, that guard can no longer PREVENT a concurrent
// double-send — it can only detect one, after both invocations have already
// emailed. Two mitigating facts, both already true today and unchanged by
// this PR: (1) the unique index does not exist yet, so the 23505 branch is
// dead code in EITHER order — this PR removes no protection that currently
// runs in production; (2) cron.job 20 fires every 30 minutes with no manual
// trigger in front of it, so the overlapping-invocation window this guard
// was built for is narrow and, per the R-097 risk brief posted on #2069,
// the accepted worst case is a failed send retried on the next tick, not a
// duplicate. If the Tier 3B index lands, closing the concurrent-double-send
// gap for real requires a SEPARATE pre-send claim (e.g. an
// INSERT ... ON CONFLICT DO NOTHING lock row keyed on (claim_id, stage),
// distinct from this outcome-reporting row) — flagged here as follow-up
// scope, not solved by this change.

/** What a dry run reports for one (claim, stage).
 *
 * NO RECIPIENT ADDRESS. The first version returned `to` — the homeowner's
 * email — over HTTP, which the review correctly called a new PII egress. The
 * diagnostic value is in the claim, the stage and whether the D-320 footer
 * rendered; the address adds none and is the one field that must not leave
 * the function. `recipient_present` says a deliverable address was resolved
 * without saying what it is. */
export interface PreviewRow {
  claim_id: string;
  stage: string;
  subject: string;
  text_first_line: string;
  /** D-320 opt-out link present in the plain-text body. */
  has_optout_link_text: boolean;
  /** …and in the HTML body, which is what most recipients actually see. */
  has_optout_link_html: boolean;
  recipient_present: boolean;
}

export interface EmailContent {
  subject: string;
  textBody: string;
  htmlBody: string;
}

export interface StampError {
  code?: string;
  message?: string;
}

// gh-2069: the `notifications` row written after every real send attempt
// (accepted or rejected) — the durable, provider-id-carrying record Mailgun's
// own event log only holds for ~5 days. Mirrors the shape
// admin-digest-executor.ts's insertNotificationRows already writes for the
// admin digest (`notification_type`, `recipient`, `mailgun_id`, `delivered`) —
// same columns, same table, no new convention.
export interface NotificationRow {
  user_id: string;
  claim_id: string;
  channel: "email";
  notification_type: string;
  recipient: string;
  message_preview: string;
  delivered: boolean;
  mailgun_id: string | null;
}

export interface DeliverDeps {
  dryRun: boolean;
  mailgunConfigured: boolean;
  buildEmail: (name: string, measurementsUrl: string, colorUrl: string, optOutUrl: string) => EmailContent;
  insertActivityLog: (row: Record<string, unknown>) => Promise<{ error: StampError | null }>;
  // gh-2069: returns Mailgun's own message id on an accepted send (copied
  // from sendAdminDigestMail's pattern in index.ts, applied here for the
  // first time on the homeowner path — see index.ts's sendMailgunEmail).
  sendEmail: (
    to: string, name: string, measurementsUrl: string, colorUrl: string, optOutUrl: string,
  ) => Promise<{ ok: boolean; mailgunId?: string; error?: string }>;
  // gh-2069: writes the notifications row described above. Failure here is
  // logged, not fatal — the email has already gone out (or definitively
  // failed) by the time this is called, and that outcome must not be
  // reverted or retried just because the audit write had trouble.
  insertNotification: (row: NotificationRow) => Promise<{ error: string | null }>;
  log?: (level: "log" | "warn" | "error", message: string) => void;
}

export interface DeliverCtx {
  claimId: string;
  userId: string;
  stage: string;
  homeownerEmail: string;
  homeownerName: string;
  measurementsUrl: string;
  colorUrl: string;
  optOutUrl: string;
}

export type DeliverOutcome =
  | { kind: "previewed"; stage: string; preview: PreviewRow }
  | { kind: "sent"; stage: string }
  | { kind: "already_sent"; stage: string }
  | { kind: "stamp_failed"; stage: string; error: string }
  | { kind: "send_failed"; stage: string; error: string };

export const NUDGE_EVENT_TYPE = "next_steps_nudge_sent";

export async function deliverStage(deps: DeliverDeps, ctx: DeliverCtx): Promise<DeliverOutcome> {
  const say = deps.log ?? (() => {});

  // ── DRY RUN — render, report, and return before ANY write or send. ────────
  // This must stay the first branch: everything below it either stamps the
  // audit row or calls Mailgun, and a preview may do neither. The tests in
  // deliver-stage.test.ts assert the insert and send fakes are called zero
  // times here, so moving this branch down fails the suite rather than
  // silently emailing a fixture.
  if (deps.dryRun) {
    const preview = deps.buildEmail(ctx.homeownerName, ctx.measurementsUrl, ctx.colorUrl, ctx.optOutUrl);
    say("log", `DRY RUN — would send ${ctx.stage} nudge for claim ${ctx.claimId} (nothing sent, nothing written)`);
    return {
      kind: "previewed",
      stage: ctx.stage,
      preview: {
        claim_id: ctx.claimId,
        stage: ctx.stage,
        subject: preview.subject,
        text_first_line: preview.textBody.split("\n")[0],
        has_optout_link_text: preview.textBody.includes(ctx.optOutUrl),
        has_optout_link_html: preview.htmlBody.includes(ctx.optOutUrl),
        recipient_present: Boolean(ctx.homeownerEmail),
      },
    };
  }

  const eventTitle = (ok: boolean, error?: string) =>
    ok
      ? (ctx.stage === "2h" ? "Next-steps nudge sent (+2h)" : "Next-steps nudge sent (+48h)")
      : (ctx.stage === "2h" ? `FAILED +2h nudge: ${error}` : `FAILED +48h nudge: ${error}`);

  const notificationTemplate = `homeowner_next_steps_${ctx.stage}`;

  const recordNotification = async (delivered: boolean, mailgunId: string | null, preview: string) => {
    const { error } = await deps.insertNotification({
      user_id: ctx.userId,
      claim_id: ctx.claimId,
      channel: "email",
      notification_type: notificationTemplate,
      recipient: ctx.homeownerEmail,
      message_preview: preview,
      delivered,
      mailgun_id: mailgunId,
    });
    if (error) {
      say("warn", `${ctx.stage} nudge for claim ${ctx.claimId} — outcome recorded in activity_log, but notifications insert failed: ${error}`);
    }
  };

  // gh-2069: dev/staging with no Mailgun key configured — nothing is sent,
  // but the outcome is still recorded (unchanged intent from the prior
  // "stamp recorded, no email sent" branch; just written after the decision
  // instead of before a send that was never going to happen).
  if (!deps.mailgunConfigured) {
    say("warn", `MAILGUN_API_KEY not set — no email sent (dev/staging) for claim ${ctx.claimId} stage ${ctx.stage}`);
    const { error: stampError } = await deps.insertActivityLog({
      user_id: ctx.userId,
      event_type: NUDGE_EVENT_TYPE,
      title: eventTitle(true),
      metadata: { claim_id: ctx.claimId, nudge_stage: ctx.stage, system_generated: true, mailgun_configured: false },
      is_test: false,
    });
    if (stampError?.code === "23505") {
      return { kind: "already_sent", stage: ctx.stage };
    }
    if (stampError) {
      say("error", `Failed to record ${ctx.stage} nudge (no-Mailgun path) for claim ${ctx.claimId}: ${stampError.message}`);
    }
    await recordNotification(true, null, eventTitle(true));
    return { kind: "sent", stage: ctx.stage };
  }

  // gh-2069: call Mailgun FIRST — the activity_log line and the notifications
  // row below both describe what actually happened, so neither can be
  // written before the outcome exists. See the file header for the
  // trade-off this accepts relative to the prior stamp-before-send order.
  const sendResult = await deps.sendEmail(
    ctx.homeownerEmail, ctx.homeownerName, ctx.measurementsUrl, ctx.colorUrl, ctx.optOutUrl,
  );

  if (!sendResult.ok) {
    const error = sendResult.error ?? "unknown";
    // gh-2069 REVIEW FIX: this stage is never retried automatically (this was
    // true on main before this PR too — a failed nudge stage is simply
    // skipped, not requeued). The log line previously said "will retry next
    // run", which was wrong. Corrected here to avoid implying a retry
    // mechanism that does not exist.
    say("error", `FAILED ${ctx.stage} nudge for claim ${ctx.claimId} — not retried: ${error}`);
    const { error: stampError } = await deps.insertActivityLog({
      user_id: ctx.userId,
      event_type: NUDGE_EVENT_TYPE,
      title: eventTitle(false, error),
      metadata: { claim_id: ctx.claimId, nudge_stage: ctx.stage, system_generated: true, send_failed: true, error },
      is_test: false,
    });
    if (stampError) {
      say("error", `Failed send for claim ${ctx.claimId} stage ${ctx.stage} ALSO failed to record in activity_log: ${stampError.message}`);
    }
    await recordNotification(false, null, eventTitle(false, error));
    return { kind: "send_failed", stage: ctx.stage, error };
  }

  say("log", `Sent ${ctx.stage} nudge for claim ${ctx.claimId}`);
  const mailgunId = sendResult.mailgunId ?? null;
  const { error: stampError } = await deps.insertActivityLog({
    user_id: ctx.userId,
    event_type: NUDGE_EVENT_TYPE,
    title: eventTitle(true),
    metadata: { claim_id: ctx.claimId, nudge_stage: ctx.stage, system_generated: true, mailgun_id: mailgunId },
    is_test: false,
  });
  if (stampError?.code === "23505") {
    // A concurrent invocation already recorded this exact (claim, stage).
    // The email above has already gone out either way (see the trade-off
    // note in the file header) — still write the notifications row so this
    // send is not the one left unrecorded.
    say("log", `${ctx.stage} nudge for claim ${ctx.claimId} recorded by a concurrent run (23505) after this run also sent`);
    await recordNotification(true, mailgunId, eventTitle(true));
    return { kind: "already_sent", stage: ctx.stage };
  }
  if (stampError) {
    say("error", `Sent ${ctx.stage} nudge for claim ${ctx.claimId} but failed to record it in activity_log: ${stampError.message}`);
  }
  await recordNotification(true, mailgunId, eventTitle(true));
  return { kind: "sent", stage: ctx.stage };
}
