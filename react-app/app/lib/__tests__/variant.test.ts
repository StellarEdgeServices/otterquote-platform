import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureVariantFromUrl, getVariant } from '../variant';

const STORAGE_KEY = 'oq_variant_v3';

function setUrl(search: string) {
  window.history.replaceState({}, '', `/get-started${search}`);
}

describe('variant.ts (gh-2078)', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUrl('');
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    setUrl('');
  });

  it('falls back to "unknown" when nothing was ever captured', () => {
    expect(getVariant()).toBe('unknown');
  });

  it('captures a valid ?v= and persists it', () => {
    setUrl('?v=e');
    captureVariantFromUrl();
    expect(getVariant()).toBe('e');
  });

  it('persists across a later call with no ?v= on the URL (help-measurements, days later)', () => {
    setUrl('?v=d');
    captureVariantFromUrl();
    setUrl(''); // simulate navigating to a page with no ?v=
    expect(getVariant()).toBe('d');
  });

  it('a later valid ?v= overwrites an earlier persisted value', () => {
    setUrl('?v=c');
    captureVariantFromUrl();
    setUrl('?v=e');
    captureVariantFromUrl();
    expect(getVariant()).toBe('e');
  });

  it('ignores a malformed ?v= (not alnum, or too long) and leaves any existing value alone', () => {
    setUrl('?v=e');
    captureVariantFromUrl();
    setUrl('?v=' + encodeURIComponent('DROP TABLE;--'));
    captureVariantFromUrl();
    expect(getVariant()).toBe('e');
  });

  it('ignores a malformed ?v= on a first-ever visit — falls back to unknown, never forwards garbage', () => {
    setUrl('?v=' + encodeURIComponent('<script>'));
    captureVariantFromUrl();
    expect(getVariant()).toBe('unknown');
  });

  it('a corrupted persisted value in localStorage falls back to "unknown" rather than being forwarded', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-valid-arm-shape!!!');
    expect(getVariant()).toBe('unknown');
  });
});
