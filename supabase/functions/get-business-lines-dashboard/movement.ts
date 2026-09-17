// get-business-lines-dashboard/movement.ts
//
// gh-1570 — pure "days-since-movement" logic for get-business-lines-dashboard,
// extracted verbatim from index.ts so it can be exercised by `deno test` with
// zero permissions (same pattern as this directory's ga4.ts and
// get-homeowner-list/rows.ts: a module co-located in the calling function's
// own directory, imported via a same-directory relative path, because the
// Supabase Edge Function deploy path does not resolve `_shared/` imports).
//
// computeMovement/bucketFor are unchanged from their prior in-file form — this
// is a behaviour-preserving move, not a rewrite. homeownerBucket is new.

export interface MovementInput { label: string; iso: string | null }

export type MovementBucket = "green" | "yellow" | "red" | "unknown";

// today - max(...every timestamp that counts as "this member did something").
// Returns { days, latest_iso, inputs } — inputs are the individual candidate
// timestamps that fed the max(), so the UI can show exactly what a "hand
// computed spot check" (gh-1340 closes-on) would have to reproduce.
export function computeMovement(nowMs: number, inputs: MovementInput[]) {
  let latest: MovementInput | null = null;
  let latestMs = -Infinity;
  for (const inp of inputs) {
    if (!inp.iso) continue;
    const t = new Date(inp.iso).getTime();
    if (!isNaN(t) && t > latestMs) {
      latestMs = t;
      latest = inp;
    }
  }
  if (!latest) {
    return { days: null, latest_label: null, latest_iso: null, inputs, bucket: "unknown" as const };
  }
  const days = Math.floor((nowMs - latestMs) / 86400000);
  return { days, latest_label: latest.label, latest_iso: latest.iso, inputs, bucket: bucketFor(days) };
}

export function bucketFor(days: number): "green" | "yellow" | "red" {
  if (days <= 7) return "green";
  if (days <= 13) return "yellow";
  return "red";
}

