// templates.ts (gh-1824 footer batch 6)
//
// Email bodies for notify-admin-new-homeowner's admin alerts (new claim, signup
// backlog digest, signup backfill digest, individual signup, router lead),
// split out of index.ts so they can be unit-tested without importing index.ts
// (which calls serve() at module load time). Pure functions: no I/O, no clock.
// Wording is moved verbatim from index.ts; templates.test.ts pins every
// rendered body with exact-equality goldens. The D-237 postal footer is NOT
// added here: index.ts's sendMail() appends it via footer-append.ts, and the
// goldens compose the same way.
//
// Deliberately a NEW file rather than additions to notify-helpers.ts, so this
// stays out of the way of open PR #2348 (gh-2019 referral-out rendering).

import { escapeHtml } from "./notify-helpers.ts";

export const ADMIN_PORTAL_URL = "https://otterquote.com/admin-dashboard.html";

export function maskEmail(email: string): string {
  const at = (email || "").indexOf("@");
  if (at <= 0) return "(no email)";
  return `${email[0]}***${email.slice(at)}`;
}

export function locationOf(p: any): string {
  return [p.address_city, p.address_state, p.address_zip].filter(Boolean).join(", ") || "location not yet provided";
}

export function buildEmailHtml(heading: string, rows: [string, string][], extraHtml?: string): string {
  const rowsHtml = rows
    .map(
      ([label, value]) => `
              <tr>
                <td style="padding:8px 0;color:#64748B;width:130px;vertical-align:top;">${escapeHtml(label)}</td>
                <td style="padding:8px 0;">${value}</td>
              </tr>`,
    )
    .join("");
  return `
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
              🦦 ${escapeHtml(heading)}
            </h2>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;font-family:sans-serif;color:#0B1929;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="border-collapse:collapse;font-size:14px;margin-bottom:24px;">${rowsHtml}
            </table>
            ${extraHtml || ""}
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#F59E0B" style="border-radius:8px;">
                  <a href="${ADMIN_PORTAL_URL}"
                     style="display:inline-block;font-family:sans-serif;font-size:15px;font-weight:700;
                            color:#0B1929;text-decoration:none;padding:12px 24px;">
                    Open Admin Dashboard &rarr;
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center"
              style="background:#F8FAFC;border-top:1px solid #E2E8F0;padding:16px;
                     font-family:sans-serif;font-size:12px;color:#94A3B8;">
            Otter Quotes &nbsp;|&nbsp;
            <a href="mailto:support@otterquote.com" style="color:#0EA5E9;text-decoration:none;">support@otterquote.com</a>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`.trim();
}

/** New-claim alert: plain-text body. */
export function newClaimText(
  claimNumber: string,
  homeownerName: string,
  maskedEmail: string,
  createdTs: string,
  propertyAddr: string,
): string {
  return [
    `A new claim was created on Otter Quotes.`,
    `Claim    : #${claimNumber}`,
    `Homeowner: ${homeownerName} (${maskedEmail})`,
    `Created  : ${createdTs} CT`,
    `Property : ${propertyAddr}`,
    ``,
    `Open the admin dashboard:`,
    ADMIN_PORTAL_URL,
  ].join("\n");
}

/** New-claim alert: HTML body. */
export function newClaimHtml(
  claimNumber: string,
  homeownerName: string,
  maskedEmail: string,
  createdTs: string,
  propertyAddr: string,
): string {
  return buildEmailHtml("New Claim Created", [
    ["Claim", `#${escapeHtml(claimNumber)}`],
    ["Homeowner", `${escapeHtml(homeownerName)} (${escapeHtml(maskedEmail)})`],
    ["Created", `${escapeHtml(createdTs)} CT`],
    ["Property", escapeHtml(propertyAddr)],
  ]);
}

