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
 *
 * gh-1796 (Dustin's ruling on #1597, 2026-09-07): this module also derives the
 * per-claim LOSS-SHEET state the admin queue is built on. Everything about it
 * is pure and testable here; the two impure inputs it needs — when the storage
 * object was created, and a signed URL to open it — are resolved in index.ts
 * with the service role and handed in / attached afterwards.
 *
 * WHERE A LOSS SHEET ACTUALLY LIVES (verified live against yeszghaspzwwstvsrioa
 * on 2026-09-07, not assumed — the query is in the PR body):
 *   - There is NO `documents` / `claim_documents` table. `information_schema`
 *     returns zero base tables matching `doc` in `public`.
 *   - The file itself is an object in the private `claim-documents` storage
 *     bucket. Its bucket-relative path is `claims.estimate_filename`
 *     (`<user_id>/<claim_id>/<epoch>-<original name>`, e.g.
 *     `5afddb5c-.../4595b6f0-.../1785930673843-dummy-estimate.jpg`).
 *   - `claims.has_estimate` is a boolean flag set alongside it by
 *     dashboard.html, and the two DISAGREE on real rows: 4 claims carry
 *     has_estimate = true with estimate_filename NULL. `estimate_filename` is
 *     therefore the authority on "is there a document to open", and
 *     has_estimate = true with no path is surfaced as a note, not silently
 *     treated as uploaded.
 *   - `claims.loss_sheet_parsed_at` is set by the parse-loss-sheet EF, which
 *     dashboard.html invokes immediately after a successful upload. It is a
 *     good FALLBACK for the upload date and nothing more — it is null on rows
 *     that were uploaded before that EF existed or where parsing failed.
 *
 * There is no upload timestamp column on claims (no `estimate_uploaded_at`),
 * so the upload date comes from `storage.objects.created_at`. The `storage`
 * schema is not exposed through PostgREST, so index.ts reads it through the
 * Storage API rather than as a join, and the basis of every date is reported
 * per row in `loss_sheet_uploaded_at_basis`.
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
  /** gh-1796 — bucket-relative path of the loss sheet in `claim-documents`. */
  estimate_filename?: string | null;
  /** gh-1796 — dashboard.html's flag. Not authoritative; see header. */
  has_estimate?: boolean | null;
  /** gh-1796 — set by parse-loss-sheet. Upload-date fallback only. */
  loss_sheet_parsed_at?: string | null;
  /**
   * gh-1796 — admin's "I have reviewed this" marker. Added by migration
   * 20260907220015_gh1796_claims_loss_sheet_reviewed_at.sql, which is filed in
   * this PR and DELIBERATELY NOT APPLIED. Optional here so this module, its
   * tests and the EF all behave correctly (every claim reads as unreviewed)
   * against the pre-migration schema.
   */
  loss_sheet_reviewed_at?: string | null;
}

export interface ProfileIn {
  id: string;
  full_name: string | null;
  email: string | null;
  /** gh-1796 — signup date, for "days since signup" on the loss-sheet queue. */
  created_at?: string | null;
}

/** gh-1796 — the three states #1796 names, and nothing else. */
export type LossSheetStatus = "missing" | "uploaded_unreviewed" | "reviewed";

/** gh-1796 — how `loss_sheet_uploaded_at` was derived, per row. */
export type LossSheetUploadedAtBasis =
  | "storage_object"
  | "loss_sheet_parsed_at"
  | "unknown";

/** gh-1796 — how `days_since_signup` was derived, per row. */
export type SignupBasis = "profile_created_at" | "claim_created_at" | "unknown";

/** The subset of a claim the loss-sheet helpers read. */
export type LossSheetIn = Pick<
  ClaimIn,
  "estimate_filename" | "has_estimate" | "loss_sheet_parsed_at" | "loss_sheet_reviewed_at"
>;

/** Trimmed storage path, or null when there is no document to open. */
export function lossSheetPath(c: LossSheetIn): string | null {
  const p = (c.estimate_filename ?? "").trim();
  return p.length > 0 ? p : null;
}

/**
 * The three states, in precedence order:
 *
 *   reviewed             loss_sheet_reviewed_at IS NOT NULL
 *   uploaded_unreviewed  not reviewed AND estimate_filename IS NOT NULL
 *   missing              not reviewed AND estimate_filename IS NULL
 *
 * `reviewed` wins outright: once Dustin has said he read it, the row leaves
 * the queue and stays gone even if the file is later replaced or cleared. The
 * alternative — letting a storage change silently re-open a reviewed row —
 * would make the queue re-surface work he has already done, which is the one
 * failure mode that would stop him using it.
 *
 * `has_estimate` is deliberately NOT consulted. It disagrees with
 * estimate_filename on 4 live rows, and in every one of those the disagreement
 * means "no document exists to review" — i.e. still `missing`. See
 * lossSheetNote(), which surfaces that specific case on the row.
 */
