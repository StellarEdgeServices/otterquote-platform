/**
 * P18 (#3219 / #3217): referrals.homeowner_user_id must never be added to a partner-readable allow-list.
 * PR #3225 (#3217) moves partners to a column allow-list on public.referrals; the lock column from PR #3226 (#3219) must stay off it,
 * whichever merges second. This scans every .sql file under supabase/ and sql/ for a GRANT ... referrals statement that names the column.
 * Run: node tests/p18-homeowner-user-id-not-granted.mjs   (exit 0 = pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p); }
    else if (e.name.endsWith('.sql')) files.push(p);
  }
})(root);

let failed = 0, grantsSeen = 0;
for (const f of files.filter((x) => /[\\/](supabase|sql)[\\/]/.test(x))) {
  const text = fs.readFileSync(f, 'utf8').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const stmt of text.split(';')) {
    if (!/\bGRANT\b/i.test(stmt) || !/\breferrals\b/i.test(stmt) || /\breferral_agents\b/i.test(stmt)) continue;
    grantsSeen++;
    if (/homeowner_user_id/i.test(stmt)) {
      failed++;
      console.log(`FAIL: ${path.relative(root, f)} grants homeowner_user_id on referrals: ${stmt.trim().replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
}
console.log(`${failed ? 'FAIL' : 'PASS'}: no GRANT on public.referrals names homeowner_user_id (${grantsSeen} referrals grant statements scanned)`);
// the gh3219 migration itself must carry no GRANT/REVOKE on the referrals table
const mig = path.join(root, 'supabase', 'migrations_drafts', 'gh3219_partner_credit_lock.sql');
if (fs.existsSync(mig)) {
  const t = fs.readFileSync(mig, 'utf8').replace(/--[^\n]*/g, '');
  const bad = t.split(';').filter((s) => /\b(GRANT|REVOKE)\b/i.test(s) && /\bON\s+(TABLE\s+)?(public\.)?referrals\b/i.test(s));
  console.log(`${bad.length ? 'FAIL' : 'PASS'}: gh3219_partner_credit_lock.sql has no GRANT/REVOKE on the referrals table`);
  failed += bad.length;
}
if (failed) process.exit(1);
console.log('\nOK: homeowner_user_id is on no partner-readable allow-list.');
