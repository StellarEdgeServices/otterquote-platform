// create-hover-order/price-setting.ts
//
// gh-1537 (audit: every `?? <literal>` / `|| <literal>` fallback on a
// platform_settings price/fee read): this function's hover_measurement_price
// read (in verifyHoverPayment, the D-181 payment guard) had a hardcoded
// fallback of 1500 cents ($15) — which happens to equal the live value at
// audit time (2026-09-02), but is the same guess-on-missing-row pattern that
// left create-payment-intent's parallel read at a stale $79 default for two
// repricings (D-205, D-291). A verification guard that can be satisfied by a
// guessed expected amount is not a guard.
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
 * Callers must catch this and fail the request closed (never contact Hover
 * or treat a payment as verified against a guessed expected amount).
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
