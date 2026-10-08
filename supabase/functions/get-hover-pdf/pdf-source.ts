/**
 * get-hover-pdf: pure/testable helpers factored out of index.ts (gh-1538).
 *
 * selectPdfSource decides where a completed hover_orders row's PDF comes
 * from:
 *   - an automated Hover order (hover_job_id set) fetches from Hover's API.
 *   - a manually fulfilled order (hover_job_id NULL — gh-1245's
 *     admin-measurements.html path) is read from its already-uploaded
 *     Storage object at report_url.
 *   - an order with neither (measurements entered but no PDF uploaded) has
 *     no file to serve at all.
 * Before gh-1538 the caller only ever checked hover_job_id and 500'd for
 * every manual order, regardless of whether a report_url existed.
 *
 * canAccessClaim decides who may be served a claim's measurement PDF:
 * (1) the homeowner who owns the claim; (2) the contractor the homeowner
 * SELECTED on it, while that contractor record is active. Nobody else.
 * gh-2559 / D-370 (CEO ruling on PR #2569, comment 6045857216): before
 * selection a bidding contractor does not open any measurement report on
 * the claim, whether the homeowner uploaded it or it was produced through
 * the platform. Before this change the function mirrored the claims-table
 * RLS SELECT boundary and served any active contractor on a claim open for
 * bids, and any contractor with a quote on it. A bidder still prices from
 * the measured quantities on the claim summary; only the report is withheld.
 */

export type PdfSource =
  | { kind: "hover"; jobId: string }
  | { kind: "manual"; path: string }
  | { kind: "none" };

export function selectPdfSource(order: {
  hover_job_id: string | null;
  report_url: string | null;
}): PdfSource {
  if (order.hover_job_id) {
    return { kind: "hover", jobId: order.hover_job_id };
  }
  if (order.report_url) {
    return { kind: "manual", path: order.report_url };
  }
  return { kind: "none" };
}

export async function canAccessClaim(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  claimId: string,
  user: { id: string },
): Promise<boolean> {
  // (1) Homeowner ownership.
  const { data: claim } = await supabase
    .from("claims")
    .select("user_id, selected_contractor_id")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) return false; // unknown claim → deny
  if (claim.user_id === user.id) return true;

  // (2) The contractor the homeowner selected on this claim, and only while
  // that contractor record is active (the same test the claim-documents
  // storage policy applies to the selected contractor). A claim with nobody
  // selected serves no contractor at all.
  if (!claim.selected_contractor_id) return false;
  const { data: contractors } = await supabase
    .from("contractors")
    .select("id, status")
    .eq("user_id", user.id);
  const contractorRows = (contractors ?? []) as { id: string; status: string | null }[];
  return contractorRows.some(
    (c) => c.id === claim.selected_contractor_id && c.status === "active",
  );
}
