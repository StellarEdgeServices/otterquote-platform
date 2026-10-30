/**
 * warranty-drift-gate.ts -- caller gate shared by approve-warranty-drift and reject-warranty-drift (gh-3115).
 *
 * Root cause fixed here: both functions used `createClient(SUPABASE_URL, callerToken).auth.getUser()`.
 * The token went in as the apikey, so the client had no session and no-arg getUser() returned
 * AuthSessionMissingError without a network call: every caller, the primary admin included, got 401.
 *
 * Fix: verify the JWT through the established _shared/admin-gate.ts requirePrimaryAdmin() (caller JWT
 * in global.headers.Authorization), then keep the pre-existing DB fallback
 * (contractors.template_review_role = 'admin'). Accepted set is unchanged from the intended one:
 * the primary admin email, plus contractors with template_review_role = 'admin'. Nothing else.
 *
 * Result: { ok: true, user } | { ok: false, status: 401 | 403 }.
 */
import { type GateDeps, type GateUser, requirePrimaryAdmin } from "./admin-gate.ts";

export type DriftGateResult =
  | { ok: true; user: GateUser }
  | { ok: false; status: 401 | 403 };

/** Returns true when contractors.template_review_role = 'admin' for this auth user id. */
export type RoleLookup = (userId: string) => Promise<boolean>;

export async function authorizeWarrantyDriftCaller(
  req: Request,
  lookupAdminRole: RoleLookup,
  deps: GateDeps = {},
): Promise<DriftGateResult> {
  const gate = await requirePrimaryAdmin(req, deps);
  if (gate.ok) return { ok: true, user: gate.user };
  // 401 = nobody identified; 403 without a user = gate misconfigured/errored (fail closed).
  if (gate.status === 401 || !gate.user) return { ok: false, status: gate.status };
  // Identified but not the primary admin: allow only the template_review_role fallback.
  try {
    if (await lookupAdminRole(gate.user.id)) return { ok: true, user: gate.user };
  } catch (_e) {
    // fail closed
  }
  return { ok: false, status: 403 };
}
