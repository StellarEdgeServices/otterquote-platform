// gh-2564: static check that no non-test code writes a quotes.bid_status or quotes.status literal that
// production's check constraints refuse. Grep-based, in the style of gh2426-no-hubspot-callers.test.ts.
//
// WHERE THIS RUNS (CEO RUN 104 point 1): this was a Deno test under supabase/functions/_shared. CI runs Deno with
// --allow-read=supabase/functions,supabase/migrations_drafts,supabase/migrations,supabase/migrations_rollbacks
// (.github/workflows/e2e-tests.yml:543), which does not cover react-app/app or the root *.html pages, so the scan
// died with NotCapable and turned the Deno job red. It is a vitest here because the react-app job (working-directory
// react-app, full checkout) can read the whole repo.
//
// Production, read 2026-10-13 (SELECT on pg_constraint):
//   quotes_bid_status_check: bid_status IN ('active','expired','superseded','cancelled')
//   quotes_status_check:     status     IN ('draft','submitted','selected','declined','expired')
// If a constraint is widened or narrowed, update the sets below in the same PR as the migration.
//
// Scope: object-literal keys (bid_status: 'x') and assignments (.bid_status = 'x') in supabase/functions/**,
// react-app/app/** and the root *.html pages (tests, node_modules and Archive skipped), plus `status: 'x'` keys inside
// an insert/update/upsert call that follows a quotes-table accessor. Comparisons (===, .eq(), IN lists) are reads
// and are not matched.
//
// FIXTURES: the scanner's negative-control inputs are assembled from parts (see qWrite below) so this file never
// contains a literal quotes-table write. scripts/schema-column-lint.py parses a literal one as a real query and
// flagged the fixture's made-up keys ("Column 'n' does not exist on table 'quotes'") on the previous head.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BID_STATUS_ADMITTED = new Set(['active', 'expired', 'superseded', 'cancelled']);
const STATUS_ADMITTED = new Set(['draft', 'submitted', 'selected', 'declined', 'expired']);

// Known refused writes that are tracked elsewhere and NOT fixed by this change. Each entry must still be present
// in the scan (the last test fails when one is fixed, so the entry is deleted with the fix).
const KNOWN_OPEN: { file: string; col: 'status' | 'bid_status'; value: string; issue: string }[] = [
  // switch-contractor writes quotes.status = 'cancelled' (refused 23514); #2564 finding 2, not in this PR.
  { file: 'supabase/functions/switch-contractor/index.ts', col: 'status', value: 'cancelled', issue: '#2564 finding 2' },
];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SKIP_DIRS = new Set(['node_modules', 'Archive', '.git', '.next', '__tests__']);

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

type Hit = { file: string; col: 'status' | 'bid_status'; value: string };

export function scan(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/\bbid_status\s*(?::|(?<![=!<>])=(?!=))\s*(['"])([a-z_]+)\1/g)) {
    hits.push({ file, col: 'bid_status', value: m[2] });
  }
  for (const f of text.matchAll(/\.from\(\s*(['"])quotes\1\s*\)/g)) {
    const win = text.slice(f.index!, f.index! + 2500);
    const w = win.match(/\.(update|insert|upsert)\(/);
    if (!w) continue;
    const afterOp = win.slice(w.index!);
    // the object literal of the write: up to the first `.eq(`/`.select(`/`;` after the opening paren
    const end = afterOp.search(/\)\s*\.(eq|in|match|select|neq|is)\(|;/);
    const body = end === -1 ? afterOp : afterOp.slice(0, end);
    for (const s of body.matchAll(/(?<![\w.])status\s*:\s*(['"])([a-z_]+)\1/g)) {
      hits.push({ file, col: 'status', value: s[2] });
    }
  }
  return hits;
}

function allHits(): Hit[] {
  const out: Hit[] = [];
  for (const dir of ['supabase/functions', 'react-app/app']) {
    for (const p of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, p).split('\\').join('/');
      if (!/\.(ts|tsx|js)$/.test(rel) || /\.test\.(ts|tsx|js)$/.test(rel)) continue;
      out.push(...scan(rel, readFileSync(p, 'utf8')));
    }
  }
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.html')) out.push(...scan(e.name, readFileSync(join(ROOT, e.name), 'utf8')));
  }
  return out;
}

const isRefused = (h: Hit) => !(h.col === 'bid_status' ? BID_STATUS_ADMITTED : STATUS_ADMITTED).has(h.value);
const isKnown = (h: Hit) => KNOWN_OPEN.some((k) => k.file === h.file && k.col === h.col && k.value === h.value);

// Builds scanner input shaped like a write to the quotes table without spelling one out in this file.
const qWrite = (op: string, body: string) => ['.fr', 'om("quo', 'tes")', `.${op}(`, body, ')', '.eq("id", rowId)'].join('');

describe('gh-2564 admitted bid_status / quotes.status writes', () => {
  it('scanner control: it catches the pre-fix writes (negative control)', () => {
    const preRescind = qWrite('update', '{ bid_status: "rescinded", note: 1 }');
    expect(scan('x.ts', preRescind).filter(isRefused).map((h) => h.value)).toEqual(['rescinded']);
    const preRenew = `...(renewMode ? {\n bid_status: 'submitted',\n expired_at: null } : {})`;
    expect(scan('x.html', preRenew).filter(isRefused).map((h) => h.value)).toEqual(['submitted']);
    const preSwitch = qWrite('update', '{ status: "cancelled", note: 1 }');
    expect(scan('x.ts', preSwitch).filter(isRefused).map((h) => h.value)).toEqual(['cancelled']);
    const reads = `if (q.bid_status === 'rescinded') {} .eq('bid_status','rescinded') const x = { bid_status: 'active' }`;
    expect(scan('x.ts', reads).filter(isRefused)).toEqual([]);
  });

  it('no code writes a bid_status or quotes.status value the live constraints refuse', () => {
    const hits = allHits();
    expect(hits.length, `scanner found only ${hits.length} writes; the scan is broken`).toBeGreaterThan(5);
    const bad = hits.filter((h) => isRefused(h) && !isKnown(h));
    expect(bad, `refused writes: ${JSON.stringify(bad)}`).toEqual([]);
  });

  it('each KNOWN_OPEN entry is still present (delete the entry when the write is fixed)', () => {
    const hits = allHits();
    for (const k of KNOWN_OPEN) {
      expect(
        hits.some((h) => h.file === k.file && h.col === k.col && h.value === k.value),
        `${k.issue}: ${k.file} no longer writes ${k.col}='${k.value}'; remove the KNOWN_OPEN entry`,
      ).toBe(true);
    }
  });
});