// gh-1570: the admin CRM "stuck-first" table sorts/colors purely off
// movement.bucket (admin-dashboard.html). Originally movement was computed
// from raw updated_at timestamps — an unrelated system write (e.g. a bulk
// column backfill) bumped profile.updated_at / claim.updated_at and made a
// claim that has NEVER had one real activity_log event look "green" again
// once it aged past gh-1580's 72h "NEW" strip window. That was the identical
// false-freshness bug gh-1580 already fixed for the NEW strip, recurring
// here because the stuck-first table never got the same fix.
//
// This is deliberately scoped to homeowners who HAVE a claim: a homeowner
// with no claim yet has nothing to be "stuck" on (their row is still on the
// "created an account, hasn't started" step, which is not a stall), so the
// override only fires once there is a claim to be neglecting. A no-claim
// row's own movement.bucket is never touched by this function (hasClaim is
// false) — it still needs SOME real recency input to color/sort by, which
// FIX ROUND 4 (review 5707823658, finding #1) supplies in index.ts's
// `computeMovement` call: the homeowner's own signup timestamp
// (`profiles.created_at`, falling back to `auth.users.created_at` for the
// schema-nullable "profile row predates that column" case), NOT
// `profiles.updated_at` — main's mechanism happened to equal signup time for
// a never-touched profile, but was still an `updated_at` read, and the next
// unrelated profile bump would have broken it exactly like claimed rows
// broke pre-FIX-ROUND-3.
//
// CEO RUN 48 REVIEW (5703958709) fix-round: round 1 of this override forced
// EVERY zero-activity-log claim red forever, including claims that had moved
// a long way past documents_needed with no `activity_log` row under the
// homeowner's own user_id — because most real milestones never write one:
//   - bids are logged under the CONTRACTOR's user_id (auto_bid_submitted),
//     not the homeowner's — see quotesByClaimId / bidsReceived in index.ts;
//   - docusign-webhook's `homeowner_contract_signed_email_sent` row carries
//     no user_id at all (activity_log.user_id is NOT NULL, so that row is
//     invisible to any per-user reduction regardless);
//   - colour selection, deductible collection and measurement UPLOAD write
//     no activity_log row anywhere — only the claim's own timestamp columns
//     move.
// So `hasRealActivity` below is no longer "this homeowner has a real
// activity_log row" alone — it is OR'd with `claimHasMilestoneProgress`
// (this file), which reads the claim's OWN columns/status/bid count
// directly. A claim that is still at `documents_needed` (or earlier —
// `draft`) with NONE of those signals AND no real activity_log evidence
// (homeowner-keyed OR claim-referenced, see `isRealActivityRow` /
// `ADMIN_ORIGIN_EVENT_TYPES` below) is the only shape still forced red.
//
// FIX ROUND 3 (review 5706511176, finding B1, DECIDED): review2's
// `claimUpdatedAtIsAdminTainted` heuristic covered exactly one writer
// (mark-loss-sheet-reviewed). Live evidence this round: a generic Postgres
// trigger bumps `claims.updated_at` on EVERY update to the row, and at least
// six other Edge Functions (`process-bid-expirations`'s hourly cron,
// `admin-measurements`, `check-siding-design-completion`,
// `process-dunning`, `hover-webhook`, `parse-hover-measurements`,
// `docusign-webhook`) write `claims` columns having nothing to do with
// homeowner activity — `cbf2c780` showed "green / 0 days" purely from
// `process-bid-expirations`'s cron stamping `bid_window_notified_at` (and,
// via the generic trigger, `updated_at`) the moment its bid window expired.
// A per-writer allow/deny-list of "which column bump is real" cannot keep
// up with every current and future write path, so raw `updated_at` (claim
// OR profile) is no longer read for movement AT ALL — see index.ts's
// `buildHomeownerRow`, whose `computeMovement` inputs are now built
// EXCLUSIVELY from (a) real claim-linked `activity_log` rows (after the
// system/admin exclusions below) and (b) an explicit allow-list of claim
// milestone timestamp columns (bids_submitted_at, quotes.created_at,
// contract_sent_at/signed_at/declined_at/voided_at, color_selected_at/
// color_confirmed_at, deductible_collected_at, contractor_switched_at,
// project_confirmation_signed_at, completion_date). `claimUpdatedAtIsAdminTainted`
// is removed entirely — there is no longer a `claim.updated_at` input for it
// to taint-check.
//
// A direct consequence (FIX ROUND 3): a claim can have real, undeniable
// progress (`claimHasMilestoneProgress` true — e.g. `has_measurements=true`)
// yet have NO column in the explicit allow-list set and NO qualifying
// `activity_log` row at all (measurement UPLOAD itself has no dedicated
// timestamp column on `claims`, and its own `activity_log` counterpart is
// `measurement_order_fulfilled`, which is admin-authored and already
// excluded — see ADMIN_ORIGIN_EVENT_TYPES). `computeMovement` would then
// legitimately return `bucket: "unknown"` (no admissible input at all)
// rather than fabricate a date. An "unknown" recency is never safe to show
// as green/yellow — the CRM cannot verify this claim is fresh, which is
// exactly the same "needs a human to look" signal as zero real activity, so
// it is ALSO forced red here, alongside the pre-existing `!hasRealActivity`
// case.
//
// FIX ROUND 4 (review 5707823658, finding #3, DECIDED): index.ts's
// `computeMovement` call now ALSO includes the claim's own `created_at` (a
// row is never younger than its own creation, and `claims.created_at` is
// the one claim timestamp that is never admin/system-tainted — it is
// stamped once, at insert, by nobody's later action) and the four
// `*_bid_released_at` columns (a homeowner's own submit-for-bids action) as
// admissible recency inputs. Practical effect: `bucket: "unknown"` can now
// only occur for a claim whose OWN `created_at` is null (schema-nullable,
// but zero live rows as of this round) — every other claim has at least one
// admissible timestamp (its own creation), so it gets a real, honest `days`
// count and buckets green/yellow/red naturally off actual age, same as any
// other claim. (Re-verified live example: `4595b6f0` no longer reads
// `"unknown"` — its `claim.created_at` alone makes it naturally red at ~42
// days old — the forced-red branch below now only fires for the
// `!hasRealActivity` case for that row, not the `"unknown"` one. The
// `"unknown"` force-red branch is kept as defense in depth for the
// remaining null-`created_at` edge case, not removed.)
//
// movement.days / latest_iso are left untouched by the caller; only the
// bucket used for coloring/sorting changes.
export function homeownerBucket(
  movement: { bucket: MovementBucket },
  hasClaim: boolean,
  hasRealActivity: boolean,
): MovementBucket {
  if (hasClaim && (!hasRealActivity || movement.bucket === "unknown")) return "red";
  return movement.bucket;
}

