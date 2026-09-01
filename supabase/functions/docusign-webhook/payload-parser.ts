/**
 * docusign-webhook — BoldSign webhook payload parser (pure, unit-testable).
 *
 * [D-274 / #631, 2026-08-13] Re-platformed from DocuSign Connect to BoldSign.
 * File path/name intentionally UNCHANGED (index.ts imports it by relative
 * path; keeping the name avoids churn in the caller for this PR).
 *
 * Confirmed payload shape (developers.boldsign.com/webhooks/sample-event-data/,
 * verified against the live "Completed" / "Declined" / "Revoked" examples —
 * NOT inferred from the shorter event-metadata page, which only shows the
 * `event` block and omits `data` entirely):
 *
 *   {
 *     event: { id, created (unix seconds), eventType, clientId, environment },
 *     context: { eventType, actor, previousState: { status } },
 *     data: {
 *       object: "document", documentId, messageTitle, documentDescription,
 *       status, senderDetail: {...},
 *       signerDetails: [ { signerName, signerRole, signerEmail, id, status,
 *                           isViewed, order, signerType, declineMessage, ... } ],
 *       revokeMessage, errorMessage, createdDate, expiryDate, ...
 *     }
 *   }
 *
 * Unlike DocuSign Connect (which had "rich"/"flat"/"lean" payload variants —
 * the Phase 17/18 "0 fees ever" bug class), BoldSign's webhook payload is a
 * SINGLE documented shape with no lean/metadata-only variant observed. This
 * parser is deliberately still defensive (optional chaining throughout, no
 * assumption a field is present) because the shape was reconstructed from
 * documentation examples, not a formal schema — an actual malformed or
 * future-BoldSign-version payload should degrade to `recognized: false`
 * rather than throw.
 *
 * No completion timestamp exists on the signer or data objects — the closest
 * available value is the top-level `event.created` (unix seconds), used for
 * completedDateTime/declinedDateTime/voidedDateTime alike (this mirrors the
 * DocuSign lean-payload fallback's use of generatedDateTime for the same
 * reason: something no more precise is available).
 *
 * Status vocabulary mapping — BoldSign uses "Revoked" where the rest of this
 * codebase (claims.contract_voided_at, docusign-webhook's status branches)
 * uses "voided": these are treated as the SAME state (sender cancelled the
 * document before it completed). BoldSign's "Expired" status has no DocuSign
 * equivalent in the original branch logic; it is also mapped to "voided" so
 * it lands on the existing contract_voided_at branch rather than falling
 * through unhandled — flagged here for anyone reconciling status semantics
 * later, since "expired" and "voided" are not identical in real-world
 * meaning even though this code treats them the same.
 */

export interface NormalizedSigner {
  /**
   * BoldSign signers[].id, as set at send time. [gh-1446] Since gh-1244 this is
   * a random GUID (crypto.randomUUID()) — BoldSign rejects string labels like
   * "contractor_1" ("The field Id is invalid"), so the legacy DocuSign-era
   * label convention survives only for any historical envelope, not new mints.
   */
  clientUserId: string;
  /** Lowercased BoldSign signer status ("completed" | "notcompleted" | "declined" | "revoked" | "expired" | "none"). */
  status: string;
  /** Always null — BoldSign's webhook payload carries no per-signer completion timestamp. */
  signedDateTime: string | null;
  email: string | null;
  /**
   * BoldSign signerDetails[].order (falling back to signerOrder if a payload
   * ever carries the send-side property name). Positive integer or null.
   * [gh-1446] This is the only stable role key the webhook payload carries now
   * that signer ids are random GUIDs — see resolveContractSignerRole.
   */
  order: number | null;
}

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
  /** data.signerDetails[], normalized. Empty array (not null) when absent. */
  signerDetails: NormalizedSigner[];
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
  signerDetails: [],
};

const STATUS_MAP: Record<string, string> = {
  completed: "completed",
  declined: "declined",
  revoked: "voided",
  expired: "voided", // see file header — not semantically identical, mapped for branch coverage
  sent: "sent",
  viewed: "delivered", // closest DocuSign-vocabulary analog used by index.ts's informational branch
  inprogress: "sent",
  draft: "sent",
  scheduled: "sent",
};

