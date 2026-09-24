// gh-2154 P-4 — kill switch. DEFAULTS OFF.
//
// Same convention as send-homeowner-next-steps/welcome-hook.ts's
// isWelcomeEnabled(): a platform_settings row, read as a jsonb value, is
// enabled ONLY for the literal boolean `true`. A missing row, `null`,
// `"true"` (string), `1`, an unreadable/errored read, or anything else is
// NOT enabled — fails CLOSED, because the cost of a false positive here is
// a real send to a real partner with placeholder copy.

export const PARTNER_ONBOARDING_SETTING_KEY = "partner_onboarding_enabled";

export function isOnboardingEnabled(settingValue: unknown): boolean {
  return settingValue === true;
}
