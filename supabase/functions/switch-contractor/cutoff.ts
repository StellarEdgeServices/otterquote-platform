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

/** True if the installation date is within the cutoff window. Absent/unparseable date → false (allow switch). */
export function isWithinCutoff(estimatedStartDate: string | null | undefined, now: Date = new Date()): boolean {
  if (!estimatedStartDate) return false; // no date set → always allow switch
  const installDate = new Date(estimatedStartDate);
  if (Number.isNaN(installDate.getTime())) return false;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() + SWITCH_CUTOFF_DAYS);
  return installDate <= cutoff;
}
