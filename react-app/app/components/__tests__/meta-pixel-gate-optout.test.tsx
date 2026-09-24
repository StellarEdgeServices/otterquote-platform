// gh-2107 / D-330 -- the React Meta Pixel gate honours the advertising-sharing opt-out. Ben's ruling on #2078 (5805593465,
// item a): "For GPC=1 or ad_sharing_opt_out = true, the Meta pixel does not load." Renders the REAL MetaPixelGate.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

let mockPath = '/get-started';
let mockProfile: { user: { id: string } | null; row: { ad_sharing_opt_out?: boolean | null } | null; error: unknown; throws: boolean } = {
  user: { id: 'u1' }, row: { ad_sharing_opt_out: null }, error: null, throws: false,
};
const profileReads: string[] = [];

vi.mock('next/navigation', () => ({ usePathname: () => mockPath }));
vi.mock('next/script', () => ({
  default: (props: { src?: string; id?: string; children?: React.ReactNode }) =>
    props.src ? <span data-testid="pixel-src" data-src={props.src} /> : <span data-testid="pixel-init" data-id={props.id} />,
}));
vi.mock('../../lib/internal-traffic', () => ({ isInternalTraffic: () => false }));
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getUser: () => (mockProfile.throws ? Promise.reject(new Error('down')) : Promise.resolve({ data: { user: mockProfile.user } })) },
    from: (t: string) => ({
      select: () => ({ eq: () => { profileReads.push(t); return { maybeSingle: () => Promise.resolve({ data: mockProfile.row, error: mockProfile.error }) }; } }),
    }),
  },
}));

import { MetaPixelGate } from '../MetaPixelGate';

function setHost(host: string) {
  Object.defineProperty(window, 'location', { value: { ...window.location, hostname: host }, writable: true, configurable: true });
}
function clearCookie() { document.cookie = 'oq_ad_optout=; max-age=0; path=/'; }
// The gate writes the cookie with Domain=.otterquote.com when the (mocked) host is an otterquote.com host, which jsdom's
// localhost origin refuses to store; so the tests record what was WRITTEN instead of what jsdom kept.
const cookieWrites: string[] = [];
function spyOnCookieWrites() {
  cookieWrites.length = 0;
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => desc.get!.call(document),
    set: (v: string) => { cookieWrites.push(v); desc.set!.call(document, v); },
  });
}
const wroteOptOutCookie = () => cookieWrites.some((w) => w.startsWith('oq_ad_optout=1'));
const loaded = (c: HTMLElement) => c.querySelector('[data-testid="pixel-src"]') !== null;

describe('MetaPixelGate: the advertising-sharing opt-out', () => {
  beforeEach(() => {
    spyOnCookieWrites();
    clearCookie();
    profileReads.length = 0;
    mockPath = '/get-started';
    mockProfile = { user: { id: 'u1' }, row: { ad_sharing_opt_out: null }, error: null, throws: false };
    setHost('otterquote.com');
    vi.stubGlobal('navigator', { globalPrivacyControl: undefined });
  });
  afterEach(() => { cleanup(); delete (document as unknown as { cookie?: string }).cookie; clearCookie(); vi.unstubAllGlobals(); });

  it('CONTROL: a visitor who has not opted out gets the pixel on a marketing route', async () => {
    const { container } = render(<MetaPixelGate />);
    await waitFor(() => expect(loaded(container)).toBe(true));
    expect(container.querySelector('[data-testid="pixel-init"]')).not.toBeNull();
  });

  it('GPC on: the pixel does NOT load, on a marketing route', async () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: true });
    const { container } = render(<MetaPixelGate />);
    await new Promise((r) => setTimeout(r, 30));
    expect(loaded(container)).toBe(false);
    expect(container.querySelector('[data-testid="pixel-init"]')).toBeNull();
    expect(wroteOptOutCookie()).toBe(true);
  });

  it('the oq_ad_optout cookie alone (no GPC) keeps the pixel off', async () => {
    document.cookie = 'oq_ad_optout=1; path=/';
    const { container } = render(<MetaPixelGate />);
    await new Promise((r) => setTimeout(r, 30));
    expect(loaded(container)).toBe(false);
  });

  it('a marketing route makes NO profile read (only the authenticated route needs the stored flag)', async () => {
    const { container } = render(<MetaPixelGate />);
    await waitFor(() => expect(loaded(container)).toBe(true));
    expect(profileReads).toEqual([]);
  });

  describe('the authenticated /help-measurements route reads the stored flag BEFORE loading anything', () => {
    beforeEach(() => { mockPath = '/help-measurements'; setHost('app.otterquote.com'); });

    it('CONTROL: signed in, flag NULL -> the pixel loads (after the read)', async () => {
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(loaded(container)).toBe(true));
      expect(profileReads).toEqual(['profiles']);
    });

    it('signed in, ad_sharing_opt_out = true -> the pixel does NOT load, and the cookie is left for every later page', async () => {
      mockProfile.row = { ad_sharing_opt_out: true };
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(profileReads).toEqual(['profiles']));
      await new Promise((r) => setTimeout(r, 30));
      expect(loaded(container)).toBe(false);
      expect(wroteOptOutCookie()).toBe(true);
    });

    it('a failed profile read fails CLOSED: the pixel does not load', async () => {
      mockProfile.error = { code: '42703' };
      const { container } = render(<MetaPixelGate />);
      await waitFor(() => expect(profileReads).toEqual(['profiles']));
      await new Promise((r) => setTimeout(r, 30));
      expect(loaded(container)).toBe(false);
    });

    it('a thrown read and no signed-in user both fail closed', async () => {
      mockProfile.throws = true;
      const a = render(<MetaPixelGate />);
      await new Promise((r) => setTimeout(r, 30));
      expect(loaded(a.container)).toBe(false);
      cleanup();
      mockProfile = { user: null, row: null, error: null, throws: false };
      const b = render(<MetaPixelGate />);
      await new Promise((r) => setTimeout(r, 30));
      expect(loaded(b.container)).toBe(false);
    });

    it('GPC on -> no profile read at all and no pixel (the synchronous signal wins)', async () => {
      vi.stubGlobal('navigator', { globalPrivacyControl: true });
      const { container } = render(<MetaPixelGate />);
      await new Promise((r) => setTimeout(r, 30));
      expect(profileReads).toEqual([]);
      expect(loaded(container)).toBe(false);
    });
  });
});
