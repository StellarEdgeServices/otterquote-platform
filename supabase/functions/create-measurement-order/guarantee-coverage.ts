/**
 * [gh-3471, P23 / #3427 D6] The covered-state check, recorded on the order next to the 100-hour clock. It RECORDS coverage; it never blocks, changes or delays a payment.
 *
 * THE RULE (Dustin, #3427 comment 6742481999, D6 = 0): coverage is decided by state. A home is covered unless its state is on an excluded list. Which states are
 * excluded is Dustin's call (Ben's legal review proposes it). This code reads the list from configuration so the list can land after the code, the same day, with no deploy.
 *
 * WHERE THE LIST LIVES. platform_settings, key `guarantee_excluded_states`, value a JSON array of two-letter codes, e.g. ["NY","CA"]. This follows the repo's
 * precedent for a state list (gh-2421 / D-344 `homeowner_blocked_states`, read directly by notify-admin-new-homeowner with the service role). platform_settings
 * has RLS on and only a key allow-list SELECT policy for authenticated (this key is not on it), so only the service role and SQL can read or write the list.
 * The schema migration inserts NO row. Dustin named the list on 2026-11-09 (FL, LA, TX, OK, AR, KS, NE, MI, KY; #3471 comment 6744041238); it is inserted by the
 * SEPARATE data file supabase/migrations_drafts/gh3471_guarantee_excluded_states_seed.sql, never by this code. Until that seed is applied every order records NULL.
 *
 * WHAT IS RECORDED (hover_orders.guarantee_covered, only on an order that got a clock; see decideGuaranteeCoverage):
 *   true   the claim's state is a valid two-letter code and is NOT on a configured list (an explicit [] means "nothing excluded")
 *   false  the claim's state IS on the configured list
 *   NULL   unknown. Never guessed. Reasons: the list is not configured yet (no row); the list is malformed; the list read failed; the claim read failed;
 *          the claim has no usable property_state (missing, blank, or not a two-letter code such as "Indiana").
 * Every NULL except "not configured yet" raises one platform_alerts_log row (alert_type guarantee_coverage_unknown) so an admin decides by hand.
 * "Not configured yet" is logged only: until Dustin's list lands EVERY order would alert, which is noise, not signal.
 *
 * WHY NULL AND NOT true/false WHEN UNSURE. true on a guess would promise a guarantee in a state Dustin may exclude; false on a guess would deny one he may owe.
 * Neither is ours to pick (Tier C, legal/money). NULL is honest and a later query can fill it once a human decides.
 *
 * FAIL-SAFE DIRECTION ON A BAD LIST. Unlike the homeowner gate (which falls back to FL/LA/TX), there is no safe default list here: any fallback would decide
 * coverage. A malformed value (not an array, or ANY element that is not a two-letter code) makes the whole list unusable -> NULL + alert. Dropping only the
 * bad element would silently COVER a state on a typo (["NY","Calif"] must not cover CA).
 */

export const EXCLUDED_STATES_SETTING_KEY = "guarantee_excluded_states";
export const GUARANTEE_COVERAGE_ALERT_TYPE = "guarantee_coverage_unknown";

export type ExcludedStatesList =
  | { kind: "configured"; states: string[] }
  | { kind: "unconfigured" }
  | { kind: "malformed" };

const TWO_LETTER_CODE = /^[A-Z]{2}$/;

/**
 * Parse the platform_settings row (or null when there is no row). Element rule = the homeowner list's rule (notify-helpers parseBlockedStates and the SQL
 * `upper(btrim(e)) ~ '^[A-Z]{2}$'`): strip SPACES only, upper-case, two letters A-Z. Not an array, or any bad element -> malformed. [] -> configured, nothing excluded.
 */
export function parseExcludedStates(row: { value?: unknown } | null | undefined): ExcludedStatesList {
  if (row === null || row === undefined) return { kind: "unconfigured" };
  const value = row.value;
  if (!Array.isArray(value)) return { kind: "malformed" };
  const codes: string[] = [];
  for (const e of value) {
    if (typeof e !== "string") return { kind: "malformed" };
    const code = e.replace(/^ +| +$/g, "").toUpperCase();
    if (!TWO_LETTER_CODE.test(code)) return { kind: "malformed" };
    codes.push(code);
  }
  return { kind: "configured", states: [...new Set(codes)].sort() };
}

/**
 * claims.property_state as a two-letter code, or null. Same normalisation the repo uses for this column (normalizeState: trim, upper; gh-3321 and D-344 read it
 * as upper(btrim())). A value that is not two letters A-Z after that (e.g. "Indiana", "") is unknown, not "not excluded": guessing would decide coverage.
 */
export function normalizePropertyState(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return TWO_LETTER_CODE.test(s) ? s : null;
}

export type CoverageReason =
  | "covered"
  | "excluded_state"
  | "list_not_configured"
  | "list_malformed"
  | "list_read_failed"
  | "claim_read_failed"
  | "no_property_state";

export interface CoverageDecision {
  covered: boolean | null;
  reason: CoverageReason;
  /** the normalised state, when there was one */
  state: string | null;
}

