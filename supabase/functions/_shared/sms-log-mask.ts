/**
 * gh-3773 (SMS hardening follow-up to #3772 review): phone numbers never appear in full in a log line.
 *
 * Every send-sms log line and the Twilio error log carry the LAST 4 DIGITS ONLY. Twilio's error body often names the `To`
 * number ("The 'To' number +1317... is not a valid phone number"), so error text is passed through maskPhoneNumbersInText()
 * before it is logged or thrown. Nothing here changes any message wording; it only shortens what is written to logs.
 */
import { last4 } from "./sms-suppression.ts";

/** `***1234` for a phone number, `***????` when fewer than 4 digits. Never more than 4 digits of the input. */
export function maskPhone(raw: string | null | undefined): string {
  return `***${last4(raw)}`;
}

// A run of digits, optionally led by "+" and broken by spaces, dots, dashes or parentheses (E.164 and common US forms).
const PHONE_RUN = /\+?\(?\d[\d\s().-]{5,}\d/g;

/** Replaces every phone-number-looking run (10+ digits, or "+" and 8+) in `text` with `***<last4>`. Short codes (e.g. Twilio's 5-digit error codes) are untouched. */
export function maskPhoneNumbersInText(text: string | null | undefined): string {
  return String(text ?? "").replace(PHONE_RUN, (m) => {
    const n = m.replace(/\D/g, "").length;
    // 10+ digits (a US number), or an explicit "+" with 8+ (the shortest E.164 the opt-out tables accept). Dates (8 digits) are left alone.
    return n >= 10 || (m.startsWith("+") && n >= 8) ? maskPhone(m) : m;
  });
}
