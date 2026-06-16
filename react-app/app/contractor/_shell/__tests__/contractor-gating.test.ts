/**
 * Unit tests for the contractor pending-approval gate (D-211 Phase 2 shell).
 */

import { describe, it, expect } from 'vitest';
import { isPendingApproval } from '../contractor-gating';

describe('isPendingApproval', () => {
  it('is true when a status is present and not active', () => {
    expect(isPendingApproval({ status: 'pending_approval' })).toBe(true);
    expect(isPendingApproval({ status: 'suspended' })).toBe(true);
  });
  it('is false when active', () => {
    expect(isPendingApproval({ status: 'active' })).toBe(false);
  });
  it('is false when status is missing/empty (matches the static guard)', () => {
    expect(isPendingApproval({})).toBe(false);
    expect(isPendingApproval({ status: null })).toBe(false);
    expect(isPendingApproval({ status: '' })).toBe(false);
    expect(isPendingApproval(null)).toBe(false);
    expect(isPendingApproval(undefined)).toBe(false);
  });
});
