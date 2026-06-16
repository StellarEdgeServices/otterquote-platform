/**
 * Unit tests for the contractor dashboard ⇄ login loop-proof marker (D-211,
 * postmortem 2026-06-16). The marker is the client-side-nav-surviving replacement
 * for the old document.referrer guard (which a Next.js router.replace bounce never
 * set).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  markContractorGateBounce,
  consumeContractorGateBounce,
  CONTRACTOR_GATE_BOUNCE_KEY,
  CONTRACTOR_GATE_BOUNCE_TTL_MS,
} from '../contractor-gate';

beforeEach(() => {
  sessionStorage.clear();
});

describe('contractor gate-bounce one-shot marker', () => {
  it('consume returns false when no marker is set', () => {
    expect(consumeContractorGateBounce()).toBe(false);
  });

  it('mark then consume returns true exactly once (one-shot)', () => {
    markContractorGateBounce(1000);
    expect(consumeContractorGateBounce(1000)).toBe(true);
    expect(consumeContractorGateBounce(1000)).toBe(false); // already cleared
  });

  it('clears the sessionStorage key on consume', () => {
    markContractorGateBounce(1000);
    expect(sessionStorage.getItem(CONTRACTOR_GATE_BOUNCE_KEY)).toBe('1000');
    consumeContractorGateBounce(1000);
    expect(sessionStorage.getItem(CONTRACTOR_GATE_BOUNCE_KEY)).toBeNull();
  });

  it('ignores (and clears) a stale marker older than the TTL', () => {
    markContractorGateBounce(1000);
    const later = 1000 + CONTRACTOR_GATE_BOUNCE_TTL_MS + 1;
    expect(consumeContractorGateBounce(later)).toBe(false);
    expect(sessionStorage.getItem(CONTRACTOR_GATE_BOUNCE_KEY)).toBeNull();
  });

  it('treats a marker exactly at the TTL boundary as fresh', () => {
    markContractorGateBounce(1000);
    expect(consumeContractorGateBounce(1000 + CONTRACTOR_GATE_BOUNCE_TTL_MS)).toBe(true);
  });

  it('ignores a non-numeric marker value', () => {
    sessionStorage.setItem(CONTRACTOR_GATE_BOUNCE_KEY, 'not-a-number');
    expect(consumeContractorGateBounce()).toBe(false);
  });

  it('does not throw and returns false when sessionStorage access throws', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('blocked'); },
    });
    try {
      expect(() => markContractorGateBounce()).not.toThrow();
      expect(consumeContractorGateBounce()).toBe(false);
    } finally {
      if (original) Object.defineProperty(window, 'sessionStorage', original);
    }
  });
});
