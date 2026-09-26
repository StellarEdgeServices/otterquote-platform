import { describe, it, expect } from 'vitest';
import { shouldShowDetailedMeasurementBadge, buildDetailedMeasurementBadge } from '../utils';

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

  it('renders copy naming no vendor (D-312) and stating the free upgrade (D-317 cl. 5)', () => {
    const model = buildDetailedMeasurementBadge();
    expect(model.header).toBe('Detailed measurement report');
    expect(model.body.toLowerCase()).not.toContain('roofscope');
    expect(model.body.toLowerCase()).not.toContain('hover');
    expect(model.body.toLowerCase()).toContain('no charge');
  });
});
