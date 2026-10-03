/**
 * gh-2105 batch 12 -- the three referral_agents writes on /admin/referrals
 * (verify W-9, manual unblock, agent-type correction) used to call
 * `.update(...).eq('id', id)` with no `.select()`. supabase-js resolves
 * `{ error: null }` when RLS or the filter matches ZERO rows, so the admin saw
 * a success toast ('W-9 verified', ...) while nothing was written.
 *
 * Decision (a): each write chains `.select('id')`; an empty result is shown
 * through that handler's EXISTING error toast ('Error ...: ' + message).
 *
 * FAIL-FIRST: against origin/main's page.tsx no `.select` is chained and the
 * zero-row cases below end on the success toast.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

type WriteResult = { data: unknown[] | null; error: { message: string } | null };

const h = vi.hoisted(() => ({
  partner: {
    id: 'a-1',
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@example.com',
    agent_type: 're_agent',
    created_at: '2026-06-10T12:00:00Z',
    payments_blocked: true,
    w9_file_url: null,
    w9_submitted_at: '2026-06-11T12:00:00Z',
    w9_verified_at: null,
    w9_notification_sent_at: null,
  },
  writeResult: { data: [{ id: 'a-1' }], error: null } as WriteResult,
  updates: [] as Array<{ payload: unknown; selected: string | null }>,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        order: () => Promise.resolve({ data: [h.partner], error: null }),
      }),
      update: (payload: unknown) => {
        const rec = { payload, selected: null as string | null };
        h.updates.push(rec);
        return {
          eq: () => ({
            select: (cols: string) => {
              rec.selected = cols;
              return Promise.resolve(h.writeResult);
            },
          }),
        };
      },
    }),
  },
}));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ signOut: vi.fn() }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../../_shell/RequireAdmin', () => ({
  RequireAdmin: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../_shell/AdminNav', () => ({ AdminNav: () => null }));
vi.mock('../../_shell/doc-viewer', () => ({ SignedDocLink: () => null }));

import AdminReferralsPage from '../page';
import { zeroRowError } from '../utils';

async function mount(over: Record<string, unknown> = {}) {
  Object.assign(h.partner, over);
  render(<AdminReferralsPage />);
  await screen.findByText('Jane Doe');
}

function confirmUnblock() {
  // Unblock shows only for a blocked partner with NO W-9 submission.
  fireEvent.click(screen.getByText('Unblock'));
  // After the modal opens there are two "Unblock" buttons; the last is the confirm.
  const buttons = screen.getAllByText('Unblock');
  fireEvent.click(buttons[buttons.length - 1]);
}

beforeEach(() => {
  Object.assign(h.partner, { payments_blocked: true, w9_submitted_at: '2026-06-11T12:00:00Z' });
  h.updates.length = 0;
  h.writeResult = { data: [{ id: 'a-1' }], error: null };
});

describe('zeroRowError', () => {
  it('is null only for a non-empty array', () => {
    expect(zeroRowError([{ id: 'x' }])).toBeNull();
    expect(zeroRowError([])).toBeInstanceOf(Error);
    expect(zeroRowError(null)).toBeInstanceOf(Error);
    expect(zeroRowError(undefined)).toBeInstanceOf(Error);
  });
});

describe('/admin/referrals zero-row writes (gh-2105 batch 12)', () => {
  it('verify W-9: one row written -> success toast, and the write selects id', async () => {
    await mount();
    fireEvent.click(screen.getByText('Verify W-9'));
    expect(await screen.findByText(/W-9 verified/)).toBeTruthy();
    expect(h.updates[0].selected).toBe('id');
  });

  it('verify W-9: ZERO rows -> existing error toast, never the success toast', async () => {
    h.writeResult = { data: [], error: null };
    await mount();
    fireEvent.click(screen.getByText('Verify W-9'));
    expect(await screen.findByText(/Error verifying W-9: zero_rows_updated/)).toBeTruthy();
    expect(screen.queryByText(/W-9 verified/)).toBeNull();
  });

  it('manual unblock: one row written -> success toast, and the write selects id', async () => {
    await mount({ w9_submitted_at: null });
    confirmUnblock();
    expect(await screen.findByText(/Partner manually unblocked/)).toBeTruthy();
    expect(h.updates[0].selected).toBe('id');
  });

  it('manual unblock: ZERO rows -> existing error toast, never the success toast', async () => {
    h.writeResult = { data: [], error: null };
    await mount({ w9_submitted_at: null });
    confirmUnblock();
    expect(await screen.findByText(/Error unblocking partner: zero_rows_updated/)).toBeTruthy();
    expect(screen.queryByText(/manually unblocked/)).toBeNull();
  });

  it('agent-type change: ZERO rows -> existing error toast, never the success toast', async () => {
    h.writeResult = { data: [], error: null };
    await mount();
    fireEvent.click(screen.getByText('Edit'));
    const select = document.querySelector('.oqr-type-select') as HTMLSelectElement;
    const other = Array.from(select.options).find((o) => o.value !== 're_agent')!;
    fireEvent.change(select, { target: { value: other.value } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(screen.getByText(/Error changing partner type: zero_rows_updated/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Partner type updated/)).toBeNull();
  });

  it('a real database error still surfaces its own message', async () => {
    h.writeResult = { data: null, error: { message: 'permission denied' } };
    await mount();
    fireEvent.click(screen.getByText('Verify W-9'));
    expect(await screen.findByText(/Error verifying W-9: permission denied/)).toBeTruthy();
  });
});
