/**
 * gh-2068 — regression test for cto36 REVIEW: FAIL findings B1/B2
 * (PR #2099 comment 5779410643), start.html's half.
 *
 * Loads the ACTUAL `oqInternalHeader` and `insertFreshLead` functions —
 * extracted verbatim out of start.html by brace-matching on their own
 * `function NAME(` anchors, not reimplemented — into a Node `vm` context,
 * matching the existing pattern (tests/gh2078-partner-signup-complete.mjs,
 * tests/gh2033-variant-assignment.mjs). `ensureSb`, `collectAttribution`
 * and `setStoredLeadId` are stubbed: they are not what this file tests
 * (attribution capture and lead-id bookkeeping are unrelated to the
 * header), and `ensureSb` in particular is the seam this test uses to
 * inject a fake Supabase builder — same "stub bridge.sb, never real
 * Supabase" convention as tests/gh2076-variant-e.mjs.
 *
 * Asserts:
 *   1. When isInternal (query param or persisted cookie), the leads
 *      insert's builder gets `.setHeader('x-oq-internal', '1')` called
 *      on it exactly once.
 *   2. Negative control: an ordinary (non-internal) visit calls
 *      `insert()` but never calls `.setHeader()` on the returned builder.
 *   3. Negative control: `.setHeader` is called ONLY on the object
 *      `ensureSb().from('leads').insert(...)` returned — a second,
 *      unrelated builder representing some other table/call is
 *      untouched, proving the header cannot leak onto any other request
 *      this page might make (there is no client-wide `global.headers`
 *      wiring left in ensureSb() to leak through — see the ensureSb()
 *      stub's own `global` assertion below).
 *
 * Run: node tests/gh2068-start-html-oq-internal-header.mjs
 * Exit code 0 = every scenario passed, 1 = at least one failed.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const startHtmlSrc = fs.readFileSync(path.join(repoRoot, 'start.html'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { console.log('PASS: ' + label); pass++; }
  else { console.log('FAIL: ' + label); fail++; }
}

function extractFunction(src, name) {
  const anchor = `function ${name}(`;
  const start = src.indexOf(anchor);
  if (start === -1) throw new Error(`${name}(...) not found in start.html`);
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

// This is also its own regression guard: if a future edit re-adds
// `global: { headers: ... }` inside ensureSb() in start.html, THIS extract
// (of ensureSb's own source, not just the two functions under test) would
// still let us assert it never appears — belt-and-suspenders alongside
// the vm-behavioral assertions below.
const ensureSbSrc = extractFunction(startHtmlSrc, 'ensureSb');
ok(!/global\s*:\s*\{\s*headers/.test(ensureSbSrc),
  'ensureSb() source no longer wires headers into a client-wide `global.headers` option');

const oqInternalHeaderSrc = extractFunction(startHtmlSrc, 'oqInternalHeader');
const insertFreshLeadSrc = extractFunction(startHtmlSrc, 'insertFreshLead');
const combinedSrc = oqInternalHeaderSrc + '\n' + insertFreshLeadSrc;

function makeBuilder() {
  const builder = {
    setHeaderCalls: [],
    insertPayload: null,
  };
  builder.self = {
    setHeader(name, value) {
      builder.setHeaderCalls.push([name, value]);
      return builder.self;
    },
    then(onFulfilled) {
      return Promise.resolve(onFulfilled({ error: null }));
    },
  };
  return builder;
}

function runScenario({ search, cookie }) {
  const leadsBuilder = makeBuilder();
  const otherBuilder = makeBuilder();

  const fromCalls = [];
  const sbClient = {
    from(table) {
      fromCalls.push(table);
      return {
        insert(payload) {
          const builder = table === 'leads' ? leadsBuilder : otherBuilder;
          builder.insertPayload = payload;
          return builder.self;
        },
      };
    },
  };

  const sandbox = {
    window: {
      location: { search: search || '', hostname: 'otterquote.com' },
      crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
      __oqInternalWalk: false,
      OQ_INTERNAL: undefined,
    },
    document: { cookie: cookie || '' },
    URLSearchParams,
    decodeURIComponent,
    console,
    // Stubs for the two dependencies insertFreshLead calls that this test
    // does not exercise (attribution capture, lead-id persistence) —
    // unrelated to the header behaviour under test.
    collectAttribution() {
      return {
        utm_source: null, utm_medium: null, utm_campaign: null,
        utm_content: null, utm_term: null, fbclid: null, gclid: null,
      };
    },
    setStoredLeadId() {},
    variant: 'a',
    // The seam: same signature as the real ensureSb(), stubbed to return
    // the fake Supabase client above instead of a real one.
    ensureSb() { return sbClient; },
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(
    combinedSrc + '\nthis.__insertFreshLead = insertFreshLead;',
    sandbox,
    { filename: 'start.html (extracted)' }
  );

  return sandbox.__insertFreshLead('Jane Doe', 'jane@example.com', '3175551234')
    .then(() => ({ leadsBuilder, otherBuilder, fromCalls }));
}

async function main() {
  // 1. Internal via query param -> leads insert gets the header.
  {
    const { leadsBuilder, otherBuilder, fromCalls } = await runScenario({ search: '?oq_internal=1' });
    ok(fromCalls.includes('leads'), 'query-param case: insertFreshLead used ensureSb().from(\'leads\')');
    ok(leadsBuilder.setHeaderCalls.length === 1
      && leadsBuilder.setHeaderCalls[0][0] === 'x-oq-internal'
      && leadsBuilder.setHeaderCalls[0][1] === '1',
      'query-param case: leads insert builder got .setHeader(\'x-oq-internal\', \'1\') exactly once');
    ok(otherBuilder.setHeaderCalls.length === 0,
      'query-param case: unrelated builder never touched');
  }

  // 2. Internal via persisted cookie, no query param -> same result.
  {
    const { leadsBuilder } = await runScenario({ cookie: 'oq_internal=1; other=x' });
    ok(leadsBuilder.setHeaderCalls.length === 1
      && leadsBuilder.setHeaderCalls[0][1] === '1',
      'cookie-only case: leads insert builder got the header from the persisted cookie');
  }

  // 3. Negative control: ordinary visit, no param/cookie -> no header at all.
  {
    const { leadsBuilder, fromCalls } = await runScenario({});
    ok(fromCalls.includes('leads'), 'ordinary visit: insert still happens (lead is still written)');
    ok(leadsBuilder.setHeaderCalls.length === 0,
      'negative control: ordinary visit never calls .setHeader on the leads insert');
  }

  // 4. Negative control: wrong cookie value must not trip the header.
  {
    const { leadsBuilder } = await runScenario({ cookie: 'oq_internal=0' });
    ok(leadsBuilder.setHeaderCalls.length === 0,
      'negative control: oq_internal=0 cookie does not set the header');
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
