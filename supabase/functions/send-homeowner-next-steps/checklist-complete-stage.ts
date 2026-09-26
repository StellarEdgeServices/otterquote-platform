// gh-1570 Part 2 — the `checklist_complete_not_submitted` nudge stage.
//
// Ben's build spec (issue #1570, comment 5764786813, CEO RUN 57):
//   "2. The nudge function gains a stage `checklist_complete_not_submitted`:
//    checklist complete >= 2 h and `ready_for_bids` not true -> one homeowner
//    email ("you're one click from bids", existing template family) and
//    inclusion in the admin digest regardless of activity."
//
// This is a THIRD, INDEPENDENT stage alongside the '2h'/'48h' age ladder in
// ./select-stage.ts — it does not compete with that ladder and is not part
// of its terminal-stage logic. It fires once a claim has a `checklist_complete`
// activity_log row (written by dashboard.html's logChecklistCompleteOnce(),
// gh-1570 Part 1 / PR #2081) that is at least two hours old, PROVIDED the
// claim has not since been submitted (`ready_for_bids === true`). Per Ben's
// spec, this stage is NOT screened by "real activity since created" the way
// the '2h'/'48h' stages are (see ./select-stage.ts's
// real_activity_since_created) — uploading the checklist items IS activity,
// and screening on it would exclude exactly the homeowner this stage exists
// to catch (the whole defect #1570's title describes). It IS still screened
// by the D-320 opt-out gate, same as every other stage in this series.
//
// Copy: the phrase "you're one click from bids" is Ben's own words in the
// build spec above, not new customer-facing copy invented for this change.
// The template FORM (subject / plain-text / HTML with an opt-out footer) is
// copied verbatim in structure from ./email-content.ts's buildEmailContent —
// "existing template family", per the spec — with one CTA (back to the
// dashboard to click "Submit for Bids") in place of the two next-steps links,
// since there is nothing left to upload or choose at this stage.

import {
  footerPostalAddressHtml,
  footerPostalAddressText,
} from "./email-footer.ts";
import { OPTOUT_LINK_TEXT, OPTOUT_TEXT_LINE } from "./email-content.ts";
import { NUDGE_ELIGIBLE_STATUS, TWO_HOURS_MS } from "./select-stage.ts";

/** The new stage id, alongside '2h' / '48h' from ./select-stage.ts. */
export const CHECKLIST_COMPLETE_STAGE = "checklist_complete_not_submitted" as const;

/** activity_log.event_type dashboard.html writes once the checklist is done (gh-1570 Part 1). */
export const CHECKLIST_COMPLETE_EVENT_TYPE = "checklist_complete";

/** activity_log.event_type THIS stage stamps once it has sent — mirrors
 * deliver-stage.ts's NUDGE_EVENT_TYPE convention for the '2h'/'48h' stages,
 * as its own event type so the two series can never be confused when
 * reduced from the same activity_log read. */
export const CHECKLIST_COMPLETE_NUDGE_EVENT_TYPE = "checklist_complete_nudge_sent";

/** notification_type this stage's `notifications` row carries — same
 * `homeowner_next_steps_<stage>` convention deliver-stage.ts uses. */
export const CHECKLIST_COMPLETE_NOTIFICATION_TYPE =
  `homeowner_next_steps_${CHECKLIST_COMPLETE_STAGE}`;

/** Same 2h delay as the first rung of the age ladder — reused, not redefined. */
export const CHECKLIST_COMPLETE_DELAY_MS = TWO_HOURS_MS;

export interface ChecklistCompleteRow {
  event_type: string;
  metadata?: { claim_id?: string } | null;
  created_at: string;
}

export interface ReducedChecklistComplete {
  /** claim_id -> ISO created_at of the EARLIEST checklist_complete stamp. */
  completedAtByClaim: Map<string, string>;
  /** claim ids this stage has already sent its one email for. */
  alreadySent: Set<string>;
}

/**
 * Reduce a raw activity_log read into what selectChecklistCompleteStage
 * needs. Takes the SAME kind of read the '2h'/'48h' stages already do
 * (activity_log has no claim_id column, so this is read-whole-reduce-in-JS,
 * matching ./select-stage.ts's reduceActivityRows and this repo's other
 * uses of the same idiom) — a second reduction over the same shape of rows,
 * not a second query pattern.
 */
