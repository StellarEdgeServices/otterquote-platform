/**
 * D-391 / #2875 (closes-on amended 2026-10-27, comment 6446506739): contractor SMS release gate.
 *
 * 10DLC campaign CDUT25F is registered homeowner-only at TCR. Until its `message_flow` is updated to describe the
 * contractor verify screen, NO real (non-test) contractor may be texted, even one who verified a number. This gate
 * sits at every contractor-recipient send path (notify-contractors, process-dunning) beside the sms_opt_in gate:
 *
 *   - contractor.is_test === true                       -> allowed (test traffic only reaches test contractors).
 *   - otherwise, CONTRACTOR_SMS_TCR_RELEASED === "true" -> allowed (the release switch Marty/Ben flip after the
 *                                                          TCR message_flow read-back is pasted on #2875).
 *   - otherwise (non-test, is_test null/undefined/unreadable, switch unset or anything but "true") -> REFUSED.
 *
 * Fail closed: an undeterminable is_test is a refusal. The switch is an environment variable, not a database row, so
 * flipping it needs no migration; the default is gated. Homeowner sends never call this.
 *
 * Every refusal is logged as one structured console line naming the contractor id, the reason, the call site and the
 * last 4 digits of each number (never the full number).
 */

export type ContractorSmsRefusalReason = "tcr_not_released" | "unverified_number";

export type ContractorSmsVerdict =
  | { allowed: true; via: "is_test" | "tcr_released" }
  | { allowed: false; reason: "tcr_not_released" };

export interface ContractorSmsRecipient {
  id?: string | null;
  is_test?: boolean | null;
}

export interface ContractorSmsGateOptions {
  /** Call-site label for the log line, e.g. "notify-contractors/new_opportunity". */
  site: string;
  /** Number(s) being refused, for the masked log only. */
  phones?: Array<string | null | undefined>;
  /** Defaults to Deno.env.get; injectable for tests. */
  getEnv?: (name: string) => string | undefined;
  /** Defaults to console.warn; injectable for tests. */
  log?: (line: string) => void;
}

export const TCR_RELEASE_ENV = "CONTRACTOR_SMS_TCR_RELEASED";

/** "+13175551234" -> "***1234". Anything with fewer than 4 digits -> "***". */
export function maskPhoneLast4(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

/** Emit the structured refusal line. Exported so the verified-list layer can log `unverified_number` the same way. */
export function logContractorSmsRefusal(
  reason: ContractorSmsRefusalReason,
  contractorId: string | null | undefined,
  opts: Pick<ContractorSmsGateOptions, "site" | "phones" | "log">,
): void {
  const line = JSON.stringify({
    event: "contractor_sms_refused",
    reason,
    contractor_id: contractorId ?? null,
    site: opts.site,
    phones: (opts.phones ?? []).map(maskPhoneLast4),
  });
  (opts.log ?? ((l: string) => console.warn(l)))(`[contractor-sms-release] ${line}`);
}

export function contractorSmsReleaseGate(
  contractor: ContractorSmsRecipient | null | undefined,
  opts: ContractorSmsGateOptions,
): ContractorSmsVerdict {
  if (contractor?.is_test === true) return { allowed: true, via: "is_test" };
  const getEnv = opts.getEnv ?? ((n: string) => Deno.env.get(n));
  let released = false;
  try {
    released = getEnv(TCR_RELEASE_ENV) === "true";
  } catch {
    released = false; // env unreadable -> fail closed
  }
  if (released) return { allowed: true, via: "tcr_released" };
  logContractorSmsRefusal("tcr_not_released", contractor?.id, opts);
  return { allowed: false, reason: "tcr_not_released" };
}
