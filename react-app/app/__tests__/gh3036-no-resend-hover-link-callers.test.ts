/**
 * gh-3036 / gh-1873 (Hover retirement, step (a) of resend-hover-link's retirement order): no client references the
 * resend-hover-link Edge Function, so the function can be deleted under its own R-097 notice.
 *
 * Source scan, no network. It walks
 *   - react-app/app (non-test .ts/.tsx/.js/.jsx),
 *   - the static site (root *.html and js/*.js), and
 *   - every other Edge Function's non-test source (supabase/functions/<other>/**.ts).
 * A hit is a code line (comment lines may still name the function) that contains the function's slug or the removed
 * client helper `resendHoverLink`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..', '..');
const FN_DIR = path.join(REPO_ROOT, 'supabase', 'functions');
const SELF_FN = 'resend-hover-link';

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '__tests__') continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, accept, out);
    else if (accept(name)) out.push(full);
  }
  return out;
}

/** Code lines only: a comment may still name the function. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

const REF = /resend-hover-link|resendHoverLink|resend-hover-btn/;
const rel = (f: string) => path.relative(REPO_ROOT, f);
const isCode = (n: string) => /\.(tsx?|jsx?)$/.test(n) && !/\.test\.[tj]sx?$/.test(n);

describe('gh-3036 no client references resend-hover-link', () => {
  it('react-app/app source does not reference it', () => {
    const files = walk(APP_DIR, isCode);
    expect(files.length).toBeGreaterThan(100); // the scan really saw the app
    expect(files.filter((f) => REF.test(codeOnly(readFileSync(f, 'utf-8')))).map(rel)).toEqual([]);
  });

  it('static pages and js/ do not reference it', () => {
    const files = [
      ...readdirSync(REPO_ROOT).filter((n) => n.endsWith('.html')).map((n) => path.join(REPO_ROOT, n)),
      ...readdirSync(path.join(REPO_ROOT, 'js')).filter((n) => n.endsWith('.js')).map((n) => path.join(REPO_ROOT, 'js', n)),
    ];
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => REF.test(codeOnly(readFileSync(f, 'utf-8')))).map(rel)).toEqual([]);
  });

  it('no other Edge Function calls it', () => {
    const files = walk(FN_DIR, (n) => /\.ts$/.test(n) && !/\.test\.ts$/.test(n)).filter(
      (f) => !f.startsWith(path.join(FN_DIR, SELF_FN) + path.sep),
    );
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => REF.test(codeOnly(readFileSync(f, 'utf-8')))).map(rel)).toEqual([]);
  });

  it('the scan itself can fail: it flags known-bad lines (negative control)', () => {
    expect(REF.test(codeOnly("await supabase.functions.invoke('resend-hover-link', { body: {} })"))).toBe(true);
    expect(REF.test(codeOnly('`${CONFIG.SUPABASE_URL}/functions/v1/resend-hover-link`,'))).toBe(true);
    expect(REF.test(codeOnly('onclick="resendHoverLink(this)"'))).toBe(true);
    expect(REF.test(codeOnly('// resend-hover-link is only named in a comment'))).toBe(false);
  });
});
