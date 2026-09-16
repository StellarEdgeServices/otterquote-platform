/**
 * Unit tests for get-started page utility functions — D-211 Phase 2
 */

import { describe, it, expect } from 'vitest';
import { formatPhoneValue, isValidEmail, isValidZip, fullAddress } from '../utils';

describe('formatPhoneValue', () => {
  it('formats a 10-digit number', () => {
    expect(formatPhoneValue('3175551234')).toBe('(317) 555-1234');
  });

  it('strips leading country code 1 from 11-digit number', () => {
    expect(formatPhoneValue('13175551234')).toBe('(317) 555-1234');
  });

  it('handles partial input — 3 digits', () => {
    expect(formatPhoneValue('317')).toBe('(317');
  });

  it('handles partial input — 6 digits', () => {
    expect(formatPhoneValue('317555')).toBe('(317) 555');
  });

  it('returns empty string for empty input', () => {
    expect(formatPhoneValue('')).toBe('');
  });

  it('strips non-numeric characters', () => {
    expect(formatPhoneValue('(317) 555-1234')).toBe('(317) 555-1234');
  });

  it('truncates to 10 digits max', () => {
    expect(formatPhoneValue('31755512349999')).toBe('(317) 555-1234');
  });
});

describe('isValidEmail', () => {
  it('accepts valid email addresses', () => {
    expect(isValidEmail('jane@example.com')).toBe(true);
    expect(isValidEmail('user+tag@domain.org')).toBe(true);
    expect(isValidEmail('a@b.co')).toBe(true);
  });

  it('rejects invalid email addresses', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('@domain.com')).toBe(false);
    expect(isValidEmail('user@')).toBe(false);
    expect(isValidEmail('user @domain.com')).toBe(false);
  });
});

// gh-1993: single "address" box replaced with Street / City / State / ZIP.
describe('isValidZip', () => {
  it('accepts exactly 5 digits', () => {
    expect(isValidZip('46201')).toBe(true);
    expect(isValidZip(' 46201 ')).toBe(true);
  });

  it('rejects anything not exactly 5 digits', () => {
    expect(isValidZip('')).toBe(false);
    expect(isValidZip('4620')).toBe(false);
    expect(isValidZip('462011')).toBe(false);
    expect(isValidZip('4620a')).toBe(false);
    expect(isValidZip('46201-1234')).toBe(false);
  });
});

describe('fullAddress', () => {
  it('joins all four fields with the standard "street, city, state zip" shape', () => {
    expect(fullAddress('123 Main St', 'Anytown', 'IN', '46201')).toBe('123 Main St, Anytown, IN 46201');
  });

  it('omits a blank city without leaving a stray comma', () => {
    expect(fullAddress('123 Main St', '', 'IN', '46201')).toBe('123 Main St, IN 46201');
  });

  it('omits a blank state/zip pair without a stray trailing separator', () => {
    expect(fullAddress('123 Main St', 'Anytown', '', '')).toBe('123 Main St, Anytown');
  });

  it('trims whitespace on every segment', () => {
    expect(fullAddress('  123 Main St  ', ' Anytown ', ' IN ', ' 46201 ')).toBe('123 Main St, Anytown, IN 46201');
  });

  it('returns empty string when every field is blank', () => {
    expect(fullAddress('', '', '', '')).toBe('');
  });
});
