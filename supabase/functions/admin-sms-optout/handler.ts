/**
 * admin-sms-optout -- #3761 (child of gate #3726 item 2): a staff action that records a contractor's SMS opt-out
 * (and its reversal) in the SAME store twilio-sms-optout writes, so every contractor SMS sender honours it.
 *
 * The store (read from the deployed twilio-sms-optout + live schema, 2026-11-15):
 *   public.sms_suppression_list  one OPEN row (released_at IS NULL) per phone_e164 stops every text to that number:
 *                                contractor_textable_numbers() excludes it. channel is CHECK-limited to
 *                                sms_keyword | sms_freeform | email | support_call | carrier_disconnect.
 *   public.contractor_sms_numbers status -> 'opted_out' with opted_out_at, opt_out_keyword, opt_out_channel
 *                                (CHECK: status 'opted_out' needs opted_out_at + opt_out_channel). Same channel set.
 * A staff opt-out writes both, in the same order as twilio-sms-optout (suppression row FIRST: it is the write that
 * stops texts; the status flip is bookkeeping), with channel 'email' or 'support_call' (the FCC "any reasonable
 * method" channels the gate names). It sends NOTHING (no Twilio, no e-mail): Tier 3A, no external side effects.
 *
 * Reversal mirrors START, no wider:
 *   - it releases an open suppression row ONLY when that row was itself a staff record (channel email / support_call).
 *     A STOP the contractor sent by text (sms_keyword / sms_freeform / carrier_disconnect) is released only by the
 *     contractor's own START (Ben's ruling, #2875 comment 6281163859), so staff are refused (409) for those numbers.
 *   - the table CHECK sms_suppression_release_by_start forces released_keyword = 'START'; the real actor is the audit row.
 *   - it does NOT flip a number back to 'verified'. The verified number is the unit of consent (D-391), so an
 *     'opted_out' number stays out of contractor_textable_numbers() until the contractor verifies it again by code.
 *
 * Auth: the caller's JWT must pass requireAdmin (public.is_admin_email()). Anything else is refused BEFORE any read or
 * write (401 no/invalid token, 403 not an admin). Fails closed.
 * Audit: one public.activity_log row per action, user_id = the acting admin, metadata carries who/when/channel/reason/last4 and
 * the ids of the suppression rows and contractor_sms_numbers rows touched. The row is written FIRST (status 'started'),
 * before any store write, then finished (status 'completed' | 'blocked' | 'failed') with the ids, so a store write that
 * succeeds can never go unattributed and a failed one is marked failed (REVIEW 6903556372 should-fix 2/4).
 * Reason (D-391 rule 7): required on both actions, trimmed, 1..300 chars, no run of 7+ digits and no phone-shaped text.
 * No customer-facing wording is produced anywhere in this file.
 */
import type { GateResult } from "../_shared/admin-gate.ts";

export const FUNCTION_NAME = "admin-sms-optout";
export const STAFF_CHANNELS = ["email", "support_call"] as const;
export type StaffChannel = typeof STAFF_CHANNELS[number];
export const EVENT_OPT_OUT = "contractor_sms_opt_out_recorded";
export const EVENT_OPT_IN = "contractor_sms_opt_in_recorded";

export interface NumberRow { id: string; phone_e164: string; status: string }
export interface OpenSuppression { id: string; phone_e164: string; channel: string }
export interface AuditRow {
  user_id: string;
  event_type: string;
  title: string;
  metadata: Record<string, unknown>;
}
export const REASON_MAX = 300;
/** D-391 rule 7 reason check. Returns the trimmed reason, or null when it must be refused. */
export function cleanReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const r = raw.trim();
  if (r.length === 0 || r.length > REASON_MAX) return null;
  if (/\d{7,}/.test(r)) return null; // no phone numbers in the audit log
  if (/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(r)) return null; // nor a formatted one
  return r;
}

