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
// verifiedAs: email Supabase returns; null = 401 (forged); 'throw' = unreachable
function stubAuth(verifiedAs: string | null) {
  const calls: { url: string; auth: string | null }[] = [];
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
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
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/auth\/v1\/user$/);
    expect(calls[0].auth).toBe(`Bearer ${token}`);
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

  it('payload email is ignored; the verified email decides', async () => {
    stubAuth('attacker@example.com');
    expect(redirected(await middleware(req(makeToken({ email: ADMIN, exp: future() }))))).toBe(true);
  });

  it('verified but non-admin email -> redirected', async () => {
    stubAuth('someone@example.com');
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
