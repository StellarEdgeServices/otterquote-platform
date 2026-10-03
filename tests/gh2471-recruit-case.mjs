/**
 * gh-2471 (CTO ruling, #2471 comment 5969701989) -- ?recruit= is case/whitespace-normalised before the recruiter lookup on
 * the 11 partner signup / funnel pages, and a URL code that resolves to no active recruiter falls back to the stored one.
 *
 * Server side (checked when this was written): referral_agents.recruit_code is stored 'r-' + up to 6 of [A-Z0-9]
 * (generate_recruit_code(), 76 of 76 production rows canonical), and BOTH the get_referral_agents_public filter the pages use
 * and register_partner match it with an exact, case-sensitive `=`. So normalising the client value (trim, upper-case,
 * R- -> r-, exactly recruit.html / gh-1648) can only turn a miss into a hit; no stored code changes under it.
 *
 * 1. BEHAVIOUR (per page): the REAL detectRecruitCode() of each of the 11 pages is extracted from the page source and run
 *    against the REAL js/config.js with a fake Supabase client that matches recruit_code EXACTLY (like the server). A
 *    mixed-case / whitespace ?recruit= must reach the lookup as 'r-ABC123' and end up in recruitContext.recruitCode (which
 *    is what register_partner receives as p_recruit_code).
 * 2. FALLBACK (per page): ?recruit= that matches nobody + a valid stored cs_recruit_code -> the stored code is used.
 * 3. WIRING: no page filters recruit_code on a raw value any more; the helper is the one shared place (js/config.js).
 *
 * Override ROOT=<dir holding the pages and js/> for the negative control (a checkout of the pre-change main).
 * Run: node tests/gh2471-recruit-case.mjs
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ROOT || path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const PAGES = ['hi-1', 'hi-4', 'hi-5', 'ins-1', 'ins-3', 'ins-5',
  'partner-adjusters', 'partner-inspectors', 'partner-insurance', 'partner-other', 'partner-re'].map((p) => `${p}.html`);

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`✓ PASS: ${name}`); }
  catch (e) { failures += 1; console.log(`✗ FAIL: ${name}\n  ${e.message}`); }
};
const ok = (c, m) => { if (!c) throw new Error(m); };

/** Source text of `function detectRecruitCode` (brace-matched), including a leading `async`. */
function extractDetect(src) {
  const i = src.indexOf('function detectRecruitCode');
  ok(i > -1, 'detectRecruitCode not found');
  const open = src.indexOf('{', src.indexOf(')', i));
  let depth = 0, j = open;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) break; }
  }
  const start = /async\s+$/.test(src.slice(Math.max(0, i - 10), i)) ? src.lastIndexOf('async', i) : i;
  return src.slice(start, j + 1);
}

/** Fake supabase client: ONE active recruiter, matched EXACTLY on recruit_code like the server's `=`. Records every eq('recruit_code', x). */
function fakeClient(activeCode) {
  const seen = [];
  const client = {
    seen,
    rpc() {
      const q = { filters: {} };
      q.select = () => q;
      q.eq = (col, val) => { q.filters[col] = val; if (col === 'recruit_code') seen.push(val); return q; };
      q.maybeSingle = async () => {
        const hit = q.filters.recruit_code === activeCode && q.filters.status === 'active';
        return { data: hit ? { id: 'rec-1', first_name: 'Rita', last_name: 'Recruiter', company: 'RR LLC' } : null, error: null };
      };
      return q;
    },
  };
  return client;
}

function loadConfig() {
  const sandbox = { window: { location: { hostname: 'otterquote.com', search: '' } }, console, setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(read('js/config.js'), sandbox, { filename: 'js/config.js' });
  // `var CONFIG` is a global of the context
  return vm.runInContext('CONFIG', sandbox);
}

async function drive(page, { search, stored, active }) {
  const src = read(page);
  const fn = extractDetect(src);
  const client = fakeClient(active);
  const store = new Map(stored == null ? [] : [['cs_recruit_code', stored]]);
  const sb = vm.createContext({
    console: { warn() {}, log() {}, error() {} },
    window: { location: { search } },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem() {}, removeItem() {} },
    document: { getElementById: () => null },
    URLSearchParams,
    sb: client,
    CONFIG: loadConfig(),
  });
  vm.runInContext(`var recruitContext = null; var __oqRecruitDetectPromise = null; ${fn}; this.__result = detectRecruitCode();`, sb);
  await sb.__result;
  return { context: vm.runInContext('recruitContext', sb), seen: client.seen };
}

