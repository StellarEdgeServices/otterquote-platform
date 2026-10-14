// templates.ts (gh-2564, CEO RUN 104 point 5)
//
// The one notice email rescind-bid sends the HOMEOWNER when a contractor withdraws a bid. The card the contractor
// confirms on (contractor-bid-form.html #rescindConfirmCard) says "the homeowner will be notified"; this is how
// that sentence is true. The wording lives here, alone, so a legal reader can quote it.
//
// It states three things and nothing else: which contractor withdrew, that the other bids are unchanged, and where
// to see the bids. No price, no fee, no deadline, no promise about what happens next.
// Same template family and footer as process-bid-expirations/templates.ts (buildBidWindowExpiredHomeownerEmail).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";

export const BID_WITHDRAWN_SUBJECT = "A contractor withdrew their bid on your project";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildBidWithdrawnHomeownerEmail(params: {
  homeownerName: string;
  contractorName: string;
  bidsUrl: string;
  mailgunDomain: string;
}): { subject: string; text: string; html: string } {
  const { homeownerName, contractorName, bidsUrl, mailgunDomain } = params;
  const subject = BID_WITHDRAWN_SUBJECT;

  const text = `Hi ${homeownerName},

${contractorName} withdrew their bid on your project.

The other bids on your project have not changed.

View your bids: ${bidsUrl}

If you have any questions, reply to this email or call us at (844) 875-3412.

— The Otter Quotes Team

${footerPostalAddressText()}`;

  const name = escapeHtml(homeownerName);
  const contractor = escapeHtml(contractorName);
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;">
    <img src="https://otterquote.com/img/otter-logo.svg" alt="Otter Quotes" width="40" style="margin-bottom:16px;" />
    <h2 style="color:#0A1E2C;margin:0 0 8px;">A contractor withdrew their bid</h2>
    <p style="color:#555;margin:0 0 16px;">Hi ${name},</p>
    <p style="color:#555;margin:0 0 16px;">
      <strong>${contractor}</strong> withdrew their bid on your project.
    </p>
    <p style="color:#555;margin:0 0 16px;">
      The other bids on your project have not changed.
    </p>
    <a href="${bidsUrl}"
       style="display:inline-block;background:#14B8A6;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin-bottom:16px;">
      View My Bids
    </a>
    <p style="color:#888;font-size:13px;">
      Questions? Reply to this email or call us at (844) 875-3412.
    </p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
    <p style="color:#aaa;font-size:11px;">
      Otter Quotes &bull; notifications@${mailgunDomain}
    </p>
    ${footerPostalAddressHtml()}
  </div>
</body>
</html>`;

  return { subject, text, html };
}
