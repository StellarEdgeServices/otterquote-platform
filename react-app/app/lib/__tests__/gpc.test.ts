// gh-2107 / D-330 half 2: the React checkout reports the browser's Global Privacy Control signal (Dustin's ruling "b.",
// #2078 comment 5801822166, scope item 2). Only ever adds { gpc: true }; never throws.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gpcField } from '@/lib/gpc';

describe('gpcField', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns { gpc: true } when navigator.globalPrivacyControl is exactly true', () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: true });
    expect(gpcField()).toEqual({ gpc: true });
  });

  it.each([[false], [undefined], ['true'], [1], [null]])('returns {} when it is %s (only exactly true opts out)', (v) => {
    vi.stubGlobal('navigator', { globalPrivacyControl: v });
    expect(gpcField()).toEqual({});
    expect('gpc' in gpcField()).toBe(false);
  });

  it('returns {} when there is no navigator', () => {
    vi.stubGlobal('navigator', undefined);
    expect(gpcField()).toEqual({});
  });

  it('never throws, even if reading the property throws', () => {
    const nav = {} as Record<string, unknown>;
    Object.defineProperty(nav, 'globalPrivacyControl', { get() { throw new Error('locked down'); } });
    vi.stubGlobal('navigator', nav);
    expect(() => gpcField()).not.toThrow();
    expect(gpcField()).toEqual({});
  });
});

// gh-1925 item 2: the privacy s12 button "Opt out of sale/sharing" leaves oq_ad_optout=1; the React checkout must report it as gpc:true.
describe('gpcField with the oq_ad_optout cookie (gh-1925)', () => {
  afterEach(() => { vi.unstubAllGlobals(); document.cookie = 'oq_ad_optout=; Max-Age=0; Path=/'; });

  function clickRealButtonScript() {
    const html = fs.readFileSync(path.join(process.cwd(), '..', 'privacy.html'), 'utf8');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((x) => x.includes('oq-ad-optout-btn')) as string;
    let onClick: () => void = () => {};
    const btn = { disabled: false, addEventListener: (_t: string, fn: () => void) => { onClick = fn; } };
    const fakeDoc = { get cookie() { return document.cookie; }, set cookie(v: string) { document.cookie = v; }, getElementById: () => btn };
    new Function('document', 'window', script)(fakeDoc, { location: { hostname: 'localhost' } });
    onClick();
  }

  it.each([[{ globalPrivacyControl: false }], [{}], [undefined]])('cookie-only visitor (navigator %j) set by the real button script -> { gpc: true }', (nav) => {
    vi.stubGlobal('navigator', nav);
    clickRealButtonScript();
    expect(document.cookie).toContain('oq_ad_optout=1');
    expect(gpcField()).toEqual({ gpc: true });
  });

  it('no cookie and no GPC -> {} (no gpc field)', () => {
    vi.stubGlobal('navigator', { globalPrivacyControl: false });
    expect('gpc' in gpcField()).toBe(false);
  });

  it('oq_ad_optout=10 is not a match', () => {
    vi.stubGlobal('navigator', {});
    document.cookie = 'oq_ad_optout=10; Path=/';
    expect(gpcField()).toEqual({});
  });
});
