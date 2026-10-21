/**
 * gh-1772 / gh-1340 -- admin-contractors.html carries the Business Lines admin
 * shell (the same `.admin-nav` the other static admin pages use), not the public
 * site header. Marty DECIDED Option A (admin-only internal page).
 *
 * Static assertions only, no network. Existing contractor-management behaviour
 * (admin auth guard, Contractors / Referrals / Payouts tab strip, supabase
 * client) must survive the re-skin.
 *
 * Run: node tests/gh1772-admin-contractors-shell.mjs
 * GH1772_ROOT points at another tree (negative control: a checkout of main).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH1772_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const page = read('admin-contractors.html');
const ref = read('admin-homeowners.html');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

function navEntries(html) {
  const m = html.match(/<nav class="admin-nav">([\s\S]*?)<\/nav>/);
  if (!m) return null;
  return [...m[1].matchAll(/<a href="([^"]+)"([^>]*)>([^<]+)<\/a>/g)]
    .map((a) => ({ href: a[1], label: a[3].trim(), active: /class="active"/.test(a[2]) }));
}
const refNav = navEntries(ref);
const nav = navEntries(page);

ok(refNav && refNav.length >= 10, 'reference admin-homeowners.html has the .admin-nav shell');
ok(!!nav, 'admin-contractors.html contains <nav class="admin-nav">');
if (nav && refNav) {
  const strip = (e) => e.map((x) => x.href + '|' + x.label);
  ok(JSON.stringify(strip(nav)) === JSON.stringify(strip(refNav)), 'same nav entries, same order, as admin-homeowners.html');
  ok(nav.some((e) => e.label === 'Business Lines' && e.href === 'admin-dashboard.html'), 'nav has the Business Lines link to admin-dashboard.html');
  const act = nav.filter((e) => e.active);
  ok(act.length === 1 && act[0].href === 'admin-contractors.html' && act[0].label === 'Contractors', 'exactly one active entry: Contractors');
}
ok(/\.admin-nav\s*\{/.test(page) && /\.admin-nav a\.active/.test(page), 'page defines the .admin-nav CSS');

// the public site header must be gone
ok(!/id="site-header"/.test(page), 'no public <header id="site-header"> element');
ok(!/js\/nav\.js/.test(page), 'public nav.js (header/footer renderer) not included');

// existing function survives
ok(/Auth\.getUser\(\)/.test(page) && /dustinstohler1@gmail\.com/.test(page) && /showUnauthorized\(\)/.test(page), 'admin auth guard retained (Auth.getUser + admin email check + showUnauthorized)');
ok(/id="unauthorizedContainer"/.test(page) && /id="adminContainer"[^>]*display: none/.test(page), 'admin content stays hidden until the guard passes');
ok(/js\/supabase-client\.js/.test(page) && /js\/auth\.js/.test(page) && /js\/config\.js/.test(page), 'auth, config and supabase-client scripts still included');
for (const lbl of ['Contractors', 'Referrals', 'Payouts']) {
  ok(new RegExp('href="admin-' + lbl.toLowerCase() + '\\.html"[^>]*>\\s*' + lbl + '\\s*<').test(page), 'D-180 tab strip still has ' + lbl);
}
for (const fn of ['loadContractors', 'renderContractors', 'loadWaitlistStats', 'loadCronHealth', 'submitApprove', 'logout']) {
  ok(new RegExp('function ' + fn + '\\b').test(page) || new RegExp('async function ' + fn + '\\b').test(page), fn + '() still defined');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
