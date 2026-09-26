/**
 * gh-2121 (HO-3) / PR #2226 REVIEW D6: the admin email for the no-account
 * (lead-keyed) paths. Before this, create-lead-measurement-order posted
 * {order_id, lead_order: true} here and this function -- which only knew
 * hover_orders -- answered 404, so a paid lead order sat unseen; loss-sheet
 * uploads had no notification at all.
 *
 * Two request shapes, both service-role only (index.ts checks the bearer
 * before dispatching here):
 *   { lead_order: true,  order_id }   -- a lead_measurement_orders row
 *   { lead_upload: true, upload_id }  -- a lead_loss_sheet_uploads row
 *
 * Idempotent per row: admin_notified_at is claimed with a zero-row-guarded
 * UPDATE ... WHERE admin_notified_at IS NULL (gh-2105 pattern) before the
 * send, and released if the send fails, so a retry can send and a duplicate
 * call (the browser and the webhook both notifying) cannot send twice.
 *
 * Test traffic (row.is_test, leads.is_synthetic, or the standing test-account
 * email patterns) is skipped unless X-Verify-Send: 1, matching the claim path.
 *
 * All I/O is injected; handleLeadNotification is unit-tested with fakes
 * (lead-notify.test.ts).
 */

import { footerPostalAddressHtml, footerPostalAddressText } from "./email-footer.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LEAD_ADMIN_PORTAL_NOTE = "Lead orders are not in the admin UI yet: find the row in public.lead_measurement_orders / public.lead_loss_sheet_uploads by the id below.";

export type LeadNotifyKind = "order" | "upload";

export interface LeadRecord {
  id: string;
  lead_id: string;
  is_test: boolean | null;
  admin_notified_at: string | null;
  created_at: string | null;
  homeowner_charge_amount?: number | null;
  stripe_payment_intent_id?: string | null;
  content_type?: string | null;
  byte_size?: number | null;
  storage_path?: string | null;
}

export interface LeadInfo {
  email: string | null;
  name: string | null;
  phone: string | null;
  property_address: string | null;
  is_synthetic: boolean | null;
}

export interface LeadNotifyDeps {
  loadRecord: (kind: LeadNotifyKind, id: string) => Promise<LeadRecord | null>;
  loadLead: (leadId: string) => Promise<LeadInfo | null>;
  /** UPDATE ... SET admin_notified_at = now() WHERE id = $1 AND admin_notified_at IS NULL, .select('id'); true iff a row was written. */
  claimNotified: (kind: LeadNotifyKind, id: string) => Promise<boolean>;
  releaseNotified: (kind: LeadNotifyKind, id: string) => Promise<void>;
  sendEmail: (msg: { subject: string; text: string; html: string }) => Promise<{ ok: boolean; id?: string }>;
  alert: (alertType: string, message: string) => Promise<void>;
  verifySend: boolean;
}

export function isTestEmail(email: string | null | undefined): boolean {
  const lower = (email ?? "").toLowerCase();
  return lower.includes("otterquote-internal.test") || lower.includes("pfw-") || lower.includes("authdoctor");
}

function escapeHtml(str: string): string {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return "$" + (cents / 100).toFixed(2);
}

export function buildLeadEmail(kind: LeadNotifyKind, rec: LeadRecord, lead: LeadInfo): { subject: string; text: string; html: string } {
  const address = lead.property_address || "(no address on lead)";
  // #1339's admin subject copy for a priced homeowner purchase, reused for the lead order.
  const subject = kind === "order" ? `Buy basic report — ${address}` : `Loss sheet uploaded — ${address}`;
  const rows: Array<[string, string]> = [
    ["Source", "HO-3 no-account page (lead, no claim)"],
    ["Property", address],
    ["Lead", [lead.name, lead.email, lead.phone].filter((v) => v && String(v).length > 0).join(" / ") || "—"],
  ];
  if (kind === "order") {
    rows.push(["Paid", money(rec.homeowner_charge_amount) + " (payment verified)"]);
    rows.push(["PaymentIntent", rec.stripe_payment_intent_id ?? "—"]);
  } else {
    rows.push(["File", `${rec.content_type ?? "?"}, ${rec.byte_size ?? "?"} bytes`]);
    rows.push(["Storage path", `lead-loss-sheets/${rec.storage_path ?? "?"}`]);
  }
  rows.push([kind === "order" ? "Order id" : "Upload id", rec.id]);
  rows.push(["Lead id", rec.lead_id]);

  const intro = kind === "order"
    ? "A no-account measurement order is waiting on manual fulfilment. Order the report from the measurement vendor and deliver it to the lead."
    : "A no-account visitor uploaded an insurance loss sheet. Review it by hand.";
  const text = [intro, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", LEAD_ADMIN_PORTAL_NOTE, "", footerPostalAddressText()].join("\n");
  const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#0B1929;">
<h2 style="font-size:1.1rem;">${escapeHtml(subject)}</h2>
<p>${escapeHtml(intro)}</p>
<table cellpadding="4" style="font-size:14px;border-collapse:collapse;">${
    rows.map(([k, v]) => `<tr><td style="color:#64748B;">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")
  }</table>
<p style="font-size:13px;color:#64748B;">${escapeHtml(LEAD_ADMIN_PORTAL_NOTE)}</p>
<div style="font-size:12px;color:#94A3B8;">${footerPostalAddressHtml()}</div>
</body></html>`;
  return { subject, text, html };
}

export function parseLeadNotifyBody(body: unknown): { kind: LeadNotifyKind; id: string } | { error: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.lead_order === true) {
    const id = typeof b.order_id === "string" ? b.order_id : "";
    return UUID_RE.test(id) ? { kind: "order", id } : { error: "Missing or invalid order_id" };
  }
  if (b.lead_upload === true) {
    const id = typeof b.upload_id === "string" ? b.upload_id : "";
    return UUID_RE.test(id) ? { kind: "upload", id } : { error: "Missing or invalid upload_id" };
  }
  return null;
}

export async function handleLeadNotification(
  req: { kind: LeadNotifyKind; id: string },
  deps: LeadNotifyDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const rec = await deps.loadRecord(req.kind, req.id);
  if (!rec) return { status: 404, body: { error: req.kind === "order" ? "Order not found" : "Upload not found" } };
  const lead = await deps.loadLead(rec.lead_id);
  if (!lead) return { status: 404, body: { error: "Lead not found" } };

  if ((rec.is_test === true || lead.is_synthetic === true || isTestEmail(lead.email)) && !deps.verifySend) {
    return { status: 200, body: { success: true, skipped: true, reason: "test_account" } };
  }
  if (rec.admin_notified_at) return { status: 200, body: { success: true, skipped: true, reason: "already_notified" } };

  const claimed = await deps.claimNotified(req.kind, req.id);
  if (!claimed) return { status: 200, body: { success: true, skipped: true, reason: "already_notified" } };

  const msg = buildLeadEmail(req.kind, rec, lead);
  let sent: { ok: boolean; id?: string };
  try {
    sent = await deps.sendEmail(msg);
  } catch {
    sent = { ok: false };
  }
  if (!sent.ok) {
    await deps.releaseNotified(req.kind, req.id);
    await deps.alert(
      "notification_failed",
      `HO-3 admin email for lead ${req.kind} ${req.id} could not be sent; the row is unnotified and a retry will send.`,
    );
    return { status: 502, body: { error: "Failed to send notification" } };
  }
  return { status: 200, body: { success: true, mailgun_id: sent.id ?? null } };
}
