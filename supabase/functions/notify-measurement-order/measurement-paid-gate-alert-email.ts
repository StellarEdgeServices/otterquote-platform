/**
 * [gh-3356] notify-measurement-order's second `alert` mode: the admin email for the paid-claim gate in create-payment-intent
 * (measurement-paid-alert.ts there is the sender and keeps its own copy of the token and body keys: the Edge Function deploy path does
 * not resolve shared imports; a parity test in create-payment-intent pins the two together).
 *
 * Two kinds:
 *   paid_without_order: a homeowner's measurement payment succeeded but no hover_orders row exists, so no report is queued.
 *   check_unavailable:  the gate could not confirm whether a claim had already paid, so it refused to start a payment.
 *
 * The body arrives over HTTP and an email is built from it, so every field is re-validated to a fixed shape and anything else prints as
 * "unrecognized". Nothing from the body is put in the email verbatim, so it cannot carry markup, a header injection or a link of its own.
 * No buyer email, name or address is in it. Reached only after notify-measurement-order's service-role bearer check.
 */
import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";

export const PAID_GATE_ALERT_TOKEN = "measurement_paid_gate";
const UNRECOGNIZED = "unrecognized";

export interface PaidGateAlertEmail {
  subject: string;
  text: string;
  html: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * What notify-measurement-order logs, and writes to platform_alerts_log, when the Mailgun send of an alert email fails. Fixed text only
 * (the send error can echo request data). The text names the alert that failed: the paid-claim alerts must not read as a non-USD problem.
 */
export function alertSendFailureText(isPaidGateAlert: boolean): { log: string; rowMessage: string; rowWriteFailedLog: string } {
  return isPaidGateAlert
    ? {
      log: "measurement paid-claim alert email send failed",
      rowMessage: "measurement paid-claim alert email could not be sent; see the measurement_paid_without_order or measurement_paid_check_unavailable alert row",
      rowWriteFailedLog: "measurement paid-claim alert failure row could not be written",
    }
    : {
      log: "non-usd alert email send failed",
      rowMessage: "non-USD payment alert email could not be sent; see the non_usd_payment_rejected alert row",
      rowWriteFailedLog: "non-usd alert failure row could not be written",
    };
}

/** Returns null unless `body` is this alert with a known kind. */
export function buildPaidGateAlertEmail(body: unknown): PaidGateAlertEmail | null {
  if (!isRecord(body) || body.alert !== PAID_GATE_ALERT_TOKEN) return null;
  const kind = body.kind;
  if (kind !== "paid_without_order" && kind !== "check_unavailable") return null;

  const claim = typeof body.claim_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.claim_id) ? body.claim_id : null;
  const pi = typeof body.payment_intent_id === "string" && /^pi_[A-Za-z0-9_]{1,80}$/.test(body.payment_intent_id) ? body.payment_intent_id : null;
  const stage = typeof body.stage === "string" && /^[a-z_ ]{1,40}$/.test(body.stage) ? body.stage : null;
  const claimText = claim ?? UNRECOGNIZED;
  const piText = pi ?? UNRECOGNIZED;
  const stageText = stage ?? UNRECOGNIZED;
  const link = pi ? `https://dashboard.stripe.com/payments/${pi}` : null;

  let subject: string;
  let lines: string[];
  if (kind === "paid_without_order") {
    subject = "ACTION NEEDED: a homeowner paid for a report and no order is queued";
    lines = [
      "A homeowner's measurement payment succeeded in Stripe, but no order exists for the claim, so no report is queued for fulfilment.",
      "A second purchase attempt on the claim was refused.",
      "",
      `claim: ${claimText}`,
      `payment_intent: ${piText}`,
      `where it was found: ${stageText}`,
      "",
      link ? `Open the PaymentIntent in Stripe: ${link}` : "The PaymentIntent id could not be read; find the payment in the Stripe dashboard.",
      "",
      "Next step: ask engineering to record the order for this payment (the order step after the card payment did not complete).",
      "Whether and how to refund is a manual decision, and it is yours (Dustin's).",
    ];
  } else {
    subject = "Measurement purchase check unavailable: buyers are being asked to retry";
    lines = [
      "create-payment-intent could not confirm whether a claim had already paid for its measurement report, so it refused to start a payment. The buyer was told to try again. Nothing was charged.",
      "",
      `claim: ${claimText}`,
      `where it failed: ${stageText}`,
      "",
      "If this repeats, check that Stripe's search endpoint answers for the live key and that the hover_orders read works. Until it does, new report purchases cannot start.",
      "At most one of these emails is sent per claim per hour.",
    ];
  }

  const text = [...lines, "", footerPostalAddressText()].join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!DOCTYPE html>
<html>
<body style="font-family:Arial,Helvetica,sans-serif;color:#222;font-size:15px;line-height:1.5;">
${lines.map((l) => (l === "" ? "<br>" : `<p style="margin:0 0 6px;">${l.startsWith("Open the PaymentIntent in Stripe: ") && link ? `<a href="${link}">Open the PaymentIntent in Stripe</a>` : esc(l)}</p>`)).join("\n")}
<p style="color:#666;font-size:12px;">${footerPostalAddressHtml()}</p>
</body>
</html>`;
  return { subject, text, html };
}
