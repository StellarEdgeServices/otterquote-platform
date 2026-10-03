/**
 * gh-2462 (Q3) -- every browser caller of the send-message-notification Edge Function
 * must send the signed-in user's session token as `Authorization: Bearer`, because the
 * function now refuses unauthenticated callers (401) and non-senders (403).
 *
 * Static check over dashboard.html, contractor-dashboard.html and the React
 * contractor Messaging.tsx: each fetch of the function (SEND_FUNCTION_URL, or
 * efUrl('send-message-notification')) must carry an Authorization header whose token
 * comes from getSession(), and must stay inside a try/catch (fire-and-forget).
 * The homeowner React path uses supabase.functions.invoke, which attaches the session
 * JWT itself; asserted to still be that.
 *
 * Run: node tests/gh2462-send-message-notification-callers.mjs   (exit 0 = all pass)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(c, label) { if (c) { console.log('PASS: ' + label); pass++; } else { console.log('FAIL: ' + label); fail++; } }
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const SITES = [
  ['dashboard.html', /await fetch\(SEND_FUNCTION_URL,/g, 2],
  ['contractor-dashboard.html', /await fetch\(SEND_FUNCTION_URL,/g, 2],
  ['react-app/app/contractor/dashboard/Messaging.tsx', /await fetch\(efUrl\('send-message-notification'\),/g, 1],
];

for (const [file, re, expected] of SITES) {
  const src = read(file);
  const hits = [...src.matchAll(re)];
  ok(hits.length === expected, `${file}: ${expected} send-message-notification fetch call(s) found (got ${hits.length})`);
  for (const [i, m] of hits.entries()) {
    const start = m.index;
    const call = src.slice(start, start + 400);
    const before = src.slice(Math.max(0, start - 600), start);
    const label = `${file} call #${i + 1}`;
    ok(/Authorization['"]?\s*:\s*`Bearer \$\{notifToken\}`/.test(call), `${label}: sends Authorization: Bearer <notifToken>`);
    ok(/notifToken\s*=\s*(notifSession|sessionData)\?\.(session\?\.)?access_token/.test(before), `${label}: token comes from getSession().access_token`);
    ok(/auth\.getSession\(\)/.test(before), `${label}: getSession() called just before the fetch`);
    const lastTry = before.lastIndexOf('try {');
    ok(lastTry !== -1 && !/catch/.test(before.slice(lastTry)), `${label}: still inside the fire-and-forget try block`);
    ok(/body:\s*JSON\.stringify\(\{ message_id: newMessage\.id \}\)/.test(call), `${label}: body unchanged ({ message_id })`);
  }
}

// dashboard.html sends the apikey on its neighbouring EF calls, so it does here too.
ok(/"apikey": CONFIG\.SUPABASE_ANON/.test(read('dashboard.html')), 'dashboard.html: apikey header present on the notification fetch');

// Nothing may read recipient_email off the response any more.
for (const f of ['dashboard.html', 'contractor-dashboard.html', 'react-app/app/contractor/dashboard/Messaging.tsx',
  'react-app/app/(homeowner)/dashboard/actions.ts', 'react-app/app/(homeowner)/dashboard/components/MessagesPanel.tsx']) {
  ok(!read(f).includes('recipient_email'), `${f}: no dependence on recipient_email`);
}

// Homeowner React path: functions.invoke (session JWT attached by supabase-js).
ok(/supabase\.functions\.invoke\('send-message-notification'/.test(read('react-app/app/(homeowner)/dashboard/actions.ts')),
  'homeowner actions.ts: uses supabase.functions.invoke (session JWT attached automatically)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
