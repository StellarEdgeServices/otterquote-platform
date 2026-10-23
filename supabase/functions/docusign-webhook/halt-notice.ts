// halt-notice.ts (gh-2543, clause 3 of the issue's closes-on)
//
// The two notices sent when the contract-price gate in index.ts HALTS on a
// signed-price mismatch: one to the homeowner, one to the contractor.
//
// WORDING IS DUSTIN'S, NOT THE CODE'S. The text below is the draft in
// #2543 comment 6279045419, approved by Dustin as "Approve (A) (Recommended)"
// (ask #2943, comment 6290512863; recorded on #2543 as 6290513370), with legal
// position (A): "Because of this, the signed contract has not gone forward
// through Otter Quotes." Do not edit a word without a new approval on #2543.
// The only things added here are template plumbing: the bracketed fields from
// the draft filled from the claim/quote, dollar formatting, and the D-237
// postal-address footer every sibling email in this function carries
// (email-footer.ts). No greeting and no sign-off are added.
//
// Pure functions (no I/O, no clock) plus one orchestrator that takes its
// Supabase client and mail sender as arguments so it can be driven by a stub.

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

/** Legal position (A), approved verbatim (#2543 6290513370). */
export const LEGAL_POSITION_A =
  "Because of this, the signed contract has not gone forward through Otter Quotes.";

export const HOMEOWNER_HALT_SUBJECT = "Your roofing contract needs one more signature";

/** Contractor subject: the draft's "[homeowner first name / job ref]" is filled with the job ref. */
export function contractorHaltSubject(jobRef: string): string {
  return `Contract for ${jobRef} halted: price does not match the accepted bid`;
}

/** Plumbing: 13561 -> "$13,561.00". */
export function formatUsd(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const HTML_OPEN =
  `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#333;max-width:600px;margin:0 auto;padding:20px;">`;

/** The approved homeowner body, as paragraphs (shared by the text and HTML builders). */
function homeownerParas(contractor: string, address: string, signed: number, accepted: number): string[] {
  return [
    `You and ${contractor} both signed the contract for ${address}. Before a contract goes forward, Otter Quotes checks that the signed price matches the bid you accepted. These did not match: the signed contract shows ${formatUsd(signed)}, and the bid you accepted was ${formatUsd(accepted)}. ${LEGAL_POSITION_A} Nothing has been charged. You do not need to do anything right now. We will send you a corrected contract at ${formatUsd(accepted)} to sign. Your earlier signed copy stays on file, marked as replaced. Questions: reply to this email.`,
  ];
}

/** The contractor notice body, as approved (#2543), as paragraphs. */
function contractorParas(jobRef: string, signed: number, accepted: number): string[] {
  return [
    `The contract you and the homeowner signed for ${jobRef} shows ${formatUsd(signed)}. The bid the homeowner accepted on Otter Quotes was ${formatUsd(accepted)}. Because the two differ, the platform has halted this contract. ${LEGAL_POSITION_A} No platform fee has been charged. Please do not schedule or start work. A corrected contract at ${formatUsd(accepted)} will be sent to both parties to sign. The earlier signed copy stays on file, marked as replaced.`,
  ];
}

export function homeownerHaltText(contractor: string, address: string, signed: number, accepted: number): string {
  return homeownerParas(contractor, address, signed, accepted).join("\n\n") + `\n\n${footerPostalAddressText()}`;
}

export function homeownerHaltHtml(contractor: string, address: string, signed: number, accepted: number): string {
  return HTML_OPEN +
    homeownerParas(escHtml(contractor), escHtml(address), signed, accepted).map((p) => `<p>${p}</p>`).join("") +
    `${footerPostalAddressHtml()}</body></html>`;
}

export function contractorHaltText(jobRef: string, signed: number, accepted: number): string {
  return contractorParas(jobRef, signed, accepted).join("\n\n") + `\n\n${footerPostalAddressText()}`;
}

export function contractorHaltHtml(jobRef: string, signed: number, accepted: number): string {
  return HTML_OPEN +
    contractorParas(escHtml(jobRef), signed, accepted).map((p) => `<p>${p}</p>`).join("") +
    `${footerPostalAddressHtml()}</body></html>`;
}

/**
 * Reply-To for both notices (gh-2543, Ben's RETURNED 6301145200 item 2). The approved text ends
 * "Questions: reply to this email." and the mail is sent from the noreply sender, so the reply has to
 * land somewhere read. marty@otterquote.com is one of the #1511 persona addresses: Cloudflare Email
 * Routing delivers mail for ben@/marty@/sloane@otterquote.com to the one inbox (#1511 comment
 * 5547727048: the routing test to all three landed in INBOX; comment 5541537811: Cloudflare accepts
 * and forwards all three), and that inbox is swept by inbox-radar (#1511 comment 5583482870). The
 * subdomain mail.otterquote.com is transactional-only (no human reads), which is why the Reply-To
 * is on the apex. This is plumbing: no word of the approved text changes.
 */
export const HALT_NOTICE_REPLY_TO = "marty@otterquote.com";

export type HaltMail = { to: string; subject: string; text: string; html: string; replyTo: string };
/** Returns the mail provider's HTTP status. */
export type HaltMailSender = (mail: HaltMail) => Promise<number>;

export const HALT_NOTICE_TYPE = "contract_halt_notice_sent";

/**
 * The partial unique index that makes the send-once marker race-proof. MUST equal the index name in
 * supabase/migrations_drafts/gh2543_halt_notice_marker_unique.sql (a test pins the two together).
 * A 23505 counts as "already sent" only when it names this index (PR #2959 RETURNED, Ben, point 3).
 */
export const HALT_NOTICE_INDEX = "notifications_contract_halt_notice_once_idx";

/** a***@domain. Recipient addresses are personal data: they never go into an Error, a log line or a Sentry event in full. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** Masks every e-mail address found inside a string (provider and database error text can echo a recipient). */
export function maskEmails(text: string): string {
  return text.replace(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m));
}

function isOnceIndexViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string; details?: string; hint?: string } | null;
  if (!e || e.code !== "23505") return false;
  return [e.message, e.details, e.hint].some((t) => typeof t === "string" && t.includes(HALT_NOTICE_INDEX));
}

export interface HaltNoticeInput {
  supabase: AnySupabase;
  claimId: string;
  envelopeId: string;
  /** quotes.contractor_id of the accepted quote */
  contractorId: string | null | undefined;
  signed: number;
  accepted: number;
  send: HaltMailSender;
  reportToSentry: (err: unknown, ctx: { fn: string; op?: string; extra?: Record<string, unknown> }) => Promise<unknown> | unknown;
}

export interface HaltNoticeResult {
  homeowner: "sent" | "already_sent" | "no_recipient" | "failed";
  contractor: "sent" | "already_sent" | "no_recipient" | "failed";
}

/**
 * Send the two approved halt notices once per halt. Never throws: the caller
 * is the halt branch, which must still return its 200 to BoldSign.
 *
 * Idempotency: one `notifications` marker row per (envelope, role), written
 * BEFORE the send (same convention as the D-149 nudge marker) and checked
 * before every send, so a repeated webhook event for the same halted envelope
 * does not send twice. If the send fails, the marker is removed so a later
 * event can retry, and an alert row is written.
 */
