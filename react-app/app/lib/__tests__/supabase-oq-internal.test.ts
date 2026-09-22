/**
 * gh-2068 — unit test for the server-side connecting rule's client half:
 * react-app/app/lib/supabase.ts must pass an `X-OQ-Internal: 1` header on
 * the shared client's `global.headers` whenever isInternalTraffic() says
 * this page load is internal (oq_internal query param or cookie), and must
 * pass no such header otherwise. This is what
 * leads_force_safe_insert_defaults() (the BEFORE INSERT trigger on
 * public.leads, supabase/migrations/20260922140801_gh2068_*.sql) reads to
 * force is_synthetic=true at write time.
 *
 * `@supabase/supabase-js`'s createClient is mocked so this test asserts on
 * the exact options object supabase.ts builds, without making a network
 * call or depending on real Supabase credentials. supabase.ts's client is
 * a module-level singleton computed once at import time, so each case
 * resets modules and dynamically re-imports it after arranging
 * window.location / document.cookie — mirroring how a real page load
 * computes the header exactly once, at client-creation time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createClientMock = vi.fn((_url: string, _key: string, options: unknown) => ({
  __options: options,
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

describe('supabase.ts — gh-2068 oq_internal header', () => {
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

  it('sets X-OQ-Internal: 1 when ?oq_internal=1 is on the URL', async () => {
    setLocation('?oq_internal=1');
    await import('../supabase');

    expect(createClientMock).toHaveBeenCalledTimes(1);
    const options = createClientMock.mock.calls[0][2] as {
      global?: { headers?: Record<string, string> };
    };
    expect(options.global?.headers).toEqual({ 'x-oq-internal': '1' });
  });

  it('sets X-OQ-Internal: 1 from a persisted oq_internal=1 cookie with no query param', async () => {
    document.cookie = 'oq_internal=1; path=/';
    setLocation('');
    await import('../supabase');

    const options = createClientMock.mock.calls[0][2] as {
      global?: { headers?: Record<string, string> };
    };
    expect(options.global?.headers).toEqual({ 'x-oq-internal': '1' });
  });

  it('negative control: sends no X-OQ-Internal header for an ordinary visit', async () => {
    setLocation('');
    await import('../supabase');

    expect(createClientMock).toHaveBeenCalledTimes(1);
    const options = createClientMock.mock.calls[0][2] as {
      global?: { headers?: Record<string, string> };
    };
    expect(options.global?.headers).toEqual({});
    expect(options.global?.headers?.['x-oq-internal']).toBeUndefined();
  });
});
