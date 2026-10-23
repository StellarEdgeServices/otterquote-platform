/**
 * gh-2881 / D-390 static guard. `authenticated` cannot SELECT claims.homeowner_notes, urgency_reason or project_confirmation once
 * supabase/migrations_drafts/gh2881_claims_private_text_column_grants.sql is applied, and a `*` select (or a bare .select() after an
 * insert/update, which is RETURNING *) then fails with 42501 for every browser session. So no client file may:
 *   (1) select `*` (or nothing) from public.claims, directly or through an embedded claims(...) / claims:claim_id(...) relation;
 *   (2) name homeowner_notes / urgency_reason / project_confirmation in a select list on claims.
 * The owner reads those three through the claim_private_text() RPC. Writes (update/insert payload keys) and reads of the bidder_claim_summary
 * VIEW (which carries a redacted homeowner_notes) are not select lists on claims and are not flagged.
 * It also keeps the column list inlined in the static pages identical to react-app/app/lib/claim-columns.ts.
 *
 * Run: node tests/gh2881-claims-no-star-select.mjs
 * GH2881_ROOT points at another tree (e.g. a checkout of main) for a negative control: expect failures there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.GH2881_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE = ['homeowner_notes', 'urgency_reason', 'project_confirmation'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'supabase', 'tests', '__tests__', '.next', 'dist', 'build', 'out', 'coverage', 'tools', 'scripts', '.github']);
const EXT = /\.(html|ts|tsx|js|mjs)$/;
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name)); }
    else if (EXT.test(e.name) && !/\.(test|spec)\./.test(e.name)) yield path.join(dir, e.name);
  }
}

// Returns [{line, why, text}] for one file's source.
export function scan(src) {
  const out = [];
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  const badList = (arg) => {
    if (arg === null) return 'empty select (RETURNING *)';
    const t = arg.trim();
    if (t === '' ) return 'empty select (RETURNING *)';
    if (!/^(['"`])/.test(t)) return null; // an identifier / constant: checked at its definition
    const body = t.slice(1, -1);
    if (/(^|[\s,(])\*([\s,)]|$)/.test(body)) return 'select *';
    for (const p of PRIVATE) if (new RegExp('\\b' + p + '\\b').test(body)) return 'names ' + p;
    return null;
  };
  // (1)+(2) direct: .from('claims') ... .select(ARG)
  for (const m of src.matchAll(/\.from\(\s*(['"`])claims\1\s*\)/g)) {
    let seg = src.slice(m.index + m[0].length, m.index + m[0].length + 900);
    const nf = seg.search(/\.from\(/); if (nf !== -1) seg = seg.slice(0, nf);
    const semi = seg.indexOf(';'); if (semi !== -1) seg = seg.slice(0, semi);
    for (const s of seg.matchAll(/\.select\(\s*((?:'[^']*'|"[^"]*"|`[^`]*`|[A-Za-z_$][\w$.]*)?)\s*(?:,[^)]*)?\)/g)) {
      const why = badList(s[1] === '' ? null : s[1]);
      if (why) out.push({ line: lineOf(m.index), why, text: s[0].slice(0, 80) });
    }
  }
  // embedded relations inside any select string: claims(...), claims:claim_id(...), claims!inner(...)
  for (const s of src.matchAll(/\.select\(\s*(['"`])([^'"`]*\bclaims\b[^'"`]*)\1/g)) {
    for (const e of s[2].matchAll(/\bclaims\b[^(,]*\(([^)]*)\)/g)) {
      const inner = e[1];
      if (/(^|[\s,])\*([\s,]|$)/.test(inner)) out.push({ line: lineOf(s.index), why: 'embedded claims(*)', text: s[2].slice(0, 80) });
      for (const p of PRIVATE) if (new RegExp('\\b' + p + '\\b').test(inner)) out.push({ line: lineOf(s.index), why: 'embedded claims names ' + p, text: s[2].slice(0, 80) });
    }
  }
  return out;
}

// ---- self-check: the scanner flags what it must and passes what it must (so a green run is not a tautology) ----
const BAD = [
  ["sb.from('claims').select('*').eq('id', x)", 'select *'],
  ["sb\n  .from('claims')\n  .select()\n  .single();", 'empty select'],
  ["const { data } = await supabase.from('claims').update(u).eq('id', 1).select();", 'bare .select() after update'],
  ["supabase.from('claims').select('id, homeowner_notes')", 'names homeowner_notes'],
  ["supabase.from('claims').select(`id, project_confirmation`)", 'names project_confirmation'],
  ["sb.from('quotes').select('id, claims(*)')", 'embedded claims(*)'],
  ["sb.from('quotes').select('id, claims:claim_id(id, urgency_reason)')", 'embedded names urgency_reason'],
];
const GOOD = [
  ["sb.from('claims').select('id, status').eq('id', 1)", 'named list'],
  ["supabase.from('claims').select(CLAIM_PUBLIC_COLUMNS).eq('id', 1)", 'constant'],
  ["sb.from('claims').update({ homeowner_notes: 'x' }).eq('id', 1).select('id')", 'write payload names the column'],
  ["sb.from('bidder_claim_summary').select('id, homeowner_notes')", 'view read'],
  ["sb.from('quotes').select('id, claims(id, status)')", 'embedded named'],
  ["sb.rpc('claim_private_text', { p_claim_id: id })", 'the RPC'],
];
for (const [src, label] of BAD) ok(scan(src).length > 0, 'scanner flags: ' + label);
for (const [src, label] of GOOD) ok(scan(src).length === 0, 'scanner passes: ' + label);

// ---- the tree ----
let files = 0;
const violations = [];
const literals = [];
for (const f of walk(ROOT)) {
  const src = fs.readFileSync(f, 'utf8'); files++;
  for (const v of scan(src)) violations.push(`${path.relative(ROOT, f)}:${v.line} ${v.why}  ${v.text.replace(/\s+/g, ' ')}`);
  for (const m of src.matchAll(/'(id, user_id, claim_number, status[^']*)'/g)) literals.push([path.relative(ROOT, f), m[1]]);
}
ok(files > 50, `scanned ${files} client files`);
ok(violations.length === 0, `no client file selects * from claims or names a private column in a claims select list (${violations.length} found)`);
for (const v of violations) console.log('  VIOLATION: ' + v);

const tsPath = path.join(ROOT, 'react-app/app/lib/claim-columns.ts');
if (fs.existsSync(tsPath)) {
  const ts = fs.readFileSync(tsPath, 'utf8');
  const canon = (ts.match(/CLAIM_PUBLIC_COLUMNS =\s*'([^']*)'/) || [])[1] || '';
  const cols = canon.split(',').map((c) => c.trim());
  ok(cols.length > 100 && PRIVATE.every((p) => !cols.includes(p)), `the shared column list has ${cols.length} columns and none of the three private ones`);
  ok(new Set(cols).size === cols.length, 'the shared column list has no duplicates');
  const other = literals.filter(([f]) => f !== 'react-app/app/lib/claim-columns.ts');
  ok(other.length >= 7, `the static pages inline the list (${other.length} literals)`);
  const diff = other.filter(([, l]) => l !== canon);
  ok(diff.length === 0, `every inlined list equals react-app/app/lib/claim-columns.ts (${diff.map(([f]) => f).join(', ') || 'all identical'})`);
} else {
  ok(false, 'react-app/app/lib/claim-columns.ts exists');
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
