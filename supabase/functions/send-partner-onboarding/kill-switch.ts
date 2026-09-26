// gh-2154 P-4 — kill switch. DEFAULTS OFF.
//
// Same convention as send-homeowner-next-steps/welcome-hook.ts's
// isWelcomeEnabled(): a platform_settings row, read as a jsonb value, is
// enabled ONLY for a well-formed "on" shape. A missing row, `null`, a bare
// `true`, `"true"` (string), `1`, an unreadable/errored read, or anything
// else is NOT enabled — fails CLOSED, because the cost of a false positive
// here is a real send to a real partner with placeholder copy.
//
// Ben, DECIDED (bus 14:01:57Z, ruling a — REVIEW FAIL 5833587935): the
// sequence must apply ONLY to partners created on/after the moment the
// switch is turned on — the day-7-blast defect was every partner who ever
// signed up while the switch was off receiving up to four backlog emails
// (day0 through day7) the instant it flipped on. The switch row itself now
// carries that moment, so this file — not a new column/migration — is where
// the fix lives: `platform_settings.value` is already a jsonb column wide
// enough to hold `{"enabled": true, "enabled_since": "<ISO-8601>"}` with NO
// schema change at all (this key has never been written in prod — the
// sequence still ships with the switch OFF — so there is no back-compat
// value to migrate away from). A bare `true` is deliberately no longer
// treated as "on": that literal-boolean shape is exactly what let the
// original defect happen with no record of when sending started, so this
// build removes that shape from the accepted vocabulary rather than
// special-casing it as "on since the beginning of time."

export const PARTNER_ONBOARDING_SETTING_KEY = "partner_onboarding_enabled";

export type OnboardingSwitchState =
  | { enabled: true; enabledSinceMs: number }
  | { enabled: false };

/** Legacy/back-compat parse: true only for the literal boolean `true` — kept
 * exported for anything still checking the raw on/off shape, but no longer
 * used by run-sweep.ts's own guard (see parseOnboardingSwitch below, which
 * additionally requires an enabled_since timestamp before treating the
 * switch as on). */
export function isOnboardingEnabled(settingValue: unknown): boolean {
  return settingValue === true;
}

/**
 * The switch's ONLY accepted "on" shape going forward:
 *   { "enabled": true, "enabled_since": "<ISO-8601 timestamp>" }
 * Anything else — including the old bare `true`, a missing/blank/unparsable
 * enabled_since, null, a string, a number — parses to `{enabled: false}`.
 * Fails closed on every malformed shape, same posture as the rest of this
 * function's guards.
 */
export function parseOnboardingSwitch(settingValue: unknown): OnboardingSwitchState {
  if (
    settingValue !== null &&
    typeof settingValue === "object" &&
    !Array.isArray(settingValue)
  ) {
    const obj = settingValue as Record<string, unknown>;
    if (obj.enabled === true && typeof obj.enabled_since === "string") {
      const ms = Date.parse(obj.enabled_since);
      if (!Number.isNaN(ms)) {
        return { enabled: true, enabledSinceMs: ms };
      }
    }
  }
  return { enabled: false };
}