export function reduceChecklistCompleteActivity(
  rows: readonly ChecklistCompleteRow[],
): ReducedChecklistComplete {
  const completedAtByClaim = new Map<string, string>();
  const alreadySent = new Set<string>();

  for (const row of rows) {
    const claimId = row.metadata?.claim_id;
    if (!claimId) continue;
    if (row.event_type === CHECKLIST_COMPLETE_EVENT_TYPE) {
      const prev = completedAtByClaim.get(claimId);
      // Earliest wins, same reasoning as select-stage.ts's nudge-stamp
      // reduction: a duplicate write must not push the clock forward.
      if (!prev || row.created_at < prev) {
        completedAtByClaim.set(claimId, row.created_at);
      }
    } else if (row.event_type === CHECKLIST_COMPLETE_NUDGE_EVENT_TYPE) {
      alreadySent.add(claimId);
    }
  }

  return { completedAtByClaim, alreadySent };
}

export interface ChecklistCompleteClaim {
  id: string;
  status: string;
  /** `claims.ready_for_bids` — the column the "Submit for Bids" click flips. */
  ready_for_bids: boolean | null | undefined;
}

export type ChecklistCompleteSkipReason =
  | "ineligible_status"
  | "already_submitted"
  | "not_checklist_complete"
  | "too_recent"
  | "opted_out"
  | "already_sent";

export interface ChecklistCompleteDecision {
  stage: typeof CHECKLIST_COMPLETE_STAGE | null;
  skipped_reason?: ChecklistCompleteSkipReason;
}

/**
 * The per-claim screen for this stage, in gate order (opt-out first, same
 * convention as ./select-stage.ts's screenClaim — an opted-out claim must
 * cost no further reasoning and must never be stamped).
 *
 * Deliberately NOT gated on "real activity since created" — see the file
 * header: uploading the checklist items is activity, and this stage exists
 * specifically to catch the homeowner who did that and then stopped.
 */
export function screenChecklistCompleteClaim(
  claim: ChecklistCompleteClaim,
  ctx: {
    optedOutClaimIds: ReadonlySet<string>;
    reduced: ReducedChecklistComplete;
    now: number;
  },
): ChecklistCompleteDecision {
  if (claim.status !== NUDGE_ELIGIBLE_STATUS) {
    return { stage: null, skipped_reason: "ineligible_status" };
  }
  if (claim.ready_for_bids === true) {
    return { stage: null, skipped_reason: "already_submitted" };
  }
  if (ctx.optedOutClaimIds.has(claim.id)) {
    return { stage: null, skipped_reason: "opted_out" };
  }
  if (ctx.reduced.alreadySent.has(claim.id)) {
    return { stage: null, skipped_reason: "already_sent" };
  }
  const completedAtIso = ctx.reduced.completedAtByClaim.get(claim.id);
  if (completedAtIso === undefined) {
    return { stage: null, skipped_reason: "not_checklist_complete" };
  }
  const completedMs = Date.parse(completedAtIso);
  if (Number.isNaN(completedMs)) {
    return { stage: null, skipped_reason: "not_checklist_complete" }; // malformed stamp: fail closed
  }
  if (ctx.now - completedMs < CHECKLIST_COMPLETE_DELAY_MS) {
    return { stage: null, skipped_reason: "too_recent" };
  }
  return { stage: CHECKLIST_COMPLETE_STAGE };
}

// ─── Copy (locked — Tier B, gh-1570 Part 2; verbatim phrase from Ben's build
// spec, comment 5764786813; template FORM copied from ./email-content.ts's
// buildEmailContent, "existing template family" per that same spec) ────────

const CHECKLIST_COMPLETE_TEXT =
  "You're one click from bids — head back to your dashboard and click Submit for Bids to get your project moving.";

export function buildChecklistCompleteEmailContent(
  homeownerName: string,
  dashboardUrl: string,
  optOutUrl: string,
): { subject: string; textBody: string; htmlBody: string } {
  if (!optOutUrl) {
    // Same D-320 fail-closed rule as buildEmailContent: no opt-out link, no send.
    throw new Error(
      "buildChecklistCompleteEmailContent: optOutUrl is required (gh-1786 / D-320)",
    );
  }
  const firstName = (homeownerName || "there").split(" ")[0] || "there";
  const subject = "You're one click from bids";

  const textBody = [
    `Hi ${firstName},`,
    "",
    CHECKLIST_COMPLETE_TEXT,
    "",
    `Go to your dashboard: ${dashboardUrl}`,
    "",
    "— The Otter Quotes Team",
    "",
    `${OPTOUT_TEXT_LINE} ${optOutUrl}`,
    "",
    footerPostalAddressText(),
  ].join("\n");

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:Arial,Helvetica,sans-serif;color:#1F2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F8FAFC;">
    <tr>
      <td align="center" style="padding:2rem 1rem;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0"
               style="max-width:600px;width:100%;background:#ffffff;border-radius:0.75rem;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#0D1B2E;padding:1.5rem 2rem;text-align:center;">
              <span style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Otter Quotes</span>
            </td>
          </tr>
          <tr>
            <td style="padding:2rem 2rem 1.5rem;">
              <p style="margin:0 0 1rem;line-height:1.6;">Hi ${firstName},</p>
              <p style="margin:0 0 1.5rem;line-height:1.6;">${CHECKLIST_COMPLETE_TEXT}</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 1rem;">
                <tr>
                  <td style="background:#E07B00;border-radius:8px;padding:14px 28px;">
                    <a href="${dashboardUrl}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;display:block;">Go to Your Dashboard &rarr;</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-size:14px;color:#64748B;">
                Questions? Reply to this email or contact
                <a href="mailto:support@otterquote.com" style="color:#E07B00;">support@otterquote.com</a>.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:20px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#64748B;">
              &mdash; The Otter Quotes Team
              <br><br>
              <a href="${optOutUrl}" style="color:#64748B;text-decoration:underline;">${OPTOUT_LINK_TEXT}</a>
              ${footerPostalAddressHtml()}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, textBody, htmlBody };
}

