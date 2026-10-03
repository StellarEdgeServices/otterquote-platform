/**
 * gh-1925: the 404 page carries the ruled Do Not Sell link exactly once, unconditionally. Renders NotFound inside the REAL
 * RootLayout (as the App Router does) at arbitrary pathnames and asserts exactly one link, exact text + href. Also pins the
 * layout allowlist to the five real routes so the layout-mounted link and the not-found link can never both render.
 */
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
import NotFound from '../../not-found';
import { DO_NOT_SELL_ROUTES } from '../DoNotSellLink';

const TEXT = 'Do Not Sell or Share My Personal Information';
const HREF = 'https://otterquote.com/privacy.html#do-not-sell-or-share';

function renderNotFoundInLayout(p: string) {
  mockPath = p;
  const html = RootLayout({ children: <NotFound /> }) as React.ReactElement<{ children: React.ReactElement<{ children: React.ReactNode }> }>;
  return render(<div>{html.props.children.props.children}</div>);
}
const dnsLinks = (c: HTMLElement) => [...c.querySelectorAll('a')].filter((a) => a.textContent === TEXT);
afterEach(cleanup);

describe('gh-1925 not-found carries the Do Not Sell link', () => {
  it.each(['/no-such-page', '/admin/whatever', '/auth-callback/x', '/a/b/c'])('exactly one ruled link at %s', (p) => {
    const { container } = renderNotFoundInLayout(p);
    const links = dnsLinks(container);
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(HREF);
  });

  it.each(['/no-such-page', '/a/b/c'])('exactly one home link to the marketing site at %s', (p) => {
    const { container } = renderNotFoundInLayout(p);
    const home = [...container.querySelectorAll('a')].filter((a) => a.textContent === 'Go to the homepage');
    expect(home).toHaveLength(1);
    expect(home[0].getAttribute('href')).toBe('https://otterquote.com/');
    expect(dnsLinks(container)).toHaveLength(1);
  });

  it('layout allowlist is exactly the five real routes, so the layout link cannot double on a 404', () => {
    expect([...DO_NOT_SELL_ROUTES]).toEqual(['/', '/login', '/refer', '/trade-selector', '/partner/dashboard']);
  });
});
