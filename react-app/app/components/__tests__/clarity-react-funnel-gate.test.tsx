// gh-1939 (row 0.4), Ben's ruling on Kevin's plan (#1939 5810533784): Microsoft Clarity on the React homeowner funnel routes /dashboard, /bids and
// /repair-intake ONLY, on top of the already-live /get-started and /trade-selector. Dustin's scope ruling (5691693161): "Funnel to bid accept",
// fields masked; excluded: contract-signing, auth-callback, admin, contractor and partner pages. Default-deny: every other route stays off.
//
// This renders the REAL GA4Gate at every real page.tsx route in the app (enumerated from the file system, so a NEW route is tested the moment it
// exists) and asserts Clarity loads on exactly the ruled set and on nothing else. It also pins the masking that makes the ruled routes safe to
// record: the shell's <header> and <main> (which wrap all three pages) carry data-clarity-mask="true", every input is tagged for Clarity's Exclude
// level, and nothing under those routes unmasks a subtree.
//
// HOLD: this widens what is recorded. The change is held (draft PR, label hold) until Dustin approves the privacy.html §5.4 disclosure (Tier C).
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

let mockPath = '/get-started';

vi.mock('next/navigation', () => ({ usePathname: () => mockPath }));
vi.mock('next/script', () => ({
  default: (props: { src?: string; id?: string }) => <span data-testid={props.id ? `script-${props.id}` : 'script-src'} data-src={props.src ?? ''} />,
}));
vi.mock('../../lib/internal-traffic', () => ({ isInternalTraffic: () => false }));

import { GA4Gate } from '../GA4Gate';

const APP_ROOT = path.resolve(__dirname, '../../'); // react-app/app

/** The ruled set: the two already live, plus the three this change adds. */
const RULED = ['/get-started', '/trade-selector', '/dashboard', '/bids', '/repair-intake'];

/** Every real page.tsx route, as a URL path: route groups "(x)" dropped, dynamic segments filled with a sample value. */
function enumerateRoutes(dir = APP_ROOT, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && entry.name === 'page.tsx') out.push(prefix || '/');
    if (!entry.isDirectory()) continue;
    if (['node_modules', '.next', '__tests__', 'tests', 'lib', 'components', 'api'].includes(entry.name) || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const seg = /^\(.*\)$/.test(entry.name) ? '' : '/' + entry.name.replace(/^\[.+\]$/, 'sample');
    out.push(...enumerateRoutes(path.join(dir, entry.name), prefix + seg));
  }
  return out;
}

function setLocation(host: string, hash = '') {
  Object.defineProperty(window, 'location', { value: { ...window.location, hostname: host, hash, search: '', pathname: mockPath }, writable: true, configurable: true });
}
const clarityLoaded = (c: HTMLElement) => c.querySelector('[data-testid="script-clarity-init"]') !== null;

