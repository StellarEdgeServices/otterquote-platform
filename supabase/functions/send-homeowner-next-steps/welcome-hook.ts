// gh-2069 (e) — homeowner first-touch "welcome" email.
//
// WHY THIS EXISTS
// ----------------
// Per the investigation this issue was filed from
// (`In Flight/reports/ceo57-nudge-pipeline-20260921.md`, Q4): Supabase Auth
// auto-confirms a homeowner signup without emailing them
// (`confirmation_sent_at` is NULL), and `send-welcome-email` is
// contractor-only (its own header says so; it is wired only from the
// contractor branch of `js/auth.js`). A new homeowner's FIRST email from the
// platform is today the +2h next-steps nudge — at least two hours after
// signup, and only if the cron tick lands, which is exactly the gap #2069's
// investigation found and this closes the plumbing for.
//
// This file owns the PURE parts (the copy, the freshness check, the gate
// predicate) and the injected-dependency executor (deliverWelcome), the same
// shape as ./deliver-stage.ts and ./admin-digest-executor.ts — a fake
// sendEmail/insertNotification pair is enough to test every branch, no
// database or Mailgun call required.
//
// GATING — this ships OFF by default, on purpose.
// -------------------------------------------------
// Copy is Tier C (D-per-decision protocol): Dustin approves the words before
// they reach a real homeowner's inbox. This PR ships the plumbing and the
// DRAFT copy below, gated behind `platform_settings.homeowner_welcome_enabled`
// (jsonb boolean; treated as `false` if the row is absent or not literally
// `true` — see isWelcomeEnabled). The row is NOT inserted by this PR; the SQL
// to add it, defaulted to `false`, is listed in the PR description for
// whoever deploys this to run once, and flipping it to `true` afterwards is
// Dustin's call, not a code change.
//
// WHO IS ELIGIBLE
// ----------------
// A homeowner profile (`profiles.role = 'homeowner'`) created less than 15
// minutes ago (see isProfileFreshEnough), with no existing
// `notifications` row of `notification_type = 'homeowner_welcome'` for that
// user — checked by the caller (index.ts), the same is_test-population split
// as the rest of this function (see dry-run.ts's candidateIsTestFlag): a dry
// run scans is_test=true profiles and sends nothing regardless of the gate,
// a real run scans is_test=false profiles and only sends when the gate is on.

export const HOMEOWNER_WELCOME_TEMPLATE = "homeowner_welcome";
export const HOMEOWNER_WELCOME_SETTING_KEY = "homeowner_welcome_enabled";
export const HOMEOWNER_WELCOME_FRESHNESS_MS = 15 * 60 * 1000;

/** True only for `{ value: true }` — the same strict-literal convention as
 * ./dry-run.ts's parseDryRun. A missing row, `null`, `"true"` (string), or
 * any other jsonb value is NOT enabled: this flag decides whether a real
 * homeowner gets emailed, so it fails CLOSED on anything but an explicit
 * `true`. */
export function isWelcomeEnabled(settingValue: unknown): boolean {
  return settingValue === true;
}

/** A profile counts as "fresh" for at most HOMEOWNER_WELCOME_FRESHNESS_MS
 * after `created_at`, and never for a clock-skewed future timestamp (a
 * negative age is treated as not-fresh, not as "somehow always eligible"). */
export function isProfileFreshEnough(createdAtIso: string, nowMs: number): boolean {
  const createdMs = new Date(createdAtIso).getTime();
  if (Number.isNaN(createdMs)) return false;
  const ageMs = nowMs - createdMs;
  return ageMs >= 0 && ageMs < HOMEOWNER_WELCOME_FRESHNESS_MS;
}

export interface WelcomeEmailContent {
  subject: string;
  textBody: string;
  htmlBody: string;
}

/**
 * DRAFT COPY — Tier C, Dustin approves before `homeowner_welcome_enabled` is
 * ever flipped to true. Deliberately narrow per #2069's own instruction:
 * thanks the homeowner, names the two things they can do right now (upload
 * their loss sheet, or order the $15 measurement report), one link to the
 * dashboard, and NO promises about coverage, bids, savings, or timelines.
 */
