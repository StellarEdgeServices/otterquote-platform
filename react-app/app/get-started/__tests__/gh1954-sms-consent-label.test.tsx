/**
 * gh-1954 (Dustin ruling: ALIGN, comment 5682310604; CEO57 triage 5768832583).
 *
 * The signup page's inline SMS-consent label had drifted from the canonical
 * `SMS_CONSENT_LABEL` in constants/legal.ts — it omitted the "(Optional — …)"
 * disclosure sentence. Fix renders the label BY REFERENCE to the constant
 * rather than an inline copy, so the two cannot drift apart again.
 *
 * Positive: the rendered Step 2 label contains the constant's full text,
 * optional sentence included.
 * Negative control: if the page rendered a stale inline literal instead of
 * the constant, changing SMS_CONSENT_LABEL would NOT change what's on the
 * page. Asserting the exact constant value is present (not a hand-copied
 * string) is what would fail if that regressed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({ useAuthReady: vi.fn() }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      signUp: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      signInWithOAuth: vi.fn(() => Promise.resolve({ data: {}, error: null })),
    },
    from: vi.fn(() => ({
      insert: vi.fn(() => ({ then: (cb: (r: unknown) => void) => cb({ error: null }) })),
    })),
  },
}));

import { useAuthReady } from '@/hooks/use-auth-ready';
import GetStartedPage from '../page';
import { SMS_CONSENT_LABEL } from '../../../constants/legal';

type AuthVal = ReturnType<typeof vi.fn>;
const mockAuth = (v: unknown) => (useAuthReady as unknown as AuthVal).mockReturnValue(v);

function advanceToStep2() {
  fireEvent.change(screen.getByLabelText('Street Address'), { target: { value: '123 Main St' } });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Anytown' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'IN' } });
  fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '46201' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('GetStartedPage — gh-1954 SMS-consent label sourced from constants/legal.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth({ user: null, role: null, loading: false });
  });

  it('renders the canonical SMS_CONSENT_LABEL verbatim, including the "(Optional — …)" sentence', () => {
    render(<GetStartedPage />);
    advanceToStep2();

    expect(screen.getByRole('heading', { name: 'Create Your Account' })).toBeInTheDocument();

    const checkbox = screen.getByRole('checkbox', { name: new RegExp('I agree to receive transactional SMS') });
    const label = checkbox.closest('label');
    expect(label).not.toBeNull();
    expect(label!.textContent).toContain(SMS_CONSENT_LABEL);
    // The constant's own optional-disclosure clause, spelled out so a
    // regression that renders SOME constant but not this one still fails.
    expect(label!.textContent).toContain(
      '(Optional — you can still use the platform without SMS notifications.)'
    );
  });
});
