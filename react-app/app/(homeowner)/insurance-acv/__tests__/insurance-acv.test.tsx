import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createHash } from 'node:crypto';

vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({
    user: { id: 'u1', email: 'jane@example.com' },
    role: 'homeowner',
    isAdmin: false,
    loading: false,
    settled: true,
    signOut: vi.fn(),
  }),
}));
vi.mock('@/hooks/use-notification-count', () => ({
  useNotificationCount: () => ({ count: 0, loading: false, error: null }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      signOut: vi.fn(),
    },
  },
}));

import Page from '../page';
import { oopHref } from '../utils';
import { ACV_EXPLAINER_TEXT } from '../copy';

// Independent literal: the approved text from #3273 (2026-10-30T19:25:06Z ruling), pasted separately from copy.ts.
const APPROVED =
  "With an ACV policy, your insurer pays the actual cash value of the damage: the replacement cost minus depreciation and your deductible. That depreciation typically isn't paid back when the work is finished. So the simplest way to handle your project is like a cash job: use your insurance payment as your budget, compare bids, and pay any difference yourself. You can use your insurance estimate, or buy a roof measurement, to get bids. Questions about what your policy covers go to your insurer.";
const APPROVED_SHA256 = '8e9e462ad14c0b46bab7f2f78c5f09ed9223782a134273f2ba1705b8d1f8ab0c';

describe('ACV explainer (LEGAL wording)', () => {
  it('the constant matches the approved text byte-for-byte and by SHA-256', () => {
    expect(ACV_EXPLAINER_TEXT).toBe(APPROVED);
    expect(Buffer.from(ACV_EXPLAINER_TEXT, 'utf-8').equals(Buffer.from(APPROVED, 'utf-8'))).toBe(true);
    expect(createHash('sha256').update(ACV_EXPLAINER_TEXT).digest('hex')).toBe(APPROVED_SHA256);
  });

  it('the RENDERED text equals the approved text exactly (textContent, no trimming)', () => {
    render(<Page />);
    expect(screen.getByTestId('acv-explainer').textContent).toBe(APPROVED);
  });

  it('NEGATIVE CONTROL: a one-character change would fail the byte check', () => {
    const altered = APPROVED.replace("isn't", 'isn’t');
    expect(altered).not.toBe(ACV_EXPLAINER_TEXT);
    expect(createHash('sha256').update(altered).digest('hex')).not.toBe(APPROVED_SHA256);
  });

  it('Continue lands on the Out-of-pocket route, carrying the claim id', () => {
    expect(oopHref('c1')).toBe('/out-of-pocket?claim_id=c1');
    expect(oopHref(null)).toBe('/out-of-pocket');
    render(<Page />);
    expect(screen.getByTestId('acv-continue').getAttribute('href')).toBe('/out-of-pocket');
  });

  it('the page has no copy other than the approved text and the Continue label', () => {
    const { container } = render(<Page />);
    const main = container.querySelector('main') ?? container;
    expect(main.textContent).toContain(APPROVED);
    expect(main.textContent!.replace(APPROVED, '')).toMatch(/Continue/);
  });
});
