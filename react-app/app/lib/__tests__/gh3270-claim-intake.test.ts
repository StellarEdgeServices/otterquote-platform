import { describe, expect, it } from 'vitest';
import { claimFinishedIntake, signupEmailMismatch } from '../claim-intake';

describe('gh-3270 claimFinishedIntake', () => {
  it('is false for no claim, a NULL address and a blank address', () => {
    expect(claimFinishedIntake(null)).toBe(false);
    expect(claimFinishedIntake(undefined)).toBe(false);
    expect(claimFinishedIntake({ id: 'x', property_address: null })).toBe(false);
    expect(claimFinishedIntake({ id: 'x', property_address: '  ' })).toBe(false);
    expect(claimFinishedIntake({ id: 'x' })).toBe(false);
  });
  it('is true once property_address is set', () => {
    expect(claimFinishedIntake({ id: 'x', property_address: '1 Main St, Zionsville, IN 46077' })).toBe(true);
  });
});

describe('gh-3270 signupEmailMismatch', () => {
  it('is true only when both are present and differ', () => {
    expect(signupEmailMismatch('a@example.com', 'b@example.com')).toBe(true);
    expect(signupEmailMismatch(' A@Example.com ', 'a@example.com')).toBe(false);
    expect(signupEmailMismatch('', 'a@example.com')).toBe(false);
    expect(signupEmailMismatch(null, 'a@example.com')).toBe(false);
    expect(signupEmailMismatch('a@example.com', undefined)).toBe(false);
  });
});