export async function sendHaltNotices(i: HaltNoticeInput): Promise<HaltNoticeResult> {
  const { supabase, claimId, envelopeId } = i;
  const result: HaltNoticeResult = { homeowner: "no_recipient", contractor: "no_recipient" };
  const jobRef = `Job #${(claimId || "").slice(-8).toUpperCase()}`;

  async function once(role: "homeowner" | "contractor", recipients: string[], mail: (to: string) => HaltMail): Promise<HaltNoticeResult["homeowner"]> {
    if (recipients.length === 0) return "no_recipient";
    const preview = `envelope=${envelopeId};role=${role}`;
    let markerWritten = false;
    try {
      const { data: existing } = await supabase
        .from("notifications")
        .select("id")
        .eq("notification_type", HALT_NOTICE_TYPE)
        .eq("message_preview", preview)
        .limit(1)
        .maybeSingle();
      if (existing) return "already_sent";
      const { error: markerErr } = await supabase.from("notifications").insert({
        claim_id: claimId,
        channel: "email",
        notification_type: HALT_NOTICE_TYPE,
        recipient: recipients[0],
        message_preview: preview,
      });
      // Two simultaneous deliveries: the partial unique index (migrations_drafts/gh2543_halt_notice_marker_unique.sql,
      // not applied until Tier 3B) rejects the second insert with 23505. The loser sends nothing. Until the
      // index is applied the check above is the only guard, as before. Only a 23505 that names THAT index counts as
      // "already sent"; any other unique violation is a real failure (no marker, no send).
      if (markerErr && isOnceIndexViolation(markerErr)) return "already_sent";
      if (markerErr) {
        const m = markerErr as { code?: string; message?: string };
        throw new Error(`could not write the send-once marker (code ${m.code ?? "unknown"}): ${maskEmails(String(m.message ?? ""))}`);
      }
      markerWritten = true;
      // Try every address even if one fails (review 6301123534 point 3). If at least one address got the
      // notice, the marker stays (a retry would re-send to the ones that already have it) and the failures
      // are alerted; only when nobody got it is the marker removed so a later event can retry.
      const failed: string[] = [];
      let delivered = 0;
      // Personal data stays out of Error text, console and Sentry (PR #2959 RETURNED, Ben, point 1): an address is
      // named by its position and a masked form only.
      for (const [idx, to] of recipients.entries()) {
        const who = `address ${idx + 1} of ${recipients.length} (${maskEmail(to)})`;
        try {
          const status = await i.send(mail(to));
          console.log(`[#2543] contract-halt notice (${role}) Mailgun status=${status} envelope=${envelopeId}`);
          if (status < 200 || status >= 300) failed.push(`${who} status ${status}`);
          else delivered++;
        } catch (sendErr) {
          failed.push(`${who} ${maskEmails(sendErr instanceof Error ? sendErr.message : String(sendErr))}`);
        }
      }
      if (delivered === 0) throw new Error(`mail provider refused the ${role} halt notice: ${failed.join("; ")}`);
      if (failed.length > 0) {
        await supabase.from("platform_alerts_log").insert({
          alert_type: "contract_halt_notice_partial",
          function_name: "docusign-webhook",
          message: `#2543: the ${role} halt notice for envelope ${envelopeId} (claim ${claimId}) reached ${delivered} of ${recipients.length} address(es); not sent to: ${failed.join("; ")}. Marker kept so the others are not re-sent.`,
        });
      }
      return "sent";
    } catch (err) {
      // Only a masked message leaves this function: the Error object itself is never logged or sent on (point 1).
      const safeMsg = maskEmails(err instanceof Error ? err.message : String(err));
      const safeErr = new Error(safeMsg);
      safeErr.name = err instanceof Error ? err.name : "HaltNoticeError";
      console.error(`[#2543] ${role} halt notice failed (non-fatal): ${safeMsg}`);
      // The delete is checked (point 2): it must report no error AND remove the row this call inserted. If it does
      // not, the marker is still there and a repeated event will NOT retry; the alert says so.
      let markerRemoved = false;
      try {
        if (markerWritten) {
          const { data: gone, error: delErr } = await supabase.from("notifications").delete()
            .eq("notification_type", HALT_NOTICE_TYPE).eq("message_preview", preview).eq("claim_id", claimId)
            .select("id");
          markerRemoved = !delErr && Array.isArray(gone) && gone.length > 0;
          if (!markerRemoved) console.error(`[#2543] ${role} halt notice marker NOT removed (code ${(delErr as { code?: string } | null)?.code ?? "none"}, rows ${Array.isArray(gone) ? gone.length : "unknown"})`);
        }
      } catch (delEx) {
        markerRemoved = false;
        console.error(`[#2543] ${role} halt notice marker delete threw: ${maskEmails(delEx instanceof Error ? delEx.message : String(delEx))}`);
      }
      try {
        await supabase.from("platform_alerts_log").insert({
          alert_type: "contract_halt_notice_failed",
          function_name: "docusign-webhook",
          message: `#2543: the ${role} halt notice for envelope ${envelopeId} (claim ${claimId}) was not sent: ${safeMsg}.` +
            (markerWritten ? (markerRemoved ? " Marker removed; a repeated event may retry." : " Marker NOT removed; a repeated event will not retry.") : ""),
        });
      } catch (e) {
        console.error("halt notice alert insert failed:", maskEmails(e instanceof Error ? e.message : String(e)));
      }
      await i.reportToSentry(safeErr, { fn: "docusign-webhook", op: "contract-halt-notice", extra: { role, envelope_id: envelopeId, claim_id: claimId } });
      return "failed";
    }
  }

  // Resolve homeowner.
  let homeownerEmail: string | null = null;
  let address = "your property";
  let contractorCompany = "your contractor";
  const contractorEmails: string[] = [];
  try {
    const { data: claimRow } = await supabase.from("claims").select("user_id, property_address").eq("id", claimId).single();
    if (claimRow?.property_address) address = claimRow.property_address;
    if (claimRow?.user_id) {
      const { data: prof } = await supabase.from("profiles").select("email").eq("id", claimRow.user_id).single();
      homeownerEmail = prof?.email || null;
    }
    if (i.contractorId) {
      const { data: c } = await supabase
        .from("contractors")
        .select("company_name, email, notification_emails")
        .eq("id", i.contractorId)
        .single();
      if (c?.company_name) contractorCompany = c.company_name;
      if (c?.email) contractorEmails.push(c.email);
      if (Array.isArray(c?.notification_emails)) {
        for (const e of c.notification_emails) if (e && !contractorEmails.includes(e)) contractorEmails.push(e);
      }
    }
  } catch (lookupErr) {
    const safeLookup = new Error(maskEmails(lookupErr instanceof Error ? lookupErr.message : String(lookupErr)));
    console.error(`[#2543] halt notice recipient lookup failed (non-fatal): ${safeLookup.message}`);
    await i.reportToSentry(safeLookup, { fn: "docusign-webhook", op: "contract-halt-notice-lookup", extra: { envelope_id: envelopeId, claim_id: claimId } });
  }

  result.homeowner = await once("homeowner", homeownerEmail ? [homeownerEmail] : [], (to) => ({
    to,
    subject: HOMEOWNER_HALT_SUBJECT,
    replyTo: HALT_NOTICE_REPLY_TO,
    text: homeownerHaltText(contractorCompany, address, i.signed, i.accepted),
    html: homeownerHaltHtml(contractorCompany, address, i.signed, i.accepted),
  }));
  result.contractor = await once("contractor", contractorEmails, (to) => ({
    to,
    subject: contractorHaltSubject(jobRef),
    replyTo: HALT_NOTICE_REPLY_TO,
    text: contractorHaltText(jobRef, i.signed, i.accepted),
    html: contractorHaltHtml(jobRef, i.signed, i.accepted),
  }));
  return result;
}

export const HALT_MAIL_TIMEOUT_MS = 8000;

/** The production Mailgun sender (same endpoint/sender as the homeowner contract-signed email). */
export function mailgunSender(apiKey: string): HaltMailSender {
  return async (mail) => {
    const fd = new FormData();
    fd.append("from", "Otter Quotes <noreply@mail.otterquote.com>");
    fd.append("to", mail.to);
    fd.append("subject", mail.subject);
    fd.append("h:Reply-To", mail.replyTo);
    fd.append("text", mail.text);
    fd.append("html", mail.html);
    const resp = await fetch("https://api.mailgun.net/v3/mail.otterquote.com/messages", {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
      body: fd,
      // A slow provider must not hold the BoldSign ack for long (review 6301123534 point 5). A timeout
      // throws, which sendHaltNotices treats as a failed send: marker removed, alert row, a later event retries.
      signal: AbortSignal.timeout(HALT_MAIL_TIMEOUT_MS),
    });
    return resp.status;
  };
}
