/**
 * gh-3471 (D-419): the return flag is an allowlist of tokens. Nothing a visitor types can become a destination.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  RETURN_STORAGE_KEY,
  RETURN_TTL_MS,
  RETURN_TARGETS,
  HOMEOWNER_DASHBOARD_URL,
  captureReturnFromUrl,
  dashboardUrlWithReturn,
  parseReturnToken,
  readReturnFromUrl,
  takeStoredReturn,
  withReturn,
} from '../return-target';

describe('parseReturnToken (allowlist, no open redirect)', () => {
  it('accepts exactly the allowlisted token', () => {
    expect(parseReturnToken('measurements')).toBe('measurements');
  });

  it.each([
    'https://evil.example/',
    '//evil.example',
    'javascript:alert(1)',
    '/help-measurements.html',
    'https://otterquote.com/help-measurements.html',
    'MEASUREMENTS',
    'measurements ',
    'measurements/../x',
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    '',
  ])('rejects %j', (bad) => {
    expect(parseReturnToken(bad)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseReturnToken(null)).toBeNull();
    expect(parseReturnToken(undefined)).toBeNull();
    expect(parseReturnToken(['measurements'])).toBeNull();
    expect(parseReturnToken({ measurements: 1 })).toBeNull();
  });

  it('every target is an https URL on otterquote.com', () => {
    for (const url of Object.values(RETURN_TARGETS)) {
      expect(new URL(url).origin).toBe('https://otterquote.com');
    }
  });
});

describe('withReturn', () => {
  it('adds the token with ? or & and leaves a null token alone', () => {
    expect(withReturn('/trade-selector', 'measurements')).toBe('/trade-selector?return=measurements');
    expect(withReturn('https://otterquote.com/project-info-rcv.html?claim_id=abc', 'measurements')).toBe(
      'https://otterquote.com/project-info-rcv.html?claim_id=abc&return=measurements',
    );
    expect(withReturn('/trade-selector', null)).toBe('/trade-selector');
  });
});

describe('stored return (get-started to auth-callback)', () => {
  beforeEach(() => sessionStorage.clear());

  it('keeps a valid token and hands it over once', () => {
    expect(captureReturnFromUrl('?return=measurements&v=d')).toBe('measurements');
    expect(sessionStorage.getItem(RETURN_STORAGE_KEY)).toMatch(/^measurements\|\d+$/);
    expect(takeStoredReturn()).toBe('measurements');
    expect(takeStoredReturn()).toBeNull();
  });

  it('never stores an invalid token, and a visit without one clears an old one', () => {
    expect(captureReturnFromUrl('?return=https%3A%2F%2Fevil.example')).toBeNull();
    expect(sessionStorage.getItem(RETURN_STORAGE_KEY)).toBeNull();
    captureReturnFromUrl('?return=measurements');
    captureReturnFromUrl('?v=d');
    expect(takeStoredReturn()).toBeNull();
  });

  it('re-validates what it reads back', () => {
    sessionStorage.setItem(RETURN_STORAGE_KEY, 'https://evil.example/|' + String(Date.now()));
    expect(takeStoredReturn()).toBeNull();
  });

  it('oq_return older than the 30 minute TTL, untimestamped or future-dated is stale: dropped and cleared', () => {
    sessionStorage.setItem(RETURN_STORAGE_KEY, 'measurements|' + String(Date.now() - RETURN_TTL_MS - 1000));
    expect(takeStoredReturn()).toBeNull();
    expect(sessionStorage.getItem(RETURN_STORAGE_KEY)).toBeNull();
    sessionStorage.setItem(RETURN_STORAGE_KEY, 'measurements');
    expect(takeStoredReturn()).toBeNull();
    sessionStorage.setItem(RETURN_STORAGE_KEY, 'measurements|' + String(Date.now() + 3600_000));
    expect(takeStoredReturn()).toBeNull();
    sessionStorage.setItem(RETURN_STORAGE_KEY, 'measurements|' + String(Date.now() - 60_000));
    expect(takeStoredReturn()).toBe('measurements');
  });

  it('readReturnFromUrl only returns allowlisted tokens', () => {
    expect(readReturnFromUrl('?claim_id=1&return=measurements')).toBe('measurements');
    expect(readReturnFromUrl('?return=//evil.example')).toBeNull();
    expect(readReturnFromUrl('')).toBeNull();
  });
});

describe('dashboardUrlWithReturn (gh-3283 / gh-3285: the RCV and OOP pages keep the return flag)', () => {
  it('carries an allowlisted token forward to the static dashboard, ignoring other params', () => {
    expect(dashboardUrlWithReturn('?claim_id=abc&return=measurements')).toBe(`${HOMEOWNER_DASHBOARD_URL}?return=measurements`);
  });
  it('no token: the bare dashboard, nothing appended', () => {
    expect(dashboardUrlWithReturn('?claim_id=abc')).toBe(HOMEOWNER_DASHBOARD_URL);
    expect(dashboardUrlWithReturn('')).toBe(HOMEOWNER_DASHBOARD_URL);
  });
  it.each(['https://evil.example/', '//evil.example', 'javascript:alert(1)', '__proto__', 'constructor', 'MEASUREMENTS', '/help-measurements.html'])(
    'no open redirect: ?return=%s is dropped and the destination stays the dashboard',
    (bad) => {
      const url = dashboardUrlWithReturn('?return=' + encodeURIComponent(bad));
      expect(url).toBe(HOMEOWNER_DASHBOARD_URL);
    },
  );
});
