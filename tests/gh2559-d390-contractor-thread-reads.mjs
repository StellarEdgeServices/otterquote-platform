/**
 * gh-2559 / D-390 -- a contractor page must read the message thread through public.contractor_thread_messages, never public.messages.
 * Reason: before the Platform Fee the table holds no homeowner-sent row for a contractor (restrictive policy d390_homeowner_text_prefee) and
 * the view is where phone- and e-mail-shaped text is removed. Reading the table would silently drop the homeowner's side of the thread.
 * Writes (insert) still go to public.messages. NEGATIVE CONTROL: the same check run against a copy that reads the table must fail.
 * Run: node tests/gh2559-d390-contractor-thread-reads.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } };

// every .from('messages') / .from("messages") call, with the text that follows it up to the end of the call chain's first statement
function messageReads(src) {
  const out = [];
  const re = /\.from\((['"])messages\1\)\s*\.(select|insert|update|delete)\b/g;
  let m; while ((m = re.exec(src))) out.push(m[2]);
  return out;
}
const viewReads = (src) => (src.match(/\.from\((['"])contractor_thread_messages\1\)\s*\.select\b/g) || []).length;

const pages = [['contractor-dashboard.html', read('contractor-dashboard.html')], ['react-app/app/contractor/dashboard/Messaging.tsx', read('react-app/app/contractor/dashboard/Messaging.tsx')]];
for (const [name, src] of pages) {
  ok(viewReads(src) === 1, `${name}: the thread is read through contractor_thread_messages exactly once`);
  ok(!messageReads(src).includes('select'), `${name}: no .select() on public.messages`);
  ok(messageReads(src).includes('insert'), `${name}: sending still inserts into public.messages`);
  ok(!/profiles:sender_id/.test(src), `${name}: no profiles embed on the thread read`);
  ok(/sender_full_name/.test(src), `${name}: the own-name label comes from the view's sender_full_name`);
}
// negative control: the pre-change read
const pre = pages[0][1].replace('.from("contractor_thread_messages")', '.from("messages")');
ok(messageReads(pre).includes('select') && viewReads(pre) === 0, 'NEGATIVE CONTROL: a page that reads the table is detected by the same check');

// the migration creates exactly the columns the pages select
const mig = read('supabase/migrations_drafts/gh2559_d390_redact_contact_until_fee.sql');
for (const col of ['id', 'sender_id', 'sender_role', 'body', 'created_at', 'sender_full_name']) {
  ok(new RegExp('(\\bm\\.' + col + '\\b|\\bAS ' + col + '\\b)').test(mig.slice(mig.indexOf('CREATE OR REPLACE VIEW public.contractor_thread_messages'))), `thread view exposes ${col}`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
