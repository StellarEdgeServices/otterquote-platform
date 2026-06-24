/**
 * Unit tests for the homeowner help-measurements pure helpers
 * (D-211 Phase 28 — PR 1/2, ADDITIVE).
 *
 * Covers the param builders (typed against app/lib/services.ts), the two distinct
 * homeowner-name resolutions, address-line resolution, the email-readiness gate (mirroring the
 * static checkReady — email-only), and the path decision. All functions are pure; no DOM,
 * network, Supabase, or Stripe is touched.
 */

import { describe, it, expect } from 'vitest';
import {
  HOVER_AMOUNT_CENTS,
  HOVER_AMOUNT_DOLLARS,
  HOVER_DELIVERABLE_TYPE_ID,
  HOVER_PAYMENT_DESCRIPTION,
  MEASUREMENTS_REQUEST_TYPE,
  resolveHomeownerName,
  resolveAddressLine1,
  buildHoverPaymentIntentParams,
  buildHoverOrderParams,
  buildAdjusterEmailParams,
  buildAdjusterClaimWriteback,
  isAdjusterFormValid,
  isHoverPath,
} from '../utils';

describe('constants (D-205 / D-181 parity values)', () => {
  it('matches the static charge/deliverable/description constants', () => {
    expect(HOVER_AMOUNT_CENTS).toBe(15000);
    expect(HOVER_AMOUNT_DOLLARS).toBe(150.0);
    expect(HOVER_DELIVERABLE_TYPE_ID).toBe(3);
    expect(HOVER_PAYMENT_DESCRIPTION).toBe('Hover Complete Property Data File');
    expect(MEASUREMENTS_REQUEST_TYPE).toBe('measurements');
  });
});

describe('resolveHomeownerName (Hover path — full_name || first+last || Homeowner)', () => {
  it('prefers full_name when present', () => {
    expect(resolveHomeownerName({ full_name: 'Jane Roof', first_name: 'X', last_name: 'Y' })).toBe(
      'Jane Roof',
    );
  });

  it('falls back to trimmed first + last', () => {
    expect(resolveHomeownerName({ first_name: 'Jane', last_name: 'Roof' })).toBe('Jane Roof');
  });

  it('trims a one-sided name (first only / last only)', () => {
    expect(resolveHomeownerName({ first_name: 'Jane' })).toBe('Jane');
    expect(resolveHomeownerName({ last_name: 'Roof' })).toBe('Roof');
  });

  it("falls back to 'Homeowner' when nothing usable is present", () => {
    expect(resolveHomeownerName({})).toBe('Homeowner');
    expect(resolveHomeownerName(null)).toBe('Homeowner');
    expect(resolveHomeownerName(undefined)).toBe('Homeowner');
    expect(resolveHomeownerName({ first_name: '', last_name: '' })).toBe('Homeowner');
  });
});

describe('resolveAddressLine1', () => {
  it('prefers profile.address_line1', () => {
    expect(
      resolveAddressLine1(
        { address_line1: '123 Main St' },
        { id: 'c1', property_address: '999 Other Ave, Town, IN 46077' },
      ),
    ).toBe('123 Main St');
  });

  it('falls back to the first comma-segment of the claim property_address, trimmed', () => {
    expect(
      resolveAddressLine1({}, { id: 'c1', property_address: '456 Elm Rd, Carmel, IN 46032' }),
    ).toBe('456 Elm Rd');
  });

  it("returns '' when neither source is present", () => {
    expect(resolveAddressLine1(null, { id: 'c1' })).toBe('');
    expect(resolveAddressLine1({}, { id: 'c1', property_address: '' })).toBe('');
  });
});

describe('buildHoverPaymentIntentParams', () => {
  it('shapes the PaymentIntent params with claim_id + 15000c + description', () => {
    expect(buildHoverPaymentIntentParams({ id: 'claim-1' })).toEqual({
      claim_id: 'claim-1',
      amount: 15000,
      description: 'Hover Complete Property Data File',
    });
  });
});

