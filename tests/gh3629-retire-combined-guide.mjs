// gh-3629: the combined Thumbtack-and-Angi guide is retired. Its old URL must 301 in one hop to the
// Thumbtack guide (no chain), nothing may still link to it, it must be out of sitemap.xml, and the
// Thumbtack page must say "per its page" (copy-read F2). Run from repo root: node tests/gh3629-retire-combined-guide.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const OLD = 'otter-quotes-vs-thumbtack-angi';
const OLD_PATH = `/guides/${OLD}`;
const TARGET = '/guides/otter-quotes-vs-thumbtack.html';
let n = 0; const fails = [];
function check(name, fn) { try { fn(); console.log('ok ' + (++n) + ' - ' + name); } catch (e) { fails.push(name); console.log('NOT OK - ' + name + ': ' + e.message); } }
const read = (p) => readFileSync(p, 'utf8');

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === '.git') continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

check('old page file is deleted (so the 301 fires without a force flag)', () => assert.ok(!existsSync(`guides/${OLD}.html`)));
check('grep -rl old slug --include=*.html returns 0 files', () => {
  const hits = walk('.').filter((p) => p.endsWith('.html') && read(p).includes(OLD));
  assert.deepEqual(hits, []);
});
check('old URL absent from sitemap.xml, llms.txt and the topic map', () => {
  for (const f of ['sitemap.xml', 'llms.txt', 'scripts/seo-topic-map.json']) assert.ok(!read(f).includes(OLD), f + ' still names the old guide');
});
check('_redirects: .html, extensionless and trailing-slash forms each 301 straight to the Thumbtack guide', () => {
  const rules = read('_redirects').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
  for (const from of [`${OLD_PATH}.html`, OLD_PATH, `${OLD_PATH}/`]) {
    const r = rules.filter((x) => x[0] === from);
    assert.equal(r.length, 1, `expected exactly one rule for ${from}, got ${r.length}`);
    assert.equal(r[0][1], TARGET, `${from} must go straight to ${TARGET}`);
    assert.equal(r[0][2], '301');
  }
});
check('no chain: the 301 target exists as a file and is not itself redirected', () => {
  assert.ok(existsSync(TARGET.slice(1)));
  const froms = read('_redirects').split('\n').map((l) => l.trim().split(/\s+/)[0]);
  assert.ok(!froms.includes(TARGET) && !froms.includes(TARGET.replace(/\.html$/, '')));
});
check('edge map: the extensionless entry points straight at the Thumbtack guide, never at the deleted .html', () => {
  const ts = read('netlify/edge-functions/blog-guides-redirect.ts');
  assert.ok(!ts.includes(`${OLD}.html`), 'edge map still targets the deleted file');
  const flat = ts.replace(/\s+/g, ' ');
  assert.ok(flat.includes(`'${OLD_PATH}': '${TARGET}'`), 'edge entry missing or wrong target');
});
check('Thumbtack page says "per its page", not "per its pages"', () => {
  const html = read('guides/otter-quotes-vs-thumbtack.html');
  assert.ok(!html.includes('per its pages'));
  assert.ok(html.includes('>per its page</a>'));
});
console.log(fails.length ? `\nFAILED ${fails.length}: ${fails.join('; ')}` : `\nall ${n} checks passed`);
process.exit(fails.length ? 1 : 0);
