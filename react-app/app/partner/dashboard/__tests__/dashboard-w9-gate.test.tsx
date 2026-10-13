/**
 * D-319 (gh-1509): the React partner dashboard hides the W-9 card when
 * platform_settings.w9_gate_retired is ON, and FAILS CLOSED (card shown, today's
 * behavior) when the flag is OFF, missing, or the read errors/throws.
 *
 * Mirrors loadW9GateFlag() in partner-dashboard.html. Renders the real page with
 * auth / router / partner-record / supabase mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fetchW9GateRetired } from '../utils';
import { W9_COPY } from '../copy';

type FlagMode = 'on' | 'off' | 'missing' | 'error' | 'throw';
const h = vi.hoisted(() => ({ mode: 'off' as FlagMode }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: { id: 'u-1', email: 'p@example.test' }, settled: true }),
}));
vi.mock('@/lib/partner-record', () => ({
  resolvePartnerRecord: async () => ({
    kind: 'ok',
    partner: { id: 'p-1', first_name: 'Pat', payments_blocked: true, w9_submitted_at: null, w9_verified_at: null },
  }),
  fetchPartnerByUserId: async () => null,
}));
vi.mock('@/lib/supabase', () => {
  const result = (table: string) => {
    if (table !== 'platform_settings') return { data: [], error: null };
    switch (h.mode) {
      case 'on':
        return { data: { value: true }, error: null };
      case 'off':
        return { data: { value: false }, error: null };
      case 'missing':
        return { data: null, error: null };
      case 'error':
        return { data: null, error: { message: 'permission denied' } };
      default:
        throw new Error('network down');
    }
  };
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'not', 'order']) chain[m] = () => chain;
    chain.maybeSingle = async () => result(table);
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(() => result(table)).then(res, rej);
    return chain;
  };
  return { supabase: { from, auth: { getSession: async () => ({ data: { session: null } }) } } };
});

import PartnerDashboardPage from '../page';

async function renderDashboard() {
  render(<PartnerDashboardPage />);
  await waitFor(() => expect(screen.getByText(/Welcome back/)).toBeTruthy());
}

describe('W-9 card vs platform_settings.w9_gate_retired (D-319)', () => {
  beforeEach(() => {
    h.mode = 'off';
  });

  it('flag ON -> no W-9 card', async () => {
    h.mode = 'on';
    await renderDashboard();
    expect(screen.queryByText(W9_COPY.actionRequired.title)).toBeNull();
    expect(screen.queryByText(W9_COPY.actionRequired.body)).toBeNull();
    expect(screen.queryByText(W9_COPY.actionRequired.uploadBtn)).toBeNull();
  });

  it('flag OFF -> W-9 card shown', async () => {
    h.mode = 'off';
    await renderDashboard();
    expect(screen.getByText(W9_COPY.actionRequired.title)).toBeTruthy();
    expect(screen.getByText(W9_COPY.actionRequired.body)).toBeTruthy();
  });

  it('flag row missing (e.g. RLS-filtered) -> W-9 card shown', async () => {
    h.mode = 'missing';
    await renderDashboard();
    expect(screen.getByText(W9_COPY.actionRequired.title)).toBeTruthy();
  });

  it('flag read error -> W-9 card shown (fail closed)', async () => {
    h.mode = 'error';
    await renderDashboard();
    expect(screen.getByText(W9_COPY.actionRequired.title)).toBeTruthy();
  });

  it('flag read throws -> W-9 card shown (fail closed)', async () => {
    h.mode = 'throw';
    await renderDashboard();
    expect(screen.getByText(W9_COPY.actionRequired.title)).toBeTruthy();
  });
});

describe('fetchW9GateRetired', () => {
  const clientFor = (r: () => unknown) =>
    ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => r() }) }) }),
    }) as never;

  it('true only for value === true', async () => {
    expect(await fetchW9GateRetired(clientFor(() => ({ data: { value: true }, error: null })))).toBe(true);
    expect(await fetchW9GateRetired(clientFor(() => ({ data: { value: 'true' }, error: null })))).toBe(false);
    expect(await fetchW9GateRetired(clientFor(() => ({ data: { value: false }, error: null })))).toBe(false);
    expect(await fetchW9GateRetired(clientFor(() => ({ data: null, error: null })))).toBe(false);
  });
  it('false on error or throw', async () => {
    expect(await fetchW9GateRetired(clientFor(() => ({ data: { value: true }, error: { message: 'x' } })))).toBe(false);
    expect(
      await fetchW9GateRetired(
        clientFor(() => {
          throw new Error('boom');
        }),
      ),
    ).toBe(false);
  });
});
