/**
 * The one switch for the homeowner measurement charge on /help-measurements (P23, gh-3858; the same flag is read by
 * gh-3859 and gh-3860).
 *
 * NEXT_PUBLIC_MEASUREMENT_CHARGE_ENABLED is ON only when its value is exactly the string 'true'. Unset, empty, 'TRUE',
 * '1', ' true' or anything else is OFF. It is set nowhere in the repo (no .env, no netlify.toml): only Dustin switches
 * it on, in the host's environment. With it OFF the page is what it was before the flag existed (the paused notice).
 *
 * Same shape as isHomeownerLaunchEnabled (app/refer/utils.ts): a pure function of the env value, so it is unit-testable,
 * plus a reader that names `process.env.NEXT_PUBLIC_...` literally, which Next needs in order to inline the value at build.
 */
export function isMeasurementChargeEnabled(envValue: string | undefined): boolean {
  return envValue === 'true';
}

/** Reads the flag. Call it at render time, not at module load, so a test can set the variable per case. */
export function measurementChargeEnabled(): boolean {
  return isMeasurementChargeEnabled(process.env.NEXT_PUBLIC_MEASUREMENT_CHARGE_ENABLED);
}
