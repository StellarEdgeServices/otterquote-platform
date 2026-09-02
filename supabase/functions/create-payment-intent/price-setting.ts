// create-payment-intent/price-setting.ts
//
// gh-1537 (audit: every `?? <literal>` / `|| <literal>` fallback on a
// platform_settings price/fee read): this function's hover_measurement_price
// read had a hardcoded fallback of 7900 cents ($79) — a THIRD stale price
// point, older than both D-205's $150 and D-291's $15. The live value at
// audit time (2026-09-02) was 1500 cents ($15): the fallback was 5.27x the
// real price, one deleted platform_settings row away from silently charging
// every Hover-measurement buyer $79 instead of $15.
//
// resolveRequiredPriceCents replaces the fallback with a fail-closed throw.
// Pure and Supabase-client-free (row/error passed in) so it is unit-testable
// with plain object literals — no live client, no network listener. Same
// source-split pattern as docusign-webhook/price-verify.ts and the various
// w9-gate.ts modules in this repo.

/** Thrown when a required platform_settings numeric setting cannot be trusted. */
export class PlatformSettingMissingError extends Error {
  readonly settingKey: string;
  constructor(settingKey: string, detail?: string) {
    super(`platform_setting_missing: ${settingKey}${detail ? ` — ${detail}` : ""}`);
    this.name = "PlatformSettingMissingError";
    this.settingKey = settingKey;
  }
}

/** Shape of a single platform_settings row fetch (`.select("value").eq("key", ...).maybeSingle()`). */
export interface PlatformSettingRow {
  value: unknown;
}

/**
 * Resolve a positive-integer-cents platform_settings value. Throws
 * PlatformSettingMissingError — never substitutes a hardcoded guess — when:
 *   - the read itself errored,
 *   - the row is absent (deleted, never seeded),
 *   - the value is null/undefined, or
 *   - the value does not parse to a positive integer.
 *
 * Callers must catch this and fail the request closed (500, no PaymentIntent
 * created) — this function intentionally has no fallback branch to remove
 * that discipline.
 */
export function resolveRequiredPriceCents(
  settingKey: string,
  row: PlatformSettingRow | null | undefined,
  readError: { message?: string } | null | undefined,
): number {
  if (readError) {
    throw new PlatformSettingMissingError(settingKey, readError.message);
  }
  if (row == null || row.value === null || row.value === undefined) {
    throw new PlatformSettingMissingError(settingKey, "no row");
  }
  const resolved = typeof row.value === "number" ? row.value : Number(row.value);
  if (!Number.isFinite(resolved) || resolved <= 0 || !Number.isInteger(resolved)) {
    throw new PlatformSettingMissingError(settingKey, `value is not a valid positive integer (cents): ${JSON.stringify(row.value)}`);
  }
  return resolved;
}
