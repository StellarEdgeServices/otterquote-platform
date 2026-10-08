/**
 * gh-2105 (PR #2610, CTO ruling): the raw internal token `update_zero_rows`
 * must never reach a user. Four catch sites used to hand the caught error's
 * message to a user-visible sink (alert / setSaveError / setSubmitError). They
 * now show the page's own existing generic failure sentence and log the
 * caught error (console / Sentry) for diagnosis.
 *
 * Source-scan convention as gh2105-batch11/12: slice each catch block and
 * assert (a) no `.message` / bare error variable reaches the sink, (b) the
 * generic sentence is the literal argument, (c) the error is still logged.
 *
 * FAIL-FIRST: against 6baa45fb every `sinkArgs` assertion below fails (the
 * sinks received `err.message` / the caught Error's message).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const read = (f: string) => readFileSync(resolve(repoRoot, f), 'utf8');

/** Slice from `startMarker` to the first `endMarker` after it. */
function block(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `start marker not found: ${startMarker}`).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end, `end marker not found: ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** Full argument text of the first `sink(...)` call in `b` (up to the line's `);`). */
function sinkArgs(b: string, sink: string): string {
  const i = b.indexOf(sink + '(');
  expect(i, `sink not found: ${sink}`).toBeGreaterThan(-1);
  const end = b.indexOf(');', i);
  return b.slice(i, end + 2);
}

const SITES = [
  {
    file: 'repair-intake.html',
    start: "console.error('Repair submit error:', err);",
    end: 'async function showRepairContractors',
    sink: 'alert',
    generic: "'Something went wrong. Please try again.'",
    log: /Sentry\.captureException\(err\)/,
  },
  {
    file: 'project-confirmation.html',
    start: "console.error('[Otter Quotes] Project confirmation submit error:', err);",
    end: 'Initialization',
    sink: 'alert',
    generic: "'There was an error submitting your confirmation.\\n\\nPlease try again or contact support.'",
    log: /Sentry\.captureException\(err\)/,
  },
  {
    file: 'react-app/app/(homeowner)/color-selection/page.tsx',
    start: 'await saveColorSelection(',
    end: '// b. Success state',
    sink: 'setSaveError',
    generic: "'Error saving color. Please try again.'",
    log: /console\.error\([^)]*err\)/,
  },
  {
    file: 'react-app/app/(homeowner)/project-confirmation/page.tsx',
    start: 'await saveProjectConfirmation(',
    end: '// b. Create envelope',
    sink: 'setSubmitError',
    generic: "'Failed to save project confirmation.'",
    log: /console\.error\([^)]*saveErr\)/,
  },
];

describe('update_zero_rows is never passed to a user-visible sink (gh-2105)', () => {
  for (const s of SITES) {
    it(s.file, () => {
      const b = block(read(s.file), s.start, s.end);
      const call = sinkArgs(b, s.sink);
      // (a) nothing derived from the caught error reaches the sink
      expect(call).not.toMatch(/\.message/);
      // outside the literal generic sentence, no caught-error variable appears
      expect(call.replace(s.generic, "''")).not.toMatch(/\berr\b|\bsaveErr\b|\berror\b/i);
      expect(call).not.toContain('update_zero_rows');
      // (b) the page's existing generic sentence, verbatim, is the argument
      expect(call).toContain(s.generic);
      // (c) the caught error is still logged for diagnosis
      expect(b).toMatch(s.log);
    });
  }

  it('the throw sites still carry the token (it stays diagnosable in logs)', () => {
    expect(read('repair-intake.html')).toContain('update_zero_rows: claims (repair intake)');
    expect(read('project-confirmation.html')).toContain('update_zero_rows');
    expect(read('react-app/app/(homeowner)/color-selection/use-color-selection-data.ts')).toContain('update_zero_rows');
    expect(read('react-app/app/(homeowner)/project-confirmation/use-project-confirmation-data.ts')).toContain('update_zero_rows');
  });
});
