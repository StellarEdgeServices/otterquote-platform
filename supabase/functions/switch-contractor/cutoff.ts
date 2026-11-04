// gh-3092: the 3-day "no switching before install" lock reads the contractor's start date from the
// winning quote's scope_summary (quotes has no estimated_start_date column and neither does claims).
// Same defensive parse as create-docusign-envelope/index.ts (~2178-2193): scope_summary is a JSON
// string or an already-parsed object.

/** Days before installation at which switching is no longer allowed. */
export const SWITCH_CUTOFF_DAYS = 3;

/** Start date from a quote's scope_summary, or null when absent/unparseable. Never throws. */
export function deriveEstimatedStartDate(
  quote: { scope_summary?: unknown } | null | undefined,
): string | null {
  const raw = quote?.scope_summary;
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const d = (parsed as { estimated_start_date?: unknown } | null)?.estimated_start_date;
    return typeof d === "string" && d.trim() ? d : null;
  } catch {
    return null;
  }
}

/**
 * Time zone that defines "today" for the cutoff. The start date is a calendar date with no time of day, so the rule is a
 * calendar-day rule, and a calendar day needs a zone. One fixed zone is used so the Edge Function (UTC), the dashboard
 * (browser) and the legacy dashboard all give the same answer for the same instant; a homeowner's own zone is not on the claim.
 * America/Chicago is the westernmost of the two zones most claims are in, so no Eastern or Central homeowner is blocked early.
 */
export const SWITCH_CUTOFF_TIMEZONE = "America/Chicago";

/** Calendar day (as UTC midnight ms) that `instant` falls on in SWITCH_CUTOFF_TIMEZONE. */
function zonedDayMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SWITCH_CUTOFF_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"));
}

/**
 * True if switching is closed: the start date is fewer than SWITCH_CUTOFF_DAYS calendar days after today (SWITCH_CUTOFF_TIMEZONE),
 * or already past. gh-3350: day three itself is OPEN. With start date S, a switch is allowed through the end of day S-3 (23:59:59
 * Central) and closed from 00:00 Central on S-2, at any time of day. Before gh-3350 this compared the start date (UTC midnight)
 * with now + 3 x 24h, which closed day three from midnight UTC onward and moved the boundary with the time of day.
 * Absent/unparseable date -> false (allow switch). Mirrored in react-app/app/(homeowner)/dashboard/utils.ts and dashboard.html.
 */
export function isWithinCutoff(estimatedStartDate: string | null | undefined, now: Date = new Date()): boolean {
  if (!estimatedStartDate) return false; // no date set → always allow switch
  const raw = estimatedStartDate.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  let installDayMs: number;
  if (dateOnly) {
    installDayMs = Date.UTC(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3]);
    const chk = new Date(installDayMs);
    if (chk.getUTCFullYear() !== +dateOnly[1] || chk.getUTCMonth() !== +dateOnly[2] - 1 || chk.getUTCDate() !== +dateOnly[3]) return false;
  } else {
    const instant = new Date(raw); // a full timestamp or other parseable string: its calendar day in the cutoff zone
    if (Number.isNaN(instant.getTime())) return false;
    installDayMs = zonedDayMs(instant);
  }
  const daysUntilStart = Math.round((installDayMs - zonedDayMs(now)) / 86_400_000);
  return daysUntilStart < SWITCH_CUTOFF_DAYS;
}