describe('Clarity on the React funnel: exactly the ruled routes, default-deny everywhere else', () => {
  beforeEach(() => { mockPath = '/get-started'; setLocation('app.otterquote.com'); });
  afterEach(() => { cleanup(); });

  it('the route enumeration finds the real routes (a sanity check on the enumerator itself)', () => {
    const routes = enumerateRoutes();
    for (const r of [...RULED, '/help-measurements', '/contract-signing', '/auth-callback', '/login', '/admin/payouts', '/contractor/dashboard', '/partner/dashboard', '/refer']) {
      expect(routes, r).toContain(r);
    }
    expect(routes.length).toBeGreaterThanOrEqual(25);
  });

  it.each(RULED)('RULED: Clarity loads on %s', async (route) => {
    mockPath = route;
    setLocation('app.otterquote.com');
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(clarityLoaded(container)).toBe(true));
  });

  it('DEFAULT-DENY: across EVERY real page.tsx route, Clarity loads on exactly the ruled set and nothing else', async () => {
    const loadedOn: string[] = [];
    for (const route of enumerateRoutes()) {
      cleanup();
      mockPath = route;
      setLocation('app.otterquote.com');
      const { container } = render(<GA4Gate />);
      await waitFor(() => expect(container.querySelector('[data-testid="script-ga4-init"]')).not.toBeNull()); // the effect has run (GA4 still loads)
      if (clarityLoaded(container)) loadedOn.push(route);
    }
    expect(loadedOn.sort()).toEqual([...RULED].sort());
  });

  it.each([
    '/help-measurements', '/help-estimate', '/help-materials', '/color-selection', '/project-confirmation', '/contract-signing',
    '/auth-callback', '/login', '/refer', '/', '/admin/payouts', '/admin/contractors', '/contractor/dashboard', '/contractor/login',
    '/contractor/pre-approval', '/contractor/sign/sample', '/partner/dashboard',
  ])('NEGATIVE CONTROL: Clarity does NOT load on the excluded route %s', async (route) => {
    mockPath = route;
    setLocation('app.otterquote.com');
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(container.querySelector('[data-testid="script-ga4-init"]')).not.toBeNull());
    expect(clarityLoaded(container)).toBe(false);
  });

  it('a sub-path of a ruled route is covered by the same rule (/bids/anything loads; /dashboardx does not)', async () => {
    mockPath = '/bids/anything';
    setLocation('app.otterquote.com');
    const a = render(<GA4Gate />);
    await waitFor(() => expect(clarityLoaded(a.container)).toBe(true));
    cleanup();
    mockPath = '/dashboardx';
    const b = render(<GA4Gate />);
    await waitFor(() => expect(b.container.querySelector('[data-testid="script-ga4-init"]')).not.toBeNull());
    expect(clarityLoaded(b.container)).toBe(false);
  });

  it.each(['/dashboard', '/bids', '/repair-intake'])('the credential-in-fragment guard still runs first on %s: no Clarity with a token in the URL fragment', async (route) => {
    mockPath = route;
    setLocation('app.otterquote.com', '#access_token=abc&refresh_token=def');
    const { container } = render(<GA4Gate />);
    await waitFor(() => expect(container.querySelector('[data-testid="script-ga4-init"]')).not.toBeNull());
    expect(clarityLoaded(container)).toBe(false);
  });

  it.each(['/dashboard', '/bids', '/repair-intake'])('on %s the gate itself starts the input exclusion: an input added afterwards is tagged data-oq-privacy="secret"', async (route) => {
    vi.resetModules(); // a fresh GA4Gate module: its once-per-page-load latch has not fired yet
    const { GA4Gate: FreshGate } = await import('../GA4Gate');
    mockPath = route;
    setLocation('app.otterquote.com');
    document.body.innerHTML = '';
    const { container } = render(<FreshGate />);
    await waitFor(() => expect(clarityLoaded(container)).toBe(true));
    const input = document.createElement('input');
    document.body.appendChild(input);
    await waitFor(() => expect(input.getAttribute('data-oq-privacy')).toBe('secret'));
  });

  it('a non-production host never loads Clarity, ruled route or not', async () => {
    mockPath = '/dashboard';
    setLocation('staging--jade-alpaca-b82b5e.netlify.app');
    const { container } = render(<GA4Gate />);
    await new Promise((r) => setTimeout(r, 30));
    expect(clarityLoaded(container)).toBe(false);
  });
});

describe('the masking that makes the three new routes safe to record', () => {
  const read = (rel: string) => fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');
  const shell = read('(homeowner)/_shell/HomeownerShell.tsx');

  it('the shell wraps all three pages and masks BOTH its <header> (user-facing nav) and its <main> (the page content)', () => {
    expect(shell).toMatch(/<header className="oqh-nav"[^>]*\sdata-clarity-mask="true"/);
    expect(shell).toMatch(/<main className="oqh-main"[^>]*\sdata-clarity-mask="true"/);
  });

  it.each(['dashboard', 'bids', 'repair-intake'])('the %s page renders inside HomeownerShell (so the masked shell wraps it)', (route) => {
    expect(read(`(homeowner)/${route}/page.tsx`)).toMatch(/<HomeownerShell\b/);
  });

  it('nothing under the shell or the three ruled routes unmasks a subtree (data-clarity-unmask)', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(full);
      return /\.(tsx|ts)$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : [];
    });
    for (const d of ['(homeowner)/_shell', '(homeowner)/dashboard', '(homeowner)/bids', '(homeowner)/repair-intake']) {
      for (const f of walk(path.join(APP_ROOT, d))) expect(fs.readFileSync(f, 'utf8'), `${f} unmasks`).not.toMatch(/data-clarity-unmask/);
    }
  });

  it('no dialog under the three routes is portalled out of the masked <main> (a portal would escape the mask)', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(full);
      return /\.(tsx|ts)$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : [];
    });
    for (const d of ['(homeowner)/dashboard', '(homeowner)/bids', '(homeowner)/repair-intake']) {
      for (const f of walk(path.join(APP_ROOT, d))) expect(fs.readFileSync(f, 'utf8'), `${f} portals`).not.toMatch(/createPortal/);
    }
  });

  it('every input, textarea and select on an allowed route is tagged data-oq-privacy="secret" (Clarity Exclude level), including later renders', async () => {
    const { startClarityInputExclusion } = await import('../GA4Gate');
    document.body.innerHTML = '<input id="a"><textarea id="b"></textarea><select id="c"></select>';
    startClarityInputExclusion(); // latched once per page load: the observer (or the initial pass) tags what exists and what is added later
    await waitFor(() => { for (const id of ['a', 'b', 'c']) expect(document.getElementById(id)!.getAttribute('data-oq-privacy')).toBe('secret'); });
    const late = document.createElement('div');
    late.innerHTML = '<input id="d">';
    document.body.appendChild(late);
    await waitFor(() => expect(document.getElementById('d')!.getAttribute('data-oq-privacy')).toBe('secret'));
  });
});