// ─── Delivery ───────────────────────────────────────────────────────────────
// Mirrors ./deliver-stage.ts's shape and safety properties (dry-run-first,
// send-then-stamp order per gh-2069, 23505 treated as "already sent", a
// `notifications` row on every real outcome) for this one stage. Kept as a
// sibling rather than folded into deliverStage(): that function's
// buildEmail/sendEmail signatures are shaped around the '2h'/'48h' template's
// two links (measurements + material); this stage has one link (the
// dashboard) and a different eligibility screen (no real-activity gate), so
// sharing the same function signature would mean routing unused parameters
// through it for every call, in both directions.

export interface ChecklistCompletePreviewRow {
  claim_id: string;
  stage: typeof CHECKLIST_COMPLETE_STAGE;
  subject: string;
  text_first_line: string;
  has_optout_link_text: boolean;
  has_optout_link_html: boolean;
  recipient_present: boolean;
}

export interface ChecklistCompleteEmailContent {
  subject: string;
  textBody: string;
  htmlBody: string;
}

export interface ChecklistCompleteStampError {
  code?: string;
  message?: string;
}

export interface ChecklistCompleteNotificationRow {
  user_id: string;
  claim_id: string;
  channel: "email";
  notification_type: string;
  recipient: string;
  message_preview: string;
  delivered: boolean;
  mailgun_id: string | null;
}

export interface ChecklistCompleteDeliverDeps {
  dryRun: boolean;
  mailgunConfigured: boolean;
  buildEmail: (name: string, dashboardUrl: string, optOutUrl: string) => ChecklistCompleteEmailContent;
  insertActivityLog: (row: Record<string, unknown>) => Promise<{ error: ChecklistCompleteStampError | null }>;
  sendEmail: (
    to: string, name: string, dashboardUrl: string, optOutUrl: string,
  ) => Promise<{ ok: boolean; mailgunId?: string; error?: string }>;
  insertNotification: (row: ChecklistCompleteNotificationRow) => Promise<{ error: string | null }>;
  log?: (level: "log" | "warn" | "error", message: string) => void;
}

export interface ChecklistCompleteDeliverCtx {
  claimId: string;
  userId: string;
  homeownerEmail: string;
  homeownerName: string;
  dashboardUrl: string;
  optOutUrl: string;
}

export type ChecklistCompleteDeliverOutcome =
  | { kind: "previewed"; preview: ChecklistCompletePreviewRow }
  | { kind: "sent" }
  | { kind: "already_sent" }
  | { kind: "stamp_failed"; error: string }
  | { kind: "send_failed"; error: string };

const EVENT_TITLE_SENT = "One-click-from-bids nudge sent";
const eventTitleFailed = (error: string) => `FAILED one-click-from-bids nudge: ${error}`;