export interface CoverageDeps {
  /** false when the claim row could not be read (the read threw / returned an error); the state is then unknown */
  claimReadOk: boolean;
  propertyState: unknown;
  /** reads platform_settings WHERE key = EXCLUDED_STATES_SETTING_KEY; resolves to the row or null; throws on a read error */
  readExcludedSetting: () => Promise<{ value?: unknown } | null>;
  log: (m: string) => void;
}

/**
 * Decide coverage for one order that has a clock. Never throws. The LIST is checked first: while it is unset nothing can be decided for any order, so that case
 * is one quiet reason (no alert) whatever the claim holds. Only with a usable list do the claim read and the state matter.
 */
export async function decideGuaranteeCoverage(deps: CoverageDeps): Promise<CoverageDecision> {
  try {
    let row: { value?: unknown } | null;
    try {
      row = await deps.readExcludedSetting();
    } catch {
      deps.log("[create-measurement-order] guarantee coverage: excluded-state list read failed (coverage recorded as unknown)");
      return { covered: null, reason: "list_read_failed", state: null };
    }
    const list = parseExcludedStates(row);
    if (list.kind === "unconfigured") {
      deps.log("[create-measurement-order] guarantee coverage: excluded-state list not configured yet (platform_settings guarantee_excluded_states); coverage recorded as unknown");
      return { covered: null, reason: "list_not_configured", state: null };
    }
    if (list.kind === "malformed") {
      deps.log("[create-measurement-order] guarantee coverage: excluded-state list is malformed (coverage recorded as unknown)");
      return { covered: null, reason: "list_malformed", state: null };
    }
    if (!deps.claimReadOk) return { covered: null, reason: "claim_read_failed", state: null };
    const state = normalizePropertyState(deps.propertyState);
    if (!state) return { covered: null, reason: "no_property_state", state: null };
    return list.states.includes(state)
      ? { covered: false, reason: "excluded_state", state }
      : { covered: true, reason: "covered", state };
  } catch {
    try { deps.log("[create-measurement-order] guarantee coverage: unexpected error (coverage recorded as unknown)"); } catch { /* never throw */ }
    return { covered: null, reason: "list_read_failed", state: null };
  }
}

/** True when this decision is worth an operator alert: every unknown except "the list is not set yet". */
export function coverageNeedsAlert(d: CoverageDecision): boolean {
  return d.covered === null && d.reason !== "list_not_configured";
}

export interface CoverageAlertRow {
  alert_type: typeof GUARANTEE_COVERAGE_ALERT_TYPE;
  function_name: "create-measurement-order";
  message: string;
  sent_at: string;
}

const WHY: Record<Exclude<CoverageReason, "covered" | "excluded_state" | "list_not_configured"> | "column_missing", string> = {
  list_malformed: "the excluded-state list (platform_settings guarantee_excluded_states) is not a JSON array of two-letter codes",
  list_read_failed: "the excluded-state list could not be read",
  claim_read_failed: "the claim could not be read",
  no_property_state: "the claim has no usable two-letter property_state",
  column_missing: "the order insert was rejected for a missing column, so guarantee_covered was not stored (the gh3471 coverage migration is likely not applied)",
};

/** Validated shapes only (ids cut to a UUID / pi_ pattern). Says what is unknown; promises nothing. */
export function buildCoverageAlertRow(
  ctx: { reason: keyof typeof WHY; orderId: string | null; paymentIntentId: string | null; claimId: string | null },
  now: () => Date = () => new Date(),
): CoverageAlertRow {
  const pi = ctx.paymentIntentId && /^pi_[A-Za-z0-9_]{1,80}$/.test(ctx.paymentIntentId) ? ctx.paymentIntentId : "unrecognized";
  const claim = ctx.claimId && /^[0-9a-f-]{36}$/i.test(ctx.claimId) ? ctx.claimId : "unrecognized";
  const order = ctx.orderId && /^[0-9a-f-]{36}$/i.test(ctx.orderId) ? ctx.orderId : "none";
  return {
    alert_type: GUARANTEE_COVERAGE_ALERT_TYPE,
    function_name: "create-measurement-order",
    message:
      `Paid measurement order recorded with guarantee coverage UNKNOWN (gh-3471): order ${order}, payment_intent ${pi}, claim ${claim}, because ${WHY[ctx.reason]}. ` +
      `The order and its clock stand. An admin decides coverage by hand and sets hover_orders.guarantee_covered.`,
    sent_at: now().toISOString(),
  };
}

/** Never throws; a failed alert is logged with fixed text. */
export async function raiseCoverageAlert(
  insertAlert: (row: CoverageAlertRow) => PromiseLike<{ error?: unknown } | null | void>,
  log: (m: string) => void,
  row: CoverageAlertRow,
): Promise<void> {
  try {
    const res = await insertAlert(row);
    if (res && (res as { error?: unknown }).error) log("[create-measurement-order] guarantee-coverage alert row insert failed");
  } catch {
    try { log("[create-measurement-order] guarantee-coverage alert row insert failed"); } catch { /* never throw */ }
  }
}
