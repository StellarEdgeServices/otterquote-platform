// gh-1925 -- CCPA/CPRA "Do Not Sell or Share" via Global Privacy Control, extended to the tags that did not yet honour it:
// GA4Gate.tsx (the GA4 library, which carries Google Ads/Signals once linked; and, since D-354 -- Dustin's ruling on #1925, comment
// 5973764305 -- Microsoft Clarity, which that same component loads) and the LinkedIn/Reddit gates shipped dark by
// #2102. MetaPixelGate.tsx already honoured this (gh-2107 / D-330); this file proves GA4Gate now does too (its MEASUREMENT_ID
// is live, so a real render-based test is possible), using the SAME lib/ad-optout.ts helper and the SAME oq_ad_optout cookie
// MetaPixelGate.tsx reads/writes.
//
// LinkedInInsightGate.tsx and RedditPixelGate.tsx are still SHIPPED DARK (LINKEDIN_PARTNER_ID / REDDIT_PIXEL_ID are empty-string
// placeholders, #1926/#2102) -- their dark-merge `if (!ID) return;` fires before any other check runs, so a render-based test
// cannot observe a behavioural difference for GPC today (both "GPC on" and "GPC absent" render nothing, for the same reason
// the PIXEL_ID is empty). A structural check instead proves the opt-out call exists in source, in the correct position (after
// the dark-merge/path checks, before the host check -- the same position MetaPixelGate.tsx uses), so the gate is provably
// live the moment a real ID lands, without this test having to fake one out of a `const`.
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

let mockPath = '/get-started';
// gh-1925 / D-354: the signed-in account's stored flag (profiles.ad_sharing_opt_out), read by GA4Gate through lib/ad-optout.ts's
// readStoredOptOut before anything loads. Default: NO session (a signed-out visitor), which is what every pre-D-354 test here assumed.
let mockProfile: { user: { id: string } | null; row: { ad_sharing_opt_out?: boolean | null } | null; error: unknown; throws: boolean } = {
  user: null, row: null, error: null, throws: false,
};
const profileReads: string[] = [];

vi.mock('next/navigation', () => ({ usePathname: () => mockPath }));
vi.mock('next/script', () => ({
  default: (props: { src?: string; id?: string; children?: React.ReactNode }) =>
    props.src ? <span data-testid="tag-src" data-src={props.src} /> : <span data-testid="tag-init" data-id={props.id} />,
}));
vi.mock('../../lib/internal-traffic', () => ({ isInternalTraffic: () => false }));
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getSession: () => (mockProfile.throws ? Promise.reject(new Error('down')) : Promise.resolve({ data: { session: mockProfile.user ? { user: mockProfile.user } : null }, error: null })) },
    from: (t: string) => ({
      select: () => ({ eq: () => { profileReads.push(t); return { maybeSingle: () => Promise.resolve({ data: mockProfile.row, error: mockProfile.error }) }; } }),
    }),
  },
}));

import { GA4Gate } from '../GA4Gate';

function setHost(host: string) {
  Object.defineProperty(window, 'location', { value: { ...window.location, hostname: host }, writable: true, configurable: true });
}
function clearCookie() { document.cookie = 'oq_ad_optout=; max-age=0; path=/'; }
// The gate writes the cookie with Domain=.otterquote.com when the (mocked) host is an otterquote.com host, which jsdom's
// localhost origin refuses to store; so the tests record what was WRITTEN instead of what jsdom kept (same technique as
// meta-pixel-gate-optout.test.tsx).
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
const srcLoaded = (c: HTMLElement, substr: string) =>
  Array.from(c.querySelectorAll('[data-testid="tag-src"]')).some((el) => String(el.getAttribute('data-src')).indexOf(substr) !== -1);
