/**
 * record-ad-sharing-opt-out -- the admin check, extracted from index.ts so it is unit-tested (gh-3077).
 *
 * Admitted = the caller is the primary admin (the verified JWT email equals _shared/admin-gate.ts PRIMARY_ADMIN_EMAIL,
 * via requirePrimaryAdmin) OR the caller's contractors.template_review_role is "admin". Exactly the set the inlined gate
 * admitted before (email === PRIMARY_ADMIN_EMAIL, then the role fallback). Nothing widens: the second admin address is
 * NOT admitted by the email arm. The role arm is only consulted when the email arm says no.
 */
import type { GateResult } from "../_shared/admin-gate.ts";

export async function isAdminCaller(
  primaryGate: () => Promise<GateResult>,
  roleIsAdmin: () => Promise<boolean>,
): Promise<boolean> {
  const g = await primaryGate();
  if (g.ok) return true;
  return await roleIsAdmin();
}
