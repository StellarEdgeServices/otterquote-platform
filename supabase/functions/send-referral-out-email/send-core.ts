// send-core.ts (gh-2019 / D-324)
//
// The decision logic of send-referral-out-email with every side effect behind
// an injected dependency, so `deno test` can drive each branch without a
// database, Mailgun or a serve() import. index.ts wires the real dependencies.
//
// Flow (each early return sends NOTHING to the requester):
//   1. input shape: lead_id + exactly three contractors {name, phone, website}
//   2. the lead exists and is a referral-out request (variant = e-referral-out)
//   3. blank name -> admin alert "no name captured", no send (Ben, #2019
//      comment 5889011634)
//   4. send-once guard on the `notifications` table (no schema change): any
//      existing row for this recipient + notification_type blocks a re-send
//   5. optimistic claim row, re-read to confirm we won, then Mailgun, then the
//      claim row is marked delivered (or removed if Mailgun refused)
//
// WHY `notifications` AND NOT A NEW COLUMN: no existing `leads` column records
// "the referral-out email was sent", and `notifications` already records
// outbound mail keyed by type + recipient (it is what notify-admin-new-homeowner
// and send-homeowner-next-steps use for the same purpose). It has no unique
// index, so the claim row is written first and re-read; two racing callers
// either see one winner or both back off (a safe failure, retry later) -- never
// two sends. A leftover delivered=false row (a crash between claim and send)
// blocks a re-send until an admin removes it: fail-closed on purpose.

import {
  buildNoNameAlert,
  isBlankName,
  REFERRAL_OUT_VARIANT,
  renderReferralOutEmail,
  type ReferralContractor,
} from "./templates.ts";

// kept in sync with supabase/functions/_shared/admin.ts PRIMARY_ADMIN_EMAIL --
// do not edit without updating that file too (the deploy path does not resolve
// imports). Same single-identity gate admin-contractor-action uses for its
// outbound-email actions; not widened to ADMIN_EMAILS.
export const PRIMARY_ADMIN_EMAIL = "dustinstohler1@gmail.com";

export function isPrimaryAdmin(verifiedEmail: string | null | undefined): boolean {
  return !!verifiedEmail && verifiedEmail === PRIMARY_ADMIN_EMAIL;
}

export const NOTIF_TYPE_REFERRAL_OUT = "referral_out_contact_info";
export const MAX_FIELD_LEN = 200;

export interface LeadRow {
  id: string;
  name: string | null;
  email: string | null;
  variant: string | null;
}

export interface NotificationRow {
  id: string;
  delivered: boolean | null;
}

export interface SendDeps {
  getLead(leadId: string): Promise<LeadRow | null>;
  /** All notifications rows for this recipient + NOTIF_TYPE_REFERRAL_OUT, oldest first (created_at, then id). */
  listSendRecords(recipient: string): Promise<NotificationRow[]>;
  /** Inserts the claim row (delivered=false); returns its id. */
  insertClaim(recipient: string, preview: string): Promise<string>;
  deleteRecord(id: string): Promise<void>;
  markDelivered(id: string, mailgunId: string | null): Promise<void>;
  /** Sends to the requester. */
  sendToRequester(msg: { to: string; subject: string; text: string; html: string }): Promise<{ ok: boolean; mailgunId?: string }>;
  /** Sends to the admin (the "no name captured" alert). */
  sendAdminAlert(msg: { subject: string; text: string; html: string }): Promise<boolean>;
}

export interface SendResult {
  status: number;
  body: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the three contractors, cleaned, or null when the input is not exactly three complete entries. */
export function validateContractors(input: unknown): ReferralContractor[] | null {
  if (!Array.isArray(input) || input.length !== 3) return null;
  const out: ReferralContractor[] = [];
  for (const c of input) {
    if (!c || typeof c !== "object") return null;
    const rec = c as Record<string, unknown>;
    const clean: string[] = [];
    for (const k of ["name", "phone", "website"]) {
      const v = rec[k];
      if (typeof v !== "string") return null;
      const t = v.replace(/[\r\n]/g, "").trim();
      if (t === "" || t.length > MAX_FIELD_LEN) return null;
      clean.push(t);
    }
    out.push({ name: clean[0], phone: clean[1], website: clean[2] });
  }
  return out;
}

export async function runSend(
  input: { lead_id?: unknown; contractors?: unknown },
  deps: SendDeps,
): Promise<SendResult> {
  if (typeof input.lead_id !== "string" || !UUID_RE.test(input.lead_id)) {
    return { status: 400, body: { error: "lead_id must be a uuid" } };
  }
  const contractors = validateContractors(input.contractors);
  if (!contractors) {
    return {
      status: 400,
      body: { error: `contractors must be exactly three objects, each with non-empty name, phone and website (max ${MAX_FIELD_LEN} chars)` },
    };
  }

  const lead = await deps.getLead(input.lead_id);
  if (!lead) return { status: 404, body: { error: "lead not found" } };
  if (lead.variant !== REFERRAL_OUT_VARIANT) {
    return { status: 409, body: { error: "lead is not a referral-out request", sent: false } };
  }
  const recipient = typeof lead.email === "string" ? lead.email.trim() : "";
  if (recipient === "") return { status: 422, body: { error: "lead has no email address", sent: false } };

  // Ben's ruling: blank name -> send nothing, raise the admin alert.
  if (isBlankName(lead.name)) {
    const alerted = await deps.sendAdminAlert(buildNoNameAlert(lead));
    return { status: 200, body: { sent: false, reason: "no name captured", admin_alerted: alerted } };
  }

  // Send-once guard.
  const prior = await deps.listSendRecords(recipient);
  if (prior.length > 0) {
    const anyDelivered = prior.some((r) => r.delivered === true);
    return {
      status: 409,
      body: {
        sent: false,
        reason: anyDelivered ? "already sent" : "a send is in progress or was interrupted; check notifications before retrying",
      },
    };
  }
  const claimId = await deps.insertClaim(recipient, `Referral-out contact information (D-324), lead ${lead.id}`);
  const after = await deps.listSendRecords(recipient);
  if (after.length === 0 || after[0].id !== claimId) {
    await deps.deleteRecord(claimId);
    return { status: 409, body: { sent: false, reason: "another send for this recipient is in progress" } };
  }

  const email = renderReferralOutEmail(lead.name as string, contractors);
  const sent = await deps.sendToRequester({ to: recipient, subject: email.subject, text: email.text, html: email.html });
  if (!sent.ok) {
    await deps.deleteRecord(claimId);
    return { status: 502, body: { sent: false, reason: "mail provider rejected the send; nothing was recorded, safe to retry" } };
  }
  try {
    await deps.markDelivered(claimId, sent.mailgunId ?? null);
  } catch (err) {
    // The email IS sent. The claim row (delivered=false) stays and keeps blocking a re-send.
    console.error("send-referral-out-email: sent, but failed to mark the notifications row delivered:", err);
    return { status: 200, body: { sent: true, mailgun_id: sent.mailgunId ?? null, record_incomplete: true } };
  }
  return { status: 200, body: { sent: true, mailgun_id: sent.mailgunId ?? null } };
}
