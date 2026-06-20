/**
 * docusign-webhook — DocuSign Connect payload parser (pure, unit-testable).
 *
 * Extracted from index.ts so the envelope-field derivation can be unit-tested
 * without booting the Deno HTTP server (top-level serve()). No side effects,
 * no imports — same-folder sibling so the standalone Supabase CLI bundles it
 * into the function's eszip (a within-folder relative import, unlike ../_shared).
 *
 * DocuSign Connect (REST v2.1) sends three payload shapes depending on the
 * Connect config's "Include Data" setting and apiVersion:
 *   (a) rich:  { event, data: { envelopeId, envelopeSummary: { status, recipients, ... } } }
 *   (b) flat:  { envelopeId, status, completedDateTime, ... }
 *   (c) lean:  { event:"envelope-completed", apiVersion:"v2.1", uri, data: { accountId, envelopeId } }
 *
 * Shape (c) is sent when "Include Data" is OFF. v53 parsed only (a) and (b), so a
 * lean payload fell through to "Unrecognized payload format" and never reached the
 * platform-fee charge path (the "0 fees ever" root cause, Phase 17). This parser
 * recognizes all three; the lean branch derives status from the event string since
 * the lean shape carries no envelopeSummary.status.
 */

export interface ParsedEnvelope {
  /** false → handler responds 200 with "Unrecognized payload format" (no claim work). */
  recognized: boolean;
  envelopeId: string | null;
  status: string | null;
  recipientEmail: string | null;
  completedDateTime: string | null;
  declinedDateTime: string | null;
  voidedDateTime: string | null;
  event: string | null;
}

const EMPTY: ParsedEnvelope = {
  recognized: false,
  envelopeId: null,
  status: null,
  recipientEmail: null,
  completedDateTime: null,
  declinedDateTime: null,
  voidedDateTime: null,
  event: null,
};

/**
 * Derive a canonical status from a Connect event string (lean payload only).
 * Mirrors the status vocabulary the rich/flat shapes already provide.
 */
function statusFromEvent(event: unknown): string | null {
  const ev = (typeof event === "string" ? event : "").toLowerCase();
  if (ev.includes("completed")) return "completed";
  if (ev.includes("declined")) return "declined";
  if (ev.includes("voided")) return "voided";
  if (ev.includes("delivered")) return "delivered";
  if (ev.includes("sent")) return "sent";
  return null;
}

// deno-lint-ignore no-explicit-any
export function parsePayload(payload: any): ParsedEnvelope {
  // (a) Rich Connect JSON — envelopeSummary present.
  if (payload?.data?.envelopeSummary) {
    const summary = payload.data.envelopeSummary;
    const signers = summary.recipients?.signers;
    return {
      recognized: true,
      envelopeId: payload.data.envelopeId || summary.envelopeId || null,
      status: summary.status ?? null,
      recipientEmail: signers && signers.length > 0 ? signers[0].email ?? null : null,
      completedDateTime: summary.completedDateTime ?? null,
      declinedDateTime: summary.declinedDateTime ?? null,
      voidedDateTime: summary.voidedDateTime ?? null,
      event: payload.event ?? null,
    };
  }

  // (b) Flat shape — top-level envelopeId.
  if (payload?.envelopeId) {
    return {
      recognized: true,
      envelopeId: payload.envelopeId,
      status: payload.status ?? null,
      recipientEmail: null,
      completedDateTime: payload.completedDateTime ?? null,
      declinedDateTime: payload.declinedDateTime ?? null,
      voidedDateTime: payload.voidedDateTime ?? null,
      event: payload.event ?? null,
    };
  }

  // (c) Lean Connect 2.0 payload — "Include Data" OFF: data.envelopeId only, no
  //     envelopeSummary. No recipients/signers → recipientEmail stays null (both
  //     it and contractor_signed_at tracking are already guarded downstream, and
  //     the charge looks up the quote by claim, not from the payload), so the lean
  //     branch reaches the charge unchanged.
  if (payload?.data?.envelopeId) {
    return {
      ...EMPTY,
      recognized: true,
      envelopeId: payload.data.envelopeId,
      event: payload.event ?? null,
      status: statusFromEvent(payload.event),
      completedDateTime:
        payload.data?.envelopeSummary?.completedDateTime ||
        payload.generatedDateTime ||
        null,
    };
  }

  // Unrecognized.
  return { ...EMPTY };
}
