/**
 * gh-2105 batch 4 -- the 12 remaining "(a)" `.update()` sites (3 money pages, 9 other), now
 * chaining `.select('id')` with a zero-row guard. Same source-slice convention as
 * gh2105-batch11/12/13 (the static pages have no runnable harness).
 *
 * Two shapes: THROW (money pages, intro video, loss-sheet attach: the success path must not run on
 * zero rows) and LOG-ONLY (secondary writebacks after the user's real action: logged loudly, flow
 * unchanged). No new customer-facing copy; the `update_zero_rows` token never reaches a screen.
 *
 * FAIL-FIRST: against origin/main every `.select('id')` assertion below fails (none of the 12
 * sites chains .select), and the ratchet baseline for these files is higher than the live count.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const read = (f: string) => readFileSync(resolve(repoRoot, f), 'utf8');

function block(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('project-info money pages: claims write requires a row (THROW)', () => {
  for (const [file, tag] of [
    ['project-info-acv.html', 'acv'],
    ['project-info-rcv.html', 'rcv'],
    ['project-info-cash.html', 'cash'],
  ] as const) {
    it(`${file}: .select('id'), error check, zero-row throw BEFORE the redirect`, () => {
      const src = read(file);
      const b = block(src, "sb.from('claims').update(updates)", 'window.location.href');
      expect(b).toContain(".eq('id', claimId).select('id')");
      expect(b).toContain('if (error) throw error;');
      expect(b).toContain(`throw new Error('update_zero_rows: claims (project info ${tag})')`);
      // the zero-row throw comes before the analytics event and the success redirect
      expect(src.indexOf('update_zero_rows: claims')).toBeLessThan(src.indexOf("gtag('event', 'project_info_saved'"));
      expect(src.indexOf('update_zero_rows: claims')).toBeLessThan(src.indexOf("window.location.href = '/dashboard.html'"));
    });
    it(`${file}: the token is logged, never shown (generic sentence on screen)`, () => {
      const src = read(file);
      const c = block(src, `console.error('[project-info-${tag}] submit failed:', err);`, 'errEl.style.display');
      expect(c).toContain("indexOf('update_zero_rows') !== 0");
      expect(c).toContain("'Something went wrong. Please try again.'");
      // the screen text is never the raw token
      expect(c).not.toMatch(/textContent = err\.message \|\|/);
    });
  }
  it('the screen-text predicate: a zero-row error shows the generic sentence, a real error keeps its message', () => {
    const show = (err: { message?: string }) =>
      (err.message && String(err.message).indexOf('update_zero_rows') !== 0) ? err.message : 'Something went wrong. Please try again.';
    // NEGATIVE CONTROL: the old expression (err.message || generic) would have shown the token
    expect((({ message: 'update_zero_rows: claims (project info cash)' }).message) || 'g').toContain('update_zero_rows');
    expect(show({ message: 'update_zero_rows: claims (project info cash)' })).toBe('Something went wrong. Please try again.');
    expect(show({ message: 'No project found for your account. Please start from the beginning.' })).toBe('No project found for your account. Please start from the beginning.');
    expect(show({})).toBe('Something went wrong. Please try again.');
  });
  it('the adjuster_id (b) write on acv/rcv is untouched', () => {
    for (const f of ['project-info-acv.html', 'project-info-rcv.html']) {
      expect(read(f)).toContain("await sb.from('claims').update({ adjuster_id: adjData }).eq('id', claimId);");
    }
  });
});

describe('contractor-profile.html intro video (THROW)', () => {
  it("contractors.intro_video_path: .select('id') + zero-row throw before 'Saved.'", () => {
    const b = block(read('contractor-profile.html'), "update({ intro_video_path: filePath", "statusEl.textContent = 'Saved.'");
    expect(b).toContain(".select('id')");
    expect(b).toContain("throw new Error('update_zero_rows: contractors (intro video)')");
  });
});

describe('trade-selector loss-sheet attach (THROW into the existing catch -> banner)', () => {
  it("claims.has_estimate: .select('id') + zero-row throw before the sessionStorage clear / parse", () => {
    const b = block(read('react-app/app/trade-selector/page.tsx'), ".update({ has_estimate: true, estimate_filename: destPath })", "sessionStorage.removeItem(PENDING_LOSS_SHEET_KEY)");
    expect(b).toContain(".select('id')");
    expect(b).toContain('if (patchError) throw patchError;');
    expect(b).toContain("throw new Error('update_zero_rows: claims (loss sheet attach)')");
  });
});

describe('LOG-ONLY secondary writebacks (flow unchanged, failure loud)', () => {
  const cases: Array<[string, string, string, string]> = [
    ['help-estimate.html', ".eq('id', currentClaim.id)\n                        .select('id')", "adjWriteErr || !Array.isArray(adjWriteRows)", 'update_zero_rows: claims (adjuster info)'],
    ['help-measurements.html', ".eq('id', currentClaim.id).select('id')", 'wbErr || !Array.isArray(wbRows)', 'update_zero_rows: claims (adjuster info)'],
    ['repair-intake.html', ".eq('user_id', user.id).select('id')", 'submittedErr || !Array.isArray(submittedRows)', 'update_zero_rows: claims (repair status)'],
    ['react-app/app/(homeowner)/help-estimate/actions.ts', ".eq('id', input.claimId)\n    .select('id')", 'writeErr || !Array.isArray(writeRows)', 'update_zero_rows: claims (adjuster info)'],
    ['react-app/app/(homeowner)/help-measurements/use-help-measurements-data.ts', ".eq('id', claim.id).select('id')", 'wbErr || !Array.isArray(wbRows)', 'update_zero_rows: claims (adjuster info)'],
    ['react-app/app/(homeowner)/repair-intake/use-repair-intake-data.ts', ".eq('user_id', user.id)\n    .select('id')", 'submittedErr || !Array.isArray(submittedRows)', 'update_zero_rows: claims (repair status)'],
  ];
  for (const [file, chain, guard, token] of cases) {
    it(`${file}: .select('id'), guard, console.error with the token; no throw`, () => {
      const src = read(file);
      expect(src).toContain(chain);
      const i = src.indexOf(guard);
      expect(i, `guard not found in ${file}`).toBeGreaterThan(-1);
      const g = src.slice(i, i + 420);
      expect(g).toContain('console.error(');
      expect(g).toContain(token);
      // log-only: the guard body does not throw or alert
      const body = g.slice(0, g.indexOf('}'));
      expect(body).not.toMatch(/throw |alert\(/);
    });
  }
});

describe('partner-record magic-link link (does not report linked on zero rows)', () => {
  const src = read('react-app/app/lib/partner-record.ts');
  const getB = () => block(src, ".from('referral_agents')\n      .update({ user_id: userId })", '// 3. No partner record');
  it("referral_agents.user_id: .select('id'), and the zero-row path returns the record WITHOUT the local user_id", () => {
    const b = getB();
    expect(b).toContain(".select('id')");
    expect(b).toContain('update_zero_rows: referral_agents (link user_id)');
    const failBranch = b.slice(b.indexOf('if (linkErr'), b.indexOf('return { kind: \'ok\', partner: { ...rec, user_id: userId } }'));
    expect(failBranch).toContain("return { kind: 'ok', partner: rec };");
    expect(failBranch).not.toContain('user_id: userId');
  });
  it('the success path still reports the linked user_id', () => {
    const b = getB();
    expect(b).toContain("return { kind: 'ok', partner: { ...rec, user_id: userId } };");
  });
});

describe('ratchet baselines match the live counts for the 12 fixed sites', () => {
  const ratchet = read('scripts/check-unselected-update-ratchet.py');
  const zero = [
    'contractor-profile.html', 'help-estimate.html', 'help-measurements.html', 'project-info-cash.html', 'repair-intake.html',
    'react-app/app/(homeowner)/help-estimate/actions.ts',
    'react-app/app/(homeowner)/help-measurements/use-help-measurements-data.ts',
    'react-app/app/(homeowner)/repair-intake/use-repair-intake-data.ts',
    'react-app/app/lib/partner-record.ts', 'react-app/app/trade-selector/page.tsx',
  ];
  for (const f of zero) it(`${f} baseline is 0`, () => expect(ratchet).toContain(`"${f}": 0,`));
  for (const f of ['project-info-acv.html', 'project-info-rcv.html']) it(`${f} baseline is 1 (adjuster_id (b) remains)`, () => expect(ratchet).toContain(`"${f}": 1,`));
});
