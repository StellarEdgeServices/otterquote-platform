// gh-1925 -- CCPA/CPRA "Do Not Sell or Share" via Global Privacy Control, extended to the tags that did not yet honour it:
// GA4Gate.tsx (the GA4 library, which carries Google Ads/Signals once linked) and the LinkedIn/Reddit gates shipped dark by
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

vi.mock('next/navigation', () => ({ usePathname: () => mockPath }));
vi.mock('next/script', () => ({
  default: (props: { src?: string; id?: string; children?: React.ReactNode }) =>
    props.src ? <span data-testid="tag-src" data-src={props.src} /> : <span data-testid="tag-init" data-id={props.id} />,
}));
vi.mock('../../lib/internal-traffic', () => ({ isInternalTraffic: () => false }));

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

beforeEach(() => {
  spyOnCookieWrites();
  clearCookie();
  mockPath = '/get-started';
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
