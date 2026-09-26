/**
 * Unit tests for the gh-951 sessionStorage persistence helpers
 * (../hover-charge-storage.ts). Runs against real jsdom sessionStorage — no mocking.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  saveHoverChargeRecord,
  readHoverChargeRecord,
  clearHoverChargeRecord,
  hasFiredMeasurementPurchase,
  markMeasurementPurchaseFired,
} from '../hover-charge-storage';

afterEach(() => {
  clearHoverChargeRecord();
});

describe('hover-charge-storage', () => {
  it('round-trips a saved record', () => {
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_1', ts: 1234 });
    expect(readHoverChargeRecord()).toEqual({ claimId: 'c1', paymentIntentId: 'pi_1', ts: 1234 });
  });

  it('returns null when nothing has been saved', () => {
    expect(readHoverChargeRecord()).toBeNull();
  });

  it('clears the record', () => {
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_1', ts: 1234 });
    clearHoverChargeRecord();
    expect(readHoverChargeRecord()).toBeNull();
  });

  it('a later save overwrites the earlier one (single-slot, not a queue)', () => {
    saveHoverChargeRecord({ claimId: 'c1', paymentIntentId: 'pi_1', ts: 1 });
    saveHoverChargeRecord({ claimId: 'c2', paymentIntentId: 'pi_2', ts: 2 });
    expect(readHoverChargeRecord()).toEqual({ claimId: 'c2', paymentIntentId: 'pi_2', ts: 2 });
  });

  it('returns null instead of throwing on corrupt JSON in the storage slot', () => {
    window.sessionStorage.setItem('oq_hm_hover_charge_v1', '{not json');
    expect(readHoverChargeRecord()).toBeNull();
  });

  it('returns null for a validly-parsed but wrong-shaped payload', () => {
    window.sessionStorage.setItem('oq_hm_hover_charge_v1', JSON.stringify({ foo: 'bar' }));
    expect(readHoverChargeRecord()).toBeNull();
  });
});


describe('measurement_purchase once-only guard (gh-2078)', () => {
  afterEach(() => {
    localStorage.removeItem('oq_ga4_measurement_purchase_fired_v1:pi_test_1');
    localStorage.removeItem('oq_ga4_measurement_purchase_fired_v1:pi_test_2');
  });

  it('has not fired for a fresh paymentIntent id', () => {
    expect(hasFiredMeasurementPurchase('pi_test_1')).toBe(false);
  });

  it('reports fired after being marked, for that id only', () => {
    markMeasurementPurchaseFired('pi_test_1');
    expect(hasFiredMeasurementPurchase('pi_test_1')).toBe(true);
    expect(hasFiredMeasurementPurchase('pi_test_2')).toBe(false);
  });

  it('marking is idempotent — calling it twice does not throw or double-key', () => {
    markMeasurementPurchaseFired('pi_test_1');
    markMeasurementPurchaseFired('pi_test_1');
    expect(hasFiredMeasurementPurchase('pi_test_1')).toBe(true);
  });
});
