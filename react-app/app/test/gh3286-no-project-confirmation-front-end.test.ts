/**
 * gh-3286 (D-407 5/8): the Project Confirmation (PC) front end is gone.
 *
 * Guard for the issue's closes-on: no live link or route to a PC page on main.
 *   (1) the static page, the React route directory and the contractor PcTemplates card do not exist;
 *   (2) no shipped static page, script or React source links to /project-confirmation(.html);
 *   (3) the homeowner dashboard checklist has no PC step and contract-signing has no PC next step;
 *   (4) negative control: the same scanner DOES flag a planted PC link, so a green run is not vacuous.
 *
 * Scope is the front end only. Database columns, Edge Functions and envelopes are untouched (#3287).
 * Test files are not scanned (they may name the path in an assertion or an allowlist).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const read = (f: string) => readFileSync(resolve(repoRoot, f), 'utf8');

/** A quoted / templated URL or path that points at the PC page or React route. */
export const PC_LINK = /['"`(=]\s*(?:https?:\/\/[^'"`\s)]+)?\/?project-confirmation(?:\.html)?(?:[?#'"`)\/]|\s|$)/;

export function findPcLinks(src: string): string[] {
  return src.split('\n').filter((l) => PC_LINK.test(l));
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'out' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
}

function shippedFiles(): string[] {
  const files: string[] = [];
  // root static pages
  for (const name of readdirSync(repoRoot)) {
    if (/\.(html|js)$/.test(name)) files.push(join(repoRoot, name));
  }
  // shared scripts
  const jsDir = resolve(repoRoot, 'js');
  if (existsSync(jsDir)) walk(jsDir, files);
  // React sources, minus tests
  const appDir = resolve(repoRoot, 'react-app', 'app');
  const react: string[] = [];
  walk(appDir, react);
  for (const p of react) {
    const rel = relative(repoRoot, p).split(sep).join('/');
    if (!/\.(ts|tsx)$/.test(rel)) continue;
    if (rel.includes('/__tests__/') || rel.startsWith('react-app/app/test/')) continue;
    files.push(p);
  }
  return files;
}

describe('gh-3286: no Project Confirmation front end', () => {
  it('the static page, React route and contractor PC card are deleted', () => {
    expect(existsSync(resolve(repoRoot, 'project-confirmation.html'))).toBe(false);
    expect(existsSync(resolve(repoRoot, 'react-app/app/(homeowner)/project-confirmation'))).toBe(false);
    expect(existsSync(resolve(repoRoot, 'react-app/app/contractor/profile/PcTemplates.tsx'))).toBe(false);
  });

  it('no shipped file links to a PC page', () => {
    const hits: string[] = [];
    for (const f of shippedFiles()) {
      for (const line of findPcLinks(readFileSync(f, 'utf8'))) {
        hits.push(`${relative(repoRoot, f)}: ${line.trim().slice(0, 140)}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('dashboard.html checklist has no PC step and no Start/Review Confirmation button', () => {
    const d = read('dashboard.html');
    expect(d).not.toContain("id: 'project_confirmation'");
    expect(d).not.toContain('Start Confirmation');
    expect(d).not.toContain('Review Confirmation');
    // control: the neighbouring material step is still there
    expect(d).toContain('Choose the roofing material and specifications for your project.');
  });

  it('contract-signing.html has no PC next step and redirects the homeowner to the dashboard', () => {
    const c = read('contract-signing.html');
    expect(c).not.toContain('colorSelectionLink');
    expect(c).not.toContain('Project Confirmation');
    expect(c).toContain('`/contractor-dashboard.html?signed=1`');
    expect(c).toContain(': `/dashboard.html`;');
    // control: the remaining next step still renders
    expect(c).toContain('Contractor Outreach');
  });

  it('contractor-profile.html has no PC templates card', () => {
    const p = read('contractor-profile.html');
    expect(p).not.toContain('pc-templates');
    expect(p).not.toContain('loadPcTemplates');
    expect(p).not.toContain('SHOW_PROJECT_CONFIRMATION');
  });

  it('negative control: the scanner flags planted PC links', () => {
    expect(findPcLinks('<a href="/project-confirmation.html?claim_id=1">x</a>')).toHaveLength(1);
    expect(findPcLinks('window.location.href = `/project-confirmation.html?claim_id=${id}`;')).toHaveLength(1);
    expect(findPcLinks("router.push('/project-confirmation')")).toHaveLength(1);
    expect(findPcLinks("url: 'https://otterquote.com/project-confirmation.html?claim_id=abc'")).toHaveLength(1);
    // and ignores prose that merely names the concept
    expect(findPcLinks('// D-407: no Project Confirmation step')).toHaveLength(0);
  });
});
