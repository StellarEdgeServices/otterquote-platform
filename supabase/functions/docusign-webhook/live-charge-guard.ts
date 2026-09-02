/**
 * [#1467, 2026-09-02] Live-charge authorization guard for the platform-fee path.
 *
 * WHY THIS EXISTS. On 2026-08-31 a signature ceremony on a claim with
 * `is_test = true` charged a real card $180.54 in LIVE mode, five seconds after
 * the ceremony completed. `is_test` was read by `docusign-webhook` and used only
 * to tag `activity_log` rows — it was a reporting flag, never a money-path guard.
 *
 * WHY THE OBVIOUS FIX IS WRONG. The first version of this guard refused every
 * live charge on a test claim. Dustin's ruling on #1467 (verbatim: "That charge
 * was a test and expected." / "Keep it") showed why that is worse than the
 * defect: a blanket refusal permanently destroys the only way anyone can prove
 * the fee path works before a real customer uses it, and destroys it SILENTLY —
 * the verification looks like it succeeded while no money moved. The original
 * defect charged money nobody intended; a blanket refusal would fake a charge
 * nobody noticed was missing.
 *
 * SO THE PREDICATE IS NOT "is this claim a test?" It is "did a human
 * deliberately authorise a live charge on this row?" Those are different
 * questions and, before this module, the code answered neither. The marker
 * (`claims.live_charge_authorized_at`, set out of band by a human) is the record
 * of intent — and it is also what makes a deliberate live test legible as
 * deliberate. Reading the database, the Stripe API, the code and every issue on
 * 2026-09-01, there was no way to tell a deliberate live test from a defect.
 * That indistinguishability was the real finding on #1467.
 *
 * FAIL CLOSED. An unreadable or absent claim row REFUSES. The asymmetry is the
 * reason: a refused real charge routes into the existing dunning path and is
 * recoverable; an unintended real charge on someone's card is not. Every branch
 * is loud — a silent skip is how a verification path dies unnoticed.
 *
 * Kept pure and separate for the same reason `price-verify.ts` and
 * `ack-verify.ts` are: this is a money check, and a money check should be
 * unit-testable without a network. See live-charge-guard.test.ts.
 *
 * ⚠ THIS FILE IS COPIED BYTE-IDENTICAL into create-payment-intent/ and
 * process-dunning/. The Supabase deploy pipeline does not resolve `_shared/`
 * imports (see notify-partner-w9/index.ts:69), so a shared module is not
 * available to these functions. `tools/live_charge_guard_parity_check.py`
 * asserts the copies are identical. Edit the docusign-webhook copy and re-run
 * that script; never edit one copy alone.
 */

/** The column that records deliberate human authorization of a live charge. */
export const AUTHORIZATION_COLUMN = "live_charge_authorized_at";

/** Select list every caller needs to evaluate this guard. */
export const GUARD_SELECT = "id, is_test, live_charge_authorized_at";

/** Machine-readable refusal code. Distinct from every existing error in the
 *  platform-fee path (400 invalid-amount, 401 unauthorized, 403 forbidden,
 *  429 rate-limited, 503 upstream) so a refusal is never mistaken for one. */
export const REFUSAL_CODE = "TEST_CLAIM_CHARGE_REFUSED";

export interface GuardClaimRow {
  id?: string | null;
  is_test?: boolean | null;
  live_charge_authorized_at?: string | null;
}

export type ChargeGuardVerdict =
  | { allow: true; reason: "not_test" }
  | { allow: true; reason: "authorized"; authorizedAt: string }
  | { allow: false; reason: "test_claim_unauthorized" }
  | { allow: false; reason: "claim_unreadable" };

/**
 * Decide whether a LIVE-mode platform-fee charge may proceed for this claim.
 *
 * - real claim (is_test false/null)      -> allow. The real path is untouched.
 * - test claim WITH the marker set       -> allow. This is Dustin's deliberate
 *                                          fee-path verification (#524, #1467).
 * - test claim WITHOUT the marker        -> refuse. This is the 2026-08-31 case.
 * - claim row missing or unreadable      -> refuse. Fail closed on money.
 *
 * `is_test` is NOT NULL in the live schema, so `null` here means "we did not
 * read a row", not "false". Treating a missing row as a real claim would
 * reintroduce the defect through the one door a lookup failure opens.
 */
export function evaluateLiveChargeGuard(
  claim: GuardClaimRow | null | undefined,
): ChargeGuardVerdict {
  if (claim === null || claim === undefined) {
    return { allow: false, reason: "claim_unreadable" };
  }
  if (claim.is_test === null || claim.is_test === undefined) {
    return { allow: false, reason: "claim_unreadable" };
  }
  if (claim.is_test !== true) {
    return { allow: true, reason: "not_test" };
  }
  const marker = claim.live_charge_authorized_at;
  if (typeof marker === "string" && marker.trim() !== "") {
    return { allow: true, reason: "authorized", authorizedAt: marker };
  }
  return { allow: false, reason: "test_claim_unauthorized" };
}

/**
 * One-line human-readable account of a verdict, for `platform_alerts_log` and
 * `activity_log`. Always names the amount that was NOT taken — a refusal that
 * does not say what it cost is indistinguishable from a charge that never had
 * a reason to happen.
 */
export function describeGuardVerdict(
  verdict: ChargeGuardVerdict,
  claimId: string | null | undefined,
  amountCents: number | null | undefined,
): string {
  const amount = typeof amountCents === "number" && Number.isFinite(amountCents)
    ? `${amountCents} cents`
    : "an undetermined amount";
  const id = claimId ?? "unknown-claim";
  switch (verdict.reason) {
    case "not_test":
      return `Claim ${id}: live platform-fee charge permitted (claim is not a test row).`;
    case "authorized":
      return `Claim ${id}: live platform-fee charge permitted on a TEST row — ` +
        `${AUTHORIZATION_COLUMN} = ${verdict.authorizedAt} (deliberate human authorization, #1467).`;
    case "test_claim_unauthorized":
      return `Claim ${id}: live platform-fee charge REFUSED — claim is a test row and ` +
        `${AUTHORIZATION_COLUMN} is not set. Amount NOT taken: ${amount}. (#1467)`;
    case "claim_unreadable":
      return `Claim ${id}: live platform-fee charge REFUSED — the claim row could not be read, ` +
        `so its test status is unknown and this guard fails closed. Amount NOT taken: ${amount}. (#1467)`;
  }
}