// ── Claim milestone progress (CEO RUN 48 fix-round, gh-1570) ──────────────
//
// Enumerated from the live `claims` table schema (supabase/migrations/
// 20260101000000_v000_baseline_schema.sql, CREATE TABLE public.claims) and
// FIX ROUND 2 (review 5705734203, finding 5): the status check is now an
// explicit ALLOWLIST against the live CHECK constraint
// (supabase/migrations/20260904132600_gh1532_claims_status_check.sql,
// re-verified live via `pg_get_constraintdef` this round), not a denylist —
// an unrecognized future status (or one meaning "cancelled"/"closed", which
// the constraint does not currently define but could) defaults to NOT
// progress rather than silently being treated as advancement.
// `bidsReceived` is not a claim column — it is the count of `quotes` rows
// for this claim.id (quotesByClaimId in index.ts), which is how a bid
// actually gets recorded (contractor-keyed activity_log or none at all).
//
// A claim counts as having moved past "sat there and nothing happened" if
// ANY of these hold, independent of who (or what) wrote the timestamp:
export interface ClaimMilestones {
  status: string | null;
  hasMeasurements: boolean;
  readyForBids: boolean;
  bidsReceived: number;
  bidsSubmittedAt: string | null;
  contractSignedAt: string | null;
  colorSelectedAt: string | null;
  deductibleCollectedAt: string | null;
  selectedContractorId: string | null;
  platformFeeCharged: boolean;
  completionDate: string | null;
  // FIX ROUND 3 (gh-1570) — added alongside the same columns now feeding
  // computeMovement's explicit milestone allow-list (index.ts), so progress
  // evidence and recency evidence stay in sync: anything real enough to date
  // a claim's recency is also real enough to count as progress.
  contractDeclinedAt: string | null;
  contractVoidedAt: string | null;
  colorConfirmedAt: string | null;
  contractorSwitchedAt: string | null;
  projectConfirmationSignedAt: string | null;
  // FIX ROUND 4 (gh-1570, review 5707823658, finding #3) — the latest of the
  // four `*_bid_released_at` columns (gutters/roofing/siding/windows), which
  // a homeowner's own submit-for-bids action writes. Added alongside the
  // same column feeding computeMovement's recency allow-list (index.ts), for
  // the same "real enough to date is real enough to count as progress"
  // reason FIX ROUND 3 gave for every other field here.
  bidReleasedAt: string | null;
}

// documents_needed is the table's own DEFAULT; draft is the only status that
// precedes it in the funnel (get-homeowner-list/rows.test.ts uses both as
// the "hasn't really started" shape).
export const EARLY_CLAIM_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "documents_needed",
]);

// FIX ROUND 2 (finding 5): every OTHER live value the `claims_status_check`
// CHECK constraint allows — i.e. the full state-machine enumeration minus
// EARLY_CLAIM_STATUSES above. A status outside BOTH sets (a future value the
// constraint doesn't list yet, e.g. a "cancelled"/"closed" state, or a NULL/
// garbage value) is treated the same as "early" — NOT progress — rather than
// assumed to mean forward motion. This is the allowlist, not "not early".
export const PROGRESS_CLAIM_STATUSES: ReadonlySet<string> = new Set([
  "submitted",
  "active",
  "waitlisted",
  "bidding",
  "contract_signed",
  "awarded",
]);

export function claimHasMilestoneProgress(claim: ClaimMilestones | null): boolean {
  if (!claim) return false;
  if (claim.status && PROGRESS_CLAIM_STATUSES.has(claim.status)) return true;
  return (
    claim.hasMeasurements === true ||
    claim.readyForBids === true ||
    claim.bidsReceived > 0 ||
    !!claim.bidsSubmittedAt ||
    !!claim.contractSignedAt ||
    !!claim.colorSelectedAt ||
    !!claim.deductibleCollectedAt ||
    !!claim.selectedContractorId ||
    claim.platformFeeCharged === true ||
    !!claim.completionDate ||
    !!claim.contractDeclinedAt ||
    !!claim.contractVoidedAt ||
    !!claim.colorConfirmedAt ||
    !!claim.contractorSwitchedAt ||
    !!claim.projectConfirmationSignedAt ||
    !!claim.bidReleasedAt
  );
}

