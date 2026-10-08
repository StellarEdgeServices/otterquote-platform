/**
 * gh-2426: the company's paid HubSpot plan ends 2026-10-15/16. No browser surface may call the
 * create-hubspot-contact Edge Function any more (the function stays deployed as a
 * "disabled" stub so a stale tab gets a clean answer, but nothing in the app invokes it).
 *
 * Source scan, no network: walks react-app/app (excluding test files) and the static site
 * (root *.html and js/*.js). The pre-change code (main 6fc2b7a) had a call in
 *   react-app/app/auth-callback/page.tsx, react-app/app/contractor/pre-approval/page.tsx and
 *   contractor-pre-approval.html -- each makes this test fail.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '__tests__') continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\.[tj]sx?$/.test(name)) out.push(full);
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

const CALL = /create-hubspot-contact|api\.hubapi\.com|hs-scripts\.com|hsforms\.(net|com)/;

describe('gh-2426 no caller of HubSpot remains in the browser surfaces', () => {
  it('react-app/app source has no create-hubspot-contact invocation', () => {
    const offenders = walk(APP_DIR).filter((f) => CALL.test(codeOnly(readFileSync(f, 'utf-8'))));
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it('static pages and js/ have no create-hubspot-contact call', () => {
    const files = [
      ...readdirSync(REPO_ROOT).filter((n) => n.endsWith('.html')).map((n) => path.join(REPO_ROOT, n)),
      ...readdirSync(path.join(REPO_ROOT, 'js')).filter((n) => n.endsWith('.js')).map((n) => path.join(REPO_ROOT, 'js', n)),
    ];
    expect(files.length).toBeGreaterThan(10); // the scan really saw the site
    const offenders = files.filter((f) => CALL.test(codeOnly(readFileSync(f, 'utf-8'))));
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it('the scan itself can fail: it flags a known-bad line (negative control)', () => {
    expect(CALL.test(codeOnly("await supabase.functions.invoke('create-hubspot-contact', {})"))).toBe(true);
    expect(CALL.test(codeOnly("// create-hubspot-contact is only named in a comment"))).toBe(false);
  });
});
