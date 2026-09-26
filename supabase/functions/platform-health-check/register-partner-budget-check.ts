/**
 * register-partner-budget-check.ts (gh-2154/gh-2223, PR #2237 REVIEW:FAIL
 * 5850688286, defect D2)
 *
 * The `register_partner_global` rate-limit bucket (see
 * supabase/migrations_drafts/gh2154_register_partner_rate_limit_fix.sql) is
 * the platform-wide abuse backstop for real (non-test) partner signups. The
 * first draft of this fix wrote an alert row to `platform_alerts_log` from
 * a standalone `pg_cron` job, `check_register_partner_global_budget()` --
 * but nothing ever read that table and sent an email or paged anyone. As
 * shipped, an exhausted global ceiling (every real signup refused
 * platform-wide) just sat in a table no one was watching.
 *
 * Fix: this module is pure logic (no Deno.env, no Supabase client, no
 * fetch) so it is unit-testable in isolation, mirroring
 * sms-delivery-check.ts's split (gh-1825) in this same directory.
 * `index.ts`'s Phase 5 queries `rate_limits` for the last-hour and
 * last-day ALLOWED counts on `register_partner_global`
 * (`caller_id IS NULL AND NOT blocked`, matching how
 * `check_register_partner_global_budget()`'s reconciler counted, and how
 * `check_rate_limit()` itself counts) and passes them into
 * `evaluateRegisterPartnerGlobalBudget`, then calls the EXISTING
 * `fireAlert()` (Mailgun + `platform_alerts_log` write + 15-minute dedup)
 * exactly the way Phases 1-4 already do -- there is no new alert-delivery
 * mechanism here, only a new check feeding the one this file already had.
 *
 * Alert types reused, not invented, so `platform_alerts_log` keeps one
 * consistent vocabulary for this bucket:
 *   - 'rate_limit_global_warning'    at >=80% of max_per_day
 *   - 'rate_limit_global_exhausted'  at >=100% of max_per_day OR
 *                                        >=100% of max_per_hour
 * `function_name` is always 'register_partner' (matching the config row's
 * caller-facing name, not '..._global'), matching what the removed SQL
 * reconciler used, so historical `platform_alerts_log` rows for this
 * bucket stay under one name.
 *
 * Severity order when more than one condition is true in the same tick:
 * hourly exhaustion is reported first (it is the most acute -- real
 * signups are being refused RIGHT NOW), then daily exhaustion, then the
 * daily warning. Only ONE alert is returned per tick; `fireAlert()`'s own
 * 15-minute dedup means a sustained outage still re-alerts every 15
 * minutes rather than being silent after the first email.
 */

export interface RegisterPartnerBudgetCounts {
  /** COUNT(*) of allowed register_partner_global rows in the last 1 hour. */
  hourCount: number;
  /** COUNT(*) of allowed register_partner_global rows in the last 1 day (rolling 24h, not a UTC-midnight reset). */
  dayCount: number;
}

export interface RegisterPartnerBudgetLimits {
  maxPerHour: number;
  maxPerDay: number;
}

export interface RegisterPartnerBudgetAlert {
  alertType: "rate_limit_global_warning" | "rate_limit_global_exhausted";
  functionName: "register_partner";
  subject: string;
  message: string;
}

/**
 * Returns the single highest-severity alert to fire for this tick, or
 * `null` if nothing crosses a threshold. Never throws -- a config row with
 * `maxPerHour`/`maxPerDay` <= 0 is treated as "no limit configured" (no
 * alert), matching this repo's general posture of failing an observability
 * check quietly rather than becoming a new source of alert noise.
 */
export function evaluateRegisterPartnerGlobalBudget(
  counts: RegisterPartnerBudgetCounts,
  limits: RegisterPartnerBudgetLimits,
): RegisterPartnerBudgetAlert | null {
  const { hourCount, dayCount } = counts;
  const { maxPerHour, maxPerDay } = limits;

  if (maxPerHour > 0 && hourCount >= maxPerHour) {
    return {
      alertType: "rate_limit_global_exhausted",
      functionName: "register_partner",
      subject: "OtterQuote Health Alert — register_partner_global HOURLY ceiling reached (real signups being refused)",
      message: [
        `register_partner_global ceiling reached: ${hourCount}/${maxPerHour} real partner signups in the last hour.`,
        "Real (non-test) partner signups are being refused platform-wide until this rolls off (rolling 1h window, not a fixed reset).",
        "This is the abuse-protection backstop (register_partner_global), not the normal per-client limit (register_partner).",
      ].join(" "),
    };
  }

  if (maxPerDay > 0 && dayCount >= maxPerDay) {
    return {
      alertType: "rate_limit_global_exhausted",
      functionName: "register_partner",
      subject: "OtterQuote Health Alert — register_partner_global daily ceiling reached (real signups being refused)",
      message: [
        `register_partner_global ceiling reached: ${dayCount}/${maxPerDay} real partner signups in the last 24h.`,
        "Real signups are being refused platform-wide until this rolls off (rolling 24h window, NOT a fixed 00:00 UTC reset).",
        "This is the abuse-protection backstop (register_partner_global), not the normal per-client limit (register_partner).",
      ].join(" "),
    };
  }

  if (maxPerDay > 0 && dayCount >= Math.ceil(maxPerDay * 0.8)) {
    return {
      alertType: "rate_limit_global_warning",
      functionName: "register_partner",
      subject: "OtterQuote Health Alert — register_partner_global at 80% of its daily ceiling",
      message: `register_partner_global at ${dayCount}/${maxPerDay} real partner signups in the last 24h (80% warning threshold, rolling window).`,
    };
  }

  return null;
}
