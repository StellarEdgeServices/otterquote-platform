/**
 * gh-2060 NEGATIVE CONTROL — instance 2: a stale `oq_lead_id` left by ANOTHER
 * visitor must never leak into a bare `/get-started` load.
 *
 * The bug (#2054 / PR #2059, refuted pre-merge, never on `main`): the
 * "corrected" gh-2054 fix persisted the router lead id to
 * `sessionStorage.oq_lead_id` whenever `?lead=` appeared and NEVER cleared it
 * when it did not. A visitor landing on a bare `/get-started` in a tab that a
 * previous visitor had used for a lead-linked visit inherited the stranger's
 * identity: the page resolved the stranger's lead id from sessionStorage and
 * either applied the stranger's cached name/email/phone to the form or fired
 * a fresh `get_lead_prefill` on the stranger's id (burning the original
 * visitor's one-time prefill slot). Seven green tests could not see it,
 * because every test file starts from empty storage — no test ever ran with a
 * stale `oq_lead_id` already present, the only state in which the bug exists.
 *
 * This file is the mandatory negative control from #2060's closes-on. It is
 * written against the PRE-FIX (leaking) source and seeds dirty state with the
 * gh-2060 harness (`seedStaleStorage`, app/test/storage-fixtures.ts):
 *
 *   - against the LEAKING source (branch `rw/gh2054-rehydrate` tip 88256cb7,
 *     applied onto current main — see
 *     tests/fixtures/gh2060-oq-lead-id-leaking-source.patch): tests 1 and 2
 *     FAIL.
 *   - against `main` (which never persists `oq_lead_id`, and reads the lead
 *     id for prefill only from the same-page-load `window.__oqRouterLeadId`
 *     the strip script sets): all tests PASS.
 *
 * Test 3 is the positive control: a genuine `?lead=` first load still gets
 * its prefill, so a "no prefill ever" implementation cannot pass this file.
 *
 * Reproduce the negative control:
 *   git apply --3way tests/fixtures/gh2060-oq-lead-id-leaking-source.patch
 *   cd react-app && npx vitest run app/get-started/__tests__/gh2060-stale-lead-id.test.tsx
 *   git checkout -- app/get-started/page.tsx    # restore the corrected source
 *
 * Assertions are on a VALUE DUMP of every input, per the issue's own
 * verification trap: the placeholders (Jane / Smith / jane@example.com) make
 * an empty form and a prefilled one indistinguishable on a screenshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { seedStaleStorage } from '@/test/storage-fixtures';

vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: null, role: null, loading: false }),
}));

const rpcMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    auth: {
      signUp: vi.fn(() =>
        Promise.resolve({ data: { user: { identities: [{ id: 'x' }] } }, error: null }),
      ),
      signInWithOAuth: vi.fn(() => Promise.resolve({ error: null })),
    },
    from: vi.fn(() => ({ insert: vi.fn(() => Promise.resolve({ error: null })) })),
  },
}));

vi.mock('@/lib/cookie-storage', () => ({
  readReferralIds: vi.fn(() => ({})),
  writeReferralIds: vi.fn(),
}));

import GetStartedPage from '../page';

const STRANGER_LEAD_ID = 'bbbbbbbb-1111-2222-3333-555555555555';
const STRANGER = { name: 'Stranger Person', email: 'stranger.leak@example.com', phone: '3175559999' };
const OWN_LEAD_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

function valueDump(): string[] {
  return Array.from(document.querySelectorAll('input')).map((i) => (i as HTMLInputElement).value);
}

function fillStep1AndContinue() {
  fireEvent.change(screen.getByLabelText('Street Address'), { target: { value: '1 Otter Way' } });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Austin' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'TX' } });
  fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '78701' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('gh-2060 negative control: stale oq_lead_id from another visitor vs a bare /get-started load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks() does not drain a queued mockResolvedValueOnce (the
    // gh-2060 "same family" trap) — reset the RPC mock explicitly.
    rpcMock.mockReset();
    sessionStorage.clear();
    localStorage.clear();
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId;
  });

  it("does not fire get_lead_prefill on a stranger's stale oq_lead_id (bare load, no ?lead=)", async () => {
    rpcMock.mockResolvedValue({ data: [STRANGER], error: null });
    // A previous visitor's lead-linked visit left this behind in the tab.
    seedStaleStorage({ sessionStorage: { oq_lead_id: STRANGER_LEAD_ID } });

    render(<GetStartedPage />);
    // Give the mount effects a full turn to run (the leak fires in one).
    await screen.findByLabelText('Street Address');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(rpcMock).not.toHaveBeenCalledWith('get_lead_prefill', expect.anything());
  });

  it("does not apply a stranger's cached name/email/phone to a bare load", async () => {
    // Worst case: the stranger's prefill payload is ALSO still cached under
    // their id (as the leaking source's own cache would have left it).
    seedStaleStorage({
      sessionStorage: {
        oq_lead_id: STRANGER_LEAD_ID,
        [`oq_prefill_${STRANGER_LEAD_ID}`]: JSON.stringify(STRANGER),
      },
    });

    render(<GetStartedPage />);
    await screen.findByLabelText('Street Address');
    fillStep1AndContinue();
    await screen.findByLabelText('First Name');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const dump = valueDump().join('|');
    expect(dump).not.toContain(STRANGER.email);
    expect(dump).not.toContain('Stranger');
    expect(dump).not.toContain(STRANGER.phone);
  });

  it('POSITIVE CONTROL: a genuine first load carrying ?lead= (window global set by the strip script) still prefills', async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ name: 'Jane Homeowner', email: 'jane.h@example.com', phone: '3175551234' }],
      error: null,
    });
    // What LEAD_STRIP_SCRIPT (app/layout.tsx) sets on the one load that still
    // carries the param. Storage is otherwise clean.
    (window as unknown as { __oqRouterLeadId?: string }).__oqRouterLeadId = OWN_LEAD_ID;

    render(<GetStartedPage />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('get_lead_prefill', { p_lead_id: OWN_LEAD_ID }));
    fillStep1AndContinue();
    await screen.findByLabelText('First Name');
    await waitFor(() => expect(valueDump().some((v) => v === 'jane.h@example.com')).toBe(true));
  });
});