describe('buildHoverOrderParams', () => {
  const profile = {
    full_name: 'Jane Roof',
    phone: '(317) 555-1234',
    address_line1: '123 Main St',
    address_city: 'Carmel',
    address_state: 'IN',
    address_zip: '46032',
  };
  const claim = { id: 'claim-1', property_address: '123 Main St, Carmel, IN 46032' };
  const user = { id: 'user-9', email: 'jane@example.com' };

  it('assembles a full order from loaded state', () => {
    expect(
      buildHoverOrderParams({ profile, claim, user, paymentIntentId: 'pi_abc' }),
    ).toEqual({
      claim_id: 'claim-1',
      user_id: 'user-9',
      address_line_1: '123 Main St',
      address_city: 'Carmel',
      address_state: 'IN',
      address_zip: '46032',
      homeowner_name: 'Jane Roof',
      homeowner_email: 'jane@example.com',
      homeowner_phone: '(317) 555-1234',
      amount_charged: 150.0,
      deliverable_type_id: 3,
      payment_intent_id: 'pi_abc',
    });
  });

  it('uses resolveHomeownerName (first+last) when full_name is absent', () => {
    const out = buildHoverOrderParams({
      profile: { first_name: 'Jane', last_name: 'Roof' },
      claim,
      user,
      paymentIntentId: 'pi_abc',
    });
    expect(out.homeowner_name).toBe('Jane Roof');
  });

  it('defaults address/email/phone to empty strings when state is missing', () => {
    const out = buildHoverOrderParams({
      profile: null,
      claim: { id: 'claim-2' },
      user: null,
      paymentIntentId: 'pi_x',
    });
    expect(out.address_line_1).toBe('');
    expect(out.address_city).toBe('');
    expect(out.address_state).toBe('');
    expect(out.address_zip).toBe('');
    expect(out.homeowner_email).toBe('');
    expect(out.homeowner_phone).toBe('');
    expect(out.homeowner_name).toBe('Homeowner');
    expect(out.user_id).toBe('');
  });

  it('always carries the D-205 amount/deliverable + the D-181 payment_intent_id', () => {
    const out = buildHoverOrderParams({ profile, claim, user, paymentIntentId: 'pi_guard' });
    expect(out.amount_charged).toBe(150.0);
    expect(out.deliverable_type_id).toBe(3);
    expect(out.payment_intent_id).toBe('pi_guard');
  });
});

describe('buildAdjusterEmailParams (adjuster path — simpler full_name || Homeowner)', () => {
  const claim = { id: 'claim-1', claim_number: 'CLM-2024-00001' };

  it('assembles the measurements request params', () => {
    expect(
      buildAdjusterEmailParams({
        claim,
        profile: { full_name: 'Jane Roof', phone: '(317) 555-0000' },
        adjusterName: 'John Smith',
        adjusterEmail: 'john.smith@insurance.com',
        adjusterPhone: '(317) 555-1234',
      }),
    ).toEqual({
      claim_id: 'claim-1',
      adjuster_name: 'John Smith',
      adjuster_email: 'john.smith@insurance.com',
      homeowner_name: 'Jane Roof',
      homeowner_phone: '(317) 555-0000',
      claim_number: 'CLM-2024-00001',
      request_type: 'measurements',
    });
  });

  it("defaults adjuster_name to 'Adjuster' when blank", () => {
    const out = buildAdjusterEmailParams({
      claim,
      profile: { full_name: 'Jane Roof' },
      adjusterName: '',
      adjusterEmail: 'a@b.com',
      adjusterPhone: '',
    });
    expect(out.adjuster_name).toBe('Adjuster');
  });

  it("uses the SIMPLER full_name || 'Homeowner' (NOT first+last)", () => {
    // first/last present but full_name absent → must NOT resolve to 'Jane Roof' here
    const out = buildAdjusterEmailParams({
      claim,
      profile: { first_name: 'Jane', last_name: 'Roof' },
      adjusterName: 'John',
      adjusterEmail: 'a@b.com',
      adjusterPhone: '',
    });
    expect(out.homeowner_name).toBe('Homeowner');
  });

  it('falls back homeowner_phone: profile.phone → adjusterPhone → empty', () => {
    expect(
      buildAdjusterEmailParams({
        claim,
        profile: {},
        adjusterName: 'John',
        adjusterEmail: 'a@b.com',
        adjusterPhone: '(555) 222-3333',
      }).homeowner_phone,
    ).toBe('(555) 222-3333');
    expect(
      buildAdjusterEmailParams({
        claim,
        profile: {},
        adjusterName: 'John',
        adjusterEmail: 'a@b.com',
        adjusterPhone: '',
      }).homeowner_phone,
    ).toBe('');
  });

  it('omits claim_number (undefined) when the claim has none', () => {
    const out = buildAdjusterEmailParams({
      claim: { id: 'claim-3' },
      profile: { full_name: 'Jane' },
      adjusterName: 'John',
      adjusterEmail: 'a@b.com',
      adjusterPhone: '',
    });
    expect(out.claim_number).toBeUndefined();
  });

  it("always sets request_type to 'measurements'", () => {
    const out = buildAdjusterEmailParams({
      claim,
      profile: { full_name: 'Jane' },
      adjusterName: 'John',
      adjusterEmail: 'a@b.com',
      adjusterPhone: '',
    });
    expect(out.request_type).toBe('measurements');
  });
});