const initRendered = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="tag-init"][data-id="${id}"]`) !== null;

beforeEach(() => {
  spyOnCookieWrites();
  clearCookie();
  mockPath = '/get-started';
  mockProfile = { user: null, row: null, error: null, throws: false };
  profileReads.length = 0;
  setHost('otterquote.com');
  vi.stubGlobal('navigator', { globalPrivacyControl: undefined });
});
afterEach(() => { cleanup(); delete (document as unknown as { cookie?: string }).cookie; clearCookie(); vi.unstubAllGlobals(); });

describe('GA4Gate: the advertising-sharing opt-out (gh-1925)', () => {
  it('CONTROL: an ordinary visitor on an allowed host loads the GA4 library', async () => {
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(srcLoaded(container, 'googletagmanager.com/gtag')).toBe(true));
  });

  it('GPC on: the GA4 library does NOT load, and the shared oq_ad_optout cookie is left', async () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: true });
    const { container } = render(<GA4Gate />);
    await new Promise((r) => setTimeout(r, 30));
    expect(srcLoaded(container, 'googletagmanager.com/gtag')).toBe(false);
    expect(wroteOptOutCookie()).toBe(true);
  });

  it('the oq_ad_optout cookie alone (no GPC) keeps the GA4 library off', async () => {
    document.cookie = 'oq_ad_optout=1; path=/';
    const { container } = render(<GA4Gate />);
    await new Promise((r) => setTimeout(r, 30));
    expect(srcLoaded(container, 'googletagmanager.com/gtag')).toBe(false);
  });

  it('GPC absent, no cookie: behaviour is unchanged (GA4 loads)', async () => {
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(srcLoaded(container, 'googletagmanager.com/gtag')).toBe(true));
  });

  // D-354 (Dustin's ruling on #1925, comment 5973764305: "Yes, gate Clarity (Recommended)"). This test used to assert the OPPOSITE --
  // "GPC on: the GA4 library does NOT load, but Clarity STILL loads (Clarity is a separate vendor, not gated by #1925)" -- which was the
  // behaviour while the "is Clarity a share?" question was open (REVIEW FAIL 5850307606 on PR #2234 had required Clarity to stay on).
  // The ruling reverses it: an opted-out visitor gets neither. mockPath '/get-started' is on CLARITY_ALLOWED_PATHS, and the CONTROL
  // below shows Clarity does load there without the signal.
  it('D-354, GPC on: NEITHER the GA4 library NOR Clarity loads', async () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: true });
    const { container } = render(<GA4Gate />);
    await new Promise((r) => setTimeout(r, 50));
    expect(initRendered(container, 'clarity-init')).toBe(false);
    expect(srcLoaded(container, 'googletagmanager.com/gtag')).toBe(false);
    expect(initRendered(container, 'ga4-init')).toBe(false);
    expect(profileReads).toEqual([]); // the synchronous signal answers; no profile read is made
  });

  it('D-354, the oq_ad_optout cookie alone (the Section 12 button, no GPC): NEITHER GA4 NOR Clarity loads', async () => {
    document.cookie = 'oq_ad_optout=1; path=/';
    const { container } = render(<GA4Gate />);
    await new Promise((r) => setTimeout(r, 50));
    expect(initRendered(container, 'clarity-init')).toBe(false);
    expect(initRendered(container, 'ga4-init')).toBe(false);
  });

  it('GPC absent: both GA4 and Clarity load (CONTROL)', async () => {
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(initRendered(container, 'ga4-init')).toBe(true));
    expect(initRendered(container, 'clarity-init')).toBe(true);
  });
});

// gh-1925 / D-354: "the stored `profiles.ad_sharing_opt_out` flag (the stored-flag read is the gap #2509's legal read just found in the GA4
// gate; fix both gates the same way)". No cookie on this device and no GPC in any of these: the ONLY signal is the signed-in account's row.
describe('GA4Gate: the stored opt-out flag follows the signed-in person (gh-1925 / D-354)', () => {
  const signedIn = (flag: boolean | null) => { mockProfile = { user: { id: 'u1' }, row: { ad_sharing_opt_out: flag }, error: null, throws: false }; };

  it('stored flag TRUE: NEITHER GA4 NOR Clarity loads, and the oq_ad_optout cookie is left for later pages', async () => {
    signedIn(true);
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(profileReads).toEqual(['profiles']));
    await new Promise((r) => setTimeout(r, 50));
    expect(srcLoaded(container, 'googletagmanager.com/gtag')).toBe(false);
    expect(initRendered(container, 'ga4-init')).toBe(false);
    expect(initRendered(container, 'clarity-init')).toBe(false);
    expect(wroteOptOutCookie()).toBe(true);
  });

  it('CONTROL, stored flag FALSE: both GA4 and Clarity load, after exactly one profile read', async () => {
    signedIn(false);
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(initRendered(container, 'ga4-init')).toBe(true));
    expect(initRendered(container, 'clarity-init')).toBe(true);
    expect(profileReads).toEqual(['profiles']);
    expect(wroteOptOutCookie()).toBe(false);
  });

  it('CONTROL, stored flag NULL (never set): both load', async () => {
    signedIn(null);
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(initRendered(container, 'ga4-init')).toBe(true));
    expect(initRendered(container, 'clarity-init')).toBe(true);
  });

  it('CONTROL, no session: both load and no profile row is read (cookie + GPC were the whole answer)', async () => {
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(initRendered(container, 'ga4-init')).toBe(true));
    expect(initRendered(container, 'clarity-init')).toBe(true);
    expect(profileReads).toEqual([]);
  });

  it('FAIL-CLOSED, the profile read errors: neither loads (an unknown opt-out is not shared)', async () => {
    mockProfile = { user: { id: 'u1' }, row: null, error: { message: 'boom' }, throws: false };
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(profileReads).toEqual(['profiles']));
    await new Promise((r) => setTimeout(r, 50));
    expect(initRendered(container, 'ga4-init')).toBe(false);
    expect(initRendered(container, 'clarity-init')).toBe(false);
  });

  it('FAIL-CLOSED, the session lookup throws: neither loads', async () => {
    mockProfile = { user: { id: 'u1' }, row: { ad_sharing_opt_out: false }, error: null, throws: true };
    const { container } = render(<GA4Gate />);
    await new Promise((r) => setTimeout(r, 50));
    expect(initRendered(container, 'ga4-init')).toBe(false);
    expect(initRendered(container, 'clarity-init')).toBe(false);
  });

  it('nothing is rendered BEFORE the stored flag has been read (no load-then-check window)', async () => {
    signedIn(false);
    const { container } = render(<GA4Gate />);
    // synchronously after the first render + effect: the read is still in flight
    expect(initRendered(container, 'ga4-init')).toBe(false);
    expect(initRendered(container, 'clarity-init')).toBe(false);
    await waitFor(() => expect(initRendered(container, 'ga4-init')).toBe(true));
  });
});

// gh-1925 / D-354 across a client-side navigation: an opt-out that appears mid-visit must switch Clarity off (it cannot wait for a reload),
// and two ruled routes in a row must not tear a running recorder down.
describe('GA4Gate: the opt-out across client-side navigation (gh-1925 / D-354)', () => {
  afterEach(() => { delete (window as unknown as { clarity?: unknown }).clarity; });

  it('an opt-out recorded mid-visit: on the next route Clarity is unmounted and told to stop', async () => {
    const view = render(<GA4Gate />);
    await waitFor(() => expect(initRendered(view.container, 'clarity-init')).toBe(true));
    const clarity = vi.fn();
    (window as unknown as { clarity?: unknown }).clarity = clarity; // what the vendor snippet would have defined
    document.cookie = 'oq_ad_optout=1; path=/'; // e.g. the Section 12 button, pressed in another tab
    mockPath = '/dashboard'; // also a ruled Clarity route: only the opt-out can explain Clarity going away
    view.rerender(<GA4Gate />);
    await waitFor(() => expect(initRendered(view.container, 'clarity-init')).toBe(false));
    expect(clarity).toHaveBeenCalledWith('stop');
    expect(initRendered(view.container, 'ga4-init')).toBe(false);
  });

  it('CONTROL: the same navigation with no opt-out keeps Clarity mounted and never calls stop', async () => {
    const view = render(<GA4Gate />);
    await waitFor(() => expect(initRendered(view.container, 'clarity-init')).toBe(true));
    const clarity = vi.fn();
    (window as unknown as { clarity?: unknown }).clarity = clarity;
    mockPath = '/dashboard';
    view.rerender(<GA4Gate />);
    await new Promise((r) => setTimeout(r, 50));
    expect(initRendered(view.container, 'clarity-init')).toBe(true);
    expect(initRendered(view.container, 'ga4-init')).toBe(true);
    expect(clarity).not.toHaveBeenCalled();
  });

  it('a stored flag that turns TRUE mid-visit (a sign-in): the next route reads it and stops Clarity', async () => {
    const view = render(<GA4Gate />);
    await waitFor(() => expect(initRendered(view.container, 'clarity-init')).toBe(true));
    const clarity = vi.fn();
    (window as unknown as { clarity?: unknown }).clarity = clarity;
    mockProfile = { user: { id: 'u1' }, row: { ad_sharing_opt_out: true }, error: null, throws: false };
    mockPath = '/dashboard';
    view.rerender(<GA4Gate />);
    await waitFor(() => expect(initRendered(view.container, 'clarity-init')).toBe(false));
    expect(clarity).toHaveBeenCalledWith('stop');
  });
});

// gh-1925, CEO on #2304 (comment 5974043923 item 7): "`/auth-callback` must not load GA4" (5973957454: the route carries no Do Not Sell
// link, "therefore no GA4 load there").
describe('GA4Gate: /auth-callback never loads the GA4 library (gh-1925)', () => {
  it.each(['/auth-callback', '/auth-callback/anything'])('%s, an ordinary signed-out visitor with no opt-out: no GA4 library, no ga4-init, no Clarity', async (route) => {
    mockPath = route;
    const { container } = render(<GA4Gate />);
    await new Promise((r) => setTimeout(r, 50));
    expect(srcLoaded(container, 'googletagmanager.com/gtag')).toBe(false);
    expect(initRendered(container, 'ga4-init')).toBe(false);
    expect(initRendered(container, 'clarity-init')).toBe(false);
  });

  it('/auth-callback, signed in with the stored flag FALSE: still no GA4 library', async () => {
    mockPath = '/auth-callback';
    mockProfile = { user: { id: 'u1' }, row: { ad_sharing_opt_out: false }, error: null, throws: false };
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(profileReads).toEqual(['profiles']));
    await new Promise((r) => setTimeout(r, 50));
    expect(initRendered(container, 'ga4-init')).toBe(false);
  });

  it.each(['/login', '/get-started', '/dashboard', '/auth-callbackx'])('CONTROL: %s still loads the GA4 library (the rule is one route, not a prefix match on its name)', async (route) => {
    mockPath = route;
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(initRendered(container, 'ga4-init')).toBe(true));
  });
});

// Structural coverage for the two dark-shipped React gates (see file docstring for why a render-based test cannot observe
// GPC behaviour while their IDs are empty placeholders).
describe('LinkedInInsightGate.tsx / RedditPixelGate.tsx: the opt-out call is wired in source (gh-1925)', () => {
  const componentsDir = path.join(__dirname, '..');

  function assertOptOutWiredBeforeHostCheck(file: string, idConstName: string) {
    const src = fs.readFileSync(path.join(componentsDir, file), 'utf8');
    expect(src).toContain('import { isAdSharingOptedOut } from "../lib/ad-optout";');
    const idCheckIdx = src.indexOf(`if (!${idConstName}) return;`);
    const optOutIdx = src.indexOf('if (isAdSharingOptedOut()) return;');
    const hostCheckIdx = src.indexOf('ALLOWED_HOSTS.includes(window.location.hostname)');
    expect(idCheckIdx).toBeGreaterThan(-1);
    expect(optOutIdx).toBeGreaterThan(-1);
    expect(hostCheckIdx).toBeGreaterThan(-1);
    // Same ordering as MetaPixelGate.tsx: dark-merge/path checks, THEN the opt-out check, THEN the host check.
    expect(optOutIdx).toBeGreaterThan(idCheckIdx);
    expect(hostCheckIdx).toBeGreaterThan(optOutIdx);
  }

  it('LinkedInInsightGate.tsx calls isAdSharingOptedOut() before the host check', () => {
    assertOptOutWiredBeforeHostCheck('LinkedInInsightGate.tsx', 'LINKEDIN_PARTNER_ID');
  });

  it('RedditPixelGate.tsx calls isAdSharingOptedOut() before the host check', () => {
    assertOptOutWiredBeforeHostCheck('RedditPixelGate.tsx', 'REDDIT_PIXEL_ID');
  });
});
