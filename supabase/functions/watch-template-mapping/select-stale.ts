/**
 * select-stale.ts — pure selection + dedup logic for watch-template-mapping
 * (gh-1313 closes-on (a)).
 *
 * Framework-free, side-effect-free. All network / supabase calls live in
 * index.ts — never here. Same split as send-homeowner-next-steps/select-stage.ts,
 * for the same reason: the decision table is what needs unit tests, and the
 * EF body-deploy path does not resolve `_shared/` imports, so this file sits
 * beside index.ts and is imported relatively.
 *
 * Vocabulary (contractor_templates.status, sql/v63-d199-contractor-templates.sql):
 *   pending_validation         — row inserted by the upload UI; validate-contract-
 *                                template has not yet written a result. A row that
 *                                stays here was uploaded and never validated
 *                                (the EF call failed, or was never made).
 *   manual_mapping_pending     — validate-contract-template ran and found
 *                                allRequiredFound === false (index.ts:666). The
 *                                D-199 Tier 2 step — the contractor supplying
 *                                manualOverrides — or the Tier 3 admin path is
 *                                needed before this contractor can bid.
 *   submitted_for_admin_review — D-199 Tier 3: waiting on the admin (Dustin)
 *                                in admin-template-review.html.
 * All three are "somebody must act and nobody is being told". Anything else
 * (auto_validated, manual_validated, admin_validated, rejected) is terminal
 * for the purposes of this watcher.
 *
 * "Age" is measured from updated_at (falling back to created_at): the
 * trg_contractor_templates_updated_at trigger bumps updated_at on every
 * status change, so updated_at is "when the row entered its current state"
 * for every transition validate-contract-template makes.
 */

export const WATCHED_STATUSES = [
  "manual_mapping_pending",
  "pending_validation",
  "submitted_for_admin_review",
] as const;

export type WatchedStatus = (typeof WATCHED_STATUSES)[number];

/** Rows older than this (hours) in a watched status are reported. */
export const DEFAULT_THRESHOLD_HOURS = 24;

/** One platform_alerts_log row per template per rolling 24h window. */
export const ALERT_DEDUP_MS = 24 * 60 * 60 * 1000;

/** alert_type written to platform_alerts_log (one type, status carried in the message). */
export const ALERT_TYPE = "template_stuck";

export interface TemplateRowInput {
  id: string;
  status: string;
  trade: string;
  funding_type: string;
  created_at: string;
  updated_at?: string | null;
  contractor_id?: string | null;
  /** joined contractors row — optional, display only */
  contractors?: {
    company_name?: string | null;
    email?: string | null;
    is_test?: boolean | null;
  } | null;
}

export interface StaleTemplate {
  template_id: string;
  status: WatchedStatus;
  trade: string;
  funding_type: string;
  contractor_id: string | null;
  company_name: string | null;
  is_test: boolean | null;
  since: string;
  age_hours: number;
}

export interface PriorAlert {
  message: string;
  sent_at: string;
}

export function isWatchedStatus(status: string | null | undefined): status is WatchedStatus {
  return !!status && (WATCHED_STATUSES as readonly string[]).includes(status);
}

/** The stable token every alert message for a template starts with — the dedup key. */
export function alertKey(templateId: string): string {
  return `template=${templateId}`;
}

export function ageHours(row: Pick<TemplateRowInput, "created_at" | "updated_at">, nowMs: number): number {
  const since = row.updated_at || row.created_at;
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return 0;
  return Math.max(0, (nowMs - sinceMs) / (60 * 60 * 1000));
}

/**
 * Select the rows that have sat in a watched status for at least
 * `thresholdHours`. Oldest first. Rows in any other status, or younger than
 * the threshold, or with an unparseable timestamp, are dropped.
 */
export function selectStale(
  rows: readonly TemplateRowInput[],
  nowMs: number,
  thresholdHours: number = DEFAULT_THRESHOLD_HOURS,
): StaleTemplate[] {
  const out: StaleTemplate[] = [];
  for (const row of rows) {
    if (!isWatchedStatus(row.status)) continue;
    const since = row.updated_at || row.created_at;
    if (Number.isNaN(Date.parse(since))) continue;
    const age = ageHours(row, nowMs);
    if (age < thresholdHours) continue;
    out.push({
      template_id: row.id,
      status: row.status,
      trade: row.trade,
      funding_type: row.funding_type,
      contractor_id: row.contractor_id ?? null,
      company_name: row.contractors?.company_name ?? null,
      is_test: row.contractors?.is_test ?? null,
      since,
      age_hours: Math.round(age * 10) / 10,
    });
  }
  out.sort((a, b) => b.age_hours - a.age_hours);
  return out;
}

/**
 * True when a platform_alerts_log row for this template was written inside
 * the dedup window — i.e. this run must NOT write another one. `priorAlerts`
 * is whatever the caller already fetched for function_name/alert_type; the
 * match is on the leading alertKey token of the message, not on the whole
 * message, so the human-readable part can change without breaking dedup.
 */
export function alreadyAlerted(
  templateId: string,
  priorAlerts: readonly PriorAlert[],
  nowMs: number,
  dedupMs: number = ALERT_DEDUP_MS,
): boolean {
  const key = alertKey(templateId);
  const cutoff = nowMs - dedupMs;
  for (const a of priorAlerts) {
    // Exact match on the leading whitespace-delimited token, so
    // "template=abc" can never be satisfied by "template=abcd ...".
    if (a.message.split(/\s/, 1)[0] !== key) continue;
    const sentMs = Date.parse(a.sent_at);
    if (Number.isNaN(sentMs)) continue;
    if (sentMs >= cutoff) return true;
  }
  return false;
}

/** Message written to platform_alerts_log — starts with the dedup token. */
export function buildAlertMessage(t: StaleTemplate, thresholdHours: number): string {
  const who = t.company_name ? `${t.company_name}${t.is_test ? " [is_test]" : ""}` : "(unknown contractor)";
  return (
    `${alertKey(t.template_id)} #1313: contractor template for ${who} ` +
    `(${t.trade} × ${t.funding_type}) has sat in ${t.status} for ${t.age_hours}h ` +
    `(since ${t.since}; threshold ${thresholdHours}h). ` +
    `Review it at https://otterquote.com/admin-template-review.html`
  );
}

/** Whole-run split: which stale rows get a new alert row this run, which are deduplicated. */
export function partitionForAlerting(
  stale: readonly StaleTemplate[],
  priorAlerts: readonly PriorAlert[],
  nowMs: number,
  dedupMs: number = ALERT_DEDUP_MS,
): { toAlert: StaleTemplate[]; deduplicated: StaleTemplate[] } {
  const toAlert: StaleTemplate[] = [];
  const deduplicated: StaleTemplate[] = [];
  for (const t of stale) {
    (alreadyAlerted(t.template_id, priorAlerts, nowMs, dedupMs) ? deduplicated : toAlert).push(t);
  }
  return { toAlert, deduplicated };
}
