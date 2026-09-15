// gh-1933 — stalled-homeowner admin digest, extracted from index.ts so it is
// testable without a live database or Mailgun (same pattern as
// ./deliver-stage.ts and ./select-stage.ts: pure functions here, an injected-
// dependency executor call site in index.ts).
//
// Reuses send-homeowner-next-steps's OWN screening — `stage === '48h'` from
// ./select-stage.ts is exactly "documents_needed, no measurements, no hover
// order, zero real activity >= 48h" — rather than re-deriving the condition
// here (gh-1933 body: "Reuse the screening; do not duplicate it").
//
// Idempotent per homeowner (claim) per UTC calendar day. The `notifications`
// table has no dedicated date/bucket column (see notify-admin-new-homeowner's
// simple eq/eq/eq shape and counter-sig-reminders' message_preview bucket for
// the two existing per-day conventions in this repo); this uses a
// `sent_at >= start of today (UTC)` filter keyed on notification_type +
// claim_id, which needs no new column and no new convention.

export const ADMIN_DIGEST_EMAIL = "dustinstohler1@gmail.com";
export const ADMIN_DIGEST_NOTIFICATION_TYPE = "admin_stalled_homeowner_digest";

export interface StalledCandidate {
  claimId: string;
  userId: string;
  email: string;
  createdAtIso: string;
}

export interface DigestRow {
  claimId: string;
  maskedEmail: string;
  daysStalled: number;
}

/** Same masking convention as notify-admin-new-homeowner / notify-admin-new-contractor. */
export function maskEmail(email: string): string {
  const at = (email || "").indexOf("@");
  if (at <= 0) return "(no email)";
  return `${email[0]}***${email.slice(at)}`;
}

function escapeHtml(str: string): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Midnight UTC of `nowMs`'s calendar day, as an ISO string — the digest's per-day bucket boundary. */
export function utcDayStartIso(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10) + "T00:00:00.000Z";
}

/** Candidates not yet digested today. Pure — no I/O. */
export function filterNotYetDigestedToday(
  candidates: StalledCandidate[],
  alreadyDigestedClaimIds: ReadonlySet<string>,
): StalledCandidate[] {
  return candidates.filter((c) => !alreadyDigestedClaimIds.has(c.claimId));
}

/** Whole days between `createdAtIso` and `nowMs`. Malformed input -> 0, never NaN or negative. */
export function daysStalled(createdAtIso: string, nowMs: number): number {
  const createdMs = new Date(createdAtIso).getTime();
  if (Number.isNaN(createdMs)) return 0;
  return Math.max(0, Math.floor((nowMs - createdMs) / (24 * 60 * 60 * 1000)));
}

/** Builds the one digest email's content. Pure — no I/O, no Mailgun, no DB. */
export function buildAdminDigestEmail(
  candidates: StalledCandidate[],
  dashboardUrl: string,
  nowMs: number,
): { subject: string; textBody: string; htmlBody: string; rows: DigestRow[] } {
  const rows: DigestRow[] = candidates.map((c) => ({
    claimId: c.claimId,
    maskedEmail: maskEmail(c.email),
    daysStalled: daysStalled(c.createdAtIso, nowMs),
  }));
  const plural = rows.length === 1 ? "" : "s";
  const subject = `[OtterQuote] ${rows.length} homeowner${plural} stalled at documents_needed`;
  const verb = rows.length === 1 ? "is" : "are";
  const textLines = rows.map((r) => `- ${r.maskedEmail} | claim ${r.claimId} | stalled ${r.daysStalled}d`);
  const textBody = [
    `${rows.length} homeowner${plural} ${verb} stuck at documents_needed with no measurements, no Hover order, and no real activity for 48+ hours.`,
    "",
    ...textLines,
    "",
    "Open the admin dashboard:",
    dashboardUrl,
  ].join("\n");
  const rowsHtml = rows
    .map(
      (r) =>
        `<tr><td style="padding:4px 8px;color:#64748B;">${escapeHtml(r.maskedEmail)}</td><td style="padding:4px 8px;">${escapeHtml(r.claimId)}</td><td style="padding:4px 8px;">${r.daysStalled}d</td></tr>`,
    )
    .join("");
  const htmlBody = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F1F5F9;font-family:sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;"><tr><td align="center" style="padding:24px 16px;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background:#0B1929;padding:20px 24px;"><h2 style="color:#F59E0B;margin:0;font-size:1.1rem;">Stalled Homeowners</h2></td></tr>
<tr><td style="padding:24px;color:#0B1929;">
<p style="margin:0 0 16px;">${rows.length} homeowner${plural} ${verb} stuck at documents_needed (no measurements, no Hover order, no real activity for 48+ hours).</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin-bottom:20px;border:1px solid #E2E8F0;">
<tr style="background:#F8FAFC;"><th align="left" style="padding:6px 8px;">Homeowner</th><th align="left" style="padding:6px 8px;">Claim</th><th align="left" style="padding:6px 8px;">Stalled</th></tr>
${rowsHtml}
</table>
<a href="${dashboardUrl}" style="display:inline-block;background:#F59E0B;color:#0B1929;font-weight:700;text-decoration:none;padding:12px 24px;border-radius:8px;">Open Admin Dashboard &rarr;</a>
</td></tr>
</table></td></tr></table>
</body></html>`;
  return { subject, textBody, htmlBody, rows };
}
