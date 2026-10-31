/**
 * gh-2105 batch 14 -- the nine remaining class-(b) `.update()` sites that legitimately accept a
 * zero-row match are annotated `update-no-select-ok: gh-2105 decision b -- <reason>` and their
 * ratchet baselines are lowered in the same change. Annotation-only: no runtime behaviour moves.
 *
 * Source-guard convention shared with gh2105-batch13-static-zero-row.test.ts. Each site is located by
 * its table + the column list it writes (not by line number), the annotation must sit on the line
 * directly above the `.update(` trigger line (the only place the scanner looks besides the statement
 * window) and must carry a real reason.
 *
 * NEGATIVE CONTROL: for every site the annotation is stripped from the real source and a port of the
 * ratchet's own rule (scripts/check-unselected-update-ratchet.py find_violations) must then flag the
 * site; with the annotation present it must not. Without this the test could not tell an annotation
 * from a comment that merely mentions the marker.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const read = (f: string) => readFileSync(resolve(repoRoot, f), 'utf8');
const MARK = 'update-no-select-ok: gh-2105 decision b -- ';

// Port of find_violations() in scripts/check-unselected-update-ratchet.py (same window + annotation rule).
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

interface Site { file: string; what: string; trigger: RegExp; reason: RegExp; }
const SITES: Site[] = [
  { file: 'bids.html', what: 'notifications.read_at (bid-updated banner)', trigger: /\.update\(\{ read_at: new Date\(\)\.toISOString\(\) \}\)\s*$/, reason: /read receipt/ },
  { file: 'react-app/app/(homeowner)/bids/actions.ts', what: 'notifications.read_at (bid-updated banner)', trigger: /\.update\(\{ read_at: new Date\(\)\.toISOString\(\) \}\)\s*$/, reason: /read receipt/ },
  { file: 'react-app/app/hooks/use-notification-count.ts', what: 'notifications.read_at (bell)', trigger: /\.from\('notifications'\)\.update\(\{ read_at:/, reason: /read receipt/ },
  { file: 'js/services.js', what: 'notifications.twilio_sid/delivered', trigger: /\.update\(\{ twilio_sid: data\.sid, delivered: true \}\)/, reason: /AFTER the SMS was already sent/ },
  { file: 'react-app/app/lib/services.ts', what: 'notifications.twilio_sid/delivered', trigger: /\.update\(\{ twilio_sid: data\.sid, delivered: true \}\)/, reason: /AFTER the SMS was already sent/ },
  { file: 'js/services.js', what: 'adjusters enrichment', trigger: /from\('adjusters'\)\.update\(updates\)/, reason: /enrichment of an adjuster knowledge-base row/ },
  { file: 'react-app/app/lib/services.ts', what: 'adjusters enrichment', trigger: /from\('adjusters'\)\.update\(updates\)/, reason: /enrichment of an adjuster knowledge-base row/ },
  // gh-3136 (P14): the project-info-acv/rcv adjuster_id link-back was removed (adjuster details moved to the dashboard); see the dedicated case below.
];

describe('gh-2105 batch 14: class-(b) zero-row sites are annotated with a reason', () => {
  for (const s of SITES) {
    it(`${s.file} -- ${s.what}`, () => {
      const src = read(s.file);
      const lines = src.split('\n');
      const idx = lines.findIndex((l) => l.includes('.update(') && s.trigger.test(l));
      expect(idx, `trigger line not found in ${s.file}`).toBeGreaterThan(0);
      const above = lines[idx - 1];
      expect(above, 'annotation must sit directly above the .update( line').toContain(MARK);
      expect(above).toMatch(s.reason);
      // the reason is a real sentence, not a bare marker
      expect(above.split(MARK)[1].trim().length).toBeGreaterThan(60);

      // positive: the annotated file has no violation at this site
      expect(violations(src)).not.toContain(idx + 1);
      // NEGATIVE CONTROL: strip the annotation line and the same site is flagged
      const stripped = lines.filter((_, i) => i !== idx - 1).join('\n');
      expect(violations(stripped), 'stripped source must be flagged by the ratchet rule').toContain(idx);
    });
  }

  it('gh-3136 (P14): project-info-acv/rcv no longer upsert an adjuster or link adjuster_id back; the dashboard keeps the zero-row-checked link-back', () => {
    for (const f of ['project-info-acv.html', 'project-info-rcv.html']) {
      const src = read(f);
      expect(src, f).not.toContain('upsert_adjuster_from_claim');
      expect(src, f).not.toMatch(/update\(\{ adjuster_id: adjData \}\)/);
    }
    const dash = read('dashboard.html');
    expect(dash).toContain("sb.rpc('upsert_adjuster_from_claim'");
    expect(dash).toMatch(/update\(\{ adjuster_id: adjData \}\)\.eq\('id', currentClaim\.id\)\.select\('id'\)/);
    expect(dash).toContain('gh-2105: zero-row update -- claims.adjuster_id matched no rows');
  });

  it('NEGATIVE CONTROL: the port flags a bare un-annotated update and honours the marker', () => {
    expect(violations("await sb.from('claims').update({ updated_at: 'x' }).eq('id', 1);")).toEqual([1]);
    expect(violations("// update-no-select-ok: x\nawait sb.from('claims').update({ updated_at: 'x' }).eq('id', 1);")).toEqual([]);
    expect(violations("await sb.from('claims').update({ updated_at: 'x' }).eq('id', 1).select('id');")).toEqual([]);
  });

  it('the annotated sites stayed annotation-only: no .select( was added to any of them', () => {
    for (const s of SITES) {
      const lines = read(s.file).split('\n');
      const idx = lines.findIndex((l) => l.includes('.update(') && s.trigger.test(l));
      const win = lines.slice(idx, idx + 6).join('\n');
      expect(win.split(';')[0]).not.toContain('.select(');
    }
  });
});
