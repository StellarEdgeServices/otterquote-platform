/**
 * #3770 (D-391 rule 5 + Amendment 1): when a STOP (or a staff opt-out) leaves a contractor with ZERO textable numbers,
 * send ONE transactional e-mail to the contractor ("texts stopped, e-mail instead, how to turn them back on") and ONE
 * internal alert e-mail to Dustin. Ben's ruling (7009019873): "3770 yes", the exact text goes through the R-177 legal read
 * on this PR. D-391 Amendment 1: do not restrict new leads; the account stays active.
 *
 * Pure and injectable: no Deno globals, no network here. The two Edge Functions (twilio-sms-optout, admin-sms-optout) wire the
 * deps in their index.ts. Best effort: nothing here can fail or delay the STOP itself (the caller swallows a throw), and
 * the suppression row is written BEFORE this runs, so the lookup below already excludes the stopped number.
 *
 * Idempotence: the caller passes only the contractor ids whose rows THIS call flipped to opted_out. A Twilio retry flips
 * zero rows, so it sends nothing.
 * Dark by default: the e-mails go out only when SMS_LAST_NUMBER_EMAIL_ENABLED is "true"; otherwise the decision is logged.
 */

export interface NoticeContractor { email: string | null; contact_name: string | null; company_name: string | null }

export interface NoticeDeps {
  /** How many numbers contractor_textable_numbers() returns for the contractor now; null = lookup failed. */
  textableCount: (contractorId: string) => Promise<number | null>;
  contractor: (contractorId: string) => Promise<NoticeContractor | null>;
  /** Sends one e-mail; true on success. */
  sendEmail: (to: string, subject: string, text: string) => Promise<boolean>;
  enabled: boolean;
  ownerEmail: string;
  log: (line: string) => void;
}

export const CONTRACTOR_SUBJECT = "Text alerts to your number have stopped";
export const SETTINGS_URL = "https://otterquote.com/contractor-settings.html";

/** The contractor-facing e-mail body. Exact text for the R-177 legal read (quoted in the PR body). */
export function contractorNoticeText(contactName: string | null): string {
  const hi = contactName && contactName.trim() ? `Hi ${contactName.trim()},` : "Hello,";
  return [
    hi,
    "",
    "We received a request to stop text messages to the phone number on your Otter Quotes contractor account, so we have stopped texting it. We will send your new-job alerts and account notices by email instead, and your account stays active.",
    "",
    `If you want text alerts again, reply START to the number that texted you, then verify the number again in Settings on your contractor account: ${SETTINGS_URL}`,
    "",
    "Questions? Email support@otterquote.com or call (844) 875-3412.",
    "",
    "Otter Quotes",
  ].join("\n");
}

/** The internal alert to Dustin. Not customer-facing. Carries the contractor id and company, never a phone number. */
export function ownerAlertText(contractorId: string, company: string | null, source: string): string {
  return `Otter Quotes alert: contractor ${company || "(no company name)"} (${contractorId}) has no textable number left after an opt-out (${source}). Texts to them are off; they are e-mailed instead and their account is not restricted.`;
}

/** Returns what was done per contractor, for the log and the tests. Never throws on a dependency failure. */
export async function noticeAfterOptOut(
  d: NoticeDeps,
  contractorIds: string[],
  source: string,
): Promise<Array<{ contractorId: string; action: "skipped_still_textable" | "skipped_lookup_failed" | "logged_dark" | "sent" | "partial" }>> {
  const out: Array<{ contractorId: string; action: "skipped_still_textable" | "skipped_lookup_failed" | "logged_dark" | "sent" | "partial" }> = [];
  for (const id of [...new Set(contractorIds)]) {
    const n = await d.textableCount(id);
    if (n === null) { d.log(`[sms-last-number-notice] textable lookup failed for ${id}; no notice sent`); out.push({ contractorId: id, action: "skipped_lookup_failed" }); continue; }
    if (n > 0) { out.push({ contractorId: id, action: "skipped_still_textable" }); continue; }
    const c = await d.contractor(id);
    if (!d.enabled) {
      d.log(`[sms-last-number-notice] DARK: contractor ${id} has no textable number (${source}); would e-mail the contractor and the owner`);
      out.push({ contractorId: id, action: "logged_dark" });
      continue;
    }
    let ok = true;
    if (c?.email) ok = (await d.sendEmail(c.email, CONTRACTOR_SUBJECT, contractorNoticeText(c.contact_name))) && ok;
    else { d.log(`[sms-last-number-notice] contractor ${id} has no e-mail on file; owner alert only`); ok = false; }
    const owner = await d.sendEmail(d.ownerEmail, `Contractor texts off: ${c?.company_name || id}`, ownerAlertText(id, c?.company_name ?? null, source));
    out.push({ contractorId: id, action: ok && owner ? "sent" : "partial" });
  }
  return out;
}

/** Production wiring (Supabase client + Mailgun), shared by both opt-out functions. `sb` is a service-role supabase-js client. */
// deno-lint-ignore no-explicit-any
export function wireNoticeDeps(sb: any, env: (n: string) => string | undefined, log: (l: string) => void = console.error): NoticeDeps {
  return {
    textableCount: async (id) => {
      const { data, error } = await sb.rpc("contractor_textable_numbers", { p_contractor_id: id });
      return error ? null : (data ?? []).length;
    },
    contractor: async (id) => {
      const { data } = await sb.from("contractors").select("email, contact_name, company_name").eq("id", id).maybeSingle();
      return data ?? null;
    },
    sendEmail: async (to, subject, text) => {
      const key = env("MAILGUN_API_KEY"), domain = env("MAILGUN_DOMAIN");
      if (!key || !domain) { log("[sms-last-number-notice] MAILGUN_API_KEY / MAILGUN_DOMAIN missing; not sent"); return false; }
      const form = new URLSearchParams({ from: `Otter Quotes <notifications@${domain}>`, to, subject, text });
      const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, { method: "POST", headers: { Authorization: `Basic ${btoa(`api:${key}`)}` }, body: form });
      if (!res.ok) log(`[sms-last-number-notice] Mailgun refused (${res.status})`);
      return res.ok;
    },
    enabled: env("SMS_LAST_NUMBER_EMAIL_ENABLED") === "true",
    ownerEmail: "dustinstohler1@gmail.com",
    log,
  };
}