function unixToIso(seconds: unknown): string | null {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/** Positive-integer parse for BoldSign's signer order; anything else → null. */
function normalizeOrder(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// deno-lint-ignore no-explicit-any
function normalizeSigners(raw: any): NormalizedSigner[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => ({
    clientUserId: String(s?.id ?? ""),
    status: String(s?.status ?? "").toLowerCase(),
    signedDateTime: null,
    email: s?.signerEmail ?? null,
    order: normalizeOrder(s?.order ?? s?.signerOrder),
  }));
}

export type ContractSignerRole = "contractor" | "homeowner";

/**
 * [gh-1446] Resolve which contract party a normalized signer is.
 *
 * CONTRACT ENVELOPES ONLY. The order convention below is
 * handleContractorSign's — the only live mint site for contract envelopes
 * (the legacy `document_type: "contract"` branch was verified caller-less,
 * 2026-08-27, and handleHomeownerSign never mints, it resumes). It sends
 * signerOrder 1 = contractor, 2 = homeowner, with enableSigningOrder: true.
 * handleLegacyFlow (color/project-confirmation envelopes) mints with the
 * OPPOSITE ordering (1 = requesting signer, 2 = contractor), so this resolver
 * must not be applied to non-contract envelopes.
 *
 * Resolution ladder:
 *   1. Legacy DocuSign-era labels ("contractor_1" / "homeowner_1") — preserves
 *      the pre-gh-1446 matching verbatim for any historical envelope.
 *   2. BoldSign signer `order` (1 = contractor, 2 = homeowner) — the only role
 *      key present since gh-1244 made signer ids random GUIDs. Signer email is
 *      deliberately NOT used: both parties can share one email (test fixtures
 *      do), so email can misattribute where order cannot.
 *   3. Anything else → null (no match, no write, no misattribution).
 */
export function resolveContractSignerRole(
  signer: Pick<NormalizedSigner, "clientUserId" | "order">,
): ContractSignerRole | null {
  if (signer.clientUserId === "contractor_1") return "contractor";
  if (signer.clientUserId === "homeowner_1") return "homeowner";
  if (signer.order === 1) return "contractor";
  if (signer.order === 2) return "homeowner";
  return null;
}

/**
 * [gh-1446] The signer-tracking predicate index.ts uses for contract
 * envelopes: the signer holding `role` iff that signer has completed.
 * Pure so the dead-matcher class that shipped in D-274 (GUID vs
 * "contractor_1", issue #1446) stays unit-testable here.
 */
export function findCompletedContractSigner(
  signers: NormalizedSigner[],
  role: ContractSignerRole,
): NormalizedSigner | undefined {
  return signers.find((s) => resolveContractSignerRole(s) === role && s.status === "completed");
}

// deno-lint-ignore no-explicit-any
export function parsePayload(payload: any): ParsedEnvelope {
  const documentId: string | null = payload?.data?.documentId ?? null;
  if (!documentId) {
    return { ...EMPTY };
  }

  const rawStatus = String(payload?.data?.status ?? payload?.event?.eventType ?? "").toLowerCase();
  const mappedStatus = STATUS_MAP[rawStatus] ?? (rawStatus || null);
  const eventCreatedIso = unixToIso(payload?.event?.created);
  const signerDetails = normalizeSigners(payload?.data?.signerDetails);
  const recipientEmail = signerDetails.length > 0 ? signerDetails[0].email : null;

  return {
    recognized: true,
    envelopeId: documentId,
    status: mappedStatus,
    recipientEmail,
    completedDateTime: mappedStatus === "completed" ? eventCreatedIso : null,
    declinedDateTime: mappedStatus === "declined" ? eventCreatedIso : null,
    voidedDateTime: mappedStatus === "voided" ? eventCreatedIso : null,
    event: payload?.event?.eventType ?? null,
    signerDetails,
  };
}