function signupTableHtml(toAlert: any[]): string {
  const rowsHtml = toAlert
    .map((p: any) => {
      const ts = new Date(p.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" });
      return `<tr><td style="padding:4px 8px;color:#64748B;">${escapeHtml(maskEmail(p.email || ""))}</td><td style="padding:4px 8px;">${escapeHtml(ts)} CT</td><td style="padding:4px 8px;">${escapeHtml(locationOf(p))}</td></tr>`;
    })
    .join("");
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:13px;margin-bottom:20px;border:1px solid #E2E8F0;">
      <tr style="background:#F8FAFC;"><th align="left" style="padding:6px 8px;">Email</th><th align="left" style="padding:6px 8px;">Signed up</th><th align="left" style="padding:6px 8px;">Location</th></tr>
      ${rowsHtml}
    </table>`;
}

function signupTextLines(toAlert: any[]): string[] {
  return toAlert.map((p: any) => `- ${maskEmail(p.email || "")} | ${new Date(p.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT | ${locationOf(p)}`);
}

/** One-time gh-1932 backlog digest: plain-text body. */
export function backlogDigestText(toAlert: any[]): string {
  return [
    `This is a one-time backlog digest for the gh-1932 homeowner signup sweep.`,
    `${toAlert.length} existing homeowner(s) with no claim were found and are listed below.`,
    `From now on, only NEW signups will trigger individual emails.`,
    ``,
    ...signupTextLines(toAlert),
    ``,
    `Open the admin dashboard:`,
    ADMIN_PORTAL_URL,
  ].join("\n");
}

/** One-time gh-1932 backlog digest: HTML body. */
export function backlogDigestHtml(toAlert: any[]): string {
  return buildEmailHtml(
    "Homeowner Signup Backlog Digest",
    [["Count", String(toAlert.length)]],
    signupTableHtml(toAlert),
  );
}

/** One-time gh-1932 backfill (no age cap) catch-up digest: plain-text body. */
export function backfillDigestText(toAlert: any[]): string {
  return [
    `One-time backlog catch-up for the gh-1932 homeowner signup sweep (no age cap).`,
    `${toAlert.length} homeowner(s) with no claim, older than the recurring sweep's 7-day window, were found and are listed below.`,
    `They are now marked alerted; the recurring 15-minute sweep keeps its 7-day window going forward.`,
    ``,
    ...signupTextLines(toAlert),
    ``,
    `Open the admin dashboard:`,
    ADMIN_PORTAL_URL,
  ].join("\n");
}

/** One-time gh-1932 backfill catch-up digest: HTML body. */
export function backfillDigestHtml(toAlert: any[]): string {
  return buildEmailHtml(
    "Homeowner Signup Backlog Catch-up",
    [["Count", String(toAlert.length)]],
    signupTableHtml(toAlert),
  );
}

/** Individual new-homeowner-signup alert: plain-text body. */
export function newHomeownerText(p: any): string {
  const ts = new Date(p.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" });
  const maskedEmail = maskEmail(p.email || "");
  const location = locationOf(p);
  const fullName = p.full_name || "(no name given)";
  return [
    `A homeowner signed up on Otter Quotes and has not yet filed a claim.`,
    `Name     : ${fullName}`,
    `Email    : ${maskedEmail}`,
    `Signed up: ${ts} CT`,
    `Location : ${location}`,
    ``,
    `Open the admin dashboard:`,
    ADMIN_PORTAL_URL,
  ].join("\n");
}

/** Individual new-homeowner-signup alert: HTML body. */
export function newHomeownerHtml(p: any): string {
  const ts = new Date(p.created_at).toLocaleString("en-US", { timeZone: "America/Chicago" });
  const maskedEmail = maskEmail(p.email || "");
  const location = locationOf(p);
  const fullName = p.full_name || "(no name given)";
  return buildEmailHtml("New Homeowner Signup", [
    ["Name", escapeHtml(fullName)],
    ["Email", escapeHtml(maskedEmail)],
    ["Signed up", `${escapeHtml(ts)} CT`],
    ["Location", escapeHtml(location)],
  ]);
}

/** Router-lead alert HTML (rows + extra HTML come from notify-helpers.ts buildRouterLeadEmail). */
export function routerLeadHtml(htmlRows: [string, string][], extraHtml: string): string {
  return buildEmailHtml("New Router Lead", htmlRows, extraHtml);
}
