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
// movement.bucket (admin-dashboard.html), and movement is computed from raw
// updated_at timestamps — an unrelated system write (e.g. a bulk column
// backfill) bumps profile.updated_at / claim.updated_at and makes a claim
// that has NEVER had one real activity_log event look "green" again once it
// ages past gh-1580's 72h "NEW" strip window. That is the identical
// false-freshness bug gh-1580 already fixed for the NEW strip, recurring here
// because the stuck-first table never got the same fix.
//
// This is deliberately scoped to homeowners who HAVE a claim: a homeowner
// with no claim yet has nothing to be "stuck" on (their row is still on the
// "created an account, hasn't started" step, which is not a stall), so the
// override only fires once there is a claim to be neglecting.
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
// movement.days / latest_iso are left untouched by the caller; only the
// bucket used for coloring/sorting changes.
export function homeownerBucket(
  movement: { bucket: MovementBucket },
  hasClaim: boolean,
  hasRealActivity: boolean,
): MovementBucket {
  if (hasClaim && !hasRealActivity) return "red";
  return movement.bucket;
}

// ── Claim milestone progress (CEO RUN 48 fix-round, gh-1570) ──────────────
//
// Enumerated from the live `claims` table schema (supabase/migrations/
// 20260101000000_v000_baseline_schema.sql, CREATE TABLE public.claims) plus
// the claim-status values actually assigned in code (get-hover-pdf/index.ts
// canAccessClaim comment: 'active' | 'bidding' | 'pending'; docusign-webhook/
// stripe-webhook: 'contract_signed'; mark-job-complete: 'job_completed').
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
}

// documents_needed is the table's own DEFAULT; draft is the only status that
// precedes it in the funnel (get-homeowner-list/rows.test.ts uses both as
// the "hasn't really started" shape). Everything else is progress.
export const EARLY_CLAIM_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "documents_needed",
]);

export function claimHasMilestoneProgress(claim: ClaimMilestones | null): boolean {
  if (!claim) return false;
  if (claim.status && !EARLY_CLAIM_STATUSES.has(claim.status)) return true;
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
    !!claim.completionDate
  );
}

// ── Admin-origin activity_log rows (CEO RUN 48 fix-round, gh-1570) ────────
//
// mark-loss-sheet-reviewed/index.ts:250-264 is the ONLY writer that inserts
// an activity_log row under a HOMEOWNER's own user_id on an admin's action
// (metadata.admin_email, title "... by admin", event_type below) — verified
// by grepping every activity_log insert in supabase/functions for
// `admin_email` metadata (2026-09-16). warranty-drift approve/reject also
// stamp `reviewed_by: adminEmail`, but under the CONTRACTOR's user_id, never
// a homeowner's, so they never reach this reducer's homeowner map. An admin
// reviewing (or un-reviewing) George's loss sheet is not George doing
// anything — it must not un-stall a claim that is otherwise untouched.
export const ADMIN_ORIGIN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "loss_sheet_reviewed",
  "loss_sheet_review_cleared",
]);

export interface ActivityLikeRow {
  event_type: string | null;
  metadata: Record<string, unknown> | null;
}

// True for an activity_log row that reflects something a real person (the
// homeowner, a contractor, anyone) actually did — false for a system nudge
// (metadata.system_generated === true, gh-1580's existing convention) or an
// admin-authored row (ADMIN_ORIGIN_EVENT_TYPES).
export function isRealActivityRow(row: ActivityLikeRow): boolean {
  if ((row.metadata as { system_generated?: boolean } | null)?.system_generated === true) return false;
  if (row.event_type && ADMIN_ORIGIN_EVENT_TYPES.has(row.event_type)) return false;
  return true;
}
