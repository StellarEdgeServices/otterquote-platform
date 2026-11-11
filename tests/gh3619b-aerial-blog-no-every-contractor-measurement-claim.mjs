// gh-3619 follow-up: blog/aerial-roof-measurement-reports.html must not carry the claim D-388 retired
// ("every contractor" uses/gets the measurements). Approved wording: "professional measurements that contractors use to bid".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'blog/aerial-roof-measurement-reports.html'), 'utf8');
const D388 = 'professional measurements that contractors use to bid';
let fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : ' -- ' + detail}`); if (!ok) fail++; };

const retired = /every contractor(?!s? bids on the same written scope)|shared with every contractor/gi;
check('S1 no retired "every contractor" measurement claim', !(html.match(retired) || []).length, (html.match(retired) || []).join(' | '));
check('S2 D-388 wording appears at 5 of the 6 former hits (meta, og, subtitle, FAQ, JSON-LD); the key-advantage box now reads "professional measurements like these to bid" per Aerial v2 (gh-3661)',
  html.split(D388).length - 1 === 5, `count=${html.split(D388).length - 1}`);
const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
let ldOk = ld.length > 0;
for (const b of ld) { try { const j = JSON.parse(b.replace(/<\/?script[^>]*>/g, '')); if (j.description && /every contractor/i.test(j.description)) ldOk = false; } catch { ldOk = false; } }
check('S3 JSON-LD parses and description is clean', ldOk);
check('S4 scope-based statement (compete from the same scope) left alone', /contractors compete from the same scope/.test(html));
process.exit(fail ? 1 : 0);
