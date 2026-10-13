/**
 * gh-1873 (Hover retirement, steps 0-3): no caller of the six Hover Edge Functions remains.
 *
 *   create-hover-order  get-hover-pdf  get-hover-siding-data  hover-webhook  hover-oauth-callback  check-siding-design-completion
 *
 * Source scan, no network. It walks
 *   - react-app/app (non-test .ts/.tsx/.js/.jsx),
 *   - the static site (root *.html and js/*.js),
 *   - every other Edge Function's non-test source (supabase/functions/<other>/**.ts), and
 *   - the six functions' own index.ts / handler.ts (which must be stubs: no Deno.env read, no outbound call),
 * and checks the unschedule draft for cron job 6 exists with its rollback, and that platform-health-check no longer
 * expects job 6.
 *
 * NEGATIVE CONTROL: copied onto main 4f331d4 this file fails 5 of its 8 blocks (react-app source, static pages and js/, the six stubs,
 * platform-health-check, the unschedule draft); the other three (no other Edge Function calls them, the refund engine is kept, the
 * scan flags known-bad lines) pass on both. Main's callers are in react-app/app/lib/services.ts, help-measurements/page.tsx,
 * contractor/opportunities/page.tsx, contractor/bid/[claimId]/bid-form.tsx and home-photos-card.tsx, (homeowner)/bids/actions.ts,
 * bids.html, contractor-bid-form.html, contractor-opportunities.html and js/services.js; the six index.ts files read HOVER_* from Deno.env.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

const APP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_DIR, '..', '..');
const FN_DIR = path.join(REPO_ROOT, 'supabase', 'functions');

const SIX = [
  'create-hover-order',
  'get-hover-pdf',
  'get-hover-siding-data',
  'hover-webhook',
  'hover-oauth-callback',
  'check-siding-design-completion',
];

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

/** Code lines only: a comment may still name a function. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

function codeOnlySql(sql: string): string {
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
}

// A caller: invoking or fetching one of the six functions, or one of the removed client helpers, or the vendor's own host.
const NAMES = SIX.join('|');
const CALL = new RegExp(
  `(invoke\\(\\s*['"\`](${NAMES})['"\`])|(/functions/v1/(${NAMES}))|createHoverOrder|placeHoverOrder|requestHoverPaymentIntent|hover\\.to\\b|api\\.hover`,
);

const rel = (f: string) => path.relative(REPO_ROOT, f);
const isCode = (n: string) => /\.(tsx?|jsx?)$/.test(n) && !/\.test\.[tj]sx?$/.test(n);

describe('gh-1873 no caller of the six Hover functions remains', () => {
  it('react-app/app source has no invocation of them', () => {
    const files = walk(APP_DIR, isCode);
    expect(files.length).toBeGreaterThan(100); // the scan really saw the app
    const offenders = files.filter((f) => CALL.test(codeOnly(readFileSync(f, 'utf-8'))));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('static pages and js/ have no call to them', () => {
    const files = [
      ...readdirSync(REPO_ROOT).filter((n) => n.endsWith('.html')).map((n) => path.join(REPO_ROOT, n)),
      ...readdirSync(path.join(REPO_ROOT, 'js')).filter((n) => n.endsWith('.js')).map((n) => path.join(REPO_ROOT, 'js', n)),
    ];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((f) => CALL.test(codeOnly(readFileSync(f, 'utf-8'))));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('no other Edge Function calls them', () => {
    const files = walk(FN_DIR, (n) => /\.ts$/.test(n) && !/\.test\.ts$/.test(n)).filter(
      (f) => !SIX.some((s) => f.startsWith(path.join(FN_DIR, s) + path.sep)),
    );
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter((f) => CALL.test(codeOnly(readFileSync(f, 'utf-8'))));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('the six functions are stubs: index.ts and handler.ts read no secret and make no outbound call', () => {
    const FORBIDDEN = /Deno\.env|HOVER_[A-Z_]+|hover\.to|fetch\(|createClient|supabase-js/;
    const offenders: string[] = [];
    for (const s of SIX) {
      for (const f of ['index.ts', 'handler.ts']) {
        const p = path.join(FN_DIR, s, f);
        if (!existsSync(p)) { offenders.push(`${s}/${f} (missing)`); continue; }
        if (FORBIDDEN.test(codeOnly(readFileSync(p, 'utf-8')))) offenders.push(`${s}/${f}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('platform-health-check no longer expects cron job 6 (otherwise the stub raises a stale-cron alert)', () => {
    const src = codeOnly(readFileSync(path.join(FN_DIR, 'platform-health-check', 'index.ts'), 'utf-8'));
    expect(src).not.toMatch(/"check-siding-design-completion"/);
  });

  it('the unschedule draft for cron job 6 exists with its rollback, and is a draft (not under supabase/migrations/)', () => {
    const draft = path.join(REPO_ROOT, 'supabase', 'migrations_drafts', 'gh1873_unschedule_check_siding_design_completion.sql');
    const rollback = path.join(REPO_ROOT, 'supabase', 'migrations_rollbacks', 'gh1873_unschedule_check_siding_design_completion_rollback.sql');
    expect(existsSync(draft)).toBe(true);
    expect(existsSync(rollback)).toBe(true);
    const sql = readFileSync(draft, 'utf-8');
    expect(sql).toMatch(/cron\.unschedule/);
    expect(sql).toMatch(/jobname\s*=\s*'check-siding-design-completion'/);
    expect(sql).toMatch(/STATUS \(gh-1438, as of [^)]*\): NOT APPLIED/);
    // job 10 (process-hover-rebate-scan) pays homeowner refunds and must never be touched by this draft.
    expect(codeOnlySql(sql)).not.toMatch(/process-hover-rebate/);
    const filed = readdirSync(path.join(REPO_ROOT, 'supabase', 'migrations')).filter((n) => /gh1873/.test(n));
    expect(filed).toEqual([]);
  });

  it('the refund engine is kept: process-hover-rebate is not a stub and still has its Stripe refund code', () => {
    const src = readFileSync(path.join(FN_DIR, 'process-hover-rebate', 'index.ts'), 'utf-8');
    expect(src).toMatch(/STRIPE_SECRET_KEY/);
    expect(existsSync(path.join(FN_DIR, 'process-hover-rebate', 'handler.ts'))).toBe(false);
  });

  it('the scan itself can fail: it flags known-bad lines (negative control)', () => {
    expect(CALL.test(codeOnly("await supabase.functions.invoke('get-hover-pdf', { body: {} })"))).toBe(true);
    expect(CALL.test(codeOnly("fetch(CONFIG.SUPABASE_URL + '/functions/v1/get-hover-siding-data', {})"))).toBe(true);
    expect(CALL.test(codeOnly('const r = await createHoverOrder(params);'))).toBe(true);
    expect(CALL.test(codeOnly("// supabase.functions.invoke('get-hover-pdf') is only named in a comment"))).toBe(false);
  });
});
