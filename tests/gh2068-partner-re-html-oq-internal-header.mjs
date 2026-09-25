/**
 * gh-2068 (cto38-b2068r) — regression test for partner-re.html's half of
 * fresh-context review Must-fix 2 (PR #2099 comment 5824273357): the
 * leads insert at ~L1506 (pre-fix) sent no X-OQ-Internal header at all,
 * so internal/QA traffic through this page's signup flow was never
 * flagged synthetic server-side by leads_force_safe_insert_defaults().
 *
 * Same structure as tests/gh2068-start-html-oq-internal-header.mjs:
 *   1. Behavioral: the ACTUAL `oqInternalHeader` function — extracted
 *      verbatim out of partner-re.html by brace-matching on its own
 *      `function oqInternalHeader(` anchor, not reimplemented — loaded
 *      into a Node `vm` context and exercised against the same 4
 *      scenarios (query param, persisted cookie, ordinary visit,
 *      negative-control bad cookie value).
 *   2. Static, source-level: the "Save lead to database" block actually
 *      calls `.setHeader('x-oq-internal', ...)` on the leads insert
 *      builder (the wiring a pure function-level test can't see, since
 *      the insert itself lives inline in the async submit handler, not
 *      in its own named function) — and a regression guard that no
 *      `global: { headers` option is ever wired into this page's
 *      Supabase client creation (that would leak the header onto every
 *      request the shared `sb` client makes, including other pages that
 *      reuse it — see this page's own oqInternalHeader() comment).
 *
 * Run: node tests/gh2068-partner-re-html-oq-internal-header.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const pageSrc = fs.readFileSync(path.join(repoRoot, 'partner-re.html'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

function extractFunction(src, name) {
  const anchor = `function ${name}(`;
  const start = src.indexOf(anchor);
  if (start === -1) throw new Error(`${name}(...) not found in partner-re.html`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`${name}(...): no matching closing brace found`);
  return src.slice(start, i + 1);
}

// ─── Part 1: behavioral, extracted oqInternalHeader() ───────────────────

const oqInternalHeaderSrc = extractFunction(pageSrc, 'oqInternalHeader');

function runScenario({ search, cookie }) {
  const sandbox = {
    window: {
      location: { search: search || '', hostname: 'otterquote.com' },
      OQ_INTERNAL: undefined,
    },
    document: { cookie: cookie || '' },
    URLSearchParams,
    decodeURIComponent,
    console,
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(
    oqInternalHeaderSrc + '\nthis.__oqInternalHeader = oqInternalHeader;',
    sandbox,
    { filename: 'partner-re.html (extracted)' }
  );
  return sandbox.__oqInternalHeader();
}

// 1. Internal via query param -> header present.
{
  const header = runScenario({ search: '?oq_internal=1' });
  ok(header['x-oq-internal'] === '1', 'query-param case: oqInternalHeader() returns x-oq-internal: 1');
}

// 2. Internal via persisted cookie, no query param -> same result.
{
  const header = runScenario({ cookie: 'oq_internal=1; other=x' });
  ok(header['x-oq-internal'] === '1', 'cookie-only case: oqInternalHeader() returns x-oq-internal: 1');
}

// 3. Negative control: ordinary visit, no param/cookie -> no header at all.
{
  const header = runScenario({});
  ok(Object.keys(header).length === 0, 'negative control: ordinary visit returns no header');
}

// 4. Negative control: wrong cookie value must not trip the header.
{
  const header = runScenario({ cookie: 'oq_internal=0' });
  ok(Object.keys(header).length === 0, 'negative control: oq_internal=0 cookie does not set the header');
}

// ─── Part 2: static, source-level wiring checks ──────────────────────────

// The leads-insert block must build the insert first, then attach the
// header via setHeader on that builder only, then await it — mirroring
// start.html's pattern (never `.insert({...}).then(...)` with the header
// attached anywhere else).
const leadsBlockAnchor = "// Save lead to database";
const leadsBlockStart = pageSrc.indexOf(leadsBlockAnchor);
ok(leadsBlockStart !== -1, "source: 'Save lead to database' block found");
const leadsBlock = pageSrc.slice(leadsBlockStart, leadsBlockStart + 700);
ok(/\.from\(\s*'leads'\s*\)/.test(leadsBlock),
  "source: the 'Save lead to database' block inserts into .from('leads')");
ok(/\.setHeader\(\s*'x-oq-internal'/.test(leadsBlock),
  "source: the leads insert builder gets .setHeader('x-oq-internal', ...) before being awaited");
ok(/oqInternalHeader\(\)/.test(leadsBlock),
  "source: the leads insert block calls oqInternalHeader() to compute the flag");

// Regression guard: no client-wide `global: { headers` option anywhere in
// this file's Supabase client creation (would leak x-oq-internal onto
// every request the shared `sb` client makes, including other pages that
// reuse it via window.sb, and any supabase.functions.invoke(...) call).
ok(!/global\s*:\s*\{\s*headers/.test(pageSrc),
  "source: no client-wide `global: { headers` wiring anywhere in partner-re.html");

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
