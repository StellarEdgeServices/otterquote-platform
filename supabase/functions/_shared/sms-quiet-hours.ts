/**
 * gh-3762 (child of gate #3726 item 5): contractor SMS quiet hours, in the RECIPIENT'S local time.
 *
 * Window: 08:00 <= local time < 20:00. 19:59:59 may be texted, 20:00:00 may not; 07:59:59 may not, 08:00:00 may.
 * Ben's ruling on PR #3774 (CEO RUN 152): one universal 20:00 end for everyone, the most protective of the US state windows
 * we know of (Florida FTSA and others), instead of per-state rules. QUIET_HOURS_END_HOUR is the single place to change it.
 *
 * Pure: checkQuietHours(now, recipient) has no I/O and no clock of its own. It answers "allowed" or "refused, and the
 * next instant it would be allowed".
 *
 * Which timezone(s)? A recipient is described by contractors.timezone and contractors.address_state. The timezone column
 * defaults to 'America/New_York' (15 of 16 production rows hold that default), so it is NOT trusted alone. The candidate
 * zones are the column value (if a valid IANA name) PLUS every zone the state touches (split states list all of them),
 * and a send is allowed only when the window is open in EVERY candidate zone: the intersection, the most restrictive
 * answer. With no recognisable state the candidates are every US zone (ALL_US_ZONES), i.e. roughly 13:00/14:00-20:00 Eastern.
 * An unreadable lookup lands on the same fallback. The check never fails open.
 *
 * Owner alerts: the owner's own number (OWNER_ALERT_NUMBER_E164) is exempt, by exact match on that one number. There is no
 * bypass flag and no caller-supplied override.
 */
import { toE164 } from "./sms-pause.ts";

export const QUIET_HOURS_START_HOUR = 8;   // inclusive
export const QUIET_HOURS_END_HOUR = 20;    // exclusive (Ben's ruling on PR #3774: 20:00 for everyone)

/** The owner's own alert line (same literal as DUSTIN_ALERT_PHONE in send-contractor-nudge/index.ts; pinned by test). */
export const OWNER_ALERT_NUMBER_E164 = "+13175019215";

export function isOwnerAlertNumber(raw: string | null | undefined): boolean {
  return toE164(raw) === OWNER_ALERT_NUMBER_E164;
}

export const ALL_US_ZONES: readonly string[] = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Phoenix", "America/Anchorage", "Pacific/Honolulu",
];

const NY = "America/New_York", CHI = "America/Chicago", DEN = "America/Denver", LA = "America/Los_Angeles";

/** State -> every IANA zone any part of the state uses. Split states list all zones so the intersection applies. */
export const STATE_ZONES: Readonly<Record<string, readonly string[]>> = {
  AL: [CHI], AK: ["America/Anchorage", "Pacific/Honolulu"], AZ: ["America/Phoenix", DEN], AR: [CHI], CA: [LA], CO: [DEN],
  CT: [NY], DE: [NY], DC: [NY], FL: [NY, CHI], GA: [NY], HI: ["Pacific/Honolulu"], ID: [DEN, LA], IL: [CHI],
  IN: ["America/Indiana/Indianapolis", CHI], IA: [CHI], KS: [CHI, DEN], KY: [NY, CHI], LA: [CHI], ME: [NY], MD: [NY],
  MA: [NY], MI: [NY, CHI], MN: [CHI], MS: [CHI], MO: [CHI], MT: [DEN], NE: [CHI, DEN], NV: [LA, DEN], NH: [NY],
  NJ: [NY], NM: [DEN], NY: [NY], NC: [NY], ND: [CHI, DEN], OH: [NY], OK: [CHI], OR: [LA, DEN], PA: [NY], RI: [NY],
  SC: [NY], SD: [CHI, DEN], TN: [NY, CHI], TX: [CHI, DEN], UT: [DEN], VT: [NY], VA: [NY], WA: [LA], WV: [NY],
  WI: [CHI], WY: [DEN],
};

export interface QuietHoursRecipient {
  /** contractors.timezone (IANA). Defaults to America/New_York in the schema, so never trusted alone. */
  timezone?: string | null;
  /** contractors.address_state, two letters. */
  state?: string | null;
}

export type ZoneBasis = "timezone_and_state" | "state" | "fallback_all_us";

export interface QuietHoursVerdict {
  allowed: boolean;
  /** The earliest instant at or after `now` at which the window is open in every candidate zone (null when allowed). */
  nextAllowedAt: Date | null;
  zones: string[];
  basis: ZoneBasis;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function isValidZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.trim() === "") return false;
  try { fmt(tz.trim()); return true; } catch { return false; }
}

interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number }
function parts(at: Date, tz: string): Parts {
  const m: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(at)) if (p.type !== "literal") m[p.type] = parseInt(p.value, 10);
  return { y: m.year, mo: m.month, d: m.day, h: m.hour === 24 ? 0 : m.hour, mi: m.minute, s: m.second };
}

