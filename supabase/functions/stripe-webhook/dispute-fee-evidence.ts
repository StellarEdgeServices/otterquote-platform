/**
 * gh-3409 (REVIEW 6669923343 B2) - the dispute's fee-acceptance evidence, as one importable unit.
 *
 * index.ts starts a server and imports esm.sh at load, so no test can import it. The wiring that matters (read the SELECTED bid's acceptance,
 * pick it, and put it or the reason into the Stripe evidence and the ClickUp task) lives here instead, and a test runs all of it end to end
 * against a fake database. index.ts only calls assembleDisputeFeeEvidence() and hands its fields on.
 */
import { assembleTextEvidence, claimRecordLines, formatAcceptedFeeDollars } from "./dispute-evidence-fields.ts";
import { describeMissingFeeAcceptance, describeMissingFeeAcceptanceForStripe, loadFeeAcceptanceForDispute, type AcceptancePickReason, type DbLike } from "./fee-acceptance-select.ts";

export interface StripeDisputeForEvidence {
  id: string;
  charge: string;
  amount: number;
  currency: string;
  reason: string;
}

export interface ClaimForEvidence {
  id: string;
  selected_contractor_id: string | null;
  contract_signed_at: string | null;
  completion_date: string | null;
}

export interface QuoteForEvidence {
  id: string;
  claim_id: string;
  contractor_id: string;
  fee_amount: number | null;
}

export interface FeeAcceptanceRow {
  id: string;
  contractor_id: string;
  claim_id: string;
  bid_id: string;
  fee_pct: number;
  fee_amount: number;
  fee_text_displayed: string;
  accepted_at: string;
  ip_address: string | null;
  user_agent: string | null;
  invoice_url: string | null;
}

// ---------------------------------------------------------------------------
// Evidence builder — D-215 stack (moved from index.ts by gh-3409)
// ---------------------------------------------------------------------------
export function buildEvidencePayload(params: {
  dispute: StripeDisputeForEvidence;
  claim: ClaimForEvidence | null;
  feeAcceptance: FeeAcceptanceRow | null;
  feeAcceptanceMissingReason?: AcceptancePickReason | null;
}): Record<string, string> {
  const { dispute, claim, feeAcceptance, feeAcceptanceMissingReason } = params;

  const productDescription = [
    "Otter Quotes is a platform that facilitates roofing and exterior repair contracts.",
    "The platform collects a platform fee from contractors when a homeowner signs their contract.",
    "The platform fee covers: competitive bid management, digital contract execution (electronic signature), ",
    "and document compliance services.",
  ].join(" ");

  const serviceDocLines = [
    "TRANSACTION RECORD — Otter Quotes Platform Fee",
    `Dispute ID: ${dispute.id}`,
    `Charge ID: ${dispute.charge}`,
    `Dispute Amount: $${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}`,
    `Dispute Reason: ${dispute.reason}`,
    "",
  ];

  if (feeAcceptance) {
    serviceDocLines.push(
      "FEE ACCEPTANCE RECORD (UETA Layer 1 — D-215):",
      `  Fee Rate: ${feeAcceptance.fee_pct}%`,
      `  Fee Amount: ${formatAcceptedFeeDollars(feeAcceptance.fee_amount)}`,
      `  Accepted At: ${feeAcceptance.accepted_at}`,
      `  IP Address: ${feeAcceptance.ip_address ?? "Not recorded"}`,
      `  Fee Text Shown to Contractor: "${feeAcceptance.fee_text_displayed}"`,
      "",
    );
  } else {
    serviceDocLines.push(
      `FEE ACCEPTANCE RECORD: ${describeMissingFeeAcceptanceForStripe(feeAcceptanceMissingReason)}`,
      "",
    );
  }

  if (claim) {
    serviceDocLines.push(
      ...claimRecordLines(claim),
    );

    if (claim.completion_date) {
      serviceDocLines.push(`  Job Completion Date: ${claim.completion_date} (contractor marked job complete)`);
    } else {
      serviceDocLines.push(
        "  Job Completion Date: PENDING — contractor 'Mark Complete' action not yet triggered.",
        "  NOTE: Completion cannot be auto-verified at this time. Manual verification of job",
        "  completion required.",
      );
    }

    serviceDocLines.push(
      "  Homeowner Completion Acknowledgment: NOT AVAILABLE — homeowner acknowledgment flow is",
      "  a net-new build per D-228 and has not yet been deployed. This evidence layer will be",
      "  available after the homeowner acknowledgment feature ships.",
    );
  }

  const customerCommunication = feeAcceptance
    ? [
        "A bid confirmation email was sent to the contractor upon bid submission.",
        `The email included the platform fee rate (${feeAcceptance.fee_pct}%), a link to rescind the bid,`,
        "and a link to review the bid.",
        feeAcceptance.invoice_url
          ? `Invoice URL (D-215 Layer 3): ${feeAcceptance.invoice_url}`
          : "Invoice URL: Not available — invoice may not have been generated yet.",
      ].join(" ")
    : "Fee acceptance record could not be retrieved at this time.";

  // gh-1759: service_documentation / customer_communication / receipt are Stripe
  // FILE fields; the prose belongs in the text fields (see dispute-evidence-fields.ts).
  const evidence: Record<string, string> = assembleTextEvidence({
    productDescription,
    serviceDocumentation: serviceDocLines.join("\n"),
    customerCommunication, // already carries the invoice URL when one exists
  });

  // ── gh-1759 GATE 2 / gh-2794 GATE 3 ────────────────────────────────────────
  // This function returns the evidence FIELDS only. Whether the request submits
  // FINAL is decided in postDisputeEvidence() (dispute-routing.ts), which always
  // sends an explicit top-level `submit` parameter: Stripe's Update-a-dispute API
  // defaults `submit` to true, so leaving it out would submit FINAL. It is
  // "true" only when claim + fee acceptance are resolved AND
  // DISPUTE_EVIDENCE_FINAL_SUBMIT_ENABLED is exactly "true"; otherwise "false"
  // (staged draft for a person to finish).
  return evidence;
}


