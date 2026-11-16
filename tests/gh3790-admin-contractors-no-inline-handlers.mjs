/**
 * gh-3790 -- admin-contractors.html must not build inline handlers (or HTML) from
 * contractor-supplied text. Loads the page's real renderContractors /
 * renderDocumentSubCards / coiState / escHtml / handleContractorAction source and
 * renders a contractor whose company name is an XSS payload.
 *
 * Part 1 (always): string-level assertions on the rendered markup, in a vm.
 * Part 2 (when Playwright + chromium exist): render the card in headless Chromium,
 *   click every button, assert no dialog fires, no injected element, the name is text,
 *   and the delegated handler receives the exact original name (incl. O'Brien).
 *
 * Run: node tests/gh3790-admin-contractors-no-inline-handlers.mjs
 * GH3790_ROOT points at another tree (negative control: a checkout of main).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH3790_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(ROOT, 'admin-contractors.html'), 'utf8');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

function extractFn(name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(page);
  if (!m) return null;
  let i = page.indexOf('{', m.index), depth = 0;
  for (let j = i; j < page.length; j++) {
    const ch = page[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return page.slice(m.index, j + 1); }
  }
  return null;
}
const names = ['escHtml', 'coiState', 'renderDocumentSubCards', 'renderContractors'];
const optional = ['handleContractorAction'];
const src = [...names, ...optional].map(extractFn).filter(Boolean).join('\n\n');
for (const n of names) ok(!!extractFn(n), n + '() found in page');

const PAYLOADS = [
  "x');alert(1);//",
  '"><img src=x onerror=alert(1)>',
  '</script><script>alert(1)</script>',
  "O'Brien Roofing",
];
const mk = (name) => ({
  id: '11111111-1111-1111-1111-111111111111', company_name: name, contact_name: name, email: 'a@b.co',
  phone: '555', status: 'pending_approval', created_at: '2026-01-01T00:00:00Z', trades: ['roofing'],
  service_counties: ['Marion-IN'], contractor_licenses: [], admin_notes: name,
});

function renderHtml(name) {
  const container = { innerHTML: '', addEventListener() {} };
  const ctx = { document: { getElementById: () => container }, contractors: [mk(name)], currentFilter: 'all', console };
  vm.createContext(ctx);
  vm.runInContext(src + '\n;renderContractors();', ctx);
  return container.innerHTML;
}

for (const p of PAYLOADS) {
  const html = renderHtml(p);
  const label = JSON.stringify(p);
  const handlers = [...html.matchAll(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi)].map((m) => m[1]);
  ok(handlers.length === 0, label + ': rendered card carries no inline on* handler attributes (' + handlers.length + ' found)');
  ok(!/<img\b/i.test(html) && !/<script\b/i.test(html), label + ': no injected <img>/<script> element in the markup');
  ok(!html.includes(p), label + ': raw (unescaped) payload text does not appear in the markup');
}

// the honest name round-trips: escaped in markup, decodes back to the exact text
const ob = renderHtml("O'Brien Roofing");
ok(/data-name="O&#39;Brien Roofing"/.test(ob), "O'Brien Roofing is carried in a data-name attribute, HTML-escaped");
ok(/>O&#39;Brien Roofing</.test(ob), "O'Brien Roofing shows as text in the Company cell");

// ---------------- Part 2: headless Chromium ----------------
let chromium = null;
try {
  const req = createRequire('/opt/npm-tools/node_modules/');
  ({ chromium } = req('playwright'));
} catch (e) {
  try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch (e2) { chromium = null; }
}
if (!chromium) {
  console.log('SKIP: Playwright not available; headless checks not run');
} else {
  let browser = null;
  try { browser = await chromium.launch(); } catch (e) { console.log('SKIP: chromium could not launch: ' + String(e.message).split('\n')[0]); }
  if (browser) {
    for (const p of PAYLOADS) {
      const label = JSON.stringify(p);
      const ctxPage = await browser.newPage();
      const dialogs = [];
      ctxPage.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
      const pageErrors = [];
      ctxPage.on('pageerror', (e) => pageErrors.push(String(e.message)));
      const html = '<!doctype html><html><body><div id="contractorsContainer"></div><div id="cronHealthContent"></div>' +
        '<script>window.__calls=[];' +
        'function openInsuranceModal(i,n){__calls.push(["insurance",i,n]);}' +
        'function openApproveConfirmModal(i,n){__calls.push(["approve",i,n]);}' +
        'function openRejectModal(i,n){__calls.push(["reject",i,n]);}' +
        'function markLicenseVerified(i){__calls.push(["mlic",i]);}' +
        'function markInsuranceVerified(i){__calls.push(["mins",i]);}' +
        'function saveNotes(i){__calls.push(["notes",i]);}' +
        'function openLicenseBoard(s,n){__calls.push(["board",s,n]);}' +
        'var contractors=' + JSON.stringify([mk(p)]).replace(/</g, '\\u003c') + ';var currentFilter="all";' +
        '<\/script><script>' + src.replace(/<\/script/gi, '<\\/script') + '\n' +
        'var c=document.getElementById("contractorsContainer");' +
        'if(typeof handleContractorAction==="function")c.addEventListener("click",handleContractorAction);' +
        'renderContractors();<\/script></body></html>';
      await ctxPage.setContent(html);
      const info = await ctxPage.evaluate(() => ({
        imgs: document.querySelectorAll('#contractorsContainer img, #contractorsContainer script').length,
        company: document.querySelector('.contractor-header-cell-value').textContent,
        notes: document.querySelector('textarea').value,
        inline: document.querySelectorAll('#contractorsContainer [onclick],#contractorsContainer [onerror]').length,
      }));
      ok(info.imgs === 0, label + ' [browser]: no injected img/script element');
      ok(info.company === p, label + ' [browser]: Company cell textContent equals the exact name');
      ok(info.notes === p, label + ' [browser]: admin notes textarea holds the exact text');
      ok(info.inline === 0, label + ' [browser]: no element carries an onclick/onerror attribute (' + info.inline + ' found)');
      // click every button on the card (expand body first so they are visible)
      await ctxPage.evaluate(() => document.querySelectorAll('.contractor-card-body').forEach((b) => b.classList.add('expanded')));
      const n = await ctxPage.locator('#contractorsContainer button').count();
      for (let i = 0; i < n; i++) await ctxPage.locator('#contractorsContainer button').nth(i).dispatchEvent('click');
      await ctxPage.waitForTimeout(150);
      ok(dialogs.length === 0, label + ' [browser]: no dialog (alert) fired after clicking all ' + n + ' buttons' + (dialogs.length ? ' -> ' + dialogs.join('|') : ''));
      ok(pageErrors.length === 0, label + ' [browser]: no page script error (' + pageErrors.join('|') + ')');
      const calls = await ctxPage.evaluate(() => window.__calls);
      const named = calls.filter((c) => ['insurance', 'approve', 'reject'].includes(c[0]));
      ok(named.length === 3 && named.every((c) => c[2] === p), label + ' [browser]: modal handlers receive the exact original name (' + named.length + ' calls)');
      await ctxPage.close();
    }
    await browser.close();
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
