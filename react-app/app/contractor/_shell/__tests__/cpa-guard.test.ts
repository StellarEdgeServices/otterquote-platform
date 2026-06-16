/**
 * Unit tests for the contractor CPA version guard (D-211 Phase 2 shell).
 * Pure mechanism — covers re-attestation detection, the dashboard modal gate,
 * and the cross-page anti-loop redirect guard. (The verbatim D-230 modal copy is
 * tested in the dashboard page's own parity test, not here.)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CURRENT_CPA_VERSION,
  CPA_REDIRECT_GUARD_KEY,
  needsCpaReattestation,
  shouldShowCpaModal,
  isCpaRedirectGuardSet,
  setCpaRedirectGuard,
  clearCpaRedirectGuard,
  enforceCpaRedirect,
} from '../cpa-guard';

beforeEach(() => {
  localStorage.clear();
});

describe('CURRENT_CPA_VERSION', () => {
  it('matches the static contractor-dashboard.html value (byte-for-byte)', () => {
    expect(CURRENT_CPA_VERSION).toBe('v1-2026-04');
  });
});

describe('needsCpaReattestation', () => {
  it('is false on the current version with no re-attest flag', () => {
    expect(
      needsCpaReattestation({ cpa_version: CURRENT_CPA_VERSION, needs_cpa_reattestation: false }),
    ).toBe(false);
  });
  it('is true when the recorded version is behind', () => {
    expect(needsCpaReattestation({ cpa_version: 'v0-2025-01' })).toBe(true);
  });
  it('is true when the version is missing (new contractor)', () => {
    expect(needsCpaReattestation({})).toBe(true);
    expect(needsCpaReattestation({ cpa_version: null })).toBe(true);
  });
  it('is true when D-230 needs_cpa_reattestation is set even on the current version', () => {
    expect(
      needsCpaReattestation({ cpa_version: CURRENT_CPA_VERSION, needs_cpa_reattestation: true }),
    ).toBe(true);
  });
  it('is false for a null/undefined contractor', () => {
    expect(needsCpaReattestation(null)).toBe(false);
    expect(needsCpaReattestation(undefined)).toBe(false);
  });
});

describe('shouldShowCpaModal (dashboard re-accept gate)', () => {
  it('only fires after the first-time agreement is accepted (modals never stack)', () => {
    expect(shouldShowCpaModal({ cpa_version: 'v0', agreement_accepted_at: null })).toBe(false);
    expect(
      shouldShowCpaModal({ cpa_version: 'v0', agreement_accepted_at: '2026-01-01T00:00:00Z' }),
    ).toBe(true);
  });
  it('is false when the CPA is already current', () => {
    expect(
      shouldShowCpaModal({
        cpa_version: CURRENT_CPA_VERSION,
        agreement_accepted_at: '2026-01-01T00:00:00Z',
      }),
    ).toBe(false);
  });
});

describe('anti-loop redirect guard', () => {
  it('set / read / clear round-trips via localStorage', () => {
    expect(isCpaRedirectGuardSet()).toBe(false);
    setCpaRedirectGuard();
    expect(localStorage.getItem(CPA_REDIRECT_GUARD_KEY)).toBe('1');
    expect(isCpaRedirectGuardSet()).toBe(true);
    clearCpaRedirectGuard();
    expect(isCpaRedirectGuardSet()).toBe(false);
  });
});

describe('enforceCpaRedirect (non-dashboard contractor pages)', () => {
  it('redirects a stale contractor to the dashboard once and sets the guard', () => {
    const redirect = vi.fn();
    const did = enforceCpaRedirect({ cpa_version: 'v0' }, redirect);
    expect(did).toBe(true);
    expect(redirect).toHaveBeenCalledWith('/contractor/dashboard');
    expect(isCpaRedirectGuardSet()).toBe(true);
  });
  it('does NOT redirect again once the guard is set (anti-loop)', () => {
    setCpaRedirectGuard();
    const redirect = vi.fn();
    const did = enforceCpaRedirect({ cpa_version: 'v0' }, redirect);
    expect(did).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });
  it('does not redirect a current contractor and clears any stale guard', () => {
    setCpaRedirectGuard();
    const redirect = vi.fn();
    const did = enforceCpaRedirect({ cpa_version: CURRENT_CPA_VERSION }, redirect);
    expect(did).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
    expect(isCpaRedirectGuardSet()).toBe(false);
  });
  it('honors a custom dashboard URL', () => {
    const redirect = vi.fn();
    enforceCpaRedirect({ needs_cpa_reattestation: true }, redirect, '/x/dash');
    expect(redirect).toHaveBeenCalledWith('/x/dash');
  });
});
