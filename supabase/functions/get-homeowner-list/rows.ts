/**
 * rows.ts — pure row-building logic for get-homeowner-list (gh-1653).
 *
 * A real module with real exports (same shape as
 * get-business-lines-dashboard/ga4.ts), so rows.test.ts can exercise every
 * function here with `deno test` and zero permissions — no source-extraction
 * tricks, no network, no secrets. index.ts imports this by relative path,
 * which the EF deploy path DOES resolve (only `_shared/` does not — see
 * _shared/admin.ts header).
 *
 * Everything here is deterministic given (claims, profiles, now).
 */

/** The exact set claims_status_check allows (migration 20260904132600_gh1532). */
export const STATUS_LABELS: Readonly<Record<string, string>> = {
  draft:            "Started, not submitted",
  documents_needed: "Waiting on documents",
  submitted:        "Submitted",
  waitlisted:       "Waitlisted — no coverage yet",
  active:           "Open for bids",
  bidding:          "Bids coming in",
  awarded:          "Contractor chosen",
  contract_signed:  "Contract signed",
};

/**
 * Plain-English status. An unknown value is returned as-is (never hidden),
 * so a status this map has not heard of still shows on the list instead of
 * rendering as blank or "undefined".
 */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return "No status";
  return STATUS_LABELS[status] ?? status;
}

/** Whole days between an ISO timestamp and `nowMs`, floored at 0. */
export function daysSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}

/**
 * Homeowner identity "as held": profile full name, then the name captured on
 * the claim itself, then the profile email. Returns null when nothing is on
 * file — the page renders that plainly rather than substituting an id.
 *
 * Verified live 2026-09-04 (yeszghaspzwwstvsrioa): 0 of the 5 real claims
 * carry claims.homeowner_name; all 5 have profiles.full_name and
 * profiles.email. profiles has no admin RLS read policy, which is why this
 * join happens in an EF with the service role and not in the page.
 */
export function homeownerLabel(
  profile: { full_name?: string | null; email?: string | null } | null | undefined,
  claim: { homeowner_name?: string | null },
): { name: string | null; email: string | null } {
  const name =
    (profile?.full_name && profile.full_name.trim()) ||
    (claim.homeowner_name && claim.homeowner_name.trim()) ||
    null;
  const email = (profile?.email && profile.email.trim()) || null;
  return { name, email };
}

export interface ClaimIn {
  id: string;
  user_id: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
  trades: string[] | null;
  job_type: string | null;
  funding_type: string | null;
  is_test: boolean | null;
  homeowner_name: string | null;
}

export interface ProfileIn {
  id: string;
  full_name: string | null;
  email: string | null;
}

export interface HomeownerRow {
  claim_id: string;
  homeowner_name: string | null;
  homeowner_email: string | null;
  status: string | null;
  status_label: string;
  created_at: string | null;
  /** ISO timestamp the dwell clock starts from. See dwell_basis. */
  status_since: string | null;
  /** Whole days from status_since to now. null when status_since is null. */
  days_at_status: number | null;
  /**
   * How status_since was derived. As of 2026-09-04 the only value is
   * "updated_at": claims carries no status-changed timestamp and
   * activity_log has no status-change event type (verified live — event
   * types present: bid_submitted, bid_confirmation_email_sent, bid_accepted,
   * bid_updated, loss_sheet_parsed, measurement_order_*, invoice_created,
   * welcome_email_sent, test_session_minted). updated_at is bumped by the
   * claims_updated_at trigger on ANY column change, so this is a LOWER
   * BOUND on time-at-status: a claim whose notes were edited yesterday reads
   * "1 day" even if its status has not moved in a month. The UI labels the
   * number "since last change" for exactly that reason.
   */
  dwell_basis: "updated_at";
  trades: string[];
  job_type: string | null;
  funding_type: string | null;
  is_test: boolean;
}

/**
 * One row per claim, sorted longest-dwell first (ties: oldest created_at
 * first, then claim_id for a stable order). Every claim is returned, is_test
 * included — hiding test rows is the page's display filter, not this EF's
 * business, so the toggle never triggers a refetch.
 */
export function buildRows(claims: ClaimIn[], profiles: ProfileIn[], nowMs: number): HomeownerRow[] {
  const profileById = new Map<string, ProfileIn>();
  for (const p of profiles) profileById.set(p.id, p);

  const rows: HomeownerRow[] = claims.map((c) => {
    const profile = c.user_id ? profileById.get(c.user_id) ?? null : null;
    const who = homeownerLabel(profile, c);
    const statusSince = c.updated_at ?? c.created_at ?? null;
    return {
      claim_id: c.id,
      homeowner_name: who.name,
      homeowner_email: who.email,
      status: c.status ?? null,
      status_label: statusLabel(c.status),
      created_at: c.created_at ?? null,
      status_since: statusSince,
      days_at_status: daysSince(statusSince, nowMs),
      dwell_basis: "updated_at",
      trades: Array.isArray(c.trades) ? c.trades.filter((t) => typeof t === "string") : [],
      job_type: c.job_type ?? null,
      funding_type: c.funding_type ?? null,
      is_test: c.is_test === true,
    };
  });

  rows.sort((a, b) => {
    const da = a.days_at_status ?? -1;
    const db = b.days_at_status ?? -1;
    if (db !== da) return db - da;
    const ca = a.created_at ? new Date(a.created_at).getTime() : Number.MAX_SAFE_INTEGER;
    const cb = b.created_at ? new Date(b.created_at).getTime() : Number.MAX_SAFE_INTEGER;
    if (ca !== cb) return ca - cb;
    return a.claim_id < b.claim_id ? -1 : a.claim_id > b.claim_id ? 1 : 0;
  });

  return rows;
}
