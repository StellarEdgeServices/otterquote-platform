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
 * canAccessClaim is copied verbatim from index.ts (behaviour unchanged) so
 * it can be exercised in isolation with a stubbed Supabase client — it
 * mirrors the `claims`-table RLS SELECT boundary: (1) homeowner ownership,
 * (2) active contractor on a released biddable claim, (3) contractor with
 * an existing quote on the claim. See the long comment at its call site in
 * index.ts for the RLS policy names each branch corresponds to.
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
    .select("user_id, ready_for_bids, status")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) return false; // unknown claim → deny
  if (claim.user_id === user.id) return true;

  // Resolve the caller's contractor record(s) once (a user may own more than one).
  const { data: contractors } = await supabase
    .from("contractors")
    .select("id, status")
    .eq("user_id", user.id);
  const contractorRows = (contractors ?? []) as { id: string; status: string | null }[];
  if (contractorRows.length === 0) return false; // not the owner and not a contractor

  // (2) Active contractor + released, biddable claim.
  const biddable =
    claim.ready_for_bids === true &&
    ["active", "bidding", "pending"].includes(claim.status);
  if (biddable && contractorRows.some((c: { status: string | null }) => c.status === "active")) {
    return true;
  }

  // (3) Contractor associated via an existing quote/selection on this claim.
  const { data: quote } = await supabase
    .from("quotes")
    .select("id")
    .eq("claim_id", claimId)
    .in("contractor_id", contractorRows.map((c: { id: string }) => c.id))
    .limit(1)
    .maybeSingle();
  if (quote) return true;

  return false;
}
