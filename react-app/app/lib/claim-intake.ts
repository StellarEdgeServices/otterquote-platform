/**
 * gh-3270 -- has this claim finished homeowner intake?
 *
 * auth-callback and trade-selector both used to send ANY homeowner with ANY
 * claim straight to the dashboard. A returning account whose only claim was an
 * address-less draft (created before intake finished) therefore skipped
 * trade-selector, the only page that writes cs_signup's address, phone,
 * funding and trades to the database, and those answers were lost.
 *
 * A claim has finished intake once property_address is set: trade-selector
 * never writes a claim without a full address (gh-2004), so a NULL or blank
 * property_address means intake did not finish. Only then may intake be
 * skipped; otherwise the visitor falls through to trade-selector, whose save
 * UPDATEs the existing claim instead of inserting a second one.
 */
export const CLAIM_INTAKE_COLUMNS = 'id, property_address';

export type ClaimIntakeRow = { id?: unknown; property_address?: unknown } | null | undefined;

export function claimFinishedIntake(claim: ClaimIntakeRow): boolean {
  if (!claim) return false;
  const address = claim.property_address;
  return typeof address === 'string' && address.trim().length > 0;
}

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * gh-3270 (also in scope): true when the email typed on get-started (cs_signup.email)
 * is present and differs from the email the signed-in account carries. Case and
 * surrounding whitespace are ignored. A blank typed email is never a mismatch.
 */
export function signupEmailMismatch(typedEmail: unknown, accountEmail: unknown): boolean {
  const typed = norm(typedEmail);
  const account = norm(accountEmail);
  if (!typed || !account) return false;
  return typed !== account;
}
