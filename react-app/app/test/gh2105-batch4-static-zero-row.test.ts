/**
 * gh-2105 batch 4 -- the 12 remaining "(a)" `.update()` sites (3 money pages, 9 other), now
 * chaining `.select('id')` with a zero-row guard. Same source-slice convention as
 * gh2105-batch11/12/13 (the static pages have no runnable harness).
 *
 * Shapes: THROW (money pages, intro video, loss-sheet attach, repair-intake status='submitted': the success path must not run on
 * zero rows), REPORT-ONLY (adjuster writebacks after the user's real action: Sentry event + console, flow
 * unchanged) and partner-record (class (c), unreachable under RLS, not fixed). No new customer-facing copy; the `update_zero_rows` token never reaches a screen.
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

describe('REPORT-ONLY secondary writebacks (flow unchanged, failure sent to Sentry)', () => {
  // The HTML pages load the Sentry CDN loader (window.sentryOnLoad -> Sentry.init); the React
  // twins use @sentry/nextjs. Behaviour of the TS twins is covered in gh2105-batch4-behaviour.test.ts.
  const cases: Array<[string, string, string, string, string]> = [
    ['help-estimate.html', ".eq('id', currentClaim.id)\n                        .select('id')", "adjWriteErr || !Array.isArray(adjWriteRows)", 'update_zero_rows: claims (adjuster info)', "site: 'help-estimate'"],
    ['help-measurements.html', ".eq('id', currentClaim.id).select('id')", 'wbErr || !Array.isArray(wbRows)', 'update_zero_rows: claims (adjuster info)', "site: 'help-measurements'"],
    ['react-app/app/(homeowner)/help-estimate/actions.ts', ".eq('id', input.claimId)\n    .select('id')", 'writeErr || !Array.isArray(writeRows)', 'update_zero_rows: claims (adjuster info)', "site: 'help-estimate'"],
    ['react-app/app/(homeowner)/help-measurements/use-help-measurements-data.ts', ".eq('id', claim.id).select('id')", 'wbErr || !Array.isArray(wbRows)', 'update_zero_rows: claims (adjuster info)', "site: 'help-measurements'"],
  ];
  for (const [file, chain, guard, token, site] of cases) {
    it(`${file}: .select('id'), guard, console.error + Sentry.captureMessage; no throw`, () => {
      const src = read(file);
      expect(src).toContain(chain);
      const i = src.indexOf(guard);
      expect(i, `guard not found in ${file}`).toBeGreaterThan(-1);
      const g = src.slice(i, i + 900);
      expect(g).toContain('console.error(');
      expect(g).toContain('Sentry.captureMessage(');
      expect(g).toContain(token);
      expect(g).toContain(site);
      // report-only: the guard body does not throw or alert
      expect(g.split('captureMessage')[0]).not.toMatch(/throw |alert\(/);
    });
  }
  it('the HTML pages guard the Sentry global before calling it (loader may be blocked)', () => {
    for (const f of ['help-estimate.html', 'help-measurements.html', 'repair-intake.html']) {
      const src = read(f);
      expect(src).toContain('js.sentry-cdn.com');
      expect(src).toContain(f === 'repair-intake.html' ? "typeof Sentry !== 'undefined' && Sentry.captureException" : "typeof Sentry !== 'undefined' && Sentry.captureMessage");
    }
  });
  it('the React twins import Sentry from @sentry/nextjs', () => {
    for (const f of [
      'react-app/app/(homeowner)/help-estimate/actions.ts',
      'react-app/app/(homeowner)/help-measurements/use-help-measurements-data.ts',
      'react-app/app/(homeowner)/repair-intake/use-repair-intake-data.ts',
    ]) expect(read(f)).toContain("import * as Sentry from '@sentry/nextjs';");
  });
});

describe("repair-intake status='submitted' is the user's submit: Sentry event + THROW (never 'submitted' on failure)", () => {
  it('repair-intake.html: the guard reports to Sentry and throws BEFORE gtag, contractors list and the success label', () => {
    const src = read('repair-intake.html');
    const b = block(src, 'submittedErr || !Array.isArray(submittedRows)', "gtag('event', 'repair_submitted'");
    // exactly one Sentry event per failure: the catch's captureException (no captureMessage before the throw)
    expect(b).not.toContain('Sentry.captureMessage');
    expect(b).toContain('throw new Error(submittedMsg);');
    expect(b).toContain('update_zero_rows: claims (repair status)');
    expect(src.indexOf('update_zero_rows: claims (repair status)')).toBeLessThan(src.indexOf("btn.textContent = '✓ Submitted!'"));
    // the existing catch re-enables the button and shows the generic error
    const c = block(src, "console.error('Repair submit error:', err);", 'async function showRepairContractors');
    expect(c).toContain('alert(\'Something went wrong. Please try again.\')');
    expect(c).toContain('btn.disabled = false;');
    expect(c).toContain('Sentry.captureException(err)');
  });
  it('use-repair-intake-data.ts: the guard reports to Sentry and throws before returning the claim id', () => {
    const src = read('react-app/app/(homeowner)/repair-intake/use-repair-intake-data.ts');
    const b = block(src, 'submittedErr || !Array.isArray(submittedRows)', 'return { claimId };');
    expect(b).toContain('Sentry.captureMessage(');
    expect(b).toContain('throw new Error(submittedMsg);');
  });
});

describe('partner-record magic-link link: reclassified class (c), not fixed', () => {
  const src = read('react-app/app/lib/partner-record.ts');
  it('the code comment states class (c) / unreachable under current RLS and gives the reason', () => {
    expect(src).toContain('class (c), NOT fixed: unreachable under current RLS');
    expect(src).toContain('is_admin_email()');
    expect(src).toContain('RETURNING');
  });
  it('the defensive guard never reports linked on zero rows (behaviour: gh2105-batch4-behaviour.test.ts)', () => {
    const b = block(src, ".from('referral_agents')\n      .update({ user_id: userId })", '// 3. No partner record');
    expect(b).toContain(".select('id')");
    expect(b).toContain("return { kind: 'ok', partner: rec };");
    expect(b).toContain("return { kind: 'ok', partner: { ...rec, user_id: userId } };");
  });
  it('the ratchet comment says (c), not (a)', () => {
    const r = read('scripts/check-unselected-update-ratchet.py');
    expect(r).toMatch(/partner-record\.ts": 0,  # gh-2105 batch 4: class \(c\), NOT fixed/);
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
  // gh-2105 batch 14: the adjuster_id (b) link-back write is now annotated update-no-select-ok, so the live count is 0.
  for (const f of ['project-info-acv.html', 'project-info-rcv.html']) it(`${f} baseline is 0 (adjuster_id (b) annotated in batch 14)`, () => expect(ratchet).toContain(`"${f}": 0,`));
});
