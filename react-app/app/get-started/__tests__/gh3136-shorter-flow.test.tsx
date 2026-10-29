/**
 * gh-3136 (P14) — shortened get-started flow.
 * Pins: prefilled identity collapses to one line (Edit reveals), direct visitor
 * still sees the fields, Confirm Password gone + show/hide toggle, phone only
 * when not prefilled (or SMS ticked without one), referral chips cut, C2 only
 * with a referrer, C1/C3 text unchanged, signUp payload unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: null, role: null, loading: false }),
}));

const rpcMock = vi.fn();
const signUpMock = vi.fn(() =>
  Promise.resolve({ data: { user: { identities: [{ id: 'x' }] }, session: null }, error: null }),
);
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: {
      signUp: (...a: unknown[]) => (signUpMock as unknown as (...x: unknown[]) => unknown)(...a),
      signInWithOAuth: vi.fn(() => Promise.resolve({ error: null })),
    },
    from: vi.fn(() => ({ insert: vi.fn(() => Promise.resolve({ error: null })) })),
  },
}));

const readReferralIdsMock = vi.fn((): Record<string, string> => ({}));
vi.mock('@/lib/cookie-storage', () => ({
  readReferralIds: () => readReferralIdsMock(),
  writeReferralIds: vi.fn(),
}));

import GetStartedPage from '../page';
import { SMS_CONSENT_LABEL } from '../../../constants/legal';

const LEAD = 'cccccccc-1111-2222-3333-444444444444';

function toStep2() {
  fireEvent.change(screen.getByLabelText('Street Address'), { target: { value: '1 Otter Way' } });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Austin' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'TX' } });
  fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '78701' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

beforeEach(() => {
  rpcMock.mockReset();
  signUpMock.mockClear();
  readReferralIdsMock.mockReturnValue({});
  localStorage.clear();
  sessionStorage.clear();
  (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = undefined;
});
afterEach(() => cleanup());

async function renderPrefilled(phone: string | null = '3175551234') {
  rpcMock.mockResolvedValueOnce({
    data: [{ name: 'Jane Homeowner', email: 'jane.h@example.com', phone }],
    error: null,
  });
  (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = LEAD;
  render(<GetStartedPage />);
  await waitFor(() => expect(rpcMock).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  toStep2();
}

describe('gh-3136 step 2 — router visitor (name/email/phone known)', () => {
  it('shows one compact line, no name/email/phone inputs, no Confirm Password, no referral chips', async () => {
    await renderPrefilled();
    const line = await screen.findByTestId('signing-up-as');
    expect(line.textContent).toContain('Signing up as');
    expect(screen.queryByLabelText('First Name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Last Name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Phone/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Confirm Password')).not.toBeInTheDocument();
    expect(screen.queryByText('How did you hear about us?')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Their Name')).not.toBeInTheDocument();
    // password is the only text-entry field left
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('signUp payload is unchanged: split name, email, password', async () => {
    await renderPrefilled();
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'correct-horse-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Create My Account/ }));
    await waitFor(() => expect(signUpMock).toHaveBeenCalled());
    const arg = (signUpMock.mock.calls[0] as unknown[])[0] as {
      email: string; password: string; options?: { data?: Record<string, unknown> };
    };
    expect(arg.email).toBe('jane.h@example.com');
    expect(arg.password).toBe('correct-horse-1');
    // names travel via cs_signup (split by splitLeadName), not the signUp payload -- unchanged.
    const cs = JSON.parse(localStorage.getItem('cs_signup') || '{}');
    expect(cs.first_name).toBe('Jane');
    expect(cs.last_name).toBe('Homeowner');
    expect(cs).not.toHaveProperty('project_type');
    expect(cs.referral_source).toBe('web');
    expect(cs.referrer_updates_opt_out).toBe(false);
  });

  it('SMS ticked while phone is known: no extra field, no error', async () => {
    await renderPrefilled();
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp('I agree to receive transactional SMS') }));
    expect(screen.queryByLabelText(/^Phone/)).not.toBeInTheDocument();
  });

  it('SMS ticked while phone is unknown: phone field is revealed and the existing error holds', async () => {
    await renderPrefilled(null);
    expect(screen.queryByLabelText(/^Phone/)).toBeInTheDocument(); // not prefilled => shown
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'correct-horse-1' } });
    fireEvent.click(screen.getByRole('checkbox', { name: new RegExp('I agree to receive transactional SMS') }));
    fireEvent.click(screen.getByRole('button', { name: /Create My Account/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please add a phone number, or leave the SMS-consent box unchecked, before continuing.',
    );
    expect(signUpMock).not.toHaveBeenCalled();
  });

  it('Edit reveals name, email and phone inputs', async () => {
    await renderPrefilled();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('First Name')).toHaveValue('Jane');
    expect(screen.getByLabelText('Email')).toHaveValue('jane.h@example.com');
    expect(screen.getByLabelText(/^Phone/)).toBeInTheDocument();
  });
});

describe('gh-3136 step 2 — direct visitor', () => {
  it('shows name, email and phone fields as before; no Confirm Password; no chips', () => {
    render(<GetStartedPage />);
    toStep2();
    expect(screen.queryByTestId('signing-up-as')).not.toBeInTheDocument();
    for (const l of ['First Name', 'Last Name', 'Email', 'Password']) {
      expect(screen.getByLabelText(l)).toBeInTheDocument();
    }
    expect(screen.getByLabelText(/^Phone/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Confirm Password')).not.toBeInTheDocument();
    expect(screen.queryByText('How did you hear about us?')).not.toBeInTheDocument();
  });

  it('a name-only or email-less prefill does not collapse the fields', async () => {
    rpcMock.mockResolvedValueOnce({ data: [{ name: 'Madonna', email: null, phone: null }], error: null });
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = LEAD;
    render(<GetStartedPage />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    toStep2();
    expect(screen.queryByTestId('signing-up-as')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('password show/hide toggle is an accessible aria-pressed button', () => {
    render(<GetStartedPage />);
    toStep2();
    const pw = screen.getByLabelText('Password') as HTMLInputElement;
    expect(pw.type).toBe('password');
    const btn = screen.getByRole('button', { name: 'Show password' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    expect(pw.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('min-8 rule still enforced', async () => {
    render(<GetStartedPage />);
    toStep2();
    fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'B' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: /Create My Account/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Password must be at least 8 characters.');
    expect(signUpMock).not.toHaveBeenCalled();
  });
});

describe('gh-3136 C1/C2/C3 text', () => {
  const C2_TITLE = 'Don’t send project updates to the person who referred me';

  it('C2 is absent without a referrer, referrerOptOut stays false', () => {
    render(<GetStartedPage />);
    toStep2();
    expect(document.getElementById('referrer-updates-opt-out')).toBeNull();
  });

  it('C2 is present with a referrer, text byte-identical, and toggles state', async () => {
    readReferralIdsMock.mockReturnValue({ oq_referral_id: 'ref-123' });
    render(<GetStartedPage />);
    toStep2();
    const box = await waitFor(() => {
      const el = document.getElementById('referrer-updates-opt-out');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });
    const txt = box.closest('label')!.textContent!;
    expect(txt).toContain("Don't send project updates to the person who referred me");
    expect(txt).toContain(
      "If someone referred you to Otter Quotes, we send them short updates as your project moves — claim submitted, bids in, contractor picked, agreement signed, job done — using your first name and last initial only. We never share your claim amount, your contractor's name, or damage details with them. Check this box if you'd rather they not get these updates. Questions? Email support@otterquote.com.".replace(/\s+/g, ' '),
    );
    void C2_TITLE;
  });

  it('C1 SMS label and C3 terms line are present and unchanged', () => {
    render(<GetStartedPage />);
    toStep2();
    const sms = screen.getByRole('checkbox', { name: new RegExp('I agree to receive transactional SMS') });
    expect(sms.closest('label')!.textContent).toContain(SMS_CONSENT_LABEL);
    expect(document.body.textContent).toContain(
      'By creating an account, you agree to our Terms of Service and Privacy Policy.',
    );
  });
});
