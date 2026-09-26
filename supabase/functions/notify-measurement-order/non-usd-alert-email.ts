/**
 * [gh-2107 / D-330] notify-measurement-order's `alert` mode: the admin email for a rejected non-USD payment.
 *
 * Ben's DECIDED (b) on #2078 (5806894411): a rejected non-USD payment raises an admin alert through the EXISTING admin email path
 * (this function's Mailgun call, to the same admin address), not only a server log. The buyer paid in another currency and was given no
 * report; refunds stay manual and are Dustin's call (Tier C), so the email says so and links the PaymentIntent.
 *
 * The sender (create-measurement-order/non-usd-alert.ts) has already validated the fields, but the body arrives over HTTP and an email is
 * built from it, so every field is re-validated here to a fixed shape and anything else prints as "unrecognized". Nothing from the body
 * is ever put in the email verbatim, so it cannot carry markup, a header injection or a link. No buyer email, name or address is in it.
 *
 * This module is the receiving side of a contract. The sender keeps its own copy of the alert token and the body keys (the Edge Function
 * deploy path does not resolve shared imports); a parity test in create-measurement-order pins them together.
 */
import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";

export const NON_USD_ALERT_TYPE = "non_usd_payment_rejected";

const UNRECOGNIZED = "unrecognized";

export interface NonUsdAlertEmail {
  subject: string;
  text: string;
  html: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Returns null unless `body` is this alert with a known flow. */
export function buildNonUsdAlertEmail(body: unknown): NonUsdAlertEmail | null {
  if (!isRecord(body) || body.alert !== NON_USD_ALERT_TYPE) return null;
  const flow = body.flow;
  if (flow !== "report" && flow !== "upgrade") return null;

  const pi = typeof body.payment_intent_id === "string" && /^pi_[A-Za-z0-9_]{1,80}$/.test(body.payment_intent_id) ? body.payment_intent_id : null;
  const currency = typeof body.currency === "string" && /^[a-z]{3}$/.test(body.currency) ? body.currency : null;
  const amount = typeof body.amount_minor === "number" && Number.isInteger(body.amount_minor) && body.amount_minor >= 0 ? body.amount_minor : null;

  const piText = pi ?? UNRECOGNIZED;
  const currencyText = currency ?? UNRECOGNIZED;
  const amountText = amount === null ? UNRECOGNIZED : String(amount);
  const link = pi ? `https://dashboard.stripe.com/payments/${pi}` : null;

  const subject = `ACTION NEEDED: non-USD payment rejected (${flow}) — refund decision`;

  const text = [
    `A buyer paid in a currency other than US dollars and was NOT given a report.`,
    ``,
    `flow: ${flow}`,
    `payment_intent: ${piText}`,
    `currency: ${currencyText}`,
    `amount: ${amountText} (minor units of that currency)`,
    ``,
    link ? `Open the PaymentIntent in Stripe: ${link}` : `The PaymentIntent id could not be read; find the payment in the Stripe dashboard.`,
    ``,
    `The order was refused (the buyer saw a message asking them to contact support). Nothing was ordered and nothing was reported to Meta.`,
    `Whether and how to refund is a manual decision, and it is yours (Dustin's).`,
    ``,
    footerPostalAddressText(),
  ].join("\n");

  const html = `<!DOCTYPE html>
<html>
<body style="font-family:Arial,Helvetica,sans-serif;color:#222;font-size:15px;line-height:1.5;">
<p><strong>A buyer paid in a currency other than US dollars and was NOT given a report.</strong></p>
<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;">
<tr><td>flow</td><td>${flow}</td></tr>
<tr><td>payment_intent</td><td>${piText}</td></tr>
<tr><td>currency</td><td>${currencyText}</td></tr>
<tr><td>amount</td><td>${amountText} (minor units of that currency)</td></tr>
</table>
<p>${link ? `<a href="${link}">Open the PaymentIntent in Stripe</a>` : `The PaymentIntent id could not be read; find the payment in the Stripe dashboard.`}</p>
<p>The order was refused (the buyer saw a message asking them to contact support). Nothing was ordered and nothing was reported to Meta.<br>
Whether and how to refund is a manual decision, and it is yours (Dustin's).</p>
<p style="color:#666;font-size:12px;">${footerPostalAddressHtml()}</p>
</body>
</html>`;

  return { subject, text, html };
}
