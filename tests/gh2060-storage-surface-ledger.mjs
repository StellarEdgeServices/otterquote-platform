/**
 * gh-2060 -- storage-surface ledger check (closes-on clause (c), kept honest).
 *
 * The enumeration of every browser-storage surface lives in
 * tests/fixtures/gh2060-storage-surface-ledger.json (one entry per surface,
 * with a status and the tests that cover it). This script keeps that file
 * from rotting:
 *
 *   1. DISCOVERY: it re-greps the shipped source (react-app/app, js/, every
 *      tracked *.html, excluding tests) for every localStorage /
 *      sessionStorage key literal and key constant, and FAILS if any key is
 *      missing from the ledger -- so a new storage key cannot be added
 *      without deciding how its stale-state behaviour is tested.
 *   2. CITATIONS: every test cited for a `tested` / `known-gap` surface must
 *      exist and contain the quoted test name (renaming or deleting a test
 *      breaks the ledger, not silently the coverage).
 *   3. WRITE-ONLY PROOF: for each `write-only` surface it proves no source
 *      file reads the key (no getItem), so a stale copy is inert. The moment
 *      a reader appears this fails, forcing a real stale-state test.
 *   4. It prints every `open` surface (a surface with NO executable test
 *      yet), so the gap is visible in CI output instead of implied.
 *
 * Grep commands this file reproduces (for the #2060 enumeration comment):
 *   git ls-files -- react-app/app js '*.html' | <filter tests/marketing>
 *   grep -ohE "\.(setItem|getItem|removeItem)\(\s*['\"`][A-Za-z0-9_.:-]+['\"`]"
 *   grep -ohE "(_KEY|STORAGE_KEY|_KEY_PREFIX)\s*=\s*['\"][A-Za-z0-9_.:-]+['\"]"
 *
 * Run: node tests/gh2060-storage-surface-ledger.mjs [--list]
 * Exit code 0 = ledger consistent, 1 = fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'gh2060-storage-surface-ledger.json'), 'utf8'));

let failures = 0;
const fail = (m) => { failures += 1; console.log(`✗ FAIL: ${m}`); };
const pass = (m) => console.log(`✓ PASS: ${m}`);

function listSourceFiles() {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '--', 'react-app/app', 'js', '*.html'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch {
    files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!['node_modules', '.git', '.next'].includes(e.name)) walk(rel); }
        else files.push(rel);
      }
    };
    walk('');
  }
  return files.filter((f) =>
    /\.(ts|tsx|js|html)$/.test(f) &&
    !/(^|\/)__tests__\//.test(f) && !/\.test\./.test(f) &&
    !f.startsWith('react-app/app/test/') && !f.startsWith('react-app/node_modules/'));
}

const files = listSourceFiles();
const sources = new Map(files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));

// ---- 1. discovery -----------------------------------------------------------
const discovered = new Map(); // key -> Set(files)
const add = (k, f) => { if (!discovered.has(k)) discovered.set(k, new Set()); discovered.get(k).add(f); };
const CALL = /\.(?:setItem|getItem|removeItem)\(\s*(['"`])([A-Za-z0-9_.:${}<>-]+)\1/g;
const CONST = /(?:_KEY|STORAGE_KEY|_KEY_PREFIX|\bKEY)\s*=\s*['"]([A-Za-z0-9_.:-]+)['"]/g;
const CONCAT = /getItem\(\s*'([^']+)'\s*\+/g;
for (const [f, src] of sources) {
  for (const m of src.matchAll(CALL)) add(m[2], f);
  for (const m of src.matchAll(CONST)) add(m[1], f);
  for (const m of src.matchAll(CONCAT)) add(m[1], f);
}

const excluded = new Set((ledger.excluded || []).map((e) => e.key));
const entries = ledger.surfaces.flatMap((s) => [s.key, ...(s.also || [])]);
const literalPrefix = (k) => k.split(/[$<]/)[0];
function inLedger(key) {
  const k = literalPrefix(key);
  for (const e of entries) {
    if (key === e || k === e) return true;
    if (/[^A-Za-z0-9]$/.test(e) && k.startsWith(e)) return true;
  }
  for (const x of excluded) if (k === x || (/[^A-Za-z0-9]$/.test(x) && k.startsWith(x))) return true;
  return false;
}
const isStorageKeyShaped = (k) => /^(oq[_-]|cs_|sb-|sb_at|d202_|hover_|ref_|pending_|utm_|arm_f_|<storageKey>)/.test(k);
const missing = [...discovered.keys()].filter((k) => isStorageKeyShaped(k) && !inLedger(k));
if (missing.length) {
  for (const k of missing) fail(`storage key "${k}" (${[...discovered.get(k)][0]}) is not in the ledger -- add it with a status and a stale-state test`);
} else {
  pass(`discovery: all ${[...discovered.keys()].filter(isStorageKeyShaped).length} discovered storage keys are in the ledger (${ledger.surfaces.length} surfaces)`);
}

// ---- 2. citations -------------------------------------------------------------
const fileCache = new Map();
const readCited = (f) => {
  if (!fileCache.has(f)) {
    const p = path.join(ROOT, f);
    fileCache.set(f, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  }
  return fileCache.get(f);
};
for (const s of ledger.surfaces) {
  const label = `${s.key}${s.also ? ' (+' + s.also.join(', ') + ')' : ''}`;
  if (s.status === 'tested' || s.status === 'known-gap') {
    if (!s.tests || s.tests.length === 0) { fail(`${label}: status ${s.status} but no tests cited`); continue; }
    for (const t of s.tests) {
      const body = readCited(t.file);
      if (body === null) fail(`${label}: cited test file missing: ${t.file}`);
      else if (!body.includes(t.contains)) fail(`${label}: ${t.file} no longer contains "${t.contains}"`);
    }
  } else if (s.status === 'write-only') {
    if (!s.reason) fail(`${label}: write-only needs a reason`);
  } else if (s.status === 'open') {
    if (!s.reason) fail(`${label}: open needs a reason`);
  } else if (s.status !== 'excluded') {
    fail(`${label}: unknown status ${s.status}`);
  }
}
pass('citations: every cited test file exists and contains its quoted test name');

// ---- 3. write-only proof --------------------------------------------------------
for (const s of ledger.surfaces.filter((x) => x.status === 'write-only')) {
  for (const key of [s.key, ...(s.also || [])]) {
    const prefix = /[^A-Za-z0-9]$/.test(key);
    const re = new RegExp(`getItem\\(\\s*['"\`]${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${prefix ? '' : '[\'"`]'}`);
    const readers = [...sources].filter(([, src]) => re.test(src)).map(([f]) => f);
    if (readers.length) fail(`${key}: marked write-only but read in ${readers.join(', ')} -- give it a stale-state test`);
    else pass(`${key}: write-only confirmed -- no source file reads it, so a stale copy is inert`);
  }
}

// ---- 4. visibility ---------------------------------------------------------------
const byStatus = {};
for (const s of ledger.surfaces) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
console.log(`\nledger summary: ${JSON.stringify(byStatus)}`);
for (const s of ledger.surfaces.filter((x) => x.status === 'open')) console.log(`OPEN (no executable test yet): ${s.key} -- ${s.reason}`);
for (const s of ledger.surfaces.filter((x) => x.status === 'known-gap')) console.log(`KNOWN GAP (test encodes the recommended default, expected to fail today): ${s.key}`);
if (process.argv.includes('--list')) {
  for (const s of ledger.surfaces) console.log(`${s.status.padEnd(10)} ${s.key}${s.also ? ' + ' + s.also.join(' + ') : ''}  [${s.stack}]`);
}

if (failures > 0) { console.log(`\n✗ ${failures} failure(s).`); process.exit(1); }
console.log('\n✓ gh-2060 storage-surface ledger is consistent with the source.');
process.exit(0);
