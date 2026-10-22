/**
 * gh-2987 -- the admin personal email must not ship in the client JS bundle,
 * and Auth._getIsAdmin must decide admin status server-side.
 *
 * Static: js/auth.js, js/nav.js, js/cookie-storage.js (served to every visitor)
 * contain no `dustinstohler1@gmail.com`.
 * Behavior: _getIsAdmin asks the DB (rpc is_admin_email), falls back to
 * contractors.template_review_role, and grants nothing on its own.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LITERAL = 'dustinstohler1@gmail.com';
let failures = 0;
const check = (name, fn) => {
  Promise.resolve().then(fn).then(
    () => console.log('PASS', name),
    (e) => { failures++; console.error('FAIL', name, '-', e.message); process.exitCode = 1; },
  );
};

for (const f of ['js/auth.js', 'js/nav.js', 'js/cookie-storage.js']) {
  check(`${f} has no admin email literal`, () => {
    const src = readFileSync(join(root, f), 'utf8');
    assert.equal(src.toLowerCase().includes(LITERAL), false);
  });
}

const authSrc = readFileSync(join(root, 'js/auth.js'), 'utf8');
const m = authSrc.match(/async _getIsAdmin\(user\) \{[\s\S]*?\n  \},\n/);
const body = m && m[0].replace(/,\n$/, '\n');

function build(sb) {
  // eslint-disable-next-line no-new-func
  return new Function('sb', `return ({ ${body} })._getIsAdmin;`)(sb);
}
const mkSb = ({ rpc, role }) => ({
  rpc: async () => rpc,
  from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: role }) }) }) }),
});

check('_getIsAdmin source extracted', () => assert.ok(body));
check('no user -> false', async () => assert.equal(await build(mkSb({ rpc: { data: true } }))(null), false));
check('rpc true -> admin', async () =>
  assert.equal(await build(mkSb({ rpc: { data: true, error: null } }))({ id: 'u', email: 'x@example.com' }), true));
check('client email alone grants nothing', async () =>
  assert.equal(await build(mkSb({ rpc: { data: false, error: null }, role: null }))({ id: 'u', email: LITERAL }), false));
check('rpc error falls back to role=admin', async () =>
  assert.equal(await build(mkSb({ rpc: { data: null, error: {} }, role: { template_review_role: 'admin' } }))({ id: 'u' }), true));
check('rpc throws -> role fallback, then false', async () => {
  const sb = mkSb({ role: null }); sb.rpc = async () => { throw new Error('x'); };
  assert.equal(await build(sb)({ id: 'u' }), false);
});
