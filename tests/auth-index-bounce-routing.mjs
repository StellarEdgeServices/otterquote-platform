/**
 * Routing-outcome test for #817 A1b — index.html's homepage bounce script.
 *
 * gh-817 comment 5292493605 established that nothing exercises this file at
 * all: tests/auth-partner-role-resolution.mjs only drives getRole() through a
 * vm sandbox, never the bounce IIFE in index.html, auth-callback.html, or
 * requireAuth(). This test loads the real bounce script out of index.html and
 * asserts the routing decision, not an internal return value.
 *
 * Case under test: a dual-role account whose JWT user_metadata.role is the
 * stale signup-time value 'contractor' (contractor-join.html stamps this once
 * and never updates it), logging in from a partner surface that stamped
 * cs_auth_role to a real partner role before the redirect. Per the A1b
 * decision (issue #817 comment 5292800526), cs_auth_role must win in this
 * case and skip the JWT read entirely -- the bounce must land on
 * /partner-dashboard.html, not /contractor-pre-approval.html.
 *
 * Companion cases confirm the two existing paths are byte-identical:
 * no cs_auth_role override present -> JWT role still decides, and a
 * cs_auth_role that is NOT a partner role (e.g. stale 'contractor') never
 * overrides the JWT.
 *
 * Run: node tests/auth-index-bounce-routing.mjs
 * Exit code 0 = pass, 1 = fail.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Pull the bounce IIFE out of its <script> tag -- the first <script>...</script>
// block in the file, immediately after the D-225 hotfix comment.
const scriptMatch = indexHtml.match(/<script>\s*\n\(function \(\) \{[\s\S]*?\}\)\(\);\s*\n<\/script>/);
if (!scriptMatch) {
  throw new Error('Could not locate the bounce IIFE in index.html -- has the script tag structure changed?');
}
const bounceSrc = scriptMatch[0].replace(/^<script>\s*\n/, '').replace(/\n<\/script>$/, '');

function makeJwt(userMetadataRole) {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'test-user',
    user_metadata: userMetadataRole ? { role: userMetadataRole } : {},
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

/**
 * Runs the real bounce script with a mock window/localStorage and returns the
 * URL passed to location.replace(), or null if the bounce did not fire.
 */
function runBounce({ jwtRole, csAuthRole }) {
  const hash = `#access_token=${makeJwt(jwtRole)}&token_type=bearer`;
  const store = { cs_auth_role: csAuthRole ?? undefined };
  let replacedTo = null;

  const sandbox = {
    console,
    URLSearchParams,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    localStorage: {
      getItem: (k) => (k in store ? store[k] ?? null : null),
      removeItem: (k) => { delete store[k]; },
      setItem: (k, v) => { store[k] = v; },
    },
    window: {
      location: {
        hash,
        search: '',
        replace: (url) => { replacedTo = url; },
      },
    },
  };
  sandbox.window.location.hash = hash;
  vm.createContext(sandbox);
  vm.runInContext(bounceSrc, sandbox, { filename: 'index.html#bounce' });
  return replacedTo;
}

function main() {
  // The A1b fix: dual-role account, stale JWT says 'contractor', cs_auth_role
  // says the live partner surface role -> cs_auth_role must win.
  {
    const dest = runBounce({ jwtRole: 'contractor', csAuthRole: 'home_inspector' });
    assert.ok(
      dest && dest.startsWith('/partner-dashboard.html'),
      `dual-role, stale JWT='contractor', cs_auth_role='home_inspector': expected bounce to /partner-dashboard.html, got ${JSON.stringify(dest)}`
    );
    console.log('✓ PASS: A1b fix — cs_auth_role partner value overrides stale JWT contractor role');
  }

  // No cs_auth_role set -> precedence byte-identical to before: JWT decides.
  {
    const dest = runBounce({ jwtRole: 'contractor', csAuthRole: null });
    assert.ok(
      dest && dest.startsWith('/contractor-pre-approval.html'),
      `no cs_auth_role, JWT='contractor': expected bounce to /contractor-pre-approval.html (unchanged), got ${JSON.stringify(dest)}`
    );
    console.log('✓ PASS: unchanged precedence — no cs_auth_role override, JWT contractor role still bounces to contractor path');
  }

  // cs_auth_role present but NOT a partner role (e.g. a stale 'contractor'
  // value) -> must not override; JWT still decides.
  {
    const dest = runBounce({ jwtRole: 'homeowner', csAuthRole: 'contractor' });
    assert.ok(
      dest && dest.startsWith('/dashboard.html'),
      `cs_auth_role='contractor' (not a partner role), JWT='homeowner': expected bounce to /dashboard.html (JWT wins, no override), got ${JSON.stringify(dest)}`
    );
    console.log('✓ PASS: non-partner cs_auth_role never overrides — JWT role still decides');
  }

  // No JWT role and no cs_auth_role at all -> falls through to homepage render.
  {
    const dest = runBounce({ jwtRole: null, csAuthRole: null });
    assert.equal(
      dest, null,
      `no role resolvable at all: expected no bounce (homepage renders), got ${JSON.stringify(dest)}`
    );
    console.log('✓ PASS: unrecognized/absent role — no bounce, homepage renders');
  }

  console.log('\n✓ All index.html bounce routing-outcome cases pass.');
  process.exit(0);
}

main();
