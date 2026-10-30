// gh-3216 -- D-199 admin-verdict guard for validate-contract-template.
//
// A template whose status is `rejected` or `admin_validated` carries an ADMIN verdict (D-199 tier 3,
// written through admin-template-review). validate-contract-template runs with the service-role key,
// so the database's freeze_verdict trigger does not stop it, and before this guard a contractor could
// call it on a `rejected` row (the "Map anchors manually" path with every field mapped) and have the
// row rewritten to `manual_validated`. A validated template passes bid_can_submit and contract creation,
// so that was a contractor bypass of the admin's rejection. Ben's ruling on #3199 (6522824754): an
// admin verdict is not to be cycled around by the contractor.
//
// Rule: current status in {rejected, admin_validated} AND caller not an admin => refuse with 409 and
// write nothing. Everything else (admin callers; pending_validation, manual_mapping_pending, and any
// other status) is untouched by this module.
//
// "Admin" here means EITHER of the two admin notions this function already has to honour:
//   - isAdminPath: the request asked for manualOverrides === "admin" and index.ts already verified the
//     JWT's app_metadata.role === "admin" (403 otherwise), or
//   - requireAdmin() from _shared/admin-gate.ts (verified JWT + live public.is_admin_email()).
// Fails CLOSED: any gate error means "not an admin", so the row is left alone.
//
// Kept in its own file (index.ts calls Deno.serve at module scope and cannot be imported by the
// pure-unit test lane) so the decision can be unit-tested; index.ts wiring is asserted in
// gh3216-verdict-guard.test.ts.
import { requireAdmin } from "../_shared/admin-gate.ts";

/** Statuses that carry an admin verdict. Only an admin may move a row out of these. */
export const ADMIN_VERDICT_STATUSES: readonly string[] = ["rejected", "admin_validated"];

export const VERDICT_LOCKED_CODE = "admin_verdict_locked";

export type VerdictGuardResult =
  | { ok: true }
  | { ok: false; httpStatus: 409; body: { error: string; code: string; status: string } };

export interface VerdictGuardInput {
  req: Request;
  /** The row's CURRENT status, as just loaded from contractor_templates. */
  currentStatus: string | null | undefined;
  /** True when index.ts has already verified an admin-role JWT on the manualOverrides === "admin" path. */
  isAdminPath: boolean;
  /** Injectable for tests; defaults to _shared/admin-gate.ts requireAdmin. */
  requireAdminFn?: (req: Request) => Promise<{ ok: boolean }>;
}

export async function checkAdminVerdictGuard(input: VerdictGuardInput): Promise<VerdictGuardResult> {
  const status = input.currentStatus ?? "";
  if (!ADMIN_VERDICT_STATUSES.includes(status)) return { ok: true };
  if (input.isAdminPath) return { ok: true };
  let admin = false;
  try {
    admin = (await (input.requireAdminFn ?? requireAdmin)(input.req)).ok === true;
  } catch (_e) {
    admin = false; // fail closed
  }
  if (admin) return { ok: true };
  const error = status === "rejected"
    ? "This template was rejected in admin review and cannot be re-validated. Upload a corrected template instead."
    : "This template has been validated by an admin and cannot be re-validated by the contractor.";
  return { ok: false, httpStatus: 409, body: { error, code: VERDICT_LOCKED_CODE, status } };
}
