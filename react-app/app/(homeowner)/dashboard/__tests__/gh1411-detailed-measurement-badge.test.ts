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

  it('renders the approved copy VERBATIM (gh-3018 / #3689, COPY-READ: PASS), naming no vendor (D-312) and nothing beyond D-317', () => {
    const model = buildDetailedMeasurementBadge();
    // Final text from Marketing/drafts/cro93-shapeb-badge-copy.md. Do not reword
    // without a new COPY-READ + LEGAL-READ.
    expect(model.header).toBe('Detailed roof measurements added');
    expect(model.body).toBe('Your roof measurement report now includes detailed measurements, at no charge.');
    expect(model.body.toLowerCase()).not.toContain('roofscope');
    expect(model.body.toLowerCase()).not.toContain('hover');
    expect(model.body.toLowerCase()).not.toContain('3d');
    // LEGAL-READ FIX (PR #2236 comment 5850580181): locked out so a future edit
    // cannot reintroduce a contractor-paid disclosure or a promise about every
    // bidder (D-317 cl. 4 is an open Tier C question).
    expect(model.body.toLowerCase()).not.toContain('every contractor');
    expect(model.body.toLowerCase()).not.toContain('a contractor purchased');
    expect(model.body.toLowerCase()).not.toContain('contractor');
  });

  it('PLACEHOLDER GUARD: the flag is off and no placeholder marker remains in either string', () => {
    expect(DETAILED_MEASUREMENT_BADGE_COPY_IS_PLACEHOLDER).toBe(false);
    const model = buildDetailedMeasurementBadge();
    expect(model.header).not.toContain('PLACEHOLDER');
    expect(model.body).not.toContain('PLACEHOLDER');
  });
});