/** Offset (ms) of `tz` from UTC at instant `at`. */
function offsetMs(at: Date, tz: string): number {
  const p = parts(at, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of local y-m-d hh:00 in `tz` (the start hour is never inside a US DST gap: transitions are at 02:00). */
function localHourToUtc(y: number, mo: number, d: number, hour: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, hour, 0, 0);
  const t1 = guess - offsetMs(new Date(guess), tz);
  const t2 = guess - offsetMs(new Date(t1), tz);
  return new Date(t2);
}

function openInZone(at: Date, tz: string): boolean {
  const h = parts(at, tz).h;
  return h >= QUIET_HOURS_START_HOUR && h < QUIET_HOURS_END_HOUR;
}

/** The zones to test for a recipient, and why. Unknown state -> every US zone. */
export function candidateZones(r: QuietHoursRecipient): { zones: string[]; basis: ZoneBasis } {
  const st = typeof r.state === "string" ? r.state.trim().toUpperCase() : "";
  const stateZones = STATE_ZONES[st];
  if (!stateZones) return { zones: [...ALL_US_ZONES], basis: "fallback_all_us" };
  const zones = new Set<string>(stateZones);
  const tz = typeof r.timezone === "string" ? r.timezone.trim() : "";
  if (isValidZone(tz)) { zones.add(tz); return { zones: [...zones], basis: "timezone_and_state" }; }
  return { zones: [...zones], basis: "state" };
}

/** Union of the candidate zones for several recipient rows (a number shared by more than one contractor). */
export function candidateZonesForAll(rs: QuietHoursRecipient[]): { zones: string[]; basis: ZoneBasis } {
  if (rs.length === 0) return { zones: [...ALL_US_ZONES], basis: "fallback_all_us" };
  const all = rs.map(candidateZones);
  const zones = new Set<string>();
  for (const a of all) for (const z of a.zones) zones.add(z);
  const basis: ZoneBasis = all.some((a) => a.basis === "fallback_all_us") ? "fallback_all_us"
    : all.every((a) => a.basis === "timezone_and_state") ? "timezone_and_state" : "state";
  return { zones: [...zones], basis };
}

export function checkQuietHoursInZones(now: Date, zones: string[], basis: ZoneBasis): QuietHoursVerdict {
  if (zones.every((z) => openInZone(now, z))) return { allowed: true, nextAllowedAt: null, zones, basis };
  // Next opening: some zone's 08:00 (local, today/tomorrow/day after) at which every zone is open.
  const cands: Date[] = [];
  for (const z of zones) {
    for (let k = -1; k <= 2; k++) {
      const p = parts(new Date(now.getTime() + k * 86_400_000), z);
      const t = localHourToUtc(p.y, p.mo, p.d, QUIET_HOURS_START_HOUR, z);
      if (t.getTime() > now.getTime()) cands.push(t);
    }
  }
  cands.sort((a, b) => a.getTime() - b.getTime());
  const next = cands.find((t) => zones.every((z) => openInZone(t, z))) ?? null;
  return { allowed: false, nextAllowedAt: next, zones, basis };
}

export function checkQuietHours(now: Date, recipient: QuietHoursRecipient): QuietHoursVerdict {
  const { zones, basis } = candidateZones(recipient);
  return checkQuietHoursInZones(now, zones, basis);
}

// ---------------------------------------------------------------------------------------------------------------------
// send-sms: resolve the recipient by phone number, then refuse outside the window.
// ---------------------------------------------------------------------------------------------------------------------

/** The slice of the supabase-js client this needs (structural, so tests can fake it). */
// deno-lint-ignore no-explicit-any
export interface QuietHoursClient { from(table: string): any }

/** Last four digits only, for logs. */
function l4(raw: string | null | undefined): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : "????";
}

/**
 * Recipient rows for a phone: contractor_sms_numbers (any status) -> contractors. Any problem (no E.164, no row, error,
 * throw) returns [] and the caller uses the all-US fallback window. Never throws.
 */
export async function lookupRecipientZones(sb: QuietHoursClient, rawTo: string | null | undefined): Promise<QuietHoursRecipient[]> {
  const phone = toE164(rawTo);
  if (!phone) return [];
  try {
    const nums = await sb.from("contractor_sms_numbers").select("contractor_id").eq("phone_e164", phone) as
      { data: Array<{ contractor_id: string | null }> | null; error: unknown };
    if (nums.error || !nums.data || nums.data.length === 0) return [];
    const ids = [...new Set(nums.data.map((r) => r.contractor_id).filter((x): x is string => !!x))];
    if (ids.length === 0) return [];
    const cs = await sb.from("contractors").select("timezone, address_state").in("id", ids) as
      { data: Array<{ timezone: string | null; address_state: string | null }> | null; error: unknown };
    if (cs.error || !cs.data) return [];
    return cs.data.map((c) => ({ timezone: c.timezone, state: c.address_state }));
  } catch {
    return [];
  }
}

/**
 * The refusal Response for send-sms, or null when the send may proceed. Owner alerts (exact owner number) return null
 * without any lookup. The refusal is HTTP 403 {error:"outside_quiet_hours", next_allowed_at, window, basis}; the caller
 * must return it without touching Twilio. Logs the last 4 digits only.
 */
export async function quietHoursRefusal(
  sb: QuietHoursClient,
  rawTo: string | null | undefined,
  corsHeaders: Record<string, string>,
  fn: string,
  now: Date = new Date(),
  log: (line: string) => void = console.warn,
): Promise<Response | null> {
  if (isOwnerAlertNumber(rawTo)) return null;
  const { zones, basis } = candidateZonesForAll(await lookupRecipientZones(sb, rawTo));
  const v = checkQuietHoursInZones(now, zones, basis);
  if (v.allowed) return null;
  const next = v.nextAllowedAt ? v.nextAllowedAt.toISOString() : null;
  log(`[${fn}] SMS refused: outside_quiet_hours (basis=${basis}), to_last4=${l4(rawTo)}, next_allowed_at=${next}. No Twilio call attempted.`);
  return new Response(
    JSON.stringify({
      error: "outside_quiet_hours",
      next_allowed_at: next,
      window: { start_hour: QUIET_HOURS_START_HOUR, end_hour: QUIET_HOURS_END_HOUR },
      basis,
    }),
    { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}