export async function deliverChecklistCompleteStage(
  deps: ChecklistCompleteDeliverDeps,
  ctx: ChecklistCompleteDeliverCtx,
): Promise<ChecklistCompleteDeliverOutcome> {
  const say = deps.log ?? (() => {});

  // ── DRY RUN — render, report, return. No write, no send. Must stay first:
  // see ./deliver-stage.ts's identical comment for why this is asserted by
  // tests rather than left to rest on the position of one branch.
  if (deps.dryRun) {
    const preview = deps.buildEmail(ctx.homeownerName, ctx.dashboardUrl, ctx.optOutUrl);
    say(
      "log",
      `DRY RUN — would send ${CHECKLIST_COMPLETE_STAGE} nudge for claim ${ctx.claimId} (nothing sent, nothing written)`,
    );
    return {
      kind: "previewed",
      preview: {
        claim_id: ctx.claimId,
        stage: CHECKLIST_COMPLETE_STAGE,
        subject: preview.subject,
        text_first_line: preview.textBody.split("\n")[0],
        has_optout_link_text: preview.textBody.includes(ctx.optOutUrl),
        has_optout_link_html: preview.htmlBody.includes(ctx.optOutUrl),
        recipient_present: Boolean(ctx.homeownerEmail),
      },
    };
  }

  const recordNotification = async (delivered: boolean, mailgunId: string | null, preview: string) => {
    const { error } = await deps.insertNotification({
      user_id: ctx.userId,
      claim_id: ctx.claimId,
      channel: "email",
      notification_type: CHECKLIST_COMPLETE_NOTIFICATION_TYPE,
      recipient: ctx.homeownerEmail,
      message_preview: preview,
      delivered,
      mailgun_id: mailgunId,
    });
    if (error) {
      say(
        "warn",
        `${CHECKLIST_COMPLETE_STAGE} nudge for claim ${ctx.claimId} — outcome recorded in activity_log, but notifications insert failed: ${error}`,
      );
    }
  };

  if (!deps.mailgunConfigured) {
    say("warn", `MAILGUN_API_KEY not set — no email sent (dev/staging) for claim ${ctx.claimId} stage ${CHECKLIST_COMPLETE_STAGE}`);
    const { error: stampError } = await deps.insertActivityLog({
      user_id: ctx.userId,
      event_type: CHECKLIST_COMPLETE_NUDGE_EVENT_TYPE,
      title: EVENT_TITLE_SENT,
      metadata: { claim_id: ctx.claimId, system_generated: true, mailgun_configured: false },
      is_test: false,
    });
    if (stampError?.code === "23505") {
      return { kind: "already_sent" };
    }
    if (stampError) {
      say("error", `Failed to record ${CHECKLIST_COMPLETE_STAGE} nudge (no-Mailgun path) for claim ${ctx.claimId}: ${stampError.message}`);
    }
    await recordNotification(true, null, EVENT_TITLE_SENT);
    return { kind: "sent" };
  }

  // gh-2069 convention: call Mailgun first, then write one row describing
  // what actually happened — see ./deliver-stage.ts's file header for why.
  const sendResult = await deps.sendEmail(ctx.homeownerEmail, ctx.homeownerName, ctx.dashboardUrl, ctx.optOutUrl);

  if (!sendResult.ok) {
    const error = sendResult.error ?? "unknown";
    say("error", `FAILED ${CHECKLIST_COMPLETE_STAGE} nudge for claim ${ctx.claimId} — not retried: ${error}`);
    const { error: stampError } = await deps.insertActivityLog({
      user_id: ctx.userId,
      event_type: CHECKLIST_COMPLETE_NUDGE_EVENT_TYPE,
      title: eventTitleFailed(error),
      metadata: { claim_id: ctx.claimId, system_generated: true, send_failed: true, error },
      is_test: false,
    });
    if (stampError) {
      say("error", `Failed send for claim ${ctx.claimId} stage ${CHECKLIST_COMPLETE_STAGE} ALSO failed to record in activity_log: ${stampError.message}`);
    }
    await recordNotification(false, null, eventTitleFailed(error));
    return { kind: "send_failed", error };
  }

  say("log", `Sent ${CHECKLIST_COMPLETE_STAGE} nudge for claim ${ctx.claimId}`);
  const mailgunId = sendResult.mailgunId ?? null;
  const { error: stampError } = await deps.insertActivityLog({
    user_id: ctx.userId,
    event_type: CHECKLIST_COMPLETE_NUDGE_EVENT_TYPE,
    title: EVENT_TITLE_SENT,
    metadata: { claim_id: ctx.claimId, system_generated: true, mailgun_id: mailgunId },
    is_test: false,
  });
  if (stampError?.code === "23505") {
    say("log", `${CHECKLIST_COMPLETE_STAGE} nudge for claim ${ctx.claimId} recorded by a concurrent run (23505) after this run also sent`);
    await recordNotification(true, mailgunId, EVENT_TITLE_SENT);
    return { kind: "already_sent" };
  }
  if (stampError) {
    say("error", `Sent ${CHECKLIST_COMPLETE_STAGE} nudge for claim ${ctx.claimId} but failed to record it in activity_log: ${stampError.message}`);
  }
  await recordNotification(true, mailgunId, EVENT_TITLE_SENT);
  return { kind: "sent" };
}
