/**
 * gh-3009 items 2 and 3 -- the owner's personal email must not appear in any file that ships to
 * browsers or the edge, and admin pages must decide "is this user an admin" via the server
 * (public.is_admin_email()), never a client-side email comparison or a second allow-list.
 *
 * Shipped = tracked files outside tests/, __tests__/, *.test.*, supabase/, sql/, Docs/, Archive/,
 * tools/, scripts/, node_modules (the DB seed and test fixtures legitimately name the email).
 * KNOWN_OWED lists files that still carry the literal and are owned by another open PR; the test
 * fails if one of them stops needing the exemption, so the list can only shrink.
 *
 * Negative control: run against the pre-fix tree (git stash / main) and this script FAILS;
 * run: node tests/gh3009-no-owner-email-in-shipped-files.mjs [--no-exemptions]
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EMAIL = 'dustinstohler1' + '@gmail.com'; // split so this file does not match itself
const KNOWN_OWED = process.argv.includes('--no-exemptions')
  ? []
  : []; // gh-3077: react-app/middleware.ts now asks is_admin_email(); the exemption is gone

const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

const files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean);
const SKIP_DIR = /^(tests|supabase|sql|Docs|docs|Archive|tools|scripts|handoffs|runbooks|skills-for-code|deploy-checks|forge-config|otterquote-deploy|netlify\/edge-functions-tests)\//;
const SKIP_FILE = /(^|\/)(__tests__|node_modules|\.next)\/|\.test\.[cm]?[jt]sx?$|\.(md|txt|png|jpg|jpeg|webp|svg|ico|woff2?|pdf)$/;
const shipped = files.filter((f) => !SKIP_DIR.test(f) && !SKIP_FILE.test(f) && fs.existsSync(path.join(ROOT, f)));

const offenders = [];
for (const f of shipped) {
  let t; try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
  if (t.includes(EMAIL)) offenders.push(f);
}
const unexpected = offenders.filter((f) => !KNOWN_OWED.includes(f));
ok(unexpected.length === 0, 'no shipped file contains the owner email literal' + (unexpected.length ? ' -- offenders: ' + unexpected.join(', ') : ` (${shipped.length} files scanned)`));
for (const f of KNOWN_OWED) ok(offenders.includes(f), 'exemption still needed (shrink KNOWN_OWED when false): ' + f);

// Admin pages must ask the server and hold no email comparison.
const adminPages = files.filter((f) => /^admin-[^/]+\.html$/.test(f));
ok(adminPages.length >= 12, `found admin pages (${adminPages.length})`);
const usesServer = (t) => /rpc\(\s*['"]is_admin_email['"]\s*\)/.test(t) || /Auth\._getIsAdmin\(/.test(t);
const emailCompare = /\.email\s*[!=]==?\s*['"]/;
for (const f of adminPages) {
  const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (t.includes('admin-sw')) { /* still a page */ }
  ok(!emailCompare.test(t), f + ': no client-side email comparison');
  // pages that gate at all must gate through the server
  if (/showUnauthorized|authError|checkAdminAndInit|checkAuth/.test(t)) ok(usesServer(t), f + ': admin determination goes through the server (is_admin_email)');
}

// Edge gate: no allow-list of its own, asks the RPC.
const gate = read('netlify/edge-functions/admin-auth-gate.ts');
ok(!/ADMIN_EMAILS/.test(gate) && !/@[a-z0-9-]+\.[a-z]{2,}'/i.test(gate), 'admin-auth-gate.ts holds no email allow-list');
ok(/rpc\/is_admin_email/.test(gate), 'admin-auth-gate.ts calls the is_admin_email RPC');

// React: no allow-list module, provider asks the server.
ok(!fs.existsSync(path.join(ROOT, 'react-app/app/lib/admin-allowlist.ts')), 'react-app admin-allowlist.ts removed');
const prov = read('react-app/app/providers/auth-provider.tsx');
ok(/rpc\('is_admin_email'\)/.test(prov) && !/ADMIN_EMAILS/.test(prov), 'auth-provider.tsx asks is_admin_email and holds no list');

// DB draft: the table, RLS on, no client grants, definer with pinned search_path, seeded.
const mig = read('supabase/migrations_drafts/gh3009_admin_emails_table.sql');
const code = mig.replace(/--.*$/gm, '');
ok(/ENABLE ROW LEVEL SECURITY/.test(code), 'admin_emails has RLS enabled');
ok(/REVOKE ALL ON TABLE public\.admin_emails FROM PUBLIC, anon, authenticated/.test(code), 'admin_emails: no client grants');
ok(/SECURITY DEFINER/.test(code) && /SET search_path = ''/.test(code), 'is_admin_email() is SECURITY DEFINER with pinned search_path');
ok(code.includes(EMAIL) && code.includes('dustin@otterquote.com'), 'seed carries the current two emails');
ok(fs.existsSync(path.join(ROOT, 'supabase/migrations_drafts/gh3009_admin_emails_table_rollback.sql')), 'rollback file present');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
