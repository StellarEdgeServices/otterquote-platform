/**
 * gh-2068 — regression test for cto36 REVIEW: FAIL findings B1/B2
 * (PR #2099 comment 5779410643):
 *
 *   B1. `react-app/app/lib/supabase.ts` no longer wires `x-oq-internal`
 *       into `global.headers` (see supabase-oq-internal.test.ts for that
 *       negative control) — the header now goes ONLY on the `leads`
 *       insert, via postgrest-js's `.setHeader('x-oq-internal', '1')`.
 *
 *   B2. Renders the ACTUAL page component (`../page`, not a
 *       reimplementation) and exercises its real `persistSignupContext()`
 *       call site through the Google-signup path (same trigger the
 *       existing get-started-google-signup.test.tsx regression uses),
 *       so a future refactor that moves the header back onto the
 *       shared client — or drops it off the leads insert entirely —
 *       turns this red.
 *
 * `@/lib/supabase`'s `supabase` object is mocked with a `from()` that
 * returns a distinct builder per table, each with its own `setHeader`
 * spy and a thenable `insert()` result — mirroring postgrest-js's real
 * `PostgrestBuilder.setHeader()` (returns `this`, mutates per-request
 * headers only). `@/lib/internal-traffic`'s `isInternalTraffic()` is
 * mocked directly so each case is deterministic, instead of relying on
 * this test file to fake the exact cookie/query-param contract that
 * module implements.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/use-auth-ready', () => ({
  useAuthReady: () => ({ user: null, role: null, loading: false }),
}));

const isInternalTrafficMock = vi.fn(() => false);
vi.mock('@/lib/internal-traffic', () => ({
  isInternalTraffic: () => isInternalTrafficMock(),
}));

// Two distinct builders so a call on one is never confused with a call on
// the other — the `otherTableBuilder` is this test's negative control for
// "a non-leads call must never carry the header", per gh-2068 fix
// requirement 3.
function makeBuilder() {
  const builder: {
    setHeader: ReturnType<typeof vi.fn>;
    then: ReturnType<typeof vi.fn>;
  } = {
    setHeader: vi.fn(() => builder),
    then: vi.fn((onFulfilled: (v: { error: null }) => unknown) => {
      onFulfilled({ error: null });
      return Promise.resolve();
    }),
  };
  return builder;
}

let leadsBuilder: ReturnType<typeof makeBuilder>;
let otherTableBuilder: ReturnType<typeof makeBuilder>;
const leadsInsertMock = vi.fn();
const otherTableInsertMock = vi.fn();
const functionsInvokeMock = vi.fn(() => Promise.resolve({ data: null, error: null }));
const fromMock = vi.fn((table: string) => {
  if (table === 'leads') {
    return { insert: leadsInsertMock };
  }
  return { insert: otherTableInsertMock };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { signInWithOAuth: vi.fn(() => Promise.resolve({ error: null })) },
    from: (table: string) => fromMock(table),
    functions: { invoke: (...args: unknown[]) => functionsInvokeMock(...args) },
  },
}));

vi.mock('@/lib/cookie-storage', () => ({
  readReferralIds: vi.fn(() => ({})),
  writeReferralIds: vi.fn(),
}));

import GetStartedPage from '../page';

async function fillAndSubmitToGoogle() {
  render(<GetStartedPage />);

  fireEvent.change(screen.getByLabelText('Street Address'), {
    target: { value: '1 Otter Way' },
  });
  fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Austin' } });
  fireEvent.change(screen.getByLabelText('State'), { target: { value: 'TX' } });
  fireEvent.change(screen.getByLabelText('ZIP Code'), { target: { value: '78701' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

  await screen.findByLabelText('First Name');
  fireEvent.change(screen.getByLabelText('First Name'), { target: { value: 'Jane' } });
  fireEvent.change(screen.getByLabelText('Last Name'), { target: { value: 'Doe' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jane@example.com' } });

  fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));

  await waitFor(() => expect(leadsInsertMock).toHaveBeenCalled());
}

describe('get-started page — gh-2068 leads insert carries x-oq-internal only when internal, only on leads', () => {
  beforeEach(() => {
    leadsBuilder = makeBuilder();
    otherTableBuilder = makeBuilder();
    leadsInsertMock.mockReset().mockReturnValue(leadsBuilder);
    otherTableInsertMock.mockReset().mockReturnValue(otherTableBuilder);
    fromMock.mockClear();
    functionsInvokeMock.mockClear();
    isInternalTrafficMock.mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sets x-oq-internal on the leads insert when isInternalTraffic() is true', async () => {
    isInternalTrafficMock.mockReturnValue(true);

    await fillAndSubmitToGoogle();

    expect(leadsBuilder.setHeader).toHaveBeenCalledTimes(1);
    expect(leadsBuilder.setHeader).toHaveBeenCalledWith('x-oq-internal', '1');
  });

  it('negative control: does NOT set x-oq-internal on the leads insert for an ordinary (non-internal) visit', async () => {
    isInternalTrafficMock.mockReturnValue(false);

    await fillAndSubmitToGoogle();

    expect(leadsBuilder.setHeader).not.toHaveBeenCalled();
  });

  it('negative control: a non-leads call (supabase.functions.invoke) never carries x-oq-internal, even when internal', async () => {
    isInternalTrafficMock.mockReturnValue(true);

    await fillAndSubmitToGoogle();
    // Something other than the leads insert making a request during this
    // flow (auth.signInWithOAuth) — confirm the header machinery never
    // touches it: functions.invoke was never called with any header
    // argument, and the leads builder's setHeader is the ONLY setHeader
    // call made anywhere in this flow.
    expect(functionsInvokeMock).not.toHaveBeenCalled();
    expect(otherTableBuilder.setHeader).not.toHaveBeenCalled();
    expect(otherTableInsertMock).not.toHaveBeenCalled();
    expect(fromMock).toHaveBeenCalledWith('leads');
  });
});
