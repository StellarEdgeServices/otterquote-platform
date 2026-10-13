/**
 * get-hover-siding-data: who may be given the job's street address (gh-2559).
 *
 * D-371 (Dustin, 2026-10-07, #2559 comment 6038067961): before a homeowner selects
 * a contractor, a bidding contractor sees city and zip only, never the street.
 * This function reads the vendor job under the service role and used to return
 * its full address as `job_address` to every caller that passed the claim
 * visibility gate, which includes any active contractor on a claim open for bids
 * (CEO return on PR #2578, comment 6045859470). The claim-summary view cannot
 * reach this path, so the rule is enforced here.
 *
 * mayReceiveJobAddress: the claim's owner, or the contractor the homeowner
 * SELECTED on the claim while that contractor record is active. Nobody else.
 * A bidder is still served the design images and material data; the response
 * carries `job_address: null` for them. City and zip come from the view.
 */
export async function mayReceiveJobAddress(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  claimId: string,
  user: { id: string },
): Promise<boolean> {
  const { data: claim } = await supabase
    .from("claims")
    .select("user_id, selected_contractor_id")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) return false;
  if (claim.user_id === user.id) return true;
  if (!claim.selected_contractor_id) return false;
  const { data: contractors } = await supabase
    .from("contractors")
    .select("id, status")
    .eq("user_id", user.id);
  const rows = (contractors ?? []) as { id: string; status: string | null }[];
  return rows.some((c) => c.id === claim.selected_contractor_id && c.status === "active");
}

/** The value put in the response: the address for a caller who may have it, else null. Fails closed. */
export function jobAddressFor(mayReceive: boolean, jobAddress: string | null): string | null {
  return mayReceive === true ? jobAddress : null;
}