export function lossSheetStatus(c: LossSheetIn): LossSheetStatus {
  if (c.loss_sheet_reviewed_at) return "reviewed";
  return lossSheetPath(c) ? "uploaded_unreviewed" : "missing";
}

/**
 * A short, admin-only explanation when a row's state is not self-evident.
 * Today there is exactly one such case: has_estimate = true with no path,
 * which reads as "missing" and would otherwise look like a queue bug.
 */
export function lossSheetNote(c: LossSheetIn): string | null {
  if (!c.loss_sheet_reviewed_at && c.has_estimate === true && !lossSheetPath(c)) {
    return "Flagged as uploaded, but no file is on record — nothing to open.";
  }
  return null;
}

/**
 * Upload date, and where it came from. `uploadedAtByPath` is the storage
 * lookup index.ts builds; when it has no entry for this path (lookup capped,
 * object deleted, or a stale path on the claim) the parse timestamp stands in,
 * and when neither exists the date is null with basis "unknown" — the page
 * says so rather than printing a date it cannot source.
 */
export function lossSheetUploadedAt(
  c: LossSheetIn,
  uploadedAtByPath?: ReadonlyMap<string, string>,
): { at: string | null; basis: LossSheetUploadedAtBasis } {
  const path = lossSheetPath(c);
  if (!path) return { at: null, basis: "unknown" };
  const fromStorage = uploadedAtByPath?.get(path);
  if (fromStorage) return { at: fromStorage, basis: "storage_object" };
  if (c.loss_sheet_parsed_at) return { at: c.loss_sheet_parsed_at, basis: "loss_sheet_parsed_at" };
  return { at: null, basis: "unknown" };
}

/**
 * Signup date, and where it came from. `profiles.created_at` is the real
 * signup; the claim's own created_at is the fallback for a claim whose profile
 * row cannot be resolved (verified live: `profiles.created_at` exists).
 */
export function signupAt(
  profile: { created_at?: string | null } | null | undefined,
  claim: { created_at?: string | null },
): { at: string | null; basis: SignupBasis } {
  const p = profile?.created_at ?? null;
  if (p) return { at: p, basis: "profile_created_at" };
  const c = claim.created_at ?? null;
  if (c) return { at: c, basis: "claim_created_at" };
  return { at: null, basis: "unknown" };
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

  // ── gh-1796 loss-sheet queue ────────────────────────────────────────────
  /** One of the three states #1796 names. See lossSheetStatus(). */
  loss_sheet: LossSheetStatus;
  /** Bucket-relative path in `claim-documents`, or null when nothing uploaded. */
  loss_sheet_path: string | null;
  /** Upload date. null means "no date this EF can source" — not "not uploaded". */
  loss_sheet_uploaded_at: string | null;
  loss_sheet_uploaded_at_basis: LossSheetUploadedAtBasis;
  /** Echo of the marker, so the page can show WHEN it was reviewed. */
  loss_sheet_reviewed_at: string | null;
  /** Admin-only note; null on ordinary rows. See lossSheetNote(). */
  loss_sheet_note: string | null;
  /**
   * Short-lived signed URL for the document. buildRows() always sets null —
   * minting a URL is an impure Storage call, so index.ts attaches it after
   * the fact, and only for rows still in the queue.
   */
  loss_sheet_url: string | null;
  /** Signup timestamp behind days_since_signup. See signupAt(). */
  signup_at: string | null;
  days_since_signup: number | null;
  signup_basis: SignupBasis;
}

/**
 * One row per claim, sorted longest-dwell first (ties: oldest created_at
 * first, then claim_id for a stable order). Every claim is returned, is_test
 * included — hiding test rows is the page's display filter, not this EF's
 * business, so the toggle never triggers a refetch.
 */
export function buildRows(
  claims: ClaimIn[],
  profiles: ProfileIn[],
  nowMs: number,
  /** gh-1796 — storage path -> object created_at, built by index.ts. */
  uploadedAtByPath?: ReadonlyMap<string, string>,
): HomeownerRow[] {
  const profileById = new Map<string, ProfileIn>();
  for (const p of profiles) profileById.set(p.id, p);

  const rows: HomeownerRow[] = claims.map((c) => {
    const profile = c.user_id ? profileById.get(c.user_id) ?? null : null;
    const who = homeownerLabel(profile, c);
    const statusSince = c.updated_at ?? c.created_at ?? null;
    const uploaded = lossSheetUploadedAt(c, uploadedAtByPath);
    const signup = signupAt(profile, c);
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

      loss_sheet: lossSheetStatus(c),
      loss_sheet_path: lossSheetPath(c),
      loss_sheet_uploaded_at: uploaded.at,
      loss_sheet_uploaded_at_basis: uploaded.basis,
      loss_sheet_reviewed_at: c.loss_sheet_reviewed_at ?? null,
      loss_sheet_note: lossSheetNote(c),
      loss_sheet_url: null,
      signup_at: signup.at,
      days_since_signup: daysSince(signup.at, nowMs),
      signup_basis: signup.basis,
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
