/**
 * gh-1980 PR 3/3 -- the React browser client is constructed with
 * flowType 'pkce', and the auth callback's legacy-fragment rescue works.
 *
 * Discriminating: importing app/lib/supabase.ts on origin/main (no flowType)
 * makes test (1) fail; see the PR body for the raw run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rescueImplicitFragment } from '../../auth-callback/implicit-fragment';

const createClientMock = vi.fn(() => ({ auth: {} }));
vi.mock('@supabase/supabase-js', async (orig) => {
  const actual = await orig<typeof import('@supabase/supabase-js')>();
  return { ...actual, createClient: (...args: unknown[]) => (createClientMock as any)(...args) };
});

describe('gh-1980 PR 3: app/lib/supabase.ts builds a PKCE client', () => {
  beforeEach(() => {
    vi.resetModules();
    createClientMock.mockClear();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-test-key');
  });

  it('(1) passes auth.flowType === "pkce" with the canonical storageKey', async () => {
    await import('../supabase');
    expect(createClientMock).toHaveBeenCalledTimes(1);
    const opts = (createClientMock.mock.calls[0] as unknown[])[2] as { auth: Record<string, unknown> };
    expect(opts.auth.flowType).toBe('pkce');
    expect(opts.auth.storageKey).toBe('sb-otterquote-auth');
  });

  it('(2) a real supabase-js client with those options starts a PKCE OAuth flow (code_challenge, no implicit token)', async () => {
    const { createClient: realCreate } = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v); },
      removeItem: (k: string) => { mem.delete(k); },
    };
    await import('../supabase');
    const opts = (createClientMock.mock.calls[0] as unknown[])[2] as { auth: Record<string, unknown> };
    const client = realCreate('https://example.supabase.co', 'anon-test-key', {
      auth: { flowType: opts.auth.flowType as 'pkce', storageKey: opts.auth.storageKey as string, storage, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: 'https://app.otterquote.com/auth-callback', skipBrowserRedirect: true },
    });
    expect(error).toBeNull();
    expect(data.url).toContain('code_challenge=');
    expect(data.url).toContain('code_challenge_method=s256');
    expect([...mem.keys()].some((k) => k.endsWith('-code-verifier'))).toBe(true);
  });
});

describe('gh-1980 PR 3: rescueImplicitFragment (pre-flip #access_token links)', () => {
  const mkWin = (hash: string) => {
    const replaceState = vi.fn();
    return { win: { location: { hash, pathname: '/auth-callback', search: '?intent=homeowner' }, history: { state: null, replaceState } } as any, replaceState };
  };

  it('sets the session from a legacy fragment and strips it from the URL', async () => {
    const setSession = vi.fn().mockResolvedValue({ data: { session: { access_token: 'a' } }, error: null });
    const { win, replaceState } = mkWin('#access_token=AT&refresh_token=RT&expires_in=3600&token_type=bearer');
    await expect(rescueImplicitFragment({ auth: { setSession } } as any, win)).resolves.toBe(true);
    expect(setSession).toHaveBeenCalledWith({ access_token: 'AT', refresh_token: 'RT' });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/auth-callback?intent=homeowner');
  });

  it('returns false and never calls setSession when there is no fragment (e.g. a cross-device ?code= link)', async () => {
    const setSession = vi.fn();
    const { win } = mkWin('');
    await expect(rescueImplicitFragment({ auth: { setSession } } as any, win)).resolves.toBe(false);
    expect(setSession).not.toHaveBeenCalled();
  });

  it('returns false when the fragment lacks a refresh token or setSession rejects it', async () => {
    const setSession = vi.fn().mockResolvedValue({ data: { session: null }, error: new Error('bad') });
    await expect(rescueImplicitFragment({ auth: { setSession } } as any, mkWin('#access_token=AT').win)).resolves.toBe(false);
    expect(setSession).not.toHaveBeenCalled();
    await expect(rescueImplicitFragment({ auth: { setSession } } as any, mkWin('#access_token=AT&refresh_token=RT').win)).resolves.toBe(false);
  });
});