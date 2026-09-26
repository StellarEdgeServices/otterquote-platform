import { describe, it, expect } from 'vitest';
import {
  MEASUREMENT_SHAPES,
  DEFAULT_MEASUREMENT_SHAPE,
  resolveClaimMeasurementShape,
  claimHasFullMeasurements,
} from '../measurement-shape';

/**
 * gh-1411 / D-317 — React-app twin of js/measurement-shape.js. Mirrors
 * tests/measurement-shape-null-means-basic.mjs's contract exactly so the two
 * worlds cannot silently drift: 'full' only for an exact 'full', everything
 * else (no row, absent column, NULL, unexpected value) resolves to 'basic'.
 */
describe('measurement-shape (React twin)', () => {
  it('exposes the frozen shape list and the basic default', () => {
    expect(MEASUREMENT_SHAPES).toEqual(['basic', 'full']);
    expect(DEFAULT_MEASUREMENT_SHAPE).toBe('basic');
  });

  it('resolves an exact "full" claim to full', () => {
    expect(resolveClaimMeasurementShape({ measurement_shape: 'full' })).toBe('full');
  });

  it('NEGATIVE CONTROL: null / undefined / absent / unexpected all resolve to basic', () => {
    expect(resolveClaimMeasurementShape(null)).toBe('basic');
    expect(resolveClaimMeasurementShape(undefined)).toBe('basic');
    expect(resolveClaimMeasurementShape({})).toBe('basic');
    expect(resolveClaimMeasurementShape({ measurement_shape: null })).toBe('basic');
    expect(resolveClaimMeasurementShape({ measurement_shape: 'basic' })).toBe('basic');
    expect(resolveClaimMeasurementShape({ measurement_shape: 'FULL' })).toBe('basic');
    expect(resolveClaimMeasurementShape({ measurement_shape: 'unexpected' })).toBe('basic');
  });

  it('claimHasFullMeasurements is true only for an exact full shape', () => {
    expect(claimHasFullMeasurements({ measurement_shape: 'full' })).toBe(true);
    expect(claimHasFullMeasurements({ measurement_shape: 'basic' })).toBe(false);
    expect(claimHasFullMeasurements(null)).toBe(false);
    expect(claimHasFullMeasurements(undefined)).toBe(false);
  });
});