describe('isAdjusterFormValid (email-only gate, mirrors static checkReady)', () => {
  it('is valid when email is non-empty and contains @', () => {
    expect(isAdjusterFormValid({ adjusterEmail: 'john@insurance.com' })).toBe(true);
  });

  it('is invalid for empty or @-less email', () => {
    expect(isAdjusterFormValid({ adjusterEmail: '' })).toBe(false);
    expect(isAdjusterFormValid({ adjusterEmail: '   ' })).toBe(false);
    expect(isAdjusterFormValid({ adjusterEmail: 'notanemail' })).toBe(false);
  });

  it('trims before checking', () => {
    expect(isAdjusterFormValid({ adjusterEmail: '  john@x.com  ' })).toBe(true);
  });

  it('ignores adjusterName — name is NOT part of the gate', () => {
    // missing name but valid email → still valid
    expect(isAdjusterFormValid({ adjusterEmail: 'john@x.com' })).toBe(true);
    // present name but invalid email → still invalid
    expect(isAdjusterFormValid({ adjusterEmail: '', adjusterName: 'John Smith' })).toBe(false);
  });
});

describe('buildAdjusterClaimWriteback (write only entered values into empty claim fields)', () => {
  it('writes all three fields when the claim has none', () => {
    expect(
      buildAdjusterClaimWriteback({
        claim: {},
        adjusterName: 'John Smith',
        adjusterEmail: 'john@insurance.com',
        adjusterPhone: '(317) 555-1234',
      }),
    ).toEqual({
      adjuster_name: 'John Smith',
      adjuster_email: 'john@insurance.com',
      adjuster_phone: '(317) 555-1234',
    });
  });

  it('skips a field whose claim value is already set (does NOT overwrite)', () => {
    expect(
      buildAdjusterClaimWriteback({
        claim: { adjuster_name: 'Existing', adjuster_email: null, adjuster_phone: '' },
        adjusterName: 'New Name',
        adjusterEmail: 'new@insurance.com',
        adjusterPhone: '(317) 555-9999',
      }),
    ).toEqual({
      adjuster_email: 'new@insurance.com',
      adjuster_phone: '(317) 555-9999',
    });
  });

  it('skips a field whose entered value is empty', () => {
    expect(
      buildAdjusterClaimWriteback({
        claim: {},
        adjusterName: '',
        adjusterEmail: 'only@email.com',
        adjusterPhone: '',
      }),
    ).toEqual({ adjuster_email: 'only@email.com' });
  });

  it('returns {} when there is nothing to write', () => {
    expect(
      buildAdjusterClaimWriteback({
        claim: { adjuster_name: 'A', adjuster_email: 'b@c.com', adjuster_phone: '111' },
        adjusterName: 'A2',
        adjusterEmail: 'b2@c.com',
        adjusterPhone: '222',
      }),
    ).toEqual({});
  });
});

describe('isHoverPath', () => {
  it("is true only for the literal 'hover' path", () => {
    expect(isHoverPath('hover')).toBe(true);
  });

  it('is false for the adjuster path and any other/empty value', () => {
    expect(isHoverPath('adjuster')).toBe(false);
    expect(isHoverPath('Hover')).toBe(false);
    expect(isHoverPath('')).toBe(false);
    expect(isHoverPath(null)).toBe(false);
    expect(isHoverPath(undefined)).toBe(false);
  });
});
