// gh-2154 P-4 switch-on hardening (Ben, bus 18:23:17Z item (2)): "uncertain
// rows raise an admin alert (reuse P-3's notify path), not just a log."
//
// Duplicated from supabase/functions/notify-admin-new-partner/index.ts's
// ADMIN_EMAIL constant and escapeHtml/stripHeaderInjection helpers — not a
// shared/cross-directory import, same constraint this directory already
// lives with for bot-pattern.ts/optout.ts/email-footer.ts (this repo's Edge
// Function deploy bundler cannot resolve cross-function imports).
// admin-alert.test.ts cross-imports notify-admin-new-partner's ADMIN_EMAIL
// only in the test (deno test resolves relative imports against the real
// filesystem, unlike the deploy bundler) to prove these never drift.
//
// Internal operational email only — this is Dustin's own ops alert, not
// customer-facing copy, so it carries no new customer-facing words and no
// Tier C/LEGAL-READ obligation (same posture P-3's own alert has).
//
// Content rules (this task's own brief): HTML-escaped PARTNER IDS ONLY —
// never a partner email address, name, or any other PII — and the subject
// is stripped of CR/LF and the other line-separator control characters
// exactly like notify-admin-new-partner's stripHeaderInjection, so a
// partner id can never inject a header (partner ids are DB-generated UUIDs
// in practice, but this function makes no assumption about that — it
// treats them as arbitrary untrusted strings, same posture as every other
// header-bound value in this codebase).

export const ADMIN_EMAIL = "dustinstohler1@gmail.com";

export function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Built from character codes rather than a regex literal containing the
// raw code points, purely to avoid any source-encoding ambiguity around
// U+2028/U+2029 (which some tools/editors treat as literal line breaks
// even inside a string). Semantically identical to
// notify-admin-new-partner/index.ts's own stripHeaderInjection regex — see
// admin-alert.test.ts's cross-import parity assertion, which proves the
// BEHAVIOR (not just the source text) matches.
const HEADER_INJECTION_CHARS = [
  ...Array.from({ length: 9 }, (_, i) => i), // U+0000-U+0008
  ...Array.from({ length: 18 }, (_, i) => 0x0a + i), // U+000A-U+001F
  0x7f,
  0x85,
  0x2028,
  0x2029,
].map((code) => String.fromCharCode(code));
const HEADER_INJECTION_RE = new RegExp(`[${HEADER_INJECTION_CHARS.join("")}]+`, "g");

/** Behaviorally identical to notify-admin-new-partner/index.ts's own
 * stripHeaderInjection — see admin-alert.test.ts's cross-import parity
 * assertion. */
export function stripHeaderInjection(str: string): string {
  return String(str).replace(HEADER_INJECTION_RE, " ");
}

export interface UncertainAlertRow {
  partner_id: string;
  stage: string;
}

export function buildUncertainAlertEmail(rows: readonly UncertainAlertRow[]): {
  subject: string;
  textBody: string;
  htmlBody: string;
} {
  const subject = stripHeaderInjection(
    `Partner onboarding: ${rows.length} uncertain send outcome${rows.length === 1 ? "" : "s"} need review`,
  );

  const textLines = [
    `send-partner-onboarding has ${rows.length} row(s) with an UNCERTAIN send outcome — a claim was made but Mailgun's actual decision is unknown (a thrown fetch, a timeout, or a crash right after Mailgun accepted the message but before the ledger was updated).`,
    ``,
    `These are NEVER auto-retried (retrying risks a real double-send). Check Mailgun's logs for each partner/stage below, then manually mark the row 'failed' in partner_onboarding_sends to allow a retry, or leave it if it did in fact send.`,
    ``,
    ...rows.map((r) => `  partner_id=${r.partner_id} stage=${r.stage}`),
  ];
  const textBody = textLines.join("\n");

  const rowsHtml = rows
    .map(
      (r) =>
        `<tr><td style="padding:4px 12px;font-family:monospace;font-size:13px;border-bottom:1px solid #E2E8F0;">${escapeHtml(r.partner_id)}</td><td style="padding:4px 12px;font-family:monospace;font-size:13px;border-bottom:1px solid #E2E8F0;">${escapeHtml(r.stage)}</td></tr>`,
    )
    .join("\n");

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
          <td style="background:#7C2D12;padding:20px 24px;">
            <h2 style="color:#FEF3C7;margin:0;font-size:1.1rem;font-family:sans-serif;">
              Partner onboarding: uncertain send outcomes
            </h2>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;font-family:sans-serif;color:#0B1929;">
            <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">
              ${rows.length} row(s) have an outcome that is unknown — never auto-retried. Check Mailgun's logs for each partner/stage below, then manually mark the row 'failed' to allow a retry, or leave it if it did in fact send.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:13px;margin-bottom:8px;">
              <tr>
                <td style="padding:4px 12px;color:#64748B;font-weight:600;">partner_id</td>
                <td style="padding:4px 12px;color:#64748B;font-weight:600;">stage</td>
              </tr>
              ${rowsHtml}
            </table>
          </td>
        </tr>
        <tr>
          <td align="center"
              style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px;
                     font-family:sans-serif;font-size:12px;color:#94A3B8;">
            Otter Quotes internal ops alert &nbsp;|&nbsp; send-partner-onboarding
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();

  return { subject, textBody, htmlBody };
}
