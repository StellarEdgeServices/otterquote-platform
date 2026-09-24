// gh-2107 / D-330 -- the two protective gaps #2106 left in the React Meta Pixel gate. Ben's DECIDED ruling d. on #2078
// (5805593465): "The React pixel on /help-measurements lacks the check that keeps tokens in the URL away from Meta. The page also
// sends a PageView where D-330 allows only Purchase. Both are protective fixes." Renders the REAL MetaPixelGate.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

let mockPath = '/get-started';
let mockOptedOut: boolean | null = null;
let sessionGate: Promise<void> | null = null; // when set, getSession() waits for it (the cancelled-race test)

vi.mock('next/navigation', () => ({ usePathname: () => mockPath }));
vi.mock('next/script', () => ({
  default: (props: { src?: string; id?: string; children?: React.ReactNode }) =>
    props.src
      ? <span data-testid="pixel-src" data-src={props.src} />
      : <span data-testid="pixel-init" data-id={props.id} data-body={String(props.children ?? '')} />,
}));
vi.mock('../../lib/internal-traffic', () => ({ isInternalTraffic: () => false }));
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getSession: () => (sessionGate ?? Promise.resolve()).then(() => ({ data: { session: { user: { id: 'u1' } } }, error: null })) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { ad_sharing_opt_out: mockOptedOut }, error: null }) }) }) }),
  },
}));

import { MetaPixelGate } from '../MetaPixelGate';

function setLocation(host: string, hash = '', search = '') {
  Object.defineProperty(window, 'location', { value: { ...window.location, hostname: host, hash, search }, writable: true, configurable: true });
}
const loaded = (c: HTMLElement) => c.querySelector('[data-testid="pixel-src"]') !== null;
const initBody = (c: HTMLElement) => c.querySelector('[data-testid="pixel-init"]')?.getAttribute('data-body') ?? null;

