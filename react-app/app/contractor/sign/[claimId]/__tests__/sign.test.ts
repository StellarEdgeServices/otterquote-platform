/**
 * Parity + unit tests for the contractor contract-signing surface
 * (D-211 Phase 17 Unit B).
 *
 *  1. TIER-3 verbatim copy: the IC 24-5-11 contractor-signs-first disclaimer is
 *     asserted BYTE-FOR-BYTE against contractor-bid-form.html #contractSigningStep,
 *     and the signed-confirmation + "Returning" bridge text against
 *     contract-signing.html. Any reword of ./copy.ts trips this — the intended
 *     Tier-3 tripwire.
 *  2. Pure gate logic (./utils): selected-quote resolution, the ready /
 *     already-signed / no-contract gate, claimId-from-path, and the DocuSign
 *     completion-event check (cancel must NOT read as complete).
 */

import { describe, it, expect } from 'vitest';
import { SIGN_COPY } from '../copy';
import {
  resolveClaimIdFromPath,
  resolveSelectedQuote,
  resolveSignGate,
  isSigningCompleteEvent,
  type SignableQuote,
} from '../utils';
import { contractorNeedsToSign } from '../../../dashboard/utils';

// ── Verbatim source strings ──
// IC 24-5-11 disclaimer: contractor-bid-form.html #contractSigningStep (~lines 2348-2355).
const STATIC_LEGAL = {
  heading: '⚖️ Sign Your Contract — Required by Indiana Law',
  para1:
    'Indiana law (IC 24-5-11) requires that you, as the contractor, sign the contract before the homeowner. Your contract template has been pre-filled with the project details. Please review and sign below.',
  para2:
    'An IC 24-5-11 compliance addendum (Statement of Right to Cancel + Notice of Cancellation) has been automatically attached.',
};
// Success + bridge: contract-signing.html (#docusignSigned + iframe-detection block).
const STATIC_REF = {
  signedTitle: 'Contract Signed Successfully',
  signedBody: 'Your signed contract has been recorded.',
  returningText: 'Contract signed! Returning...',
};

describe('TIER-3 verbatim legal copy (byte-for-byte)', () => {
  it('IC 24-5-11 disclaimer matches contractor-bid-form.html exactly', () => {
    expect(SIGN_COPY.legalHeading).toBe(STATIC_LEGAL.heading);
    // Para 1 is split around the bold "before" — reconstitute and compare.
    expect(
      SIGN_COPY.legalPara1Lead + SIGN_COPY.legalPara1Emphasis + SIGN_COPY.legalPara1Tail,
    ).toBe(STATIC_LEGAL.para1);
    expect(SIGN_COPY.legalPara2).toBe(STATIC_LEGAL.para2);
  });

  it('signed-confirmation + bridge copy matches contract-signing.html exactly', () => {
    expect(SIGN_COPY.signedTitle).toBe(STATIC_REF.signedTitle);
    expect(SIGN_COPY.signedBody).toBe(STATIC_REF.signedBody);
    expect(SIGN_COPY.returningText).toBe(STATIC_REF.returningText);
  });
});

describe('resolveClaimIdFromPath', () => {
  it('extracts the claim segment from the sign route', () => {
    expect(resolveClaimIdFromPath('/contractor/sign/abc-123')).toBe('abc-123');
    expect(resolveClaimIdFromPath('/contractor/sign/abc-123?signed=contractor')).toBe('abc-123');
    expect(resolveClaimIdFromPath('/contractor/sign/abc%2D123')).toBe('abc-123');
  });
  it('returns null when there is no claim segment', () => {
    expect(resolveClaimIdFromPath('/contractor/dashboard')).toBeNull();
    expect(resolveClaimIdFromPath('/contractor/sign/')).toBeNull();
  });
});

describe('resolveSelectedQuote', () => {
  const ME = 'ctr-1';
  const q = (over: Partial<SignableQuote>): SignableQuote => ({
    id: 'q', contractor_id: ME, status: 'selected', contractor_signed_at: null, ...over,
  });

  it('returns the selected/awarded quote owned by this contractor', () => {
    expect(resolveSelectedQuote([q({ id: 'a', status: 'selected' })], ME)?.id).toBe('a');
    expect(resolveSelectedQuote([q({ id: 'b', status: 'awarded' })], ME)?.id).toBe('b');
  });
  it('ignores quotes in a non-signable status', () => {
    expect(resolveSelectedQuote([q({ status: 'submitted' })], ME)).toBeNull();
    expect(resolveSelectedQuote([q({ status: 'rescinded' })], ME)).toBeNull();
    expect(resolveSelectedQuote([q({ status: 'completed' })], ME)).toBeNull();
  });
  it('ignores quotes belonging to another contractor', () => {
    expect(resolveSelectedQuote([q({ contractor_id: 'other', status: 'selected' })], ME)).toBeNull();
  });
  it('handles empty / nullish input', () => {
    expect(resolveSelectedQuote([], ME)).toBeNull();
    expect(resolveSelectedQuote(null, ME)).toBeNull();
    expect(resolveSelectedQuote(undefined, ME)).toBeNull();
    expect(resolveSelectedQuote([q({})], '')).toBeNull();
  });
});

describe('resolveSignGate', () => {
  it('ready when a selected quote is not yet contractor-signed', () => {
    expect(resolveSignGate({ id: 'q', status: 'selected', contractor_signed_at: null })).toBe('ready');
    expect(resolveSignGate({ id: 'q', status: 'awarded', contractor_signed_at: null })).toBe('ready');
  });
  it('already-signed once contractor_signed_at is set', () => {
    expect(
      resolveSignGate({ id: 'q', status: 'selected', contractor_signed_at: '2026-06-19T00:00:00Z' }),
    ).toBe('already-signed');
  });
  it('no-contract when there is no selected quote', () => {
    expect(resolveSignGate(null)).toBe('no-contract');
  });
});

describe('contractorNeedsToSign (shared dashboard CTA gate)', () => {
  it('true only for selected/awarded with no signature on file', () => {
    expect(contractorNeedsToSign('selected', null)).toBe(true);
    expect(contractorNeedsToSign('awarded', null)).toBe(true);
    expect(contractorNeedsToSign('selected', '2026-06-19T00:00:00Z')).toBe(false);
    expect(contractorNeedsToSign('submitted', null)).toBe(false);
    expect(contractorNeedsToSign('completed', null)).toBe(false);
    expect(contractorNeedsToSign(null, null)).toBe(false);
  });
});

describe('isSigningCompleteEvent', () => {
  const params = (qs: string) => new URLSearchParams(qs);
  it('true only for the DocuSign completion event', () => {
    expect(isSigningCompleteEvent(params('event=signing_complete'))).toBe(true);
    expect(isSigningCompleteEvent(params('signed=contractor&event=signing_complete'))).toBe(true);
  });
  it('false for cancel/decline or a bare return marker (no false success)', () => {
    expect(isSigningCompleteEvent(params('signed=contractor&event=cancel'))).toBe(false);
    expect(isSigningCompleteEvent(params('event=decline'))).toBe(false);
    expect(isSigningCompleteEvent(params('signed=contractor'))).toBe(false);
    expect(isSigningCompleteEvent(params(''))).toBe(false);
  });
});
