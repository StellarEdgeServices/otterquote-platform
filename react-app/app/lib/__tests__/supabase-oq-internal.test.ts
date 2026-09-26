/**
 * gh-2068 — regression test for cto36 REVIEW: FAIL finding B2
 * (github.com/StellarEdgeServices/otterquote-platform/pull/2099#issuecomment-5779410643):
 *
 * react-app/app/lib/supabase.ts must NEVER wire `X-OQ-Internal` into the
 * shared client's `global.headers`. That option is passed to auth, rest,
 * storage, realtime AND `supabase.functions.invoke(...)` alike (supabase-js
 * 2.116.0, dist/index.cjs ~L658-693) — Edge Function CORS allow-lists
 * (supabase/functions/*\/index.ts) do not list x-oq-internal, so a
 * client-wide header would get every `functions.invoke` call for an
 * internal/admin browser blocked by CORS (payments, DocuSign, admin
 * actions, etc — the exact regression the review caught).
 *
 * The header is attached ONLY to the leads insert now, via postgrest-js's
 * per-request `.setHeader('x-oq-internal', '1')` at the call site
 * (react-app/app/get-started/page.tsx's persistSignupContext — see
 * gh2068-leads-oq-internal-header.test.tsx for that half). This file is
 * the negative control for every OTHER call this shared client makes:
 * since `global.headers` is never set here, at all, for any oq_internal
 * state, nothing but the explicit per-request call above can ever carry
 * the header — there is no client-wide path left for it to leak through.
 *
 * `@supabase/supabase-js`'s createClient is mocked so this test asserts on
 * the exact options object supabase.ts builds, without making a network
 * call or depending on real Supabase credentials. supabase.ts's client is
 * a module-level singleton computed once at import time, so each case
 * resets modules and dynamically re-imports it after arranging
 * window.location / document.cookie.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createClientMock = vi.fn((_url: string, _key: string, options: unknown) => ({
  __options: options,
  auth: {},
  from: vi.fn(),
  functions: { invoke: vi.fn() },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

function setLocation(search: string) {
  window.history.pushState({}, '', '/get-started' + search);
}

function clearOqInternalCookie() {
  document.cookie = 'oq_internal=; Max-Age=0; path=/';
}

describe('supabase.ts — gh-2068 B2 regression: no client-wide oq_internal header', () => {
  beforeEach(() => {
    vi.resetModules();
    createClientMock.mockClear();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
    clearOqInternalCookie();
    setLocation('');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearOqInternalCookie();
    setLocation('');
  });

  it('negative control: no `global` key at all on an ordinary visit', async () => {
    setLocation('');
    await import('../supabase');

    expect(createClientMock).toHaveBeenCalledTimes(1);
    const options = createClientMock.mock.calls[0][2] as Record<string, unknown>;
    expect(options.global).toBeUndefined();
  });

  it('negative control: still no `global` key with ?oq_internal=1 on the URL — the marker must not become a client-wide header', async () => {
    setLocation('?oq_internal=1');
    await import('../supabase');

    const options = createClientMock.mock.calls[0][2] as Record<string, unknown>;
    expect(options.global).toBeUndefined();
  });

  it('negative control: still no `global` key with a persisted oq_internal=1 cookie', async () => {
    document.cookie = 'oq_internal=1; path=/';
    setLocation('');
    await import('../supabase');

    const options = createClientMock.mock.calls[0][2] as Record<string, unknown>;
    expect(options.global).toBeUndefined();
  });

  it('does not import isInternalTraffic at all — the header decision moved to the leads-insert call site', async () => {
    const mod = await import('../supabase');
    // supabase.ts exports only the client (and nothing header-related) now.
    expect(Object.keys(mod)).toEqual(['supabase']);
  });
});
