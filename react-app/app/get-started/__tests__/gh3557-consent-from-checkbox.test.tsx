/**
 * gh-3557 (protective, R-134) -- get-started records SMS consent and the
 * referrer-updates opt-out ONLY from the checkbox the visitor actually sees.
 *
 *   (a) both boxes left unticked -> sms_consent_ts null, referrer_updates_opt_out false
 *       (the input from #3557's closes-on; passes on main too -- main's code already
 *       maps unticked -> null/false, see the PR body for why that matters)
 *   (b) both boxes ticked -> consent recorded (no regression)
 *   (c) state says ticked but the visible box is NOT checked (DOM changed without a
 *       React change event, e.g. a browser form-restore or extension) -> nothing
 *       recorded. FAILS on main (main trusts React state alone), passes with the guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: null, role: null, loading: false }),
}));

const signUpMock = vi.fn(() =>
  Promise.resolve({ data: { user: { identities: [{ id: 'x' }] }, session: null }, error: null }),
);
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    auth: {
      signUp: (...a: unknown[]) => (signUpMock as unknown as (...x: unknown[]) => unknown)(...a),
      signInWithOAuth: vi.fn(() => Promise.resolve({ error: null })),
    },
    from: vi.fn(() => ({ insert: vi.fn(() => Promise.resolve({ error: null })) })),
  },
}));

// A referrer is attached, so the opt-out box (C2) is rendered -- the #3557 path
// (/dustin-p18-test -> /ref/<code> -> /?code= -> signup).
vi.mock('@/lib/cookie-storage', () => ({
  readReferralIds: () => ({ oq_referral_id: 'ref-3557', oq_referral_agent_id: 'agent-3557' }),
  writeReferralIds: vi.fn(),
}));

import GetStartedPage from '../page';

const SMS = () => document.getElementById('sms-consent') as HTMLInputElement;
const OPT = () => document.getElementById('referrer-updates-opt-out') as HTMLInputElement;

async function toStep2AndFill() {
  render(<GetStartedPage />);
  fireEvent.change(screen.getByLabelText('Street Address'), { target: { value: '1 Otter Way' } });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Carmel' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'IN' } });
  fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '46032' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByLabelText('First Name')).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Deezy' } });
  fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Cheezy' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'deezy@example.invalid' } });
  fireEvent.change(screen.getByLabelText(/^Phone/), { target: { value: '3175550100' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-1' } });
  await waitFor(() => expect(OPT()).not.toBeNull());
}

async function submitAndReadSignup(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole('button', { name: /Create My Account/ }));
  await waitFor(() => expect(signUpMock).toHaveBeenCalled());
  return JSON.parse(localStorage.getItem('cs_signup') || '{}');
}

beforeEach(() => {
  signUpMock.mockClear();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => cleanup());

describe('gh-3557 consent is recorded only from the visible checkbox', () => {
  it('(a) both boxes unticked: no SMS consent, opt-out false', async () => {
    await toStep2AndFill();
    expect(SMS().checked).toBe(false);
    expect(OPT().checked).toBe(false);
    const cs = await submitAndReadSignup();
    expect(cs.sms_consent_ts).toBeNull();
    expect(cs.referrer_updates_opt_out).toBe(false);
  });

  it('(b) both boxes ticked: both choices recorded', async () => {
    await toStep2AndFill();
    fireEvent.click(SMS());
    fireEvent.click(OPT());
    const cs = await submitAndReadSignup();
    expect(typeof cs.sms_consent_ts).toBe('string');
    expect(cs.referrer_updates_opt_out).toBe(true);
  });

  it('(c) state ticked but the visible box is unchecked: nothing recorded', async () => {
    await toStep2AndFill();
    fireEvent.click(SMS());
    fireEvent.click(OPT());
    // The page now shows both boxes unchecked, with no change event reaching React.
    SMS().checked = false;
    OPT().checked = false;
    const cs = await submitAndReadSignup();
    expect(cs.sms_consent_ts).toBeNull();
    expect(cs.referrer_updates_opt_out).toBe(false);
  });
});
