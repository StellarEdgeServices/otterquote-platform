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
// firstActivityIso is the homeowner's first-ever REAL (non-system-generated)
// activity_log timestamp (null = none, ever). When it is null and a claim
// exists, the raw bucketFor verdict is discarded and the row is forced red —
// regardless of how recently updated_at was bumped — because "zero real
// activity, ever" is never actually on-track. movement.days / latest_iso are
// left untouched by the caller; only the bucket used for coloring/sorting
// changes.
export function homeownerBucket(
  movement: { bucket: MovementBucket },
  firstActivityIso: string | null,
  hasClaim: boolean,
): MovementBucket {
  if (hasClaim && !firstActivityIso) return "red";
  return movement.bucket;
}