describe('MetaPixelGate: token-in-URL guard and the PageView rule', () => {
  beforeEach(() => {
    mockPath = '/get-started';
    mockOptedOut = null;
    sessionGate = null;
    setLocation('otterquote.com');
    vi.stubGlobal('navigator', { globalPrivacyControl: undefined });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  describe('gap 1: a live auth credential in the URL fragment means the pixel never loads (fbevents.js reads location.href)', () => {
    it('CONTROL: an ordinary fragment loads the pixel', async () => {
      setLocation('otterquote.com', '#section-2');
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(loaded(container)).toBe(true));
    });

    it.each(['access_token', 'refresh_token', 'provider_token'])('a %s in the fragment: no pixel on a marketing route', async (k) => {
      setLocation('otterquote.com', `#${k}=abc&type=recovery`);
      const { container } = render(<MetaPixelGate />);
      await new Promise((r) => setTimeout(r, 30));
      expect(loaded(container)).toBe(false);
      expect(initBody(container)).toBeNull();
    });

    it.each(['access_token', 'refresh_token', 'provider_token'])('a %s in the fragment: no pixel on /help-measurements either (the authenticated route)', async (k) => {
      mockPath = '/help-measurements';
      setLocation('app.otterquote.com', `#${k}=abc`);
      const { container } = render(<MetaPixelGate />);
      await new Promise((r) => setTimeout(r, 30));
      expect(loaded(container)).toBe(false);
    });

    // REVIEW B1 on #2139: a credential in the QUERY STRING must not reach Meta either (fbevents.js reads location.href for `dl`, and the
    // pixel's server config strips no keys). Exact parameter names only: `code` is this site's own referral parameter and must keep loading.
    it.each(['access_token', 'refresh_token', 'provider_token', 'token_hash', 'token'])('a ?%s= in the query string: no pixel on a marketing route', async (k) => {
      setLocation('otterquote.com', '', `?${k}=abc&x=1`);
      const { container } = render(<MetaPixelGate />);
      await new Promise((r) => setTimeout(r, 30));
      expect(loaded(container)).toBe(false);
      expect(initBody(container)).toBeNull();
    });

    it.each(['access_token', 'refresh_token', 'provider_token', 'token_hash', 'token'])('a ?%s= in the query string: no pixel on /help-measurements either', async (k) => {
      mockPath = '/help-measurements';
      setLocation('app.otterquote.com', '', `?step=1&${k}=abc`);
      const { container } = render(<MetaPixelGate />);
      await new Promise((r) => setTimeout(r, 30));
      expect(loaded(container)).toBe(false);
    });

    it.each([
      ['a referral ?code= (this site\'s own parameter)', '?code=ABC123'],
      ['a ?promocode=', '?promocode=SAVE10'],
      ['a ?zipcode=', '?zipcode=46224'],
      ['a ?mytoken= (the word inside another key)', '?mytoken=x'],
      ['a ?tokens= (a longer key)', '?tokens=2'],
      ['a value that mentions the word', '?note=access_token'],
      ['utm parameters', '?utm_source=facebook&utm_medium=cpc'],
    ])('CONTROL: %s still loads the pixel (exact key names only)', async (_label, search) => {
      setLocation('otterquote.com', '', search);
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(loaded(container)).toBe(true));
    });

    it('a query string that cannot be parsed fails CLOSED (the pixel does not load)', async () => {
      setLocation('otterquote.com', '', '?x=1');
      vi.stubGlobal('URLSearchParams', class { constructor() { throw new Error('unparseable'); } });
      const { container } = render(<MetaPixelGate />);
      await new Promise((r) => setTimeout(r, 30));
      expect(loaded(container)).toBe(false);
    });

    it('CONTROL: an ordinary fragment plus an ordinary query still loads', async () => {
      setLocation('otterquote.com', '#section-2', '?ref=home');
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(loaded(container)).toBe(true));
    });
  });

  describe('the stored-flag read is cancelled when the route changes before it resolves (REVIEW N2, survivor from #2134)', () => {
    it('a late "not opted out" answer for /get-started does NOT load the pixel after the visitor moved to a route that never loads it', async () => {
      let release: () => void = () => {};
      sessionGate = new Promise<void>((res) => { release = res; });
      mockOptedOut = false;
      const { container, rerender } = render(<MetaPixelGate />); // /get-started: the read is in flight
      mockPath = '/dashboard'; // an excluded route
      rerender(<MetaPixelGate />);
      release(); // the stale read now resolves with `false`
      await new Promise((r) => setTimeout(r, 40));
      expect(loaded(container)).toBe(false);
      expect(initBody(container)).toBeNull();
    });

    it('CONTROL: with no route change the same late answer DOES load it', async () => {
      let release: () => void = () => {};
      sessionGate = new Promise<void>((res) => { release = res; });
      mockOptedOut = false;
      const { container } = render(<MetaPixelGate />);
      expect(loaded(container)).toBe(false);
      release();
      await waitFor(() => expect(loaded(container)).toBe(true));
    });
  });

  describe('gap 2: PageView only where D-330 allows it; /help-measurements sends Purchase only', () => {
    it('CONTROL: /get-started still fires init AND PageView (D-322 marketing route)', async () => {
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(initBody(container)).not.toBeNull());
      const body = initBody(container)!;
      expect(body).toContain("fbq('init',");
      expect(body).toContain("fbq('track', 'PageView');");
    });

    it('/help-measurements initialises the pixel (so fbq(\'track\',\'Purchase\') works) but sends NO PageView', async () => {
      mockPath = '/help-measurements';
      setLocation('app.otterquote.com');
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(initBody(container)).not.toBeNull());
      const body = initBody(container)!;
      expect(body).toContain("fbq('init',");
      expect(body).not.toContain('PageView');
      expect(loaded(container)).toBe(true);
    });

    it('a sub-path of /help-measurements follows the same rule', async () => {
      mockPath = '/help-measurements/resume';
      setLocation('app.otterquote.com');
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(initBody(container)).not.toBeNull());
      expect(initBody(container)).not.toContain('PageView');
    });

    // REVIEW B2 on #2139: fbevents.js wraps pushState / replaceState / popstate and sends its OWN PageView on a client-side URL change
    // once any event has fired. The only thing that stops it is `fbq.disablePushState = true`, set before `init`.
    it.each(['/help-measurements', '/get-started'])('%s: the init body sets fbq.disablePushState = true, BEFORE fbq(init)', async (path) => {
      mockPath = path;
      setLocation('app.otterquote.com');
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(initBody(container)).not.toBeNull());
      const body = initBody(container)!;
      const flagAt = body.indexOf('fbq.disablePushState = true');
      const initAt = body.indexOf("fbq('init',");
      expect(flagAt).toBeGreaterThan(-1);
      expect(initAt).toBeGreaterThan(flagAt);
    });

    // A model of the part of fbevents.js in question (documented in REVIEW 5807912369 B2): once an event has fired, a history change
    // sends an automatic PageView unless fbq.disablePushState is true. The init body is EXECUTED here, so this tests what the page runs.
    function runInitBodyThenPushState(body: string, opts: { pageviewRoute: boolean }) {
      const sent: string[] = [];
      const history = { pushState: (_s: unknown, _t: string, _u: string) => {} };
      const win: Record<string, unknown> = { history };
      // eslint-disable-next-line no-new-func
      new Function('window', 'with (window) {' + body + '}')(win); // `fbq` resolves to window.fbq, as in a browser
      const fbq = win.fbq as ((...a: unknown[]) => void) & { queue: unknown[][]; disablePushState?: boolean; callMethod?: (...a: unknown[]) => void };
      let eventFired = false;
      // "fbevents.js loads": it installs callMethod on the same object, drains the queue once, and wraps history.pushState.
      fbq.callMethod = (...a: unknown[]) => { if (a[0] === 'track') { eventFired = true; sent.push(String(a[1])); } };
      fbq.queue.forEach((q) => fbq.callMethod!(...Array.from(q)));
      const orig = history.pushState;
      history.pushState = (a, b, c) => { orig(a, b, c); if (!fbq.disablePushState && eventFired) sent.push('PageView(auto:pushState)'); };
      fbq('track', 'Purchase', { value: 15, currency: 'USD' });
      history.pushState({}, '', opts.pageviewRoute ? '/get-started?step=2' : '/help-measurements?step=done');
      return sent;
    }

    it('BEHAVIOUR: on /help-measurements, Purchase then a pushState sends NO PageView (init only, Purchase only)', async () => {
      mockPath = '/help-measurements';
      setLocation('app.otterquote.com');
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(initBody(container)).not.toBeNull());
      const sent = runInitBodyThenPushState(initBody(container)!, { pageviewRoute: false });
      expect(sent).toEqual(['Purchase']);
    });

    it('MODEL CONTROL: without the flag the same model DOES send an automatic PageView on pushState (so the test above can fail)', async () => {
      mockPath = '/help-measurements';
      setLocation('app.otterquote.com');
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(initBody(container)).not.toBeNull());
      const withoutFlag = initBody(container)!.replace('window.fbq.disablePushState = true;', '');
      const sent = runInitBodyThenPushState(withoutFlag, { pageviewRoute: false });
      expect(sent).toContain('PageView(auto:pushState)');
    });

    it('the meta-pixel-init stub is unchanged (gh-2000 callMethod forwarding)', async () => {
      mockPath = '/help-measurements';
      setLocation('app.otterquote.com');
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(initBody(container)).not.toBeNull());
      expect(initBody(container)).toContain('n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments)');
    });
  });
});
