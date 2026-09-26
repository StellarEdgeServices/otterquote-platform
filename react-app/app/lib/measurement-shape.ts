/**
 * Claim measurement-shape resolver — React app twin.
 *
 * gh-1410 / D-317: the basic/full measurement-shape groundwork that the
 * contractor upgrade-purchase gate (gh-1411) and the declarations gate
 * (gh-1377) both key off. The static-HTML equivalent is js/measurement-shape.js
 * at the repo root (the js/agent-types.js <-> react-app/app/lib/agent-types.ts
 * pattern) — this file is the first React consumer that module's own header
 * asked for.
 *
 * NULL / ABSENT MEANS 'basic'. Existing claims predate the two-shape model
 * and stay NULL forever (never backfilled — gh-1410 Rails); every reader
 * treats NULL, an absent column, or an unexpected value as 'basic'-equivalent,
 * and only the exact string 'full' resolves to 'full'.
 *
 * WRITER DISCIPLINE (D-317): no page here writes this flag. The ONLY writer
 * is admin-measurements.html's admin-fulfilment step (gh-1411) when a paid
 * detailed report is delivered. This module is read-only.
 */

export const MEASUREMENT_SHAPES = ['basic', 'full'] as const;

export type MeasurementShape = (typeof MEASUREMENT_SHAPES)[number];

export const DEFAULT_MEASUREMENT_SHAPE: MeasurementShape = 'basic';

/**
 * resolveClaimMeasurementShape(claim) -> 'basic' | 'full'
 *
 * `claim` is a claims row (or null/undefined) — loosely typed here the same
 * way HomeownerClaim is (`select('*')`, schema owned by SQL/migrations).
 * Returns 'full' only when the row explicitly carries
 * measurement_shape === 'full'; every other case (no row, column absent,
 * NULL, or an unexpected value) resolves to 'basic'.
 */
export function resolveClaimMeasurementShape(
  claim: ({ measurement_shape?: unknown } & Record<string, unknown>) | null | undefined,
): MeasurementShape {
  const raw = claim && typeof claim === 'object' ? claim.measurement_shape : undefined;
  return raw === 'full' ? 'full' : DEFAULT_MEASUREMENT_SHAPE;
}

/**
 * claimHasFullMeasurements(claim) -> boolean
 * Convenience predicate for the homeowner dashboard's Shape-B badge
 * (gh-1411 closes-on: "the homeowner's screen renders Shape B with the
 * 'detailed' mark").
 */
export function claimHasFullMeasurements(
  claim: ({ measurement_shape?: unknown } & Record<string, unknown>) | null | undefined,
): boolean {
  return resolveClaimMeasurementShape(claim) === 'full';
}
