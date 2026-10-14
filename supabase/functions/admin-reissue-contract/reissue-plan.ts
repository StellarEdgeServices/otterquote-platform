/**
 * [gh-2543 part 2, slice 2a] Pure decision logic for re-issuing a contract after
 * a signed-price halt (docusign-webhook/price-verify.ts verdict `mismatch` or
 * `unverified`, contract_signed_at NULL).
 *
 * No I/O, no Deno.env, no Supabase client -- directly unit-testable.
 *
 * VENDOR FACT THIS DESIGN RESTS ON (BoldSign docs, developers.boldsign.com
 * /documents/revoke-document/: "Revoke action can only be performed on
 * documents that have not completed the signing process"): a document that is
 * already Completed CANNOT be voided through the API. After a price halt both
 * parties have signed, so the document is Completed in the case this exists
 * for. The plan therefore never deletes and never claims to void a Completed
 * document: it RETAINS the executed document at the vendor (the only copy of
 * what both parties signed) and detaches it from the claim, so a corrected
 * document can be minted by the existing resume/mint path
 * (create-docusign-envelope: "Explicitly voided is expressed as
 * quotes.docusign_envelope_id = NULL").
 *
 * What the executed-but-superseded document means between the parties, and
 * whether it should ever be deleted at the vendor, is legal position -- NOT
 * decided here (gh-2543 Q: default = retain, never delete).
 */

export type HaltVerdict = "mismatch" | "unverified";

export interface ReissueClaim {
  id: string;
  signed_price_verdict: string | null;
  contract_signed_at: string | null;
  docusign_envelope_id: string | null;
}

export interface ReissueQuote {
  id: string;
  docusign_envelope_id: string | null;
}

/** BoldSign document.status values, lower-cased by normalizeDocumentStatus(). */
export type DocumentStatus =
  | "completed"
  | "inprogress"
  | "draft"
  | "declined"
  | "expired"
  | "revoked"
  | "unknown";

export type VendorAction =
  /** Document not finished: revoke it at the vendor before detaching. */
  | "revoke"
  /** Document Completed: cannot be revoked, never deleted -- keep it, detach only. */
  | "retain_completed"
  /** Already revoked/declined/expired at the vendor: nothing to do there. */
  | "none";

export type RefusalCode =
  | "claim_not_halted"
  | "already_signed"
  | "no_envelope_on_claim"
  | "quote_pointer_mismatch"
  | "no_quote_points_at_envelope"
  | "expected_envelope_mismatch"
  | "document_status_unreadable";

export type ReissuePlan =
  | { ok: false; code: RefusalCode; detail: string }
  | {
      ok: true;
      envelopeId: string;
      verdict: HaltVerdict;
      vendorAction: VendorAction;
      /** quote ids whose docusign_envelope_id pointer is cleared */
      quoteIds: string[];
      /** columns written on claims, all guarded by .eq(docusign_envelope_id, envelopeId) */
      claimClear: Record<string, null>;
    };

/** Claim columns the re-issue clears. The old values go into the audit row first. */
export const CLAIM_CLEAR: Record<string, null> = {
  docusign_envelope_id: null,
  contract_sent_at: null,
  signed_contract_price: null,
  signed_price_raw: null,
  signed_price_verdict: null,
  signed_price_reason: null,
  signed_price_checked_at: null,
};

export function normalizeDocumentStatus(raw: unknown): DocumentStatus {
  const s = String(raw ?? "").trim().toLowerCase();
  switch (s) {
    case "completed":
    case "inprogress":
    case "draft":
    case "declined":
    case "expired":
    case "revoked":
      return s;
    default:
      return "unknown";
  }
}

export function vendorActionFor(status: DocumentStatus): VendorAction | null {
  switch (status) {
    case "completed":
      return "retain_completed";
    case "inprogress":
    case "draft":
      return "revoke";
    case "declined":
    case "expired":
    case "revoked":
      return "none";
    default:
      return null; // unknown/unreadable: fail closed
  }
}

export function planReissue(input: {
  claim: ReissueClaim;
  quotes: ReissueQuote[];
  documentStatus: DocumentStatus;
  /** envelope id the admin saw on the halted-contracts page; guards against a stale click */
  expectedEnvelopeId: string | null | undefined;
}): ReissuePlan {
  const { claim, quotes, documentStatus, expectedEnvelopeId } = input;
  const verdict = claim.signed_price_verdict;
  if (verdict !== "mismatch" && verdict !== "unverified") {
    return { ok: false, code: "claim_not_halted", detail: `signed_price_verdict=${verdict ?? "null"}` };
  }
  if (claim.contract_signed_at) {
    return { ok: false, code: "already_signed", detail: `contract_signed_at=${claim.contract_signed_at}` };
  }
  const envelopeId = claim.docusign_envelope_id;
  if (!envelopeId) return { ok: false, code: "no_envelope_on_claim", detail: "claims.docusign_envelope_id is null" };
  if (!expectedEnvelopeId || expectedEnvelopeId !== envelopeId) {
    return {
      ok: false,
      code: "expected_envelope_mismatch",
      detail: `caller expected ${expectedEnvelopeId ?? "(none)"}, claim holds ${envelopeId}`,
    };
  }
  const pointing = quotes.filter((q) => q.docusign_envelope_id === envelopeId);
  if (pointing.length === 0) {
    return { ok: false, code: "no_quote_points_at_envelope", detail: `no quote carries ${envelopeId}` };
  }
  const vendorAction = vendorActionFor(documentStatus);
  if (vendorAction === null) {
    return { ok: false, code: "document_status_unreadable", detail: `status=${documentStatus}` };
  }
  return {
    ok: true,
    envelopeId,
    verdict,
    vendorAction,
    quoteIds: pointing.map((q) => q.id),
    claimClear: { ...CLAIM_CLEAR },
  };
}

/** One-line audit message: what the claim held BEFORE the pointers were cleared. */
export function auditMessage(args: {
  claim: ReissueClaim & {
    signed_contract_price?: number | string | null;
    signed_price_raw?: string | null;
    signed_price_reason?: string | null;
  };
  plan: Extract<ReissuePlan, { ok: true }>;
  adminEmail: string;
  documentStatus: DocumentStatus;
}): string {
  const { claim, plan, adminEmail, documentStatus } = args;
  return (
    `gh-2543 reissue: claim ${claim.id} detached from envelope ${plan.envelopeId} ` +
    `(vendor status ${documentStatus}, vendor action ${plan.vendorAction}, document NOT deleted) ` +
    `by ${adminEmail}. Prior halt: verdict=${plan.verdict}, reason=${claim.signed_price_reason ?? "null"}, ` +
    `signed=${claim.signed_contract_price ?? "null"}, raw=${claim.signed_price_raw ?? "null"}. ` +
    `Quotes detached: ${plan.quoteIds.join(",")}. A corrected document is minted on the next signing entry.`
  );
}
