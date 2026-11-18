/**
 * gh-3783 (D-375) -- a contractor never sees windows on a claim: no trade badge, no per-trade status line,
 * no pre-ticked bid-form checkbox, no price field. Runs the page's own code against a mixed ['roofing','windows'] claim.
 * Run: node tests/gh3783-windows-contractor-view.mjs     GH3783_ROOT=<another tree> for a negative control.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.GH3783_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('PASS: ' + m); } else { failed++; console.log('FAIL: ' + m); } }
const opp = fs.readFileSync(path.join(ROOT, 'contractor-opportunities.html'), 'utf8');
const bid = fs.readFileSync(path.join(ROOT, 'contractor-bid-form.html'), 'utf8');

// --- opportunity card ---
const tl = opp.match(/trades: (\(?Array\.isArray\(trades\)[^\n]*?),\s*(?:\/\/[^\n]*)?\n\s*damageType: claim\.damage_type/);
ok(!!tl, 'opportunity mapper trades line found');
const fn = (name) => { const m = opp.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n        }\\n')); return m ? m[0] : ''; };
const code = ['getTradeBadges', 'getTradeReleaseBadges', 'getMultiTradeBadge'].map(fn).join('\n');
ok(code.includes('getTradeBadges') && code.includes('getTradeReleaseBadges') && code.includes('getMultiTradeBadge'), 'badge functions extracted');
const trades = (() => { try { return new Function('trades', 'return (' + tl[1] + ');')(['roofing', 'windows']); } catch { return ['roofing', 'windows']; } })();
const released = { roofing: true, gutters: false, siding: false, windows: false };
const html = new Function('trades', 'released', code + '; const o = {trades, releasedTrades: released}; return getTradeBadges(trades) + getMultiTradeBadge(trades) + getTradeReleaseBadges(o);')(trades, released);
ok(!/windows|🪟|Waiting on homeowner design/i.test(html), 'mixed claim: opportunity card has no Windows badge, no MULTI-TRADE badge for it, no "Waiting on homeowner design" line');

// --- static bid form ---
const strip = bid.match(/\['trades', 'selected_trades'\]\.forEach\(function \(k\) \{[\s\S]*?\n            \}\);/);
ok(!!strip, 'bid form strips windows from the loaded claim');
const init = (bid.match(/function initTradeSelection\(trades\) \{[\s\S]*?\n    \}\n(?=\s*\n\s*\/\/ ── Initialize)/) || [''])[0];
ok(init.length > 0, 'initTradeSelection extracted');
const data = { trades: ['roofing', 'windows'], selected_trades: ['roofing', 'windows'] };
if (strip) new Function('data', strip[0])(data);
const els = {}; const el = (id) => els[id] || (els[id] = { style: {}, innerHTML: '', value: '', checked: false, addEventListener() {}, querySelectorAll: () => [] });
const doc = { getElementById: el, querySelectorAll: () => [] };
new Function('document', 'escHtmlBid', 'trades', init + '; initTradeSelection(trades);')(doc, (x) => String(x), data.trades);
const rendered = (els.tradeCheckboxes?.innerHTML || '') + (els.tradeBreakdownFields?.innerHTML || '');
ok(!/windows|🪟|trade-price/i.test(rendered) && els.tradeSelectionCard?.style.display !== 'block', 'mixed claim: bid form shows no Windows checkbox, no per-trade price field');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
