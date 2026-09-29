// templates.ts (gh-1824 footer batch 4)
//
// Email HTML/text builders for process-bid-expirations, split out of
// index.ts so they can be unit-tested without importing index.ts (which
// calls `serve()` at module load time and would start listening for
// requests). Same convention as send-homeowner-next-steps/email-content.ts
// and admin-contractor-action/templates.ts (batch 3).

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts"; // gh-1824

export function buildBidExpiredEmail(params: {
  contractorName: string;
  homeownerAddress: string;
  tradeLabel: string;
  quoteId: string;
  mailgunDomain: string;
}): { subject: string; text: string; html: string } {
  const { contractorName, homeownerAddress, tradeLabel, quoteId, mailgunDomain } = params;
  const renewUrl = `https://otterquote.com/contractor-bid-form.html?renew=${quoteId}`;

  const subject = `Your ${tradeLabel} bid has expired — renew in one click`;

  const text = `Hi ${contractorName},

Your ${tradeLabel} bid for the property at ${homeownerAddress} has expired (14-day window).

The homeowner can still see your bid but cannot select you until it's renewed.

Renew your bid: ${renewUrl}

If you're no longer interested in this project, no action is needed.

— The Otter Quotes Team

${footerPostalAddressText()}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;">
    <img src="https://otterquote.com/img/otter-logo.svg" alt="Otter Quotes" width="40" style="margin-bottom:16px;" />
    <h2 style="color:#0A1E2C;margin:0 0 8px;">Your bid has expired</h2>
    <p style="color:#555;margin:0 0 16px;">Hi ${contractorName},</p>
    <p style="color:#555;margin:0 0 16px;">
      Your <strong>${tradeLabel}</strong> bid for <strong>${homeownerAddress}</strong>
      has expired (14-day window). The homeowner can still see your bid,
      but cannot select you until it's renewed.
    </p>
    <a href="${renewUrl}"
       style="display:inline-block;background:#14B8A6;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin-bottom:16px;">
      Renew My Bid
    </a>
    <p style="color:#888;font-size:12px;">
      If you're no longer interested in this project, no action is needed.
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

export function buildAutoRenewedEmail(params: {
  contractorName: string;
  homeownerAddress: string;
  tradeLabel: string;
  newQuoteId: string;
  newExpiresAt: string;
  stopUrl: string;
  mailgunDomain: string;
}): { subject: string; text: string; html: string } {
  const { contractorName, homeownerAddress, tradeLabel, newExpiresAt, stopUrl, mailgunDomain } = params;

  const subject = `Your ${tradeLabel} bid was auto-renewed — valid for 14 more days`;

  const text = `Hi ${contractorName},

Your ${tradeLabel} bid for ${homeownerAddress} was auto-renewed. It's now valid until ${newExpiresAt}.

To stop auto-renewing this bid: ${stopUrl}

— The Otter Quotes Team

${footerPostalAddressText()}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;">
    <img src="https://otterquote.com/img/otter-logo.svg" alt="Otter Quotes" width="40" style="margin-bottom:16px;" />
    <h2 style="color:#0A1E2C;margin:0 0 8px;">Your bid was auto-renewed ✓</h2>
    <p style="color:#555;margin:0 0 16px;">Hi ${contractorName},</p>
    <p style="color:#555;margin:0 0 16px;">
      Your <strong>${tradeLabel}</strong> bid for <strong>${homeownerAddress}</strong>
      was automatically renewed and is valid until <strong>${newExpiresAt}</strong>.
    </p>
    <p style="color:#555;margin:0 0 16px;">
      <a href="${stopUrl}" style="color:#14B8A6;">Stop auto-renewing this bid</a>
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

export function buildRenewalCapEmail(params: {
  contractorName: string;
  homeownerAddress: string;
  tradeLabel: string;
  mailgunDomain: string;
}): { subject: string; text: string; html: string } {
  const { contractorName, homeownerAddress, tradeLabel, mailgunDomain } = params;

  const subject = `Your ${tradeLabel} bid renewal limit reached — review your pricing`;

  const text = `Hi ${contractorName},

Your ${tradeLabel} bid for ${homeownerAddress} has reached the maximum of 3 auto-renewals (42 days total). No further auto-renewals will occur.

The homeowner can still see your original bid for comparison, but it is marked expired.

If you'd like to stay competitive, log in to submit a fresh bid: https://otterquote.com/contractor-opportunities.html

— The Otter Quotes Team

${footerPostalAddressText()}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;">
    <img src="https://otterquote.com/img/otter-logo.svg" alt="Otter Quotes" width="40" style="margin-bottom:16px;" />
    <h2 style="color:#0A1E2C;margin:0 0 8px;">Auto-renewal limit reached</h2>
    <p style="color:#555;margin:0 0 16px;">Hi ${contractorName},</p>
    <p style="color:#555;margin:0 0 16px;">
      Your <strong>${tradeLabel}</strong> bid for <strong>${homeownerAddress}</strong>
      has reached the maximum of <strong>3 auto-renewals</strong> (42 days total).
      No further auto-renewals will occur.
    </p>
    <p style="color:#555;margin:0 0 16px;">
      If you'd like to stay competitive, consider submitting a fresh bid with updated pricing.
    </p>
    <a href="https://otterquote.com/contractor-opportunities.html"
       style="display:inline-block;background:#14B8A6;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin-bottom:16px;">
      View Open Opportunities
    </a>
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

export function buildBidWindowExpiredHomeownerEmail(params: {
  homeownerName: string;
  propertyAddress: string;
  bidsUrl: string;
  mailgunDomain: string;
}): { subject: string; text: string; html: string } {
  const { homeownerName, propertyAddress, bidsUrl, mailgunDomain } = params;

  const subject = `All contractor bids for your project have expired`;

  const text = `Hi ${homeownerName},

All contractor bids for your project at ${propertyAddress} have expired.

This can happen when the bidding window closes before a contractor is selected. To move forward, log in to your dashboard — you may request fresh bids or contact us for help.

View your project: ${bidsUrl}

If you have any questions, reply to this email or call us at (844) 875-3412.

— The Otter Quotes Team

${footerPostalAddressText()}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;">
    <img src="https://otterquote.com/img/otter-logo.svg" alt="Otter Quotes" width="40" style="margin-bottom:16px;" />
    <h2 style="color:#0A1E2C;margin:0 0 8px;">Your bids have expired</h2>
    <p style="color:#555;margin:0 0 16px;">Hi ${homeownerName},</p>
    <p style="color:#555;margin:0 0 16px;">
      All contractor bids for your project at <strong>${propertyAddress}</strong>
      have expired. This can happen when the bidding window closes before a contractor is selected.
    </p>
    <p style="color:#555;margin:0 0 16px;">
      To move forward, visit your dashboard — you may request fresh bids from the contractors
      you were considering, or contact us and we'll help you find new options.
    </p>
    <a href="${bidsUrl}"
       style="display:inline-block;background:#14B8A6;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;margin-bottom:16px;">
      View My Project
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