export function buildWelcomeEmailContent(homeownerName: string, dashboardUrl: string): WelcomeEmailContent {
  const firstName = (homeownerName || "there").split(" ")[0] || "there";

  const subject = "Welcome to OtterQuote — two things you can do right now";

  const textBody = [
    `Hi ${firstName},`,
    "",
    "Thanks for signing up with OtterQuote.",
    "",
    "There are two things you can do right now to get your project moving:",
    "",
    "  1. Upload your loss sheet, if you have one.",
    "  2. Order a $15 measurement report — an aerial report of your property that most contractors need to put together a bid.",
    "",
    "Either one can be done from your dashboard:",
    dashboardUrl,
    "",
    "— The OtterQuote team",
  ].join("\n");

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:Arial,Helvetica,sans-serif;color:#1F2937;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F8FAFC;">
    <tr>
      <td align="center" style="padding:2rem 1rem;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0"
               style="max-width:600px;width:100%;background:#ffffff;border-radius:0.75rem;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#0D1B2E;padding:1.5rem 2rem;text-align:center;">
              <p style="margin:0;color:#94A3B8;font-size:0.875rem;letter-spacing:0.05em;">OTTERQUOTE</p>
            </td>
          </tr>
          <tr>
            <td style="padding:2rem 2rem 1.5rem;">
              <p style="margin:0 0 1rem;line-height:1.6;">Hi ${firstName},</p>
              <p style="margin:0 0 1rem;line-height:1.6;">Thanks for signing up with OtterQuote.</p>
              <p style="margin:0 0 0.75rem;line-height:1.6;">There are two things you can do right now to get your project moving:</p>
              <ol style="margin:0 0 1.25rem;padding-left:1.25rem;line-height:1.6;">
                <li>Upload your loss sheet, if you have one.</li>
                <li>Order a $15 measurement report — an aerial report of your property that most contractors need to put together a bid.</li>
              </ol>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 1.5rem;">
                <tr>
                  <td align="center" bgcolor="#E07B00" style="border-radius:8px;">
                    <a href="${dashboardUrl}" style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;padding:14px 28px;">Go to My Dashboard →</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0;line-height:1.6;color:#374151;">— The OtterQuote team</p>
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

export interface WelcomeCandidate {
  userId: string;
  email: string;
  name: string;
}

export interface WelcomeNotificationRow {
  user_id: string;
  claim_id: null;
  channel: "email";
  notification_type: string;
  recipient: string;
  message_preview: string;
  delivered: boolean;
  mailgun_id: string | null;
}

export interface WelcomeDeps {
  /** isWelcomeEnabled(platform_settings row's value), read once by the caller. */
  enabled: boolean;
  mailgunConfigured: boolean;
  sendEmail: (
    to: string, name: string, dashboardUrl: string,
  ) => Promise<{ ok: boolean; mailgunId?: string; error?: string }>;
  insertNotification: (row: WelcomeNotificationRow) => Promise<{ error: string | null }>;
  log?: (level: "log" | "warn" | "error", message: string) => void;
}

export type WelcomeOutcome =
  | { kind: "disabled"; userId: string }
  | { kind: "not_configured"; userId: string }
  | { kind: "sent"; userId: string }
  | { kind: "send_failed"; userId: string; error: string };

/**
 * Per-candidate delivery decision. Mirrors ./deliver-stage.ts: check the gate
 * first (NO send, NO write when disabled — this is the branch
 * `homeowner_welcome_enabled=false` (the default) must always take), then
 * send, then record the outcome either way when a send was attempted.
 */
export async function deliverWelcome(
  deps: WelcomeDeps,
  candidate: WelcomeCandidate,
  dashboardUrl: string,
): Promise<WelcomeOutcome> {
  const say = deps.log ?? (() => {});

  // gh-2069: the gate. Disabled (the default, and the shipped state of this
  // PR) sends nothing and writes nothing — same "do neither" shape as
  // deliverStage's dry-run branch, asserted the same way in the tests.
  if (!deps.enabled) {
    return { kind: "disabled", userId: candidate.userId };
  }

  if (!deps.mailgunConfigured) {
    say("warn", `MAILGUN_API_KEY not set — homeowner_welcome not sent for user ${candidate.userId}`);
    return { kind: "not_configured", userId: candidate.userId };
  }

  const { subject } = buildWelcomeEmailContent(candidate.name, dashboardUrl);
  const result = await deps.sendEmail(candidate.email, candidate.name, dashboardUrl);

  if (!result.ok) {
    const error = result.error ?? "unknown";
    say("error", `FAILED homeowner_welcome for user ${candidate.userId}: ${error}`);
    await deps.insertNotification({
      user_id: candidate.userId,
      claim_id: null,
      channel: "email",
      notification_type: HOMEOWNER_WELCOME_TEMPLATE,
      recipient: candidate.email,
      message_preview: `FAILED: ${error}`,
      delivered: false,
      mailgun_id: null,
    });
    return { kind: "send_failed", userId: candidate.userId, error };
  }

  say("log", `Sent homeowner_welcome to user ${candidate.userId}`);
  await deps.insertNotification({
    user_id: candidate.userId,
    claim_id: null,
    channel: "email",
    notification_type: HOMEOWNER_WELCOME_TEMPLATE,
    recipient: candidate.email,
    message_preview: subject,
    delivered: true,
    mailgun_id: result.mailgunId ?? null,
  });
  return { kind: "sent", userId: candidate.userId };
}
