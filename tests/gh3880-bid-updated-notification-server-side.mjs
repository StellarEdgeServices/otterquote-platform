/**
 * gh-3880 -- the homeowner's bid_updated notification must be written by the server (rpc notify_homeowner_bid_updated),
 * not by a direct notifications INSERT from the contractor's session (RLS refuses it, 42501), and the returned {error} is read.
 * Static scan of both bid-form twins (code only). Fails on main (direct insert present, no rpc).
 * Run: node tests/gh3880-bid-updated-notification-server-side.mjs      Exit 0 = all green.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
let fail = 0;
const ok = (c, m) => { if (!c) fail++; console.log((c ? 'PASS: ' : 'FAIL: ') + m); };
const files = { 'contractor-bid-form.html': 'sb', 'react-app/app/contractor/bid/[claimId]/bid-form.tsx': 'supabase' };
for (const [f, cl] of Object.entries(files)) {
  const c = code(rd(f));
  ok(!new RegExp(cl + "\\.from\\('notifications'\\)\\s*\\.insert").test(c), f + ' has no direct notifications insert from the contractor session');
  ok(new RegExp(cl + "\\.rpc\\('notify_homeowner_bid_updated',\\s*\\{\\s*p_quote_id:\\s*existingQuote").test(c), f + ' calls rpc notify_homeowner_bid_updated with the quote id');
  ok(/_?notifErr\s*\|\|/.test(c) || /if \(_notifErr/.test(c), f + ' reads the returned error (supabase-js does not throw it)');
}
const sql = rd('supabase/migrations_drafts/gh3880_notify_homeowner_bid_updated.sql');
ok(/SECURITY DEFINER/.test(sql) && /k\.user_id = v_uid/.test(sql) && /FROM PUBLIC, anon, authenticated/.test(sql), 'draft RPC is SECURITY DEFINER, checks the caller owns the quote, and revokes PUBLIC/anon');
ok(!/CREATE POLICY|ALTER POLICY|DROP POLICY/.test(sql), 'draft does not touch any RLS policy');
process.exit(fail ? 1 : 0);
