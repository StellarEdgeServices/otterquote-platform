/**
 * Unit tests for the gh-951 sessionStorage persistence helpers
 * (../hover-charge-storage.ts). Runs against real jsdom sessionStorage — no mocking.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  saveHoverChargeRecord,
  readHoverChargeRecord,
  clearHoverChargeRecord,
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
