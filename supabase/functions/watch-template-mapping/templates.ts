// templates.ts (gh-1824 footer batch 5)
//
// Email text builder for watch-template-mapping's stale-template digest,
// split out of index.ts so it can be unit-tested without importing index.ts
// (which calls `serve()` at module load time and would start listening for
// requests). Same convention as send-message-notification/templates.ts
// (gh-1824 footer batch 2).
//
// This alert is flag-gated (TEMPLATE_WATCH_EMAIL_ENABLED === "true", unset
// by default — see index.ts) so it sends no email in practice today. It
// still gets the D-237 footer here because it is a real Mailgun-sending code
// path (this repo's check-mailgun-footer-coverage.py counts any code that
// makes a literal call to api.mailgun.net, gated or not) and because the
// alternative — leaving a dormant sender without a footer — would silently
// regress the moment the flag is flipped on.

import { footerPostalAddressText } from "./email-footer.ts"; // gh-1824
import type { StaleTemplate } from "./select-stale.ts";

export function buildDigest(
  newlyAlerted: StaleTemplate[],
  thresholdHours: number,
  functionName: string,
): { subject: string; text: string } {
  const n = newlyAlerted.length;
  const subject = `OtterQuote — ${n} contract template${n === 1 ? "" : "s"} waiting on mapping/review > ${thresholdHours}h`;
  const lines = [
    `${n} contractor template${n === 1 ? " has" : "s have"} sat in a pending state longer than ${thresholdHours} hours ` +
      `and nobody has acted (gh-1313 watcher).`,
    "",
    ...newlyAlerted.map((t) =>
      `- ${t.company_name ?? "(unknown contractor)"}${t.is_test ? " [is_test]" : ""} — ${t.trade} × ${t.funding_type} — ` +
      `${t.status} for ${t.age_hours}h (since ${t.since}) — template ${t.template_id}`
    ),
    "",
    "Review: https://otterquote.com/admin-template-review.html",
    "",
    `Sent by ${functionName}. One email per template per 24h.`,
    "",
    footerPostalAddressText(),
  ];
  return { subject, text: lines.join("\n") };
}