export interface Deps {
  /** Verifies the caller is an admin (requireAdmin in production). */
  gate: (req: Request) => Promise<GateResult>;
  now: () => Date;
  /** Every contractor_sms_numbers row for the contractor, any status. */
  listNumbers: (contractorId: string) => Promise<NumberRow[] | null>;
  /** Open a suppression row for the number (an already-open row is kept); returns the open row's id, null on failure. */
  suppress: (phone: string, keyword: string, channel: StaffChannel, atIso: string, sourceNumberId: string) => Promise<string | null>;
  /** Mark the contractor's verified rows opted_out; returns the ids of the rows changed, null on failure. */
  markOptedOut: (contractorId: string, keyword: string, channel: StaffChannel, atIso: string) => Promise<string[] | null>;
  /** Open suppression rows for the given numbers (null = lookup failed). */
  openSuppressions: (phones: string[]) => Promise<OpenSuppression[] | null>;
  /** Release the given suppression rows (released_keyword START); true on success. */
  release: (ids: string[], atIso: string) => Promise<boolean>;
  /** Write the audit row (status 'started') BEFORE any store write; returns its id, null on failure. */
  auditBegin: (row: AuditRow) => Promise<string | null>;
  /** Replace the audit row's metadata with its final state; true on success. */
  auditFinish: (id: string, metadata: Record<string, unknown>) => Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const last4 = (p: string) => p.slice(-4);

export function buildCorsHeaders(req: Request): Record<string, string> {
  const allowed = [
    "https://otterquote.com",
    "https://app.otterquote.com",
    "https://app-staging.otterquote.com",
    "https://jade-alpaca-b82b5e.netlify.app",
    "https://staging--jade-alpaca-b82b5e.netlify.app",
  ];
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

export async function handle(req: Request, d: Deps): Promise<Response> {
  const cors = buildCorsHeaders(req);
  const json = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // Admin gate first: nothing below this line runs for a non-admin.
  const gate = await d.gate(req);
  if (!gate.ok) return json(gate.status, { error: gate.status === 401 ? "unauthorized" : "forbidden" });
  const actor = gate.user;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const action = body.action;
  const contractorId = typeof body.contractor_id === "string" ? body.contractor_id.trim() : "";
  if (action !== "opt_out" && action !== "opt_in") return json(400, { error: "invalid_action" });
  if (!UUID.test(contractorId)) return json(400, { error: "invalid_contractor_id" });
  const channel = body.channel;
  if (!(STAFF_CHANNELS as readonly string[]).includes(channel as string)) {
    return json(400, { error: "invalid_channel", allowed: [...STAFF_CHANNELS] });
  }
  const ch = channel as StaffChannel;
  const reason = cleanReason(body.reason);
  if (reason === null) return json(400, { error: "invalid_reason" });
  const at = d.now().toISOString();

  const numbers = await d.listNumbers(contractorId);
  if (numbers === null) return json(500, { error: "lookup_failed" });
  if (numbers.length === 0) return json(404, { error: "no_sms_number_on_file" });
  const phones = [...new Set(numbers.map((n) => n.phone_e164))];
  const event = action === "opt_out" ? EVENT_OPT_OUT : EVENT_OPT_IN;
  const meta: Record<string, unknown> = {
    status: "started",
    contractor_id: contractorId,
    channel: ch,
    reason,
    actor_email: actor.email,
    at,
    numbers_last4: phones.map(last4),
    number_ids: numbers.map((n) => n.id),
    suppression_ids: [] as string[],
  };

  // Audit FIRST: if this cannot be written, nothing is changed (fail closed).
  const auditId = await d.auditBegin({ user_id: actor.id, event_type: event, title: event, metadata: { ...meta } });
  if (!auditId) return json(500, { error: "audit_failed", store_written: false });
  const finish = async (patch: Record<string, unknown>) => d.auditFinish(auditId, { ...meta, ...patch });
  const fail = async (error: string) => {
    await finish({ status: "failed", error });
    return json(500, { error });
  };

  if (action === "opt_out") {
    const keyword = `STAFF_${ch.toUpperCase()}`;
    // Every number the contractor has ever registered is suppressed (by phone), whatever its status, so a later
    // re-verification of a disabled/removed row cannot make it textable again.
    const seen = new Set<string>();
    const suppressionIds: string[] = [];
    for (const n of numbers) {
      if (seen.has(n.phone_e164)) continue;
      seen.add(n.phone_e164);
      const id = await d.suppress(n.phone_e164, keyword, ch, at, n.id);
      if (!id) return await fail("suppress_failed");
      suppressionIds.push(id);
    }
    meta.suppression_ids = suppressionIds;
    const changed = await d.markOptedOut(contractorId, keyword, ch, at);
    if (changed === null) return await fail("status_update_failed");
    meta.opted_out_number_ids = changed;
    // The store is written and the write is idempotent, so a retry is safe.
    if (!(await finish({ status: "completed" }))) return json(500, { error: "audit_failed", store_written: true });
    return json(200, { ok: true, action, contractor_id: contractorId, numbers_suppressed: phones.length });
  }

  // opt_in
  const open = await d.openSuppressions(phones);
  if (open === null) return await fail("lookup_failed");
  const releasable = open.filter((o) => (STAFF_CHANNELS as readonly string[]).includes(o.channel));
  const blocked = open.filter((o) => !(STAFF_CHANNELS as readonly string[]).includes(o.channel));
  meta.blocked_last4 = blocked.map((o) => last4(o.phone_e164));
  meta.blocked_suppression_ids = blocked.map((o) => o.id);
  if (releasable.length > 0) {
    meta.suppression_ids = releasable.map((o) => o.id);
    meta.released_last4 = releasable.map((o) => last4(o.phone_e164));
    if (!(await d.release(releasable.map((o) => o.id), at))) return await fail("release_failed");
  }
  const needsReverify = numbers.filter((n) => n.status === "opted_out").length;
  const result = {
    action,
    contractor_id: contractorId,
    suppressions_released: releasable.length,
    blocked_by_contractor_stop: blocked.length,
    numbers_needing_reverification: needsReverify,
  };
  // A STOP the contractor texted is released only by their own START: staff cannot clear it.
  if (!(await finish({ status: blocked.length > 0 ? "blocked" : "completed" }))) {
    return json(500, { error: "audit_failed", store_written: releasable.length > 0 });
  }
  if (blocked.length > 0) return json(409, { error: "stop_by_text_needs_contractor_start", ...result });
  return json(200, { ok: true, ...result });
}
