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
// Nothing about the production path's behaviour changed in the move: the
// stamp-before-send order, the 23505 concurrent-run branch, the
// MAILGUN_API_KEY-unset branch and the stamped-but-send-failed branch are the
// same code with the same comments, now behind one function boundary.

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

export interface DeliverDeps {
  dryRun: boolean;
  mailgunConfigured: boolean;
  buildEmail: (name: string, measurementsUrl: string, colorUrl: string, optOutUrl: string) => EmailContent;
  insertActivityLog: (row: Record<string, unknown>) => Promise<{ error: StampError | null }>;
  sendEmail: (
    to: string, name: string, measurementsUrl: string, colorUrl: string, optOutUrl: string,
  ) => Promise<{ ok: boolean; error?: string }>;
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

  // gh-1580 review fix (PR #1601, comment 5532245612): stamp BEFORE sending.
  // If the stamp fails, nothing went out and the next cron run retries
  // cleanly; if the stamp commits and the send then fails, that claim does
  // NOT auto-retry and is logged loudly. Skipping a nudge is recoverable;
  // double-emailing a real homeowner is not.
  const { error: stampError } = await deps.insertActivityLog({
    user_id: ctx.userId,
    event_type: NUDGE_EVENT_TYPE,
    title: ctx.stage === "2h" ? "Next-steps nudge sent (+2h)" : "Next-steps nudge sent (+48h)",
    metadata: { claim_id: ctx.claimId, nudge_stage: ctx.stage, system_generated: true },
    is_test: false,
  });

  if (stampError) {
    // A unique violation means a concurrent invocation already stamped and
    // sent this exact (claim, stage) — not a failure. Dead code until the
    // Tier 3B unique partial index lands.
    if (stampError.code === "23505") {
      say("log", `${ctx.stage} nudge for claim ${ctx.claimId} already sent (23505 — concurrent run won the race) — skipping send`);
      return { kind: "already_sent", stage: ctx.stage };
    }
    say("error", `Failed to stamp ${ctx.stage} nudge for claim ${ctx.claimId} — skipping send this run, will retry next run: ${stampError.message}`);
    return { kind: "stamp_failed", stage: ctx.stage, error: stampError.message ?? "unknown" };
  }

  if (!deps.mailgunConfigured) {
    say("warn", `MAILGUN_API_KEY not set — stamp recorded, no email sent (dev/staging) for claim ${ctx.claimId} stage ${ctx.stage}`);
    return { kind: "sent", stage: ctx.stage };
  }

  const sendResult = await deps.sendEmail(
    ctx.homeownerEmail, ctx.homeownerName, ctx.measurementsUrl, ctx.colorUrl, ctx.optOutUrl,
  );
  if (!sendResult.ok) {
    say("error", `STAMPED BUT SEND FAILED for claim ${ctx.claimId} stage ${ctx.stage} — will NOT auto-retry (stamp already committed); needs manual follow-up: ${sendResult.error}`);
    return { kind: "send_failed", stage: ctx.stage, error: sendResult.error ?? "unknown" };
  }
  say("log", `Sent ${ctx.stage} nudge for claim ${ctx.claimId}`);
  return { kind: "sent", stage: ctx.stage };
}
