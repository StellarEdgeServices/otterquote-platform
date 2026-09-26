import { describe, it, expect } from 'vitest';
import {
  shouldShowDetailedMeasurementBadge,
  buildDetailedMeasurementBadge,
  DETAILED_MEASUREMENT_BADGE_COPY_IS_PLACEHOLDER,
} from '../utils';

/**
 * gh-1411 / D-317 cl. 5-6 — homeowner Shape-B "detailed" mark.
 *
 * FAIL-FIRST: before this change, dashboard/utils.ts had no
 * shouldShowDetailedMeasurementBadge / buildDetailedMeasurementBadge exports
 * and no homeowner-facing surface read claims.measurement_shape at all — the
 * gh-1411 closes-on conjunct "the homeowner's screen renders Shape B with
 * the 'detailed' mark" had no code path to demonstrate. This file failing
 * to even import on the pre-change checkout (named exports undefined) is
 * the fail-first evidence; it passes once utils.ts exports both functions.
 *
 * NEGATIVE CONTROL: a claim that never had the upgrade purchased (shape
 * NULL/absent/'basic', or the column not existing pre-migration) must show
 * nothing — the badge is not a generic "measurements exist" indicator, it is
 * specifically the paid-upgrade Shape-B mark.
 */
describe('DetailedMeasurementBadge (gh-1411 / D-317 cl. 5-6)', () => {
  it('shows once the claim has been flipped to the detailed shape', () => {
    expect(shouldShowDetailedMeasurementBadge({ id: 'c1', user_id: 'u1', status: 'active', measurement_shape: 'full' } as never)).toBe(
      true,
    );
  });

  it('NEGATIVE CONTROL: a basic-shape (or unflipped) claim shows nothing', () => {
    expect(shouldShowDetailedMeasurementBadge({ id: 'c1', user_id: 'u1', status: 'active', measurement_shape: 'basic' } as never)).toBe(
      false,
    );
    expect(shouldShowDetailedMeasurementBadge({ id: 'c1', user_id: 'u1', status: 'active', measurement_shape: null } as never)).toBe(
      false,
    );
    expect(shouldShowDetailedMeasurementBadge({ id: 'c1', user_id: 'u1', status: 'active' } as never)).toBe(false);
    expect(shouldShowDetailedMeasurementBadge(null)).toBe(false);
    expect(shouldShowDetailedMeasurementBadge(undefined)).toBe(false);
  });

  it('renders copy naming no vendor (D-312) and stating the free upgrade (D-317 cl. 5), and nothing beyond what D-317 decided', () => {
    const model = buildDetailedMeasurementBadge();
    expect(model.header).toContain('Detailed measurement report');
    expect(model.body.toLowerCase()).not.toContain('roofscope');
    expect(model.body.toLowerCase()).not.toContain('hover');
    expect(model.body.toLowerCase()).toContain('no charge');
    // LEGAL-READ FIX (PR #2236 comment 5850580181): these two clauses were
    // flagged as "beyond D-numbers" (disclosing a contractor paid) and
    // "beyond, and conflicts with, D-317" (a new promise about every future
    // bidder, contradicting D-317 cl. 4's "every later upgrade... is
    // margin" -- an unresolved Tier C question). Locked out here so a
    // future edit cannot reintroduce either without this test catching it.
    expect(model.body.toLowerCase()).not.toContain('every contractor');
    expect(model.body.toLowerCase()).not.toContain('a contractor purchased');
  });

  it('PLACEHOLDER GUARD: the copy is marked as not production-approved, and both strings carry the marker', () => {
    // This is not final copy (see utils.ts's PLACEHOLDER comment) -- it has not
    // been drafted by Sloane or cleared by LEGAL-READ. The flag and the literal
    // marker text exist so a future wiring-in of this component cannot miss
    // that the strings need replacing first, and so this test starts failing
    // loudly (not silently) once someone actually writes real copy without
    // also flipping the flag and removing the marker deliberately.
    expect(DETAILED_MEASUREMENT_BADGE_COPY_IS_PLACEHOLDER).toBe(true);
    const model = buildDetailedMeasurementBadge();
    expect(model.header).toContain('PLACEHOLDER COPY');
    expect(model.body).toContain('PLACEHOLDER COPY');
  });
});