// ── Admin-origin / system-notification activity_log rows (gh-1570) ───────
//
// ADMIN_ORIGIN_EVENT_TYPES: an admin explicitly acted ON BEHALF OF the
// homeowner, and the row lands under the HOMEOWNER's OWN user_id — the
// dangerous shape, because it looks identical to the homeowner's own
// activity to any per-user reduction.
//   - loss_sheet_reviewed / loss_sheet_review_cleared —
//     mark-loss-sheet-reviewed/index.ts:250-264, metadata.admin_email,
//     title "... by admin". The ORIGINAL motivating case for this fix.
//   - measurement_order_fulfilled — send-measurement-ready/index.ts, an
//     admin-gated endpoint (primary-admin gate; the function's own comment:
//     "the admin gate above has already returned 403 for a non-admin
//     caller"), writes `user_id: order.user_id` — the HOMEOWNER's id, not
//     the admin's. Same shape as loss_sheet_reviewed: an admin action
//     wearing the homeowner's identity. FIX ROUND 2 (review 5705734203,
//     finding 4).
//
// SYSTEM_NOTIFICATION_EVENT_TYPES: an automated side-effect of some other
// real event (an email being sent, a failure being logged, a Stripe
// webhook reacting to a dispute) — never a deliberate action by anyone on
// the claim. FIX ROUND 2 (review 5705734203, finding 4): enumerated by
// grepping every `activity_log.insert(...)` call in `supabase/functions`
// for `event_type` and `metadata.claim_id` (2026-09-16):
//   - bid_confirmation_email_sent — send-bid-confirmation/index.ts, under
//     the CONTRACTOR's user_id but carries metadata.claim_id, so it would
//     otherwise pollute the claim-level scan even though no homeowner-row
//     reduction ever keys off a contractor id directly.
//   - notification_failed — the shared notification-failure.ts (create-
//     measurement-order / notify-measurement-order / send-measurement-
//     ready): a swallowed SEND FAILURE, not an action; `user_id` can be
//     either role's id depending on `recipientRole`.
//   - homeowner_contract_signed_email_sent — docusign-webhook/index.ts, an
//     email-sent record with metadata.claim_id and (separately) no user_id
//     at all (activity_log.user_id is NOT NULL, so in practice this insert
//     cannot land under any id — excluded here anyway as defense in depth
//     for the claim-level scan, which reads metadata regardless of user_id).
//   - signed_unbilled_no_method — docusign-webhook/index.ts, a billing-guard
//     log for a signing the platform could not bill; also has no user_id.
//   - hover_rebate_failed / hover_rebate_db_update_failed —
//     process-hover-rebate/index.ts, a failed Stripe refund / a failed DB
//     write AFTER a real refund; both under `claimUserId` (the homeowner's
//     own id) with metadata.claim_id.
//   - dispute.auto_evidence_submitted / dispute.routed_to_manual_queue —
//     stripe-webhook/index.ts, Stripe dispute-handling under
//     `claim?.user_id` (the homeowner's own id, falls back to a system
//     placeholder) with metadata.claim_id.
//   - wc_cert_expiry_reminder_sent — process-coi-reminders/index.ts, a
//     reminder sent TO a contractor about their own W/C cert; under the
//     contractor's id, no claim_id, included for completeness of the
//     enumeration.
//   - welcome_email_sent — send-welcome-email/index.ts, under the
//     contractor's id, no claim_id; included for completeness.
// (`sms_sent` and `invoice_created` were checked and excluded from this
// list: `sms_sent` writes under a fixed system-placeholder UUID with no
// claim_id, and `invoice_created`'s metadata has no claim_id — neither can
// reach either reducer regardless of a deny-list entry.)
export const ADMIN_ORIGIN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "loss_sheet_reviewed",
  "loss_sheet_review_cleared",
  "measurement_order_fulfilled",
]);

export const SYSTEM_NOTIFICATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "bid_confirmation_email_sent",
  "notification_failed",
  "homeowner_contract_signed_email_sent",
  "signed_unbilled_no_method",
  "hover_rebate_failed",
  "hover_rebate_db_update_failed",
  "dispute.auto_evidence_submitted",
  "dispute.routed_to_manual_queue",
  "wc_cert_expiry_reminder_sent",
  "welcome_email_sent",
]);

export interface ActivityLikeRow {
  event_type: string | null;
  metadata: Record<string, unknown> | null;
}

// True for an activity_log row that reflects something a real person (the
// homeowner, a contractor, anyone) actually DID — false for a system nudge
// (metadata.system_generated === true, gh-1580's existing convention), an
// admin-authored row (ADMIN_ORIGIN_EVENT_TYPES), or an automated
// notification/failure/webhook side-effect (SYSTEM_NOTIFICATION_EVENT_TYPES).
export function isRealActivityRow(row: ActivityLikeRow): boolean {
  if ((row.metadata as { system_generated?: boolean } | null)?.system_generated === true) return false;
  if (row.event_type && ADMIN_ORIGIN_EVENT_TYPES.has(row.event_type)) return false;
  if (row.event_type && SYSTEM_NOTIFICATION_EVENT_TYPES.has(row.event_type)) return false;
  return true;
}

// `claimUpdatedAtIsAdminTainted` (FIX ROUND 2) is REMOVED as of FIX ROUND 3
// (review 5706511176, finding B1, DECIDED): it heuristically taint-checked
// `claim.updated_at` against ONE known admin writer
// (`mark-loss-sheet-reviewed`'s `loss_sheet_reviewed_at`), but a generic
// Postgres trigger bumps `claims.updated_at` on every update regardless of
// writer, and at least six other Edge Functions touch `claims` columns
// unrelated to homeowner activity (see homeownerBucket's header comment
// above for the full live enumeration and the `cbf2c780` example). A
// per-writer heuristic cannot keep up with every current and future write
// path, so the cure is not a smarter taint check — it is reading
// `claim.updated_at` / `profile.updated_at` for movement NEVER, full stop.
