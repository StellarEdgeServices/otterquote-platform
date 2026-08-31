/**
 * OtterQuote — Claim measurement-shape resolver (single source of truth)
 *
 * gh-1410 / D-317: the basic/full measurement-shape groundwork that the
 * contractor upgrade-purchase gate (gh-1411) and the declarations gate's
 * later basic-only condition (gh-1377) both key off.
 *
 * THE COLUMN MAY NOT EXIST YET. The additive `claims.measurement_shape`
 * migration (text, nullable, CHECK IN ('basic','full')) is drafted on
 * gh-1410 and, per D-182, waits on human approval before apply. Every
 * reader must therefore be tolerant of the column's absence:
 *
 *   - NEVER list `measurement_shape` in an explicit PostgREST
 *     .select('col1,col2') column list until the migration is applied —
 *     that is a 42703 error against today's schema. Use select('*') (or
 *     omit the column) and pass the row through
 *     resolveClaimMeasurementShape(), which handles `undefined` the same
 *     as NULL.
 *
 * NULL / ABSENT MEANS 'basic'. Ruled by the CTO on gh-1410
 * (cto-2026-08-31T18:43:39Z): existing claims predate the two-shape model,
 * stay NULL forever (never backfilled — gh-1410 Rails: "Absence means
 * 'basic' by definition, not a guess to backfill"), and every reader
 * treats NULL as basic-equivalent.
 *
 * WHY 'basic' IS THE SAFE DEFAULT (and why unexpected values also resolve
 * to it): 'basic' is the NON-upgraded shape.
 *   - gh-1411's gate: treating an unflagged claim as 'full' would suppress
 *     the paid $25/$55 upgrade CTA and hand out the detailed report the
 *     contractor is supposed to buy. Defaulting to 'basic' keeps the
 *     purchase path in front of them.
 *   - gh-1377's later basic-gate: the declarations requirement applies on
 *     'basic' claims, so defaulting to 'basic' is the stricter direction —
 *     the one gh-1377 itself called reversible.
 *
 * WRITER DISCIPLINE (D-317): no static page and no contractor action ever
 * writes this flag. The ONLY writer is gh-1411's admin-fulfilment step
 * (expected to hook the existing hover_orders fulfilment action in
 * admin-measurements.html) when a paid detailed report is entered. Never
 * infer the shape from data presence.
 *
 * NOT the same thing as create-docusign-envelope's resolveMeasurementShape()
 * — that is a content-derived sniff of claims.hover_measurements used only
 * for SOW-PDF rendering (same vocabulary, different mechanism; see the
 * gh-1410 evidence thread). Reconciling the two is gh-1411 design work, and
 * any change to the SOW generators is owed to PR #1408's sequence.
 *
 * React-app consumers: add a twin at react-app/app/lib/measurement-shape.ts
 * (the js/agent-types.js <-> react-app/app/lib/agent-types.ts pattern) when
 * the first React consumer lands; do not import this file cross-world.
 *
 * Test: node tests/measurement-shape-null-means-basic.mjs
 */

var MEASUREMENT_SHAPES = Object.freeze(['basic', 'full']);

var DEFAULT_MEASUREMENT_SHAPE = 'basic';

/**
 * resolveClaimMeasurementShape(claim) -> 'basic' | 'full'
 *
 * `claim` is a claims row (or null/undefined). Returns 'full' only when the
 * row explicitly carries measurement_shape === 'full'; every other case —
 * no row, column absent (pre-migration), NULL (no upgrade on record), or an
 * unexpected value — resolves to 'basic', the non-upgraded shape.
 */
function resolveClaimMeasurementShape(claim) {
  var raw = (claim && typeof claim === 'object') ? claim.measurement_shape : undefined;
  return raw === 'full' ? 'full' : DEFAULT_MEASUREMENT_SHAPE;
}

/**
 * claimHasFullMeasurements(claim) -> boolean
 * Convenience predicate for gate code ("nothing to buy" / detailed-mark
 * branches in gh-1411).
 */
function claimHasFullMeasurements(claim) {
  return resolveClaimMeasurementShape(claim) === 'full';
}

(typeof window !== 'undefined' ? window : globalThis).MeasurementShape = {
  MEASUREMENT_SHAPES: MEASUREMENT_SHAPES,
  DEFAULT_MEASUREMENT_SHAPE: DEFAULT_MEASUREMENT_SHAPE,
  resolveClaimMeasurementShape: resolveClaimMeasurementShape,
  claimHasFullMeasurements: claimHasFullMeasurements
};
