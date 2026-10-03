/**
 * gh-2472 -- public.referrals must not accept direct client INSERTs.
 *
 * Production had policy "Public can insert referral clicks" FOR INSERT TO
 * public WITH CHECK (true) plus the INSERT grant for anon/authenticated, so a
 * browser could insert a referral already at registered..commission_paid for
 * any agent, skipping track_referral_click() and the #2345 30-day check.
 * Migration 20261003140000_gh2472_referrals_insert_lockdown drops that policy
 * and revokes INSERT from anon/authenticated; clicks go only through the
 * SECURITY DEFINER rpc.
 *
 * Static guard (same style as gh2421-static-homeowner-blocked-states.mjs):
 *   1. the migration drops the policy and revokes the grant, and adds no
 *      permissive INSERT policy / client INSERT grant back;
 *   2. no LATER migration re-grants INSERT to a client role or re-creates a
 *      client INSERT policy on referrals;
 *   3. "Service role full access" stays service-role gated;
 *   4. no browser code inserts/upserts into referrals directly, and the ref
 *      landing pages still use the rpc;
 *   5. track_referral_click is still SECURITY DEFINER and inserts 'clicked'.
 *
 * Run: node tests/gh2472-static-referrals-insert-lockdown.mjs [migration.sql]
 * (the optional argument replaces the migration file; used for the negative
 * control.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIG_DIR = path.join(ROOT, 'supabase/migrations');
const MIG_NAME = '20261003140000_gh2472_referrals_insert_lockdown.sql';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('PASS: ' + msg); } else { failed++; console.log('FAIL: ' + msg); } }

const stripSql = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
const statements = (s) => stripSql(s).split(';').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);

const CLIENT_ROLE = /\b(anon|authenticated|public)\b/i;
const REFERRALS = /\bpublic\.referrals\b(?!_)|\bON\s+(TABLE\s+)?referrals\b(?!_)/i;

// A statement that grants INSERT (or ALL) on referrals, or on all tables in public, to a client role.
function isClientInsertGrant(st) {
  if (!/^GRANT\b/i.test(st) && !/\bDEFAULT PRIVILEGES\b.*\bGRANT\b/i.test(st)) return false;
  const m = st.match(/\bGRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+(.+)$/i);
  if (!m) return false;
  const [, privs, target, roles] = m;
  if (!/\b(INSERT|ALL)\b/i.test(privs)) return false;
  if (!CLIENT_ROLE.test(roles)) return false;
  return REFERRALS.test('ON ' + target) || /\bALL\s+TABLES\s+IN\s+SCHEMA\s+public\b/i.test(target) || /^TABLES$/i.test(target.trim());
}

// A CREATE/ALTER POLICY on referrals that admits INSERT for a client role.
function isClientInsertPolicy(st) {
  if (!/^(CREATE|ALTER)\s+POLICY\b/i.test(st)) return false;
  if (!REFERRALS.test(st)) return false;
  const forCmd = (st.match(/\bFOR\s+(ALL|INSERT|SELECT|UPDATE|DELETE)\b/i) || [, 'ALL'])[1].toUpperCase();
  if (forCmd !== 'INSERT' && forCmd !== 'ALL') return false;
  const toRoles = (st.match(/\bTO\s+(.+?)(?:\s+USING\b|\s+WITH\s+CHECK\b|$)/i) || [, 'public'])[1];
  if (!CLIENT_ROLE.test(toRoles)) return false;
  // A FOR ALL / INSERT policy gated on the service role is not a client policy.
  const check = (st.match(/\bWITH\s+CHECK\s*\((.*)\)\s*$/i) || st.match(/\bUSING\s*\((.*)\)\s*$/i) || [, ''])[1];
  if (/auth\.role\(\)\s*=\s*'service_role'/i.test(check) && !/\bOR\b/i.test(check)) return false;
  return true;
}

const migPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(MIG_DIR, MIG_NAME);
ok(fs.existsSync(migPath), `migration file exists (${path.relative(ROOT, migPath)})`);
const mig = fs.existsSync(migPath) ? fs.readFileSync(migPath, 'utf8') : '';
const migSt = statements(mig);

// ---- 1. the migration itself ----
ok(migSt.some((s) => /^BEGIN$/i.test(s)) && migSt.some((s) => /^COMMIT$/i.test(s)), 'migration: wrapped in BEGIN/COMMIT');
ok(migSt.some((s) => /^DROP POLICY IF EXISTS "Public can insert referral clicks" ON public\.referrals$/i.test(s)),
  'migration: drops "Public can insert referral clicks" (IF EXISTS, idempotent)');
const revoke = migSt.find((s) => /^REVOKE\s+(INSERT|ALL)\b.*\bON\s+(TABLE\s+)?public\.referrals\s+FROM\b/i.test(s)) || '';
ok(/\banon\b/i.test(revoke) && /\bauthenticated\b/i.test(revoke), 'migration: REVOKE INSERT ON public.referrals FROM anon, authenticated');
ok(!migSt.some(isClientInsertGrant), 'migration: no INSERT grant to anon/authenticated/public on referrals');
ok(!migSt.some(isClientInsertPolicy), 'migration: no client INSERT policy created on referrals');
ok(!migSt.some((s) => /POLICY\b.*\bpublic\.referrals\b.*\bWITH CHECK\s*\(\s*true\s*\)/i.test(s)),
  'migration: no referrals policy with WITH CHECK (true)');

// ---- 2. no later migration re-opens it ----
const later = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && f > MIG_NAME).sort();
const reopened = [];
for (const f of later) {
  for (const s of statements(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'))) {
    if (isClientInsertGrant(s) || isClientInsertPolicy(s)) reopened.push(`${f}: ${s.slice(0, 140)}`);
  }
}
ok(reopened.length === 0, `no migration after ${MIG_NAME} re-grants INSERT or re-creates a client INSERT policy on referrals` +
  (reopened.length ? '\n    ' + reopened.join('\n    ') : ''));

// ---- 3. "Service role full access" stays service-role gated ----
const allMigs = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
let srPolicy = '';
for (const f of allMigs) {
  for (const s of statements(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'))) {
    if (/^CREATE POLICY "Service role full access" ON public\.referrals\b/i.test(s)) srPolicy = s;
  }
}
ok(/USING \(\(auth\.role\(\) = 'service_role'::text\)\) WITH CHECK \(\(auth\.role\(\) = 'service_role'::text\)\)$/.test(srPolicy),
  '"Service role full access" on referrals: USING and WITH CHECK are auth.role() = service_role');

// ---- 4. browser code ----
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.netlify', '.claude', 'tests', 'e2e']);
const browserFiles = [];
(function walk(dir, rel) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      const r = path.posix.join(rel, ent.name);
      if (SKIP_DIRS.has(ent.name) || r === 'supabase/functions' || r === 'supabase/migrations') continue;
      walk(path.join(dir, ent.name), r);
    } else if (/\.(html|js|mjs|ts|tsx|jsx)$/.test(ent.name)) {
      browserFiles.push(path.posix.join(rel, ent.name));
    }
  }
})(ROOT, '');
const stripJsLineComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const DIRECT_WRITE = /\.from\(\s*['"`]referrals['"`]\s*\)\s*\.(insert|upsert)\s*\(/;
const offenders = browserFiles.filter((f) => DIRECT_WRITE.test(stripJsLineComments(fs.readFileSync(path.join(ROOT, f), 'utf8'))));
ok(browserFiles.length > 50, `scanned ${browserFiles.length} browser source files`);
ok(offenders.length === 0, 'no browser code does .from(\'referrals\').insert/upsert' + (offenders.length ? ': ' + offenders.join(', ') : ''));
for (const page of ['ref.html', 'ref-re.html', 'ref-inspector.html', 'ref-insurance.html']) {
  const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
  ok(/\.rpc\(\s*['"]track_referral_click['"]/.test(src), `${page}: records the click via rpc('track_referral_click')`);
}

// ---- 5. the rpc that replaces the client insert ----
let rpcDef = '';
for (const f of allMigs) {
  const src = fs.readFileSync(path.join(MIG_DIR, f), 'utf8');
  const m = src.match(/CREATE OR REPLACE FUNCTION public\.track_referral_click\([\s\S]*?\$function\$;/);
  if (m) rpcDef = m[0];
}
ok(/\bSECURITY DEFINER\b/.test(rpcDef), 'track_referral_click (latest definition): SECURITY DEFINER');
ok(/INSERT INTO referrals[\s\S]*?VALUES\s*\(\s*v_agent_id,\s*'clicked'/.test(rpcDef), "track_referral_click: inserts status 'clicked' only");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
