/**
 * gh-2105 batch 15 -- the two sites batch 14 reclassified from (b) to (a): a zero-row match is a
 * FAILURE there, so each write now chains `.select('id')` and treats an empty result as one.
 *
 *  - js/video-upload-handler.js claims.video_url: BEHAVIOUR test. The real source is evaluated against a
 *    mocked supabase client; zero rows / error return the function's existing `warning` shape, one row
 *    returns the clean success shape. No new text: the warning string is the one already shipped.
 *  - js/auth.js profiles role='contractor': SOURCE guard (handleAuthCallback has no harness). The write
 *    chains `.select('id')`, and a zero-row result reaches a console.warn (log-only, block stays non-fatal).
 *
 * NEGATIVE CONTROL: for each site the `.select('id')` is stripped from the real source and the same
 * assertions must then fail (video: zero rows is reported as clean success; auth: the guard finds no
 * select and the ratchet rule flags the site), proving the tests can tell the fix from its absence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const read = (f: string) => readFileSync(resolve(repoRoot, f), 'utf8');

// Port of find_violations() in scripts/check-unselected-update-ratchet.py.
function violations(text: string): number[] {
  const lines = text.split('\n');
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('.update(')) continue;
    const win: string[] = [];
    for (let j = i; j < lines.length && j < i + 25; j++) {
      win.push(lines[j]);
      if (lines[j].includes(';')) break;
      if (j > i && lines[j].trim() === '') break;
    }
    const joined = win.join('\n');
    if (joined.includes('.select(')) continue;
    const prior = i > 0 ? lines[i - 1] : '';
    if (joined.includes('update-no-select-ok') || prior.includes('update-no-select-ok')) continue;
    out.push(i + 1);
  }
  return out;
}

type Result = { data: unknown; error: { message: string } | null };
const ONE: Result = { data: [{ id: 'c1' }], error: null };
const ZERO: Result = { data: [], error: null };
const ERR: Result = { data: null, error: { message: 'trigger raised' } };

const WARNING = 'Saved to storage but failed to record in database.';

/** Evaluate the real video-upload-handler.js with a mocked `sb`; `selectChained` mimics supabase-js. */
function loadManager(src: string, result: Result) {
  const calls = { selected: false };
  const sb = {
    storage: { from: () => ({ upload: () => Promise.resolve({ error: null }) }) },
    from: () => ({
      update: () => {
        const chain: any = {};
        chain.eq = () => chain;
        chain.select = () => { calls.selected = true; return Promise.resolve(result); };
        // supabase-js without .select(): awaiting the builder yields { error: null } regardless of rows
        chain.then = (res: (v: unknown) => void) => res({ data: null, error: result.error });
        return chain;
      },
    }),
  };
  const win: Record<string, unknown> = {};
  const fn = new Function('sb', 'window', 'console', `${src}\nreturn VideoUploadManager;`);
  const Mgr = fn(sb, win, { error: () => {}, warn: () => {}, log: () => {} });
  const m = Object.create(Mgr.prototype);
  m.userId = 'u1';
  m.claimId = 'claim-1';
  m.allowedExtensions = { 'video/mp4': 'mp4' };
  return { m, calls };
}
const file = { type: 'video/mp4' };

describe('js/video-upload-handler.js claims.video_url (class a)', () => {
  const src = read('js/video-upload-handler.js');
  beforeEach(() => vi.clearAllMocks());

  it('one row: clean success, no warning', async () => {
    const { m, calls } = loadManager(src, ONE);
    const r = await m.upload(file);
    expect(calls.selected).toBe(true);
    expect(r.success).toBe(true);
    expect(r.warning).toBeUndefined();
  });
  it('zero rows: the existing warning is returned, not a clean success', async () => {
    const { m } = loadManager(src, ZERO);
    const r = await m.upload(file);
    expect(r.success).toBe(true);
    expect(r.warning).toBe(WARNING);
  });
  it('db error: the existing warning is returned', async () => {
    const { m } = loadManager(src, ERR);
    expect((await m.upload(file)).warning).toBe(WARNING);
  });
  it('no new user-facing string was introduced', () => {
    expect(src.match(/Saved to storage but failed to record in database\./g)).toHaveLength(1);
  });
  it('NEGATIVE CONTROL: with .select(\'id\') stripped, a zero-row match reports clean success', async () => {
    // restore the pre-fix shape: no .select('id'), error-only check
    const stripped = src
      .replace(/\n\s*\.select\('id'\);/, ';')
      .replace('if (dbError || !dbRows || dbRows.length === 0)', 'if (dbError)');
    expect(stripped).toContain('if (dbError)');
    expect(stripped).not.toBe(src);
    expect(violations(stripped).length).toBe(1);
    const { m } = loadManager(stripped, ZERO);
    const r = await m.upload(file);
    expect(r.warning).toBeUndefined(); // the silent-success defect the fix removes
  });
  it('the fixed source has no un-annotated bare .update(', () => {
    expect(violations(src)).toEqual([]);
  });
});

describe('js/auth.js profiles role=contractor (class a)', () => {
  const src = read('js/auth.js');
  const start = src.indexOf("role: 'contractor'");
  const win = (s: string) => {
    const e = s.indexOf('} catch (profileUpdateEx)');
    const i = s.lastIndexOf("role: 'contractor'", e);
    return s.slice(s.lastIndexOf('const {', i), e);
  };

  it('the role write chains .select(\'id\') after the .eq(\'id\', user.id) filter', () => {
    expect(start).toBeGreaterThan(0);
    expect(win(src)).toMatch(/\.eq\('id', user\.id\)\s*\.select\('id'\);/);
  });
  it('a zero-row result is logged and the block stays non-fatal (no throw)', () => {
    const w = win(src);
    expect(w).toMatch(/profileUpdateRows\.length === 0\)\s*\{\s*console\.warn\(/);
    expect(w).not.toMatch(/throw /);
  });
  it('the profiles write is no longer a ratchet violation', () => {
    const lines = src.split('\n');
    const idx = lines.findIndex((l) => l.includes('.update({'));
    expect(idx).toBeGreaterThan(0);
    expect(violations(src).includes(idx + 1)).toBe(false);
  });
  it("NEGATIVE CONTROL: with .select('id') stripped the guard regex fails and the ratchet flags the write", () => {
    const stripped = src.replace(/\n\s*\.select\('id'\);\n(\s*if \(profileUpdateErr\))/, ';\n$1');
    expect(stripped).not.toBe(src);
    expect(win(stripped)).not.toMatch(/\.eq\('id', user\.id\)\s*\.select\('id'\);/);
    const lines = stripped.split('\n');
    const idx = lines.findIndex((l) => l.includes('.update({'));
    expect(violations(stripped).some((n) => n >= idx)).toBe(true);
  });
});
