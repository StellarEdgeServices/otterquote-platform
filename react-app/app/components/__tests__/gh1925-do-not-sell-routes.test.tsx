/**
 * gh-1925 (CEO ruling #2304 5963898698 item 5): the ruled Do Not Sell link, verbatim, on /, /login, /refer, /trade-selector and
 * /partner/dashboard via the root layout; absent from admin pages and auth-callback; never duplicated on routes whose shell
 * already carries it. Renders the REAL RootLayout (not just the component) so a layout that stops mounting it fails here.
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

let mockPath = '/';
vi.mock('next/navigation', () => ({ usePathname: () => mockPath }));
vi.mock('next/script', () => ({ default: () => null }));
vi.mock('../AttributionCapture', () => ({ AttributionCapture: () => null }));
vi.mock('../GA4Gate', () => ({ GA4Gate: () => null }));
vi.mock('../MetaPixelGate', () => ({ MetaPixelGate: () => null }));
vi.mock('../LinkedInInsightGate', () => ({ LinkedInInsightGate: () => null }));
vi.mock('../RedditPixelGate', () => ({ RedditPixelGate: () => null }));
vi.mock('../SentryInitializer', () => ({ SentryInitializer: () => null }));
vi.mock('../../providers/auth-provider', () => ({ AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../../lib/query-client', () => ({ QueryClientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../../globals.css', () => ({}));

import RootLayout from '../../layout';
import { DoNotSellLink, DO_NOT_SELL_HREF, DO_NOT_SELL_ROUTES, DO_NOT_SELL_TEXT } from '../DoNotSellLink';

const TEXT = 'Do Not Sell or Share My Personal Information';
const HREF = 'https://otterquote.com/privacy.html#do-not-sell-or-share';
// CEO ruling #2304 5973477617: /contractor/login (signed-out route) carries the same link as every other route.
const ROUTES = ['/', '/login', '/refer', '/trade-selector', '/partner/dashboard', '/contractor/login'];

// RootLayout returns <html><body>...</body></html>; render the body's children so the layout's own mounts are exercised.
function renderLayout(p: string) {
  mockPath = p;
  const html = RootLayout({ children: <main>page</main> }) as React.ReactElement<{ children: React.ReactElement<{ children: React.ReactNode }> }>;
  return render(<div>{html.props.children.props.children}</div>);
}
const dnsLinks = (c: HTMLElement) => [...c.querySelectorAll('a')].filter((a) => a.textContent === TEXT);
afterEach(cleanup);

describe('gh-1925: Do Not Sell link on the consumer React routes (root layout)', () => {
  for (const route of ROUTES) {
    it(`${route}: exact text, exact absolute href, exactly once`, () => {
      const { container } = renderLayout(route);
      const links = dnsLinks(container);
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute('href')).toBe(HREF);
    });
  }
  it('tolerates a trailing slash', () => {
    const { container } = renderLayout('/login/');
    expect(dnsLinks(container)).toHaveLength(1);
  });
  for (const route of ['/admin/contractors', '/admin/payouts', '/auth-callback', '/contractor/dashboard', '/dashboard', '/get-started', '/partner', '/refer/x']) {
    it(`${route}: no link from the layout (admin/auth-callback excluded; shells and get-started carry their own)`, () => {
      const { container } = renderLayout(route);
      expect(container.textContent).not.toContain(TEXT);
    });
  }
  // The real negative control for the layout mount is the source assertion below plus the
  // per-route RootLayout renders above: removing the mount from layout.tsx fails both (observed
  // when the PR was built). A render of a hand-built tree without the component cannot fail and
  // would prove nothing, so none is kept here.
  // Guard against deletion: the five routes shipped by the earlier PRs must stay in the allowlist, and the strings must not drift.
  it('keeps every previously allowlisted route and the ruled strings (nothing removed)', () => {
    for (const r of ['/', '/login', '/refer', '/trade-selector', '/partner/dashboard']) {
      expect(DO_NOT_SELL_ROUTES as readonly string[]).toContain(r);
    }
    expect(DO_NOT_SELL_ROUTES as readonly string[]).toContain('/contractor/login');
    expect(DO_NOT_SELL_TEXT).toBe(TEXT);
    expect(DO_NOT_SELL_HREF).toBe(HREF);
  });
  it('the layout source mounts DoNotSellLink', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../layout.tsx'), 'utf8');
    expect(src).toContain('<DoNotSellLink />');
  });
  it('the component renders the link directly too', () => {
    mockPath = '/refer';
    const { container } = render(<DoNotSellLink />);
    expect(container.querySelector('a')!.getAttribute('href')).toBe(HREF);
  });
});
