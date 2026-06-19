/**
 * Loop-safety integration test for the re-applied #291 auth-entry flip (PR 2/2,
 * postmortem 2026-06-16). With CONTRACTOR_DASHBOARD_URL flipped to the SAME-ORIGIN
 * React route '/contractor/dashboard', an authed-contractor redirect from
 * /contractor/login can only loop if the dashboard gate bounces back. This test
 * simulates the ContractorShell bounce (the one-shot sessionStorage marker the
 * shell drops via markContractorGateBounce) and asserts /contractor/login does NOT
 * send the contractor back to the flipped dashboard — the loop terminates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { signInWithOtp: vi.fn(), signInWithOAuth: vi.fn() } },
}));
vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));

import { useAuthReady } from '@/hooks/use-auth-ready';
import ContractorLoginPage from '../page';
import { CONTRACTOR_LOGIN_COPY } from '../copy';
import { CONTRACTOR_DASHBOARD_URL } from '../utils';
import { markContractorGateBounce } from '@/lib/contractor-gate';
import { _COOKIE_ACCESS, _COOKIE_REFRESH } from '@/lib/cookie-storage';

const asContractor = () =>
  (useAuthReady as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    user: { id: 'c1' }, role: 'contractor', isAdmin: false, loading: false, signOut: vi.fn(),
  });

let hrefValue: string;
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  hrefValue = 'http://localhost/contractor/login';
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() { return hrefValue; },
      set href(v: string) { hrefValue = v; },
      assign: vi.fn(), search: '', pathname: '/contractor/login',
    },
  });
});

describe('re-applied flip is loop-safe (PR 2/2)', () => {
  it('the flip is live — already-authed redirect now targets the same-origin React dashboard', () => {
    expect(CONTRACTOR_DASHBOARD_URL).toBe('/contractor/dashboard');
  });

  it('without a gate-bounce marker, an authed contractor IS redirected to the React dashboard', () => {
    asContractor();
    render(<ContractorLoginPage />);
    expect(hrefValue).toBe('/contractor/dashboard'); // the flipped same-origin target
  });

  it('after a ContractorShell gate-bounce, /contractor/login does NOT bounce back — loop terminates', () => {
    markContractorGateBounce(); // exactly what ContractorShell does before its client-side replace
    asContractor();
    render(<ContractorLoginPage />);
    // No navigation to the flipped dashboard → the dashboard ⇄ login loop is broken.
    expect(hrefValue).toBe('http://localhost/contractor/login');
    // The sign-in form stays visible instead of an endless redirect spinner.
    expect(screen.getByRole('button', { name: CONTRACTOR_LOGIN_COPY.submitButton })).toBeInTheDocument();
  });
});

describe('D-212 — a transient gate-bounce must not pin a contractor who holds a valid cookie session', () => {
  function setCookie(name: string, value: string): void {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/`;
  }
  function clearCookies(): void {
    for (const pair of document.cookie.split('; ')) {
      const k = pair.split('=')[0];
      if (k) document.cookie = `${k}=; path=/; max-age=0`;
    }
  }
  function b64url(obj: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(obj)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function jwt(payload: Record<string, unknown>): string {
    return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
  }
  const NOW = Math.floor(Date.now() / 1000);

  afterEach(() => clearCookies());

  it('redirects an authed contractor WITH a valid cookie session to the dashboard despite a fresh bounce marker', () => {
    setCookie(_COOKIE_ACCESS, jwt({ sub: 'c1', exp: NOW + 3600, iat: NOW }));
    setCookie(_COOKIE_REFRESH, 'refresh-token-abc');
    markContractorGateBounce(); // the shell bounced this request (a slow-hydration transient)
    asContractor();
    render(<ContractorLoginPage />);
    // The bounce was a false-positive (a live cookie session exists), so the
    // contractor is sent to the dashboard, NOT stranded on /contractor/login.
    expect(hrefValue).toBe(CONTRACTOR_DASHBOARD_URL);
  });
});
