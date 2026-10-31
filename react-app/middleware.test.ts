// gh-3048: react-app/middleware.ts must verify the admin JWT through Supabase
// Auth (same approach as gh-3009 / PR #3040 in the Netlify edge gate). fetch is
// stubbed to play Supabase Auth, so this is pure-unit: no network, no secrets.
// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

const b64u = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const makeToken = (payload: Record<string, unknown>, alg = 'none') =>
  `${b64u({ alg, typ: 'JWT' })}.${b64u(payload)}.unsigned`;
const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 3600;
const ADMIN = 'dustinstohler1@gmail.com';

function req(token?: string, cookie = 'sb-otterquote-at') {
  return new NextRequest('https://otterquote.com/admin/dashboard', {
    headers: token ? { cookie: `${cookie}=${token}` } : {},
  });
}
// verifiedAs: email Supabase Auth returns; null = 401 (forged); 'throw' = unreachable.
// rpc: what POST /rest/v1/rpc/is_admin_email answers (gh-3077): true/false = body,
// 'error' = HTTP 500, 'throw' = network failure, 'garbage' = 200 with a non-boolean body.
function stubAuth(verifiedAs: string | null, rpc: boolean | 'error' | 'throw' | 'garbage' = true) {
  const calls: { url: string; auth: string | null; method: string; apikey: string | null }[] = [];
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    const h = new Headers(init?.headers);
    const url = String(input);
    calls.push({ url, auth: h.get('authorization'), method: init?.method ?? 'GET', apikey: h.get('apikey') });
    if (url.endsWith('/rest/v1/rpc/is_admin_email')) {
      if (rpc === 'throw') throw new Error('network down');
      if (rpc === 'error') return new Response('{}', { status: 500 });
      if (rpc === 'garbage') return new Response('"true"', { status: 200 });
      return new Response(JSON.stringify(rpc), { status: 200 });
    }
    if (verifiedAs === 'throw') throw new Error('network down');
    if (verifiedAs === null) return new Response('{"msg":"invalid JWT"}', { status: 401 });
    return new Response(JSON.stringify({ email: verifiedAs }), { status: 200 });
  });
  return calls;
}
const admitted = (r: Response) => r.headers.get('x-middleware-next') === '1';
const redirected = (r: Response) => r.status === 307 && new URL(r.headers.get('location')!).pathname === '/get-started';

afterEach(() => vi.unstubAllGlobals());

describe('middleware admin gate (gh-3048)', () => {
  it('valid token, verified admin email -> admitted, token sent to Supabase Auth', async () => {
    const calls = stubAuth(ADMIN);
    const token = makeToken({ email: ADMIN, exp: future() }, 'HS256');
    const res = await middleware(req(token));
    expect(admitted(res)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toMatch(/\/auth\/v1\/user$/);
    expect(calls[0].auth).toBe(`Bearer ${token}`);
    // gh-3077: the admin decision is the database's, asked with the caller's own JWT.
    expect(calls[1].url).toMatch(/\/rest\/v1\/rpc\/is_admin_email$/);
    expect(calls[1].method).toBe('POST');
    expect(calls[1].auth).toBe(`Bearer ${token}`);
  });

  it('gh-3077: any address is admitted when is_admin_email() says true (no list in middleware)', async () => {
    stubAuth('newadmin@example.com', true);
    expect(admitted(await middleware(req(makeToken({ email: 'newadmin@example.com', exp: future() }))))).toBe(true);
  });

  it('gh-3077 NEGATIVE CONTROL: verified token but is_admin_email() false -> redirected', async () => {
    stubAuth(ADMIN, false);
    expect(redirected(await middleware(req(makeToken({ email: ADMIN, exp: future() }))))).toBe(true);
  });

  it('gh-3077: RPC error / network failure / non-boolean body -> fail closed', async () => {
    for (const rpc of ['error', 'throw', 'garbage'] as const) {
      stubAuth(ADMIN, rpc);
      expect(redirected(await middleware(req(makeToken({ email: ADMIN, exp: future() }))))).toBe(true);
    }
  });

  it('legacy sb_at cookie still works when verified', async () => {
    stubAuth('dustin@otterquote.com');
    expect(admitted(await middleware(req(makeToken({ email: ADMIN, exp: future() }), 'sb_at')))).toBe(true);
  });

  it('NEGATIVE CONTROL: forged/unsigned token (alg none) claiming admin -> redirected', async () => {
    stubAuth(null);
    const res = await middleware(req(makeToken({ email: ADMIN, exp: future() }, 'none')));
    expect(admitted(res)).toBe(false);
    expect(redirected(res)).toBe(true);
  });

  it('wrong-key signature (Supabase Auth 401s) -> redirected', async () => {
    stubAuth(null);
    const res = await middleware(req(makeToken({ email: ADMIN, exp: future() }, 'HS256')));
    expect(redirected(res)).toBe(true);
  });

  it('expired token -> redirected, and Supabase Auth is not even asked', async () => {
    const calls = stubAuth(ADMIN);
    const res = await middleware(req(makeToken({ email: ADMIN, exp: past() })));
    expect(redirected(res)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('payload email is ignored; the database decides for the real caller', async () => {
    stubAuth('attacker@example.com', false);
    expect(redirected(await middleware(req(makeToken({ email: ADMIN, exp: future() }))))).toBe(true);
  });

  it('verified but non-admin email -> redirected', async () => {
    stubAuth('someone@example.com', false);
    expect(redirected(await middleware(req(makeToken({ email: 'someone@example.com', exp: future() }))))).toBe(true);
  });

  it('Supabase Auth unreachable -> fail closed', async () => {
    stubAuth('throw');
    expect(redirected(await middleware(req(makeToken({ email: ADMIN, exp: future() }))))).toBe(true);
  });

  it('no cookie / malformed token -> redirected', async () => {
    stubAuth(ADMIN);
    expect(redirected(await middleware(req()))).toBe(true);
    expect(redirected(await middleware(req('not.a.jwt.at.all')))).toBe(true);
  });
});