/** The ClickUp task's fee block (internal: names the reason and the quarantine table, which Stripe text must not). */
export function buildTaskFeeInfo(feeAcceptance: FeeAcceptanceRow | null, reason: AcceptancePickReason | null | undefined): string {
  return feeAcceptance
    ? [
        `**Fee %:** ${feeAcceptance.fee_pct}%`,
        `**Fee Amount:** ${formatAcceptedFeeDollars(feeAcceptance.fee_amount)}`,
        `**Accepted At:** ${feeAcceptance.accepted_at}`,
        `**Fee Text Shown:** ${feeAcceptance.fee_text_displayed}`,
        `**Invoice URL:** ${feeAcceptance.invoice_url ?? "None"}`,
      ].join("\n")
    : `⚠️ ${describeMissingFeeAcceptance(reason)}`;
}

/**
 * Reads the acceptance of the SELECTED bid (see fee-acceptance-select.ts), and builds the Stripe evidence fields and the task's fee block from it.
 * `quote` is the quote the payment intent resolved, when the claim came from it.
 */
export async function assembleDisputeFeeEvidence(
  db: DbLike,
  dispute: StripeDisputeForEvidence,
  claim: ClaimForEvidence | null,
  quote: QuoteForEvidence | null,
): Promise<{
  feeAcceptance: FeeAcceptanceRow | null;
  feeAcceptanceMissingReason: AcceptancePickReason | null;
  evidencePayload: Record<string, string>;
  taskFeeInfo: string;
}> {
  let feeAcceptance: FeeAcceptanceRow | null = null;
  let feeAcceptanceMissingReason: AcceptancePickReason | null = null;
  if (claim) {
    const contractorId = claim.selected_contractor_id ?? quote?.contractor_id;
    if (contractorId) {
      const picked = await loadFeeAcceptanceForDispute<FeeAcceptanceRow>(db, claim, contractorId, quote);
      if (picked.row) {
        feeAcceptance = picked.row;
      } else {
        feeAcceptanceMissingReason = picked.reason;
        console.warn(`[stripe-webhook] gh-3409: no usable fee acceptance for claim ${claim.id} (${picked.reason}); manual evidence gathering`);
      }
    }
  }
  return {
    feeAcceptance,
    feeAcceptanceMissingReason,
    evidencePayload: buildEvidencePayload({ dispute, claim, feeAcceptance, feeAcceptanceMissingReason }),
    taskFeeInfo: buildTaskFeeInfo(feeAcceptance, feeAcceptanceMissingReason),
  };
}