const ACTIVE = 'r-ABC123';
const FORMS = [
  ['R-AbC123', 'mixed case with an upper-case prefix'],
  ['r-abc123', 'all lower case'],
  ['%20r-abc123%20', 'surrounding whitespace'],
  ['R-ABC123', 'upper-case prefix'],
  ['AbC123', 'mixed case, no prefix typed (issue example)'],
];

await check('discovery: 11 partner pages read ?recruit= via urlParams.get', () => {
  const found = PAGES.filter((p) => /urlParams\.get\('recruit'\)/.test(read(p)));
  ok(found.length === 11, `expected 11, found ${found.length}: ${found.join(', ')}`);
});

for (const page of PAGES) {
  for (const [raw, label] of FORMS) {
    const expected = raw === 'AbC123' ? 'ABC123' : ACTIVE;
    await check(`${page}: ?recruit=${raw} (${label}) reaches the lookup as '${expected}' and is stored in recruitContext as sent to register_partner`, async () => {
      const { context, seen } = await drive(page, { search: `?recruit=${raw}`, stored: null, active: expected });
      ok(seen.length >= 1 && seen[0] === expected, `lookup received ${JSON.stringify(seen)}, wanted ${expected}`);
      ok(context && context.recruitCode === expected, `recruitContext = ${JSON.stringify(context)}`);
    });
  }
  await check(`${page}: a ?recruit= that matches no active recruiter falls back to the valid stored code (normalised)`, async () => {
    const { context, seen } = await drive(page, { search: '?recruit=R-TYPO99', stored: 'R-abc123 ', active: ACTIVE });
    ok(context && context.recruitCode === ACTIVE, `recruitContext = ${JSON.stringify(context)}, lookups = ${JSON.stringify(seen)}`);
  });
  await check(`${page}: URL-wins is kept -- a valid ?recruit= beats a different valid stored code (gh-2060 item 4)`, async () => {
    const { context, seen } = await drive(page, { search: '?recruit=r-abc123', stored: 'r-ZZZ999', active: ACTIVE });
    ok(context && context.recruitCode === ACTIVE && seen[0] === ACTIVE, `lookups = ${JSON.stringify(seen)}, ctx = ${JSON.stringify(context)}`);
  });
  await check(`${page}: no URL code and no stored code -> no lookup, no recruiter`, async () => {
    const { context, seen } = await drive(page, { search: '', stored: null, active: ACTIVE });
    ok(!context && seen.length === 0, `lookups = ${JSON.stringify(seen)}, ctx = ${JSON.stringify(context)}`);
  });
  await check(`${page}: wiring -- no raw .eq('recruit_code', recruitCode) filter; lookup goes through CONFIG.lookupRecruiter`, () => {
    const src = read(page);
    ok(!/\.eq\('recruit_code', recruitCode\)/.test(src), "page still filters recruit_code on its own value");
    ok(/CONFIG\.lookupRecruiter\(sb, urlParams\.get\('recruit'\), localStorage\.getItem\('cs_recruit_code'\)\)/.test(src), 'CONFIG.lookupRecruiter call not found');
  });
}

await check('CONFIG.normRecruitCode matches recruit.html (gh-1648): trim, upper-case, R- -> r-', () => {
  const C = loadConfig();
  const html = read('recruit.html');
  ok(html.includes(".trim().toUpperCase().replace(/^R-/, 'r-')"), 'recruit.html normalisation changed -- keep the two in step');
  for (const [i, o] of [['  R-abc123 ', 'r-ABC123'], ['r-abc123', 'r-ABC123'], ['R-ABC123', 'r-ABC123'], ['r-ABC123', 'r-ABC123'], ['', ''], [null, ''], [undefined, '']]) {
    ok(C.normRecruitCode(i) === o, `${JSON.stringify(i)} -> ${JSON.stringify(C.normRecruitCode(i))}, wanted ${JSON.stringify(o)}`);
  }
});

await check("react-app: the dead sessionStorage.getItem('cs_signup') fallback is gone (0 occurrences)", () => {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && read(rel).includes("sessionStorage.getItem('cs_signup')")) hits.push(rel);
    }
  };
  walk('react-app');
  ok(hits.length === 0, `still present in: ${hits.join(', ')}`);
});

process.exit(failures ? 1 : 0);
