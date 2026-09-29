/**
 * gh-1980 PR 3/3, RE-SCOPED (Ben's ruling on #1980, comment 5889011351; Dustin:
 * "PKCE for Google only"): the shared React client stays IMPLICIT so emailed
 * magic / recovery / confirmation links keep working on any device; only Google
 * OAuth is PKCE (dedicated initiation client + a pkce client on the one page
 * load that is a verifier-backed ?code= return).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { rescueImplicitFragment } from '../../auth-callback/implicit-fragment';
import { flowTypeForPageLoad, createVerifierOnlyStorage } from '../oauth-pkce';

const createClientMock = vi.fn(() => ({ auth: {} }));
vi.mock('@supabase/supabase-js', async (orig) => {
  const actual = await orig<typeof import('@supabase/supabase-js')>();
  return { ...actual, createClient: (...args: unknown[]) => (createClientMock as any)(...args) };
});

const appDir = path.resolve(__dirname, '../..');
const src = (rel: string) => fs.readFileSync(path.join(appDir, rel), 'utf8');

function setUrl(url: string) {
  window.history.replaceState(null, '', url);
}

describe('gh-1980 PR 3: the shared React client is implicit except on a Google ?code= return', () => {
  beforeEach(() => {
    vi.resetModules();
    createClientMock.mockClear();
    localStorage.clear();
    setUrl('/');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-test-key');
  });

  const flowOfSharedClient = async () => {
    await import('../supabase');
    expect(createClientMock).toHaveBeenCalledTimes(1);
    const opts = (createClientMock.mock.calls[0] as unknown[])[2] as { auth: Record<string, unknown> };
    expect(opts.auth.storageKey).toBe('sb-otterquote-auth');
    return opts.auth.flowType;
  };

  it('(a) plain load -> implicit', async () => {
    expect(await flowOfSharedClient()).toBe('implicit');
  });

  it('(a) emailed-link fragment landing -> implicit, even with a stale verifier stored', async () => {
    localStorage.setItem('sb-otterquote-auth-code-verifier', 'stale');
    setUrl('/auth-callback#access_token=AT&refresh_token=RT&expires_in=3600&token_type=bearer');
    expect(await flowOfSharedClient()).toBe('implicit');
  });

  it('(a) ?code= with NO stored verifier (cross-device / referral-style) -> implicit', async () => {
    setUrl('/auth-callback?code=abc');
    expect(await flowOfSharedClient()).toBe('implicit');
  });

  it('(a) ?code= WITH a stored verifier (our own Google return) -> pkce', async () => {
    localStorage.setItem('sb-otterquote-auth-code-verifier', 'v');
    setUrl('/auth-callback?intent=homeowner&code=abc');
    expect(await flowOfSharedClient()).toBe('pkce');
  });

  it('(a) ?code= + sb_flow_id resolves the slot verifier', () => {
    localStorage.setItem('sb-otterquote-auth-flow-f1-code-verifier', 'v');
    setUrl('/auth-callback?code=abc&sb_flow_id=f1');
    expect(flowTypeForPageLoad()).toBe('pkce');
    setUrl('/auth-callback?code=abc&sb_flow_id=other');
    expect(flowTypeForPageLoad()).toBe('implicit');
  });
});

describe('gh-1980 PR 3: Google initiation is PKCE on an isolated, verifier-only storage', () => {
  beforeEach(() => {
    vi.resetModules();
    createClientMock.mockClear();
    localStorage.clear();
    setUrl('/');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-test-key');
  });

  it('(b) a real supabase-js client built by signInWithGoogleOAuth emits code_challenge and stores the verifier under the canonical key', async () => {
    const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js');
    createClientMock.mockImplementation(((...a: unknown[]) => (actual.createClient as any)(...a)) as any);
    const { signInWithGoogleOAuth } = await import('../supabase-oauth');
    const { data, error } = await signInWithGoogleOAuth({
      redirectTo: 'https://app.otterquote.com/auth-callback?intent=homeowner',
      skipBrowserRedirect: true,
    });
    expect(error).toBeNull();
    expect(data.url).toContain('code_challenge=');
    expect(data.url).toContain('code_challenge_method=s256');
    expect(localStorage.getItem('sb-otterquote-auth-code-verifier')).toBeTruthy();
    const opts = (createClientMock.mock.calls[0] as unknown[])[2] as { auth: Record<string, unknown> };
    expect(opts.auth.flowType).toBe('pkce');
    expect(opts.auth.storageKey).toBe('sb-otterquote-auth');
    expect(opts.auth.detectSessionInUrl).toBe(false);
    expect(opts.auth.autoRefreshToken).toBe(false);
  });

  it('(b) the initiation storage never reads, writes or clears the shared session', () => {
    const real = {
      getItem: vi.fn(() => 'SESSION'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const st = createVerifierOnlyStorage(real as any);
    expect(st.getItem('sb-otterquote-auth')).toBeNull();
    st.setItem('sb-otterquote-auth', 'x');
    st.removeItem('sb-otterquote-auth');
    expect(real.getItem).not.toHaveBeenCalled();
    expect(real.setItem).not.toHaveBeenCalled();
    expect(real.removeItem).not.toHaveBeenCalled();
    st.setItem('sb-otterquote-auth-code-verifier', 'v');
    st.setItem('sb-otterquote-auth-flow-f1-code-verifier', 'v');
    expect(real.setItem).toHaveBeenCalledTimes(2);
    expect(st.getItem('sb-otterquote-auth-code-verifier')).toBe('SESSION');
  });

  it('(b) every React Google entry point initiates through signInWithGoogleOAuth, none through the shared client', () => {
    for (const rel of ['login/page.tsx', 'contractor/login/page.tsx', 'get-started/page.tsx']) {
      const code = src(rel);
      expect(code, rel).toContain('signInWithGoogleOAuth(');
      expect(code, rel).not.toMatch(/supabase\.auth\.signInWithOAuth\(/);
    }
  });
});

describe('gh-1980 PR 3: email-initiated flows are not PKCE-bound', () => {
  it('(d) the auth-uniform caller and the email pages carry no code_challenge / pkce', () => {
    for (const rel of ['lib/auth-uniform.ts', 'login/page.tsx', 'contractor/login/page.tsx']) {
      const code = src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, rel).not.toMatch(/code_challenge|flowType/);
    }
    // get-started signUp() rides the shared implicit client (no flowType override).
    const gs = src('get-started/page.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(gs).toMatch(/supabase\.auth\.signUp\(/);
    expect(gs).not.toMatch(/flowType/);
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