// gh-2107 / D-330 -- the two protective gaps #2106 left in the React Meta Pixel gate. Ben's DECIDED ruling d. on #2078
// (5805593465): "The React pixel on /help-measurements lacks the check that keeps tokens in the URL away from Meta. The page also
// sends a PageView where D-330 allows only Purchase. Both are protective fixes." Renders the REAL MetaPixelGate.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

let mockPath = '/get-started';
let mockOptedOut: boolean | null = null;

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
    auth: { getSession: () => Promise.resolve({ data: { session: { user: { id: 'u1' } } }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { ad_sharing_opt_out: mockOptedOut }, error: null }) }) }) }),
  },
}));

import { MetaPixelGate } from '../MetaPixelGate';

function setLocation(host: string, hash = '') {
  Object.defineProperty(window, 'location', { value: { ...window.location, hostname: host, hash }, writable: true, configurable: true });
}
const loaded = (c: HTMLElement) => c.querySelector('[data-testid="pixel-src"]') !== null;
const initBody = (c: HTMLElement) => c.querySelector('[data-testid="pixel-init"]')?.getAttribute('data-body') ?? null;

describe('MetaPixelGate: token-in-URL guard and the PageView rule', () => {
  beforeEach(() => {
    mockPath = '/get-started';
    mockOptedOut = null;
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

    it('a key that merely CONTAINS the word elsewhere in the URL is not the fragment guard (only the hash is checked)', async () => {
      setLocation('otterquote.com', '');
      const { container } = render(<MetaPixelGate />);
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

    it('the meta-pixel-init stub is unchanged (gh-2000 callMethod forwarding)', async () => {
      mockPath = '/help-measurements';
      setLocation('app.otterquote.com');
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(initBody(container)).not.toBeNull());
      expect(initBody(container)).toContain('n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments)');
    });
  });
});
