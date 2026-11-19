// gh-3730: /contractor/bid/* on app.otterquote.com must 308 to the static contractor-bid-form.html
// for the same claim, keeping every query param (renew, action, oq_internal, ...). Fails on main
// (middleware passed these requests through, 200 from the React page).
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from '../../../middleware';
import { staticBidFormUrl, isReactBidRoute } from '../bid-route-redirect';

const ID = '7f3c2a10-1b2d-4c3e-9a8b-0123456789ab';
const get = (path: string) => middleware(new NextRequest(`https://app.otterquote.com${path}`));
const loc = (r: Response) => new URL(r.headers.get('location')!);

describe('gh-3730 React bid route redirects to the static bid form', () => {
  it('/contractor/bid/<id> -> 308 https://otterquote.com/contractor-bid-form.html?claim_id=<id>', async () => {
    const r = await get(`/contractor/bid/${ID}`);
    expect(r.status).toBe(308);
    expect(r.headers.get('location')).toBe(`https://otterquote.com/contractor-bid-form.html?claim_id=${ID}`);
  });

  it('keeps oq_internal=1 and the mode params', async () => {
    const l = loc(await get(`/contractor/bid/${ID}?oq_internal=1&renew=true&action=rescind&trades=roofing`));
    expect(l.origin + l.pathname).toBe('https://otterquote.com/contractor-bid-form.html');
    expect(l.searchParams.get('claim_id')).toBe(ID);
    expect(l.searchParams.get('oq_internal')).toBe('1');
    expect(l.searchParams.get('renew')).toBe('true');
    expect(l.searchParams.get('action')).toBe('rescind');
    expect(l.searchParams.get('trades')).toBe('roofing');
  });

  it('the path segment wins over a claim_id / project in the query', () => {
    const l = new URL(staticBidFormUrl(`https://app.otterquote.com/contractor/bid/${ID}?claim_id=other&project=other2`)!);
    expect(l.searchParams.getAll('claim_id')).toEqual([ID]);
    expect(l.searchParams.has('project')).toBe(false);
  });

  it('no segment: query claim_id / project is passed through for the static form to resolve', () => {
    const l = new URL(staticBidFormUrl('https://app.otterquote.com/contractor/bid?project=abc')!);
    expect(l.searchParams.get('project')).toBe('abc');
  });

  it('percent-encoded segment is decoded once and re-encoded safely', () => {
    expect(staticBidFormUrl('https://app.otterquote.com/contractor/bid/a%26b')).toBe(
      'https://otterquote.com/contractor-bid-form.html?claim_id=a%26b');
  });

  it('is a redirect only: no cache-warming for attribution, and not cached as permanent state', async () => {
    const r = await get(`/contractor/bid/${ID}`);
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(r.headers.get('cache-control')).toMatch(/no-cache/);
  });

  it('does not capture look-alike or other contractor routes', async () => {
    expect(isReactBidRoute('/contractor/bidding')).toBe(false);
    expect(isReactBidRoute('/contractor/opportunities')).toBe(false);
    const r = await get('/contractor/bidding/x');
    expect(r.status).not.toBe(308);
  });

  it('middleware matcher covers the bid route (otherwise Next never calls it)', () => {
    expect(config.matcher).toEqual(expect.arrayContaining(['/contractor/bid', '/contractor/bid/:path*']));
  });
});
