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

/** The approved contractor body, as paragraphs. */
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

export type HaltMail = { to: string; subject: string; text: string; html: string };
/** Returns the mail provider's HTTP status. */
export type HaltMailSender = (mail: HaltMail) => Promise<number>;

export const HALT_NOTICE_TYPE = "contract_halt_notice_sent";

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
      if (markerErr) throw markerErr; // no marker, no send: cannot guarantee once
      let allOk = true;
      for (const to of recipients) {
        const status = await i.send(mail(to));
        console.log(`[#2543] contract-halt notice (${role}) Mailgun status=${status} envelope=${envelopeId}`);
        if (status < 200 || status >= 300) allOk = false;
      }
      if (!allOk) throw new Error(`mail provider refused the ${role} halt notice`);
      return "sent";
    } catch (err) {
      console.error(`[#2543] ${role} halt notice failed (non-fatal):`, err);
      try {
        await supabase.from("notifications").delete()
          .eq("notification_type", HALT_NOTICE_TYPE).eq("message_preview", preview);
        await supabase.from("platform_alerts_log").insert({
          alert_type: "contract_halt_notice_failed",
          function_name: "docusign-webhook",
          message: `#2543: the ${role} halt notice for envelope ${envelopeId} (claim ${claimId}) was not sent: ` +
            `${err instanceof Error ? err.message : String(err)}. Marker removed; a repeated event may retry.`,
        });
      } catch (e) {
        console.error("halt notice cleanup failed:", e);
      }
      await i.reportToSentry(err, { fn: "docusign-webhook", op: "contract-halt-notice", extra: { role, envelope_id: envelopeId, claim_id: claimId } });
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
    console.error("[#2543] halt notice recipient lookup failed (non-fatal):", lookupErr);
    await i.reportToSentry(lookupErr, { fn: "docusign-webhook", op: "contract-halt-notice-lookup", extra: { envelope_id: envelopeId, claim_id: claimId } });
  }

  result.homeowner = await once("homeowner", homeownerEmail ? [homeownerEmail] : [], (to) => ({
    to,
    subject: HOMEOWNER_HALT_SUBJECT,
    text: homeownerHaltText(contractorCompany, address, i.signed, i.accepted),
    html: homeownerHaltHtml(contractorCompany, address, i.signed, i.accepted),
  }));
  result.contractor = await once("contractor", contractorEmails, (to) => ({
    to,
    subject: contractorHaltSubject(jobRef),
    text: contractorHaltText(jobRef, i.signed, i.accepted),
    html: contractorHaltHtml(jobRef, i.signed, i.accepted),
  }));
  return result;
}

/** The production Mailgun sender (same endpoint/sender as the homeowner contract-signed email). */
export function mailgunSender(apiKey: string): HaltMailSender {
  return async (mail) => {
    const fd = new FormData();
    fd.append("from", "Otter Quotes <noreply@mail.otterquote.com>");
    fd.append("to", mail.to);
    fd.append("subject", mail.subject);
    fd.append("text", mail.text);
    fd.append("html", mail.html);
    const resp = await fetch("https://api.mailgun.net/v3/mail.otterquote.com/messages", {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
      body: fd,
    });
    return resp.status;
  };
}
