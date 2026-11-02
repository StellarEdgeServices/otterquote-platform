/**
 * docusign-webhook -- which of a claim's envelopes did this event come from? (pure, unit-testable)
 *
 * D-407 (#3287): create-docusign-envelope no longer creates Project Confirmation or colour envelopes
 * (it answers 410). This webhook creates no envelope of any kind. Envelopes of those two types that
 * were minted BEFORE the retirement still exist at BoldSign and can still send events, so they stay
 * recognised: their completion timestamps are written for history (claims.color_confirmed_at,
 * claims.project_confirmation_signed_at; the columns are kept) and they never enter any contract
 * branch (price gate, acknowledgment backstop, payment, contract_signed, notifications).
 *
 * Precedence is contract first: if one id sits in several claim columns, it is the contract.
 */
export type EnvelopeKind =
  | "contract"
  | "retired_color_confirmation"
  | "retired_project_confirmation"
  | "unmatched";

export interface ClaimEnvelopeColumns {
  docusign_envelope_id?: string | null;
  color_confirmation_envelope_id?: string | null;
  project_confirmation_envelope_id?: string | null;
}

export function classifyEnvelope(claim: ClaimEnvelopeColumns | null | undefined, envelopeId: string | null | undefined): EnvelopeKind {
  if (!claim || !envelopeId) return "unmatched";
  if (claim.docusign_envelope_id === envelopeId) return "contract";
  if (claim.color_confirmation_envelope_id === envelopeId) return "retired_color_confirmation";
  if (claim.project_confirmation_envelope_id === envelopeId) return "retired_project_confirmation";
  return "unmatched";
}
