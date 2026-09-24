// gh-2107 / D-330 half 2: the React checkout reports the browser's Global Privacy Control signal (Dustin's ruling "b.",
// #2078 comment 5801822166, scope item 2). Only ever adds { gpc: true }; never throws.
import { afterEach, describe, expect, it, vi } from 'vitest';
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
